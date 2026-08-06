/**
 * Appeals integrity — the appellant's own words stop being destroyed by the
 * ruling on them.
 *
 * THE INCIDENT THIS MIGRATION EXISTS FOR
 *
 * 014 gave `appeals` a single `reasoning` column. The submission route wrote the
 * student's statement into it; the review route wrote the moderator's decision
 * reasoning into the same column. So the act of deciding an appeal overwrote the
 * defence being decided on. Reproduced end to end before this was written:
 *
 *   stored on submit : "I never sent that message. My account was logged in on a
 *                       school computer I did not sign out of."
 *   after the ruling : "Reviewed server logs; the session was the users own device."
 *   original survives: false
 *
 * Nothing failed, nothing logged, and the moderator UI then rendered the
 * moderator's own sentence back under the heading "Appeal Statement". For a
 * platform whose users are minors contesting an enforcement action, that is the
 * single worst data-integrity defect in the repository: the record of what the
 * accused said in their own defence did not survive the decision against them.
 *
 * WHAT THIS MIGRATION DOES
 *
 *   1. Separates the two texts. `statement` is the appellant's, and it is frozen.
 *      `reasoning` keeps its name but from now on means only the reviewer's.
 *   2. Backfills `statement` from `reasoning` for appeals not yet decided — those
 *      are the rows whose `reasoning` still holds the student's words and is
 *      therefore still recoverable. A decided row's statement is already gone and
 *      is deliberately left NULL rather than backfilled with the moderator's text,
 *      which would fabricate a record. §3 below.
 *   3. Makes `appeals` append-only in the columns that are evidence, using the
 *      same `BEFORE UPDATE OF` mechanism 012 applies to `reports`.
 *   4. Gives `moderation_actions` the append-only triggers 012's header implies it
 *      has and the spec (§3.1) requires — it had none, and both UPDATE and DELETE
 *      succeeded against it.
 *   5. Adds `appeal_events`, the appeal-scoped, permanently retained history that
 *      `admin_audit_logs` cannot be (it is swept at 365 days by the retention
 *      worker, and a suspension is permanent and appealable years later).
 *
 * ADDITIVE ONLY — no rebuild, and that is deliberate. The `status` and `decision`
 * CHECK constraints are left exactly as 014 wrote them ('open','reviewing',
 * 'resolved' / 'stands','reversed'). Widening a CHECK means a table rebuild, which
 * means the six ENGINEERING_GUIDE §8.3 guards, on a table that is about to hold
 * the only surviving copy of a student's defence. The reopen workflow this release
 * adds needs `resolved` -> `reviewing`, and both values already exist. A `partial`
 * decision and a `withdrawn` status are specified in the T&S MVP §11.3 and are NOT
 * delivered here; they are a rebuild with no launch blocker behind them, and are
 * recorded as deferred rather than smuggled into a migration that has to be safe.
 *
 * ROLLBACK. Forward-only, like the rest of the registry. The four columns are
 * additive so a revert of the code leaves them harmlessly unread; the triggers are
 * the part that would need dropping by hand:
 *   DROP TRIGGER appeals_no_delete; DROP TRIGGER appeals_immutable;
 *   DROP TRIGGER moderation_actions_no_update; DROP TRIGGER moderation_actions_no_delete;
 *   DROP TRIGGER appeal_events_no_update; DROP TRIGGER appeal_events_no_delete;
 */

/** Columns 014 created. Anything else on the table means a state this file does not know. */
const EXPECTED_APPEALS_COLUMNS = [
  'id', 'user_id', 'report_id', 'status', 'decision', 'reasoning', 'reviewer_id',
  'created_at', 'updated_at',
];

/** The columns this migration adds, and the type each carries. */
const ADDED_COLUMNS = [
  // The appellant's own words. Nullable only because ADD COLUMN cannot be NOT NULL
  // against existing rows; the route requires it and the trigger below freezes it.
  ['statement', 'TEXT'],
  // When the decision was recorded. `updated_at` cannot answer this — a reopen
  // moves it — and "when was this decided" is the question an appeal record is
  // asked years later.
  ['decided_at', 'TEXT'],
  // What is being appealed. 'suspension' | 'content_removal' | 'report_outcome'.
  // No CHECK: adding a fourth subject later would be a rebuild, and the route
  // validates against one exported list (server/appeals.js) which is a better
  // error than a constraint failure anyway.
  ['subject', 'TEXT'],
  // The id of the thing named by `subject` — a report id, a message id, or NULL
  // for a suspension, which is a state of the account rather than an object.
  ['subject_ref', 'TEXT'],

  /**
   * What was being appealed, captured at filing time.
   *
   * These four exist because of a defect found while reviewing this work, and it
   * is worse than the one that started it. `POST /unsuspend` sets
   * `users.suspension_reason`, `suspended_at` and `suspended_by` to NULL
   * (adminRoutes.js), and the appeal detail route reads all three LIVE off
   * `users`. So lifting a suspension — including lifting it *because the appeal
   * succeeded* — erases the record of what the appeal was contesting. The
   * reviewer UI then renders "Suspended By: System" and a 1970 date, because
   * `new Date(null)` is the epoch.
   *
   * An appeal must carry its own copy. A snapshot cannot be un-written by a
   * later workflow step on a different table.
   */
  ['suspension_reason_snapshot', 'TEXT'],
  ['suspended_at_snapshot', 'TEXT'],
  ['suspended_by_snapshot', 'TEXT'],
  ['suspended_by_name_snapshot', 'TEXT'],

  /**
   * Who reviewed it, as a name rather than only a foreign key.
   *
   * Community Guidelines publishes "We will tell you who reviewed it."
   * `reviewer_id` is `ON DELETE SET NULL`, so that promise breaks the first time
   * an administrator's account is closed. `reports` already carries a
   * `*_name_snapshot` beside every nullable actor FK for exactly this reason.
   */
  ['reviewer_name_snapshot', 'TEXT'],
];

