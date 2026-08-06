/**
 * One reporting model, replacing two that did not know about each other.
 *
 * ── What was here before ──
 *
 * `reports` took `target_type IN ('event','comment')`, a free-text `reason`, and
 * a three-value status. `conversation_reports` took messages, with its own
 * four-value reason enum, its own four-value status enum, its own evidence
 * table, and — until PR-1 — no reader anywhere in the application. A student
 * reporting a comment and a student reporting a conversation produced records
 * that could not be compared, sorted together, or worked through as one queue,
 * and only one of the two was ever going to be seen.
 *
 * There was also no way to report a person. The two things a student is most
 * likely to want to report — an adult, and one specific message — were the two
 * things the schema could not express.
 *
 * ── What this migration does ──
 *
 * Rebuilds `reports` as the unified model: five target types, a category
 * taxonomy, four priorities, five statuses, assignment, and resolution. The
 * legacy `conversation_reports` fold happens in 013, which also creates
 * `report_evidence` — deliberately the next migration rather than this one,
 * because `report_evidence` carries a foreign key to `reports(id)` and this
 * rebuild must run while `reports` is still childless. Guard 5 below is vacuous
 * today for exactly that reason, and 013 is why it must stay in the file.
 *
 * ── Preserving PR-1 ──
 *
 * PR-1 (migration 011) severed the cascades that let a reported person destroy
 * the evidence against themselves, and froze what was left with triggers. All of
 * it survives here and none of it is weakened:
 *
 *   - `reporter_id` and the two author columns stay ON DELETE SET NULL beside
 *     their name snapshots, so purging an account shell still cannot destroy a
 *     report.
 *   - `target_body_snapshot` is carried across unchanged and joined by
 *     `target_name_snapshot` and `target_role_snapshot`.
 *   - The `reports_no_delete` and `reports_immutable` triggers are recreated
 *     after the rename — DROP TABLE takes triggers with it, and a rebuild that
 *     forgot them would silently un-freeze every report in the table. The
 *     immutable column list GROWS to cover the new snapshot columns.
 *
 * `reason` becomes `description`. Existing rows carry free text that was always
 * the reporter's own words, which is what `description` means; `category`
 * backfills to `'other'` because no category was ever collected and inventing
 * one would be a fabricated record. `priority` backfills to `'medium'`, not
 * one would be a fabricated record. `priority` backfills to `'normal'`, not
 * urgent: a historical report cannot be triaged retroactively by software, and
 * marking them all urgent would bury the live queue on day one.
 *
 * ── Rollback ──
 *
 * Forward-only, like the rest of the registry, and a rebuild has no column-level
 * undo. Recovery is the backup taken before the release — `bin/verify-restore.sh`
 * is a release-checklist step for the version carrying this.
 */

/** The shape this migration assumes it is transforming: migration 011's output. */
export const EXPECTED_REPORT_COLUMNS = [
  'id', 'reporter_id', 'reporter_name_snapshot', 'target_type', 'target_id',
  'target_body_snapshot', 'target_author_id', 'target_author_name_snapshot',
  'reason', 'status', 'created_at',
];

