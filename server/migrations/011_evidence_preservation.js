/**
 * Safety evidence must outlive the thing it is evidence about.
 *
 * ── The incident this migration closes ──
 *
 * Three foreign keys chained together, every one of them ON DELETE CASCADE:
 *
 *   conversations.event_id                 -> events(id)
 *   conversation_reports.conversation_id   -> conversations(id)
 *   conversation_report_messages.report_id -> conversation_reports(id)
 *
 * So `DELETE FROM events` removed every conversation held under the event, every
 * safety report filed about those conversations, and the message snapshots that
 * were written specifically to survive message deletion. Measured, not inferred:
 * one report and one snapshot before, zero and zero after.
 *
 * `DELETE /api/events/:id` refused only an event with attendance recorded, or a
 * completed one. Grooming happens BEFORE the event runs, when attendance is zero
 * by definition — so the window in which the evidence was destructible was
 * exactly the window in which the harm occurs, and the reported organizer needed
 * no privilege they did not already have. It was their own event.
 *
 * A fourth cascade did the same thing on a three-year timer:
 *
 *   conversation_reports.reporter_id -> users(id) ON DELETE CASCADE
 *   reports.reporter_id              -> users(id) ON DELETE CASCADE
 *
 * The retention sweep hard-deletes anonymised account shells at three years
 * (retentionWorker.js). A student who reported an adult and later deleted their
 * own account had their report — and its evidence — destroyed with the shell.
 * A victim's own privacy right, silently erasing the record of what was done to
 * them.
 *
 * ── Two different fixes, and why they are different ──
 *
 * SEVER for people. `reporter_id` and `reported_user_id` become ON DELETE SET
 * NULL alongside `*_name_snapshot` columns. The shell still purges on the
 * published three-year schedule — Privacy Policy "the remaining shell is deleted
 * after 3 years" stays true — and the report survives with the names it needs.
 * Holding the shell instead would have been the easier patch and would have made
 * a published retention period false, indefinitely, with no stated end.
 *
 * HOLD for content. `conversation_id` loses its foreign key entirely, so a
 * deleted conversation can no longer take a report with it; the route layer
 * additionally refuses to delete an event or comment named by a live report
 * (see server/evidenceHolds.js). Severing alone would preserve the snapshot but
 * lose the surrounding context a moderator has to read to judge it. The
 * Administrator Responsibilities Policy already instructs a human not to "delete
 * a conversation that is part of a report, even at a participant's request" —
 * this makes that instruction binding on the party it most needs to bind, who is
 * not an administrator.
 *
 * ── Immutability is a trigger, not a convention ──
 *
 * A test asserts that the code path somebody wrote does not rewrite evidence. A
 * trigger asserts it for every path anybody ever writes, including a bin/ script
 * and a sqlite3 session. Snapshot bodies take no UPDATE and no DELETE at all;
 * report envelopes take no DELETE and no UPDATE of the evidentiary columns.
 *
 * `reporter_id` and `reported_user_id` are deliberately EXCLUDED from the
 * immutable column lists. An FK ON DELETE SET NULL performs a real UPDATE on the
 * child row and does fire BEFORE UPDATE OF triggers — verified by running it, on
 * node:sqlite, before this file was written. Listing those two columns would
 * have made the trigger abort the shell purge and take down the nightly sweep.
 * `status` is excluded for the obvious reason: a report has to be resolvable.
 *
 * ── Relationship to the reports rebuild that follows ──
 *
 * The trust & safety spec (docs/specs/2026-08-05-trust-and-safety-mvp.md §2)
 * rebuilds `reports` again to widen `target_type` and `status` and add the
 * workflow columns. This migration deliberately does NOT do that work early: it
 * changes `reports` only where a cascade destroys evidence, so the two changes
 * stay separately reviewable. That later rebuild must add `reporter_name_snapshot`
 * to its own EXPECTED_REPORT_COLUMNS list, or its guard 4 will refuse to run.
 *
 * ── Rollback ──
 *
 * Forward-only, like the rest of the registry, and a rebuild has no column-level
 * undo — unlike 006, whose three ALTER TABLE ... DROP COLUMN can be reversed by
 * hand. Recovery is restoring the backup taken before the release, which is why
 * bin/verify-restore.sh is a release-checklist step for the version carrying this.
 */

/** The shape this migration assumes it is transforming. Guard 4 compares against these. */
export const EXPECTED_CONVERSATION_REPORT_COLUMNS = [
  'id', 'reporter_id', 'conversation_id', 'reason', 'details', 'status',
  'snapshot_created_at', 'created_at',
];

export const EXPECTED_CONVERSATION_REPORT_MESSAGE_COLUMNS = [
  'report_id', 'message_id', 'sender_id', 'body', 'created_at',
];