function addColumnIfMissing(db, table, column, type) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  if (existing.has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

function up(db) {
  /**
   * Guard: is `appeals` in the state 014 left it in?
   *
   * Weaker than 012's unknown-column guard on purpose. This migration copies
   * nothing, so an unknown column cannot be silently dropped by it — the risk a
   * strict guard defends against does not exist here. What DOES matter is that
   * the columns the backfill and the triggers name are actually present, because
   * a `BEFORE UPDATE OF <missing column>` is a SQLite error at CREATE TRIGGER
   * time and would abort the boot rather than the tampering.
   */
  const present = new Set(db.prepare('PRAGMA table_info(appeals)').all().map(c => c.name));
  const missing = EXPECTED_APPEALS_COLUMNS.filter(c => !present.has(c));
  if (missing.length) {
    throw new Error(
      `appeals is missing expected columns [${missing.join(', ')}]. Migration 014 must have `
      + 'run before this one — check the order in server/migrations/index.js.'
    );
  }

  for (const [name, type] of ADDED_COLUMNS) addColumnIfMissing(db, 'appeals', name, type);

  /**
   * The backfill, and the line it refuses to cross.
   *
   * `decision IS NULL` is the test for "not yet decided", and it is the only
   * rows whose `reasoning` is still the student's text. For a decided row the
   * statement was overwritten by the moderator and is gone; copying the
   * moderator's sentence into `statement` would turn an irreversible data loss
   * into a false record of what the student said, which is worse than the loss.
   * Those rows keep `statement = NULL`, and the reviewer UI is required to say
   * so in as many words rather than rendering an empty box.
   *
   * `statement IS NULL` keeps this idempotent: a second run of up() finds the
   * rows already backfilled and matches nothing.
   */
  db.prepare(`
    UPDATE appeals
       SET statement = reasoning
     WHERE statement IS NULL
       AND decision IS NULL
       AND reasoning IS NOT NULL
  `).run();

  /**
   * Every appeal that already carries a decision, recorded as unrecoverable.
   *
   * Not a data change — a marker on the subject field so a reviewer opening an
   * old appeal is told why the statement panel is empty. Appeals predating this
   * migration have no `subject` either, and 'suspension' is the only kind 014's
   * routes could produce.
   */
  db.prepare("UPDATE appeals SET subject = 'suspension' WHERE subject IS NULL").run();

  /**
   * `appeal_events` — the appeal's own history.
   *
   * Why not `moderation_actions`: its `report_id` is NOT NULL and references
   * `reports`, and an appeal against a suspension frequently has no report at
   * all. Why not `admin_audit_logs`: the retention worker sweeps it at 365 days
   * (retentionWorker.js), a suspension is permanent, and a district asking "who
   * decided this, on what basis" two years later must get an answer rather than
   * a gap. `recordAudit` also throws on any field outside its four, by design.
   *
   * `actor_id` is nullable and SET NULL: an appeal event outlives the account of
   * whoever performed it, and a RESTRICT here would block the account-deletion
   * path this platform is legally required to offer.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS appeal_events (
      id          TEXT PRIMARY KEY,
      appeal_id   TEXT NOT NULL REFERENCES appeals(id) ON DELETE RESTRICT,
      actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_role  TEXT,
      action      TEXT NOT NULL,
      from_status TEXT,
      to_status   TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_appeal_events_appeal ON appeal_events(appeal_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_appeal_events_actor ON appeal_events(actor_id) WHERE actor_id IS NOT NULL');

  /* ── Indexes the appeals queue and token lookup need ───────────────────── */
  db.exec('CREATE INDEX IF NOT EXISTS idx_appeal_tokens_user ON appeal_tokens(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_appeals_reviewer ON appeals(reviewer_id) WHERE reviewer_id IS NOT NULL');

  /* ── Immutability ──────────────────────────────────────────────────────────
   *
   * The column list is the whole design, so it is spelled out rather than
   * inferred.
   *
   * FROZEN — what the appeal IS:
   *   id, user_id, report_id, subject, subject_ref, created_at, and the four
   *   suspension snapshots
   *
   * WRITE-ONCE — NULL may become a value exactly once, and never change after:
   *   statement, reviewer_name_snapshot
   *
   * MUTABLE — the review workflow acting ON it:
   *   status, decision, reasoning, reviewer_id, decided_at, updated_at
   *
   * `statement` is write-once rather than frozen for a concrete reason: this
   * migration's own backfill is an UPDATE that sets it, and the registry re-runs
   * `up()` in the idempotency test. A blanket freeze would make the migration
   * unable to re-run against a row inserted between two runs — and, worse, would
   * block the one legitimate repair (recovering a statement) while doing nothing
   * extra to prevent the destruction it exists to stop. Overwriting a statement
   * that already exists is the defect; writing one that is missing is the fix.
   *
   * `reviewer_id` is deliberately absent from the frozen list for the reason
   * 012's header records against `reports`: an FK `ON DELETE SET NULL` performs a
   * real UPDATE and DOES fire `BEFORE UPDATE OF` triggers. Naming a SET NULL
   * column freezes nothing an attacker cares about and instead aborts the
   * nightly retention sweep the first time a reviewer's account is deleted.
   * `user_id` and `report_id` are RESTRICT, not SET NULL, so freezing those is
   * safe — and `user_id` in particular must be frozen, since re-pointing an
   * appeal at a different account would launder one person's defence onto
   * another's record.
   */
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS appeals_no_delete
    BEFORE DELETE ON appeals BEGIN
      SELECT RAISE(ABORT, 'an appeal is never deleted: it is the record of a person contesting an enforcement action');
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS appeals_immutable
    BEFORE UPDATE OF id, user_id, report_id, subject, subject_ref, created_at,
                     suspension_reason_snapshot, suspended_at_snapshot,
                     suspended_by_snapshot, suspended_by_name_snapshot
    ON appeals BEGIN
      SELECT RAISE(ABORT, 'what an appeal contests is a record: only the review workflow may change');
    END;
  `);

  /**
   * The whole point of this migration, expressed as a database fact.
   *
   * The review route used to write the moderator's reasoning over the student's
   * statement. From here that statement is unwritable once present, by every
   * path — a route, a bin/ script, a psql-equivalent session. A test asserts the
   * code path somebody wrote; a trigger asserts every path anybody ever writes.
   */
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS appeals_statement_write_once
    BEFORE UPDATE OF statement ON appeals
    WHEN OLD.statement IS NOT NULL AND NEW.statement IS NOT OLD.statement
    BEGIN
      SELECT RAISE(ABORT, 'an appellant''s own statement is evidence and is never overwritten');
    END;
  `);

  /**
   * The reviewer's name is write-once, not frozen.
   *
   * NULL -> value is the decision being recorded. value -> anything else would
   * rewrite who the appellant was told had judged them, which is a published
   * commitment. A re-review after a reopen appends a new `appeal_events` row
   * naming the new reviewer; it does not overwrite the first one.
   */
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS appeals_reviewer_name_write_once
    BEFORE UPDATE OF reviewer_name_snapshot ON appeals
    WHEN OLD.reviewer_name_snapshot IS NOT NULL
     AND NEW.reviewer_name_snapshot IS NOT OLD.reviewer_name_snapshot
    BEGIN
      SELECT RAISE(ABORT, 'who reviewed an appeal is published to the appellant: a re-review appends, it does not rewrite');
    END;
  `);

  /**
   * `moderation_actions` had no triggers at all.
   *
   * 012's header describes this table as the append-only moderation history and
   * the MVP spec §3.1 specifies both triggers explicitly, but neither was ever
   * created: `UPDATE moderation_actions SET action = 'tampered'` and
   * `DELETE FROM moderation_actions` both succeeded when run. Every other
   * evidence table in this schema (`reports`, `report_evidence`,
   * `conversation_reports`, `conversation_report_messages`) carries the pair.
   *
   * `actor_id` is excluded from the UPDATE list for the SET NULL reason above.
   * Every other column is named, which is the whole row.
   */
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS moderation_actions_no_update
    BEFORE UPDATE OF id, report_id, action, old_status, new_status,
                     old_priority, new_priority, old_resolution, new_resolution, created_at
    ON moderation_actions BEGIN
      SELECT RAISE(ABORT, 'moderation_actions is append-only: correct the record by appending, never by editing');
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS moderation_actions_no_delete
    BEFORE DELETE ON moderation_actions BEGIN
      SELECT RAISE(ABORT, 'moderation_actions is append-only: a moderation record is never deleted');
    END;
  `);

  /** `appeal_events` is history and nothing about it is ever correct to edit. */
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS appeal_events_no_update
    BEFORE UPDATE OF id, appeal_id, actor_role, action, from_status, to_status, note, created_at
    ON appeal_events BEGIN
      SELECT RAISE(ABORT, 'appeal_events is append-only: append a correction, never edit the history');
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS appeal_events_no_delete
    BEFORE DELETE ON appeal_events BEGIN
      SELECT RAISE(ABORT, 'appeal_events is append-only: an appeal history row is never deleted');
    END;
  `);
}

export default {
  version: 15,
  name: 'appeals_integrity',
  up,
  fileUrl: import.meta.url,
};