/**
 * Row counts for every table holding a foreign key to `reports`.
 *
 * Schema-derived rather than hardcoded, for the reason 001 gives: a literal list
 * silently stops covering the newest children, which are exactly the ones a
 * stale guard would fail to protect. Vacuous today — nothing references `reports`
 * yet — and that is the point: 013 gives it children, so this rebuild happens at
 * the last moment the destructive step is free, and the guard stays in the file
 * so any future rebuild is covered without anybody remembering to add it.
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

function up(db) {
  /**
   * Idempotency probe. The registry re-runs `up()` in its own test, and a pilot
   * database may already carry this change. `priority` is a column only this
   * migration adds.
   */
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='reports'"
  ).get();
  if (existing?.sql?.includes('priority')) return;

  // Guard 4: refuse a table this file does not recognise. The copy below is an
  // explicit transformation, so an unknown column would be silently dropped.
  const actual = db.prepare('PRAGMA table_info(reports)').all().map(c => c.name);
  const unknown = actual.filter(c => !EXPECTED_REPORT_COLUMNS.includes(c));
  const missing = EXPECTED_REPORT_COLUMNS.filter(c => !actual.includes(c));
  if (unknown.length) {
    throw new Error(
      `reports has unexpected columns [${unknown.join(', ')}]. Add them to `
      + 'EXPECTED_REPORT_COLUMNS and to the CREATE TABLE below, then re-run. '
      + 'Copying without them would delete that data.'
    );
  }
  if (missing.length) {
    throw new Error(
      `reports is missing expected columns [${missing.join(', ')}]. Migration 011 `
      + 'must have run before this one — check server/migrations/index.js ordering.'
    );
  }

  const fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;

  db.exec('PRAGMA foreign_keys = OFF');       // MUST be outside the transaction
  try {
    /**
     * Guard 2. Setting this pragma inside an open transaction is a silent no-op.
     * `reports` has no children today so nothing would cascade — but deviating
     * from the reviewed recipe per-table is how a rebuild eventually gets it
     * wrong, and the copy below re-validates four REFERENCES users(id)
     * constraints on every row it inserts. With foreign keys ON, a `reporter_id`
     * pointing at an already-purged shell throws mid-migration; with them OFF the
     * row copies and guard 6 reports it cleanly at the end.
     */
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 0) {
      throw new Error(
        'PRAGMA foreign_keys = OFF did not take effect — a transaction is already open. '
        + 'Aborting the reports rebuild.'
      );
    }

    db.exec('BEGIN');
    try {
      const childCounts = countCascadingChildren(db, 'reports');

      db.exec(`
        CREATE TABLE reports_new (
          id                          TEXT PRIMARY KEY,
          reporter_id                 TEXT REFERENCES users(id) ON DELETE SET NULL,
          reporter_name_snapshot      TEXT,
          target_type                 TEXT NOT NULL CHECK(target_type IN
                                        ('event', 'comment', 'message', 'conversation', 'user', 'announcement', 'certificate')),
          target_id                   TEXT NOT NULL,
          target_name_snapshot        TEXT,
          target_body_snapshot        TEXT,
          target_author_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
          target_author_name_snapshot TEXT,
          target_role_snapshot        TEXT,
          conversation_id_snapshot    TEXT,
          event_id_snapshot           TEXT,
          category                    TEXT NOT NULL,
          description                 TEXT,
          status                      TEXT NOT NULL DEFAULT 'open' CHECK(status IN
                                        ('open', 'reviewing', 'escalated', 'resolved', 'dismissed')),
          priority                    TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN
                                        ('normal', 'urgent')),
          assigned_to                 TEXT REFERENCES users(id) ON DELETE SET NULL,
          assigned_at                 TEXT,
          resolution                  TEXT CHECK(resolution IS NULL OR resolution IN
                                        ('no_action', 'content_removed', 'warning_issued',
                                         'account_suspended', 'account_removed',
                                         'escalated_offline', 'duplicate')),
          resolution_note             TEXT,
          resolved_by                 TEXT REFERENCES users(id) ON DELETE SET NULL,
          resolved_at                 TEXT,
          created_at                  TEXT NOT NULL,
          updated_at                  TEXT NOT NULL
        )
      `);

      /**
       * `category` deliberately carries no CHECK constraint.
       *
       * The list will change as students tell us what is happening to them, and a
       * CHECK on it buys a table rebuild every time a category is added. It is
       * validated at the route against `REPORT_CATEGORIES` in server/moderation.js,
       * where a bad value is a 400 naming the valid ones — a better error than a
       * SQLite constraint failure in any case. The two enums that ARE CHECKed,
       * `status` and `priority`, are closed sets that queries branch on.
       */

      /**
       * `target_name_snapshot` backfills from the live row where it is still
       * there, and is left NULL where it is not. `target_body_snapshot` already
       * carries the event title for event reports (PR-1 wrote it that way), so a
       * COALESCE onto it would be right for events and wrong for comments, where
       * the body is the comment text and not a name. Better an honest NULL than a
       * plausible wrong label on a moderation surface.
       */
      db.exec(`
        INSERT INTO reports_new (
          id, reporter_id, reporter_name_snapshot, target_type, target_id,
          target_name_snapshot, target_body_snapshot, target_author_id,
          target_author_name_snapshot, target_role_snapshot,
          conversation_id_snapshot, event_id_snapshot,
          category, description, status, priority,
          assigned_to, assigned_at, resolution, resolution_note, resolved_by, resolved_at,
          created_at, updated_at
        )
        SELECT
          r.id, r.reporter_id, r.reporter_name_snapshot, r.target_type, r.target_id,
          CASE r.target_type
            WHEN 'event'   THEN e.title
            WHEN 'comment' THEN CASE WHEN ce.title IS NOT NULL
                                     THEN 'Comment on “' || ce.title || '”' END
          END,
          r.target_body_snapshot, r.target_author_id,
          r.target_author_name_snapshot, au.role,
          NULL,
          CASE r.target_type WHEN 'event' THEN r.target_id WHEN 'comment' THEN c.event_id END,
          'other', r.reason, r.status, 'normal',
          NULL, NULL, NULL, NULL, NULL, NULL,
          r.created_at, r.created_at
        FROM reports r
        LEFT JOIN users u           ON u.id  = r.reporter_id
        LEFT JOIN users au          ON au.id = r.target_author_id
        LEFT JOIN events e          ON r.target_type = 'event'   AND e.id  = r.target_id
        LEFT JOIN event_comments c  ON r.target_type = 'comment' AND c.id  = r.target_id
        LEFT JOIN events ce         ON ce.id = c.event_id
      `);

      // Guard 6a: the copy moved every row, and nothing cascaded away under it.
      const before = db.prepare('SELECT COUNT(*) c FROM reports').get().c;
      const after = db.prepare('SELECT COUNT(*) c FROM reports_new').get().c;
      if (before !== after) {
        throw new Error(`reports: row count changed during copy: ${before} -> ${after}`);
      }

      db.exec('DROP TABLE reports');
      db.exec('ALTER TABLE reports_new RENAME TO reports');

      for (const [table, expected] of Object.entries(childCounts)) {
        const nowCount = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
        if (nowCount !== expected) {
          throw new Error(
            `${table} lost rows during the reports rebuild: ${expected} -> ${nowCount}. `
            + 'Foreign keys were enforced during DROP TABLE and cascade-deleted them.'
          );
        }
      }

      db.exec(`
        CREATE TABLE moderation_actions (
          id               TEXT PRIMARY KEY,
          report_id        TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
          actor_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
          action           TEXT NOT NULL,
          old_status       TEXT,
          new_status       TEXT,
          old_priority     TEXT,
          new_priority     TEXT,
          old_resolution   TEXT,
          new_resolution   TEXT,
          created_at       TEXT NOT NULL
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_moderation_actions_report ON moderation_actions(report_id)');

      /* ── Indexes ─────────────────────────────────────────────────────────
       *
       * DROP TABLE took 011's two indexes with it. Recreated, plus the ones the
       * unified queue needs. `idx_reports_queue` is the queue's own ordering;
       * `idx_reports_target` is what keeps the delete-time evidence hold from
       * table-scanning on every event and comment deletion.
       */
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_queue ON reports(status, priority, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_assignee ON reports(assigned_to) WHERE assigned_to IS NOT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_author ON reports(target_author_id) WHERE target_author_id IS NOT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id) WHERE reporter_id IS NOT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_conversation ON reports(conversation_id_snapshot) WHERE conversation_id_snapshot IS NOT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_reports_event ON reports(event_id_snapshot) WHERE event_id_snapshot IS NOT NULL');

      /**
       * Duplicate suppression.
       *
       * A second live report of the same thing by the same person is not new
       * information; it is usually a double-tap or somebody checking whether the
       * first one worked. The route catches the constraint failure and answers
       * 200 with the original report id rather than an error, because telling a
       * student "you already reported this" is fine and showing them a failure
       * after they worked up to tapping the button is not.
       */
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_no_dup
        ON reports(reporter_id, target_type, target_id)
        WHERE status IN ('open', 'reviewing', 'escalated') AND reporter_id IS NOT NULL
      `);

      /* ── Immutability, recreated ─────────────────────────────────────────
       *
       * DROP TABLE dropped PR-1's triggers. Recreating them is not optional: a
       * rebuild that forgot would silently un-freeze every report in the table,
       * and nothing would fail until somebody edited one.
       *
       * The UPDATE list grows to cover the new snapshot columns, and `category`
       * joins it — what a report was filed as is part of what it says. `status`,
       * `priority`, `assigned_to`, `assigned_at`, the four resolution columns and
       * `updated_at` are all deliberately absent: those are the moderation
       * workflow, and a report that cannot be worked is a permanent hold on
       * everything keyed to it.
       *
       * `reporter_id`, `target_author_id`, `assigned_to` and `resolved_by` must
       * also stay out of the list even though they look evidentiary. An FK
       * ON DELETE SET NULL performs a real UPDATE and does fire BEFORE UPDATE OF
       * triggers — verified by running it — so naming them would abort the
       * nightly retention sweep instead of the tampering this is aimed at.
       */
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS reports_no_delete
        BEFORE DELETE ON reports BEGIN
          SELECT RAISE(ABORT, 'a report is never deleted: resolve or dismiss it instead');
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS reports_immutable
        BEFORE UPDATE OF id, target_type, target_id, category, description, created_at,
                         reporter_name_snapshot, target_name_snapshot, target_body_snapshot,
                         target_author_name_snapshot, target_role_snapshot,
                         conversation_id_snapshot, event_id_snapshot
        ON reports BEGIN
          SELECT RAISE(ABORT, 'what a report says is a record of what was said: only its workflow may change');
        END;
      `);

      /**
       * `moderation_actions` is append-only, enforced by the database.
       *
       * The table's whole value is that a decision cannot be edited or removed
       * after the fact, and a convention is not that. A test checks the code path
       * somebody wrote; a trigger checks every path anybody ever writes, including
       * a `bin/` script and a hand-run SQL session, and it costs two statements.
       *
       * These live here, with the CREATE TABLE, rather than in a later migration.
       * A table's invariants have to ship with the table: between the release that
       * creates it and the release that freezes it, the history is editable and
       * nothing says so. (Migration 015 also declares them `IF NOT EXISTS`, so it
       * remains a no-op on any database that has run this one — the two do not
       * fight, and 015 stays correct for the appeals tables it also freezes.)
       *
       * `actor_id` is deliberately ABSENT from the UPDATE column list, for the
       * same reason `reports_immutable` omits its own FK columns: `ON DELETE SET
       * NULL` performs a real UPDATE and does fire `BEFORE UPDATE OF` triggers, so
       * naming it would abort the nightly retention sweep instead of the tampering
       * this is aimed at. Every other column is named, which is the rest of the row.
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

      /**
       * There is deliberately NO trigger writing moderation history.
       *
       * An earlier draft of this migration carried a `reports_audit` AFTER UPDATE
       * trigger that appended a row on every status, priority or resolution
       * change. It had to go, and the reason is worth writing down so it is not
       * added back as an obvious improvement.
       *
       * A trigger cannot know who acted. SQLite has no session context, so every
       * row it wrote had `actor_id = NULL` — and "somebody changed this report,
       * at this time, to this" is precisely the record with the one fact removed
       * that the table exists to hold. Worse, the route writes its own attributed
       * row, so every decision appeared twice: once correctly and once by nobody,
       * under two action names a letter apart (`update` and `updated`). A
       * moderation history a district reads a year later must not have to explain
       * that half its rows are shadows of the other half.
       *
       * The prohibitions below stay as triggers, because a prohibition is exactly
       * what a trigger is good at: it needs no context, it applies to every path
       * including a `bin/` script, and it cannot be forgotten by a new route.
       * Recording who did something is the route's job, and `moderation_actions`
       * being append-only is what stops the route lying about it afterwards.
       */

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error(`${violations.length} foreign key violations after the reports rebuild`);
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
  version: 12,
  name: 'unified_reports',
  ownTransaction: true,
  up,
  fileUrl: import.meta.url,
};