export const EXPECTED_REPORT_COLUMNS = [
  'id', 'reporter_id', 'target_type', 'target_id', 'reason', 'status', 'created_at',
];

/**
 * Row counts for every table holding a foreign key to `table`.
 *
 * Schema-derived rather than hardcoded, for the reason 001 gives: a literal list
 * silently stops covering the newest children, which are exactly the ones a
 * stale guard would fail to protect. Vacuous for `reports`, which has none — and
 * that is worth keeping rather than skipping, because the next rebuild of that
 * table will not be vacuous and nobody will remember to add it back.
 */
function countCascadingChildren(db, parent) {
  const counts = {};
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);

  for (const table of tables) {
    if (table === parent || table === `${parent}_new`) continue;
    // Table names come from sqlite_master, never from user input.
    const references = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .some(fk => fk.table === parent);
    if (references) counts[table] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  }
  return counts;
}

/** Guard 4, shared by all three rebuilds: refuse a table this file does not recognise. */
function assertColumns(db, table, expected) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const unknown = actual.filter(c => !expected.includes(c));
  const missing = expected.filter(c => !actual.includes(c));
  if (unknown.length) {
    throw new Error(
      `${table} has unexpected columns [${unknown.join(', ')}]. Add them to this `
      + "migration's expected-column list AND to its CREATE TABLE, then re-run. "
      + 'Copying without them would delete that data.'
    );
  }
  if (missing.length) {
    throw new Error(
      `${table} is missing expected columns [${missing.join(', ')}]. `
      + 'initDatabase() must run its bootstrap pass before migrations.'
    );
  }
}

/** Guard 6, shared: the copy moved every row, and nothing cascaded away underneath it. */
function assertCopied(db, from, to, childCountsBefore, parent) {
  const before = db.prepare(`SELECT COUNT(*) c FROM ${from}`).get().c;
  const after = db.prepare(`SELECT COUNT(*) c FROM ${to}`).get().c;
  if (before !== after) {
    throw new Error(`${from}: row count changed during copy: ${before} -> ${after}`);
  }
  for (const [table, expected] of Object.entries(childCountsBefore)) {
    const actual = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    if (actual !== expected) {
      throw new Error(
        `${table} lost rows during the ${parent} rebuild: ${expected} -> ${actual}. `
        + 'Foreign keys were enforced during DROP TABLE and cascade-deleted them.'
      );
    }
  }
}

function up(db) {
  /**
   * Idempotency probe. The registry re-runs `up()` in its own test, and a
   * pilot database may already carry this change. The presence of a column that
   * only this migration adds is the cheapest reliable answer.
   */
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_reports'"
  ).get();
  if (existing?.sql?.includes('reporter_name_snapshot')) return;

  assertColumns(db, 'conversation_reports', EXPECTED_CONVERSATION_REPORT_COLUMNS);
  assertColumns(db, 'conversation_report_messages', EXPECTED_CONVERSATION_REPORT_MESSAGE_COLUMNS);
  assertColumns(db, 'reports', EXPECTED_REPORT_COLUMNS);

  const fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;

  db.exec('PRAGMA foreign_keys = OFF');       // MUST be outside the transaction
  try {
    /**
     * Guard 2. Setting this pragma inside an open transaction is a silent no-op,
     * and with foreign keys still ON, `DROP TABLE conversation_reports` cascades
     * its snapshots away — destroying, in the migration written to preserve
     * evidence, exactly the evidence it exists to preserve. Nothing downstream
     * catches that on its own: the copy counts the parent, whose rows survive,
     * and `foreign_key_check` finds nothing because a cascade deletes children
     * rather than orphaning them.
     */
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 0) {
      throw new Error(
        'PRAGMA foreign_keys = OFF did not take effect — a transaction is already open. '
        + 'Aborting: the rebuild below would cascade-delete the evidence snapshots.'
      );
    }

    db.exec('BEGIN');
    try {
      const conversationReportChildren = countCascadingChildren(db, 'conversation_reports');
      const reportChildren = countCascadingChildren(db, 'reports');

      /* ── 1. conversation_reports ─────────────────────────────────────────
       *
       * `conversation_id` carries NO foreign key. That is the whole point and it
       * is not an oversight: a constraint that CASCADEs destroys the report, and
       * one that RESTRICTs makes ordinary retention impossible. The id is a
       * recorded fact about what was reported, and the snapshot columns beside it
       * are what stays readable once the conversation is gone.
       */
      db.exec(`
        CREATE TABLE conversation_reports_new (
          id TEXT PRIMARY KEY,
          reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          reporter_name_snapshot TEXT,
          conversation_id TEXT NOT NULL,
          reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          reported_name_snapshot TEXT,
          reported_role_snapshot TEXT,
          event_id_snapshot TEXT,
          event_title_snapshot TEXT,
          reason TEXT NOT NULL CHECK(reason IN ('inappropriate', 'spam', 'safety', 'other')),
          details TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'reviewing', 'resolved', 'dismissed')),
          snapshot_created_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      /**
       * The backfill resolves the review context that was never captured at
       * write time, from the live rows while they are still there. Every join is
       * a LEFT JOIN: a report whose conversation or event has ALREADY been
       * destroyed by the cascade this migration closes must still copy across,
       * carrying nulls, rather than being dropped by an inner join. Losing a
       * historical report to the migration that preserves reports would be a
       * poor joke.
       *
       * The reported party is the participant who is not the reporter. Derived
       * here rather than stored at report time because report time is in the
       * past; from now on the route writes it directly.
       */
      db.exec(`
        INSERT INTO conversation_reports_new (
          id, reporter_id, reporter_name_snapshot, conversation_id,
          reported_user_id, reported_name_snapshot, reported_role_snapshot,
          event_id_snapshot, event_title_snapshot,
          reason, details, status, snapshot_created_at, created_at
        )
        SELECT
          cr.id, cr.reporter_id, ru.name, cr.conversation_id,
          pu.id, pu.name, pu.role,
          c.event_id, e.title,
          cr.reason, cr.details, cr.status, cr.snapshot_created_at, cr.created_at
        FROM conversation_reports cr
        LEFT JOIN users ru         ON ru.id = cr.reporter_id
        LEFT JOIN conversations c  ON c.id  = cr.conversation_id
        LEFT JOIN events e         ON e.id  = c.event_id
        LEFT JOIN users pu         ON pu.id = CASE
                                       WHEN c.student_id = cr.reporter_id THEN c.organizer_id
                                       ELSE c.student_id
                                     END
      `);
      assertCopied(db, 'conversation_reports', 'conversation_reports_new',
        conversationReportChildren, 'conversation_reports');

      db.exec('DROP TABLE conversation_reports');
      db.exec('ALTER TABLE conversation_reports_new RENAME TO conversation_reports');

      /* ── 2. conversation_report_messages ─────────────────────────────────
       *
       * ON DELETE RESTRICT, not CASCADE. Reports are not deletable at all after
       * this migration, so the constraint is belt and braces — but it is the
       * difference between "nothing deletes a report today" and "deleting a
       * report cannot take its evidence", and only the second one is a property
       * of the database.
       *
       * `message_id` deliberately carries no foreign key to `messages`. It has to
       * survive the message row being swept or hard-deleted; that is the entire
       * purpose of a snapshot. A CASCADE here would make evidence preservation a
       * lie and a RESTRICT here would make retention impossible.
       */
      db.exec(`
        CREATE TABLE conversation_report_messages_new (
          report_id TEXT NOT NULL REFERENCES conversation_reports(id) ON DELETE RESTRICT,
          message_id TEXT NOT NULL,
          sender_id TEXT,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(report_id, message_id)
        )
      `);
      db.exec(`
        INSERT INTO conversation_report_messages_new
          (report_id, message_id, sender_id, body, created_at)
        SELECT report_id, message_id, sender_id, body, created_at
        FROM conversation_report_messages
      `);
      assertCopied(db, 'conversation_report_messages', 'conversation_report_messages_new',
        {}, 'conversation_report_messages');

      db.exec('DROP TABLE conversation_report_messages');
      db.exec('ALTER TABLE conversation_report_messages_new RENAME TO conversation_report_messages');

      /* ── 3. reports ──────────────────────────────────────────────────────
       *
       * Two changes: the reporter cascade, and a snapshot of what was reported.
       *
       * `target_type` and `status` keep their existing CHECK constraints —
       * widening those is the later rebuild's job, and doing it here would bury
       * a schema change nobody reviewed inside a security fix.
       *
       * The snapshot is not optional decoration. `reports` stores `target_id`
       * with no foreign key and, until now, no copy of the thing reported — so a
       * student could delete their own comment and destroy the entire
       * evidentiary basis of the report against them, needing no privilege at
       * all, and the moderation queue would render the literal string 'Deleted
       * Comment' where the evidence should be. The route hold added in this
       * release stops that while the report is live; the snapshot is what keeps
       * the decision auditable after it is resolved and the hold lifts.
       */
      db.exec(`
        CREATE TABLE reports_new (
          id TEXT PRIMARY KEY,
          reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          reporter_name_snapshot TEXT,
          target_type TEXT NOT NULL CHECK(target_type IN ('event', 'comment')),
          target_id TEXT NOT NULL,
          target_body_snapshot TEXT,
          target_author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          target_author_name_snapshot TEXT,
          reason TEXT NOT NULL,
          status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
          created_at TEXT NOT NULL
        )
      `);
      /**
       * Backfilled from whatever is still there. A report whose target was
       * already destroyed copies across with nulls rather than being dropped —
       * losing a historical report to the migration that preserves reports
       * would be a poor joke — and a null here is honestly distinguishable from
       * a snapshot taken at report time.
       */
      db.exec(`
        INSERT INTO reports_new
          (id, reporter_id, reporter_name_snapshot, target_type, target_id,
           target_body_snapshot, target_author_id, target_author_name_snapshot,
           reason, status, created_at)
        SELECT
          r.id, r.reporter_id, u.name, r.target_type, r.target_id,
          CASE r.target_type WHEN 'comment' THEN ec.body WHEN 'event' THEN e.title END,
          CASE r.target_type WHEN 'comment' THEN ec.user_id WHEN 'event' THEN e.organizer_id END,
          CASE r.target_type WHEN 'comment' THEN cu.name WHEN 'event' THEN eu.name END,
          r.reason, r.status, r.created_at
        FROM reports r
        LEFT JOIN users u          ON u.id  = r.reporter_id
        LEFT JOIN event_comments ec ON r.target_type = 'comment' AND ec.id = r.target_id
        LEFT JOIN users cu         ON cu.id = ec.user_id
        LEFT JOIN events e         ON r.target_type = 'event'   AND e.id  = r.target_id
        LEFT JOIN users eu         ON eu.id = e.organizer_id
      `);
      assertCopied(db, 'reports', 'reports_new', reportChildren, 'reports');

      db.exec('DROP TABLE reports');
      db.exec('ALTER TABLE reports_new RENAME TO reports');

      /* ── 4. Indexes ──────────────────────────────────────────────────────
       *
       * DROP TABLE took any indexes with it. These three tables had none at all,
       * which is not a reason to ship without them: every one below backs a query
       * this release adds to a hot path. `idx_reports_target` and
       * `idx_conversation_reports_conversation` are what keep the delete-time
       * evidence hold from table-scanning, and `idx_conversation_report_messages_message`
       * is probed by the retention sweep on every pass.
       */
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_reports_conversation ON conversation_reports(conversation_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_reports_status ON conversation_reports(status, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_reports_event ON conversation_reports(event_id_snapshot) WHERE event_id_snapshot IS NOT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_report_messages_message ON conversation_report_messages(message_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at)');

      /* ── 5. Immutability ─────────────────────────────────────────────────
       *
       * See the header for why `reporter_id` and `reported_user_id` are absent
       * from the UPDATE OF lists: the FK SET NULL that replaced the cascade is
       * itself an UPDATE, and naming those columns here would abort the nightly
       * retention sweep instead of the tampering this is aimed at.
       */
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS conversation_report_messages_no_update
        BEFORE UPDATE ON conversation_report_messages BEGIN
          SELECT RAISE(ABORT, 'conversation_report_messages is a frozen evidence snapshot: it is never edited');
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS conversation_report_messages_no_delete
        BEFORE DELETE ON conversation_report_messages BEGIN
          SELECT RAISE(ABORT, 'conversation_report_messages is a frozen evidence snapshot: it is never deleted');
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS conversation_reports_no_delete
        BEFORE DELETE ON conversation_reports BEGIN
          SELECT RAISE(ABORT, 'a safety report is never deleted: resolve or dismiss it instead');
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS conversation_reports_immutable
        BEFORE UPDATE OF id, conversation_id, reason, details, created_at, snapshot_created_at,
                         reporter_name_snapshot, reported_name_snapshot, reported_role_snapshot,
                         event_id_snapshot, event_title_snapshot
        ON conversation_reports BEGIN
          SELECT RAISE(ABORT, 'what a report says is a record of what was said: only its status may change');
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS reports_no_delete
        BEFORE DELETE ON reports BEGIN
          SELECT RAISE(ABORT, 'a report is never deleted: resolve or dismiss it instead');
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS reports_immutable
        BEFORE UPDATE OF id, target_type, target_id, reason, created_at,
                         reporter_name_snapshot, target_body_snapshot,
                         target_author_name_snapshot
        ON reports BEGIN
          SELECT RAISE(ABORT, 'what a report says is a record of what was said: only its status may change');
        END;
      `);

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error(
          `${violations.length} foreign key violations after the evidence-preservation rebuild`
        );
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
  }
}

export default {
  version: 11,
  name: 'evidence_preservation',
  ownTransaction: true,
  up,
  fileUrl: import.meta.url,
};
