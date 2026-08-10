/**
 * External hours are a personal log, not a submission.
 *
 * ── Why this migration exists ──
 *
 * 031 shipped `external_hours` with `status`, `reviewed_by`, `reviewed_at` and
 * `review_note`, on the reasoning that the platform already named a
 * `service.verify.external` capability so somebody must have intended a review
 * flow. That was an inference, and it was wrong: the feature is personal
 * record-keeping, and a verification pipeline turns a notebook into an
 * application form — a student writing down that they helped at a food bank is
 * not asking anybody's permission.
 *
 * So the review apparatus is removed rather than merely left unused. A dormant
 * `status` column is an invitation: the next person to read the schema finds a
 * state machine, assumes it is load-bearing, and writes a query against it. The
 * honest schema for "self-reported, always" has no column saying so.
 *
 * ── Why this one rebuilds a table ──
 *
 * SQLite gained `ALTER TABLE ... DROP COLUMN` in 3.35, and `node:sqlite` is new
 * enough — but four separate drops each rewrite the table anyway, and none of
 * them can restate the CHECK constraints. One explicit rebuild is clearer about
 * what the table becomes and leaves the result identical on every database.
 *
 * It follows the structure ENGINEERING_GUIDE §8.3 requires of the only other
 * sanctioned rebuild (001): `ownTransaction` so the foreign-key pragma actually
 * takes effect, an assertion that it did, an explicit column list rather than
 * `SELECT *`, a row-count comparison across the copy, and `foreign_key_check`
 * before commit. `external_hours` has no child tables, so there is no child-row
 * count to compare — the row count of the table itself is the whole check.
 *
 * ── Data ──
 *
 * Nothing is lost that a student wrote. Every entry's organization, activity,
 * description, date and hours is carried across verbatim. What is dropped is
 * the review metadata, which on any real database is `'self_reported'` and three
 * NULLs — no deployment ever had a UI that could set anything else, because the
 * review endpoints shipped and were removed in the same release.
 *
 * Entries previously marked `rejected` are carried across too. A rejection was
 * an administrative opinion about somebody's own record of their own afternoon,
 * and this release's position is that nobody was ever entitled to hold one.
 */

export default {
  version: 32,
  name: 'external_hours_tracking_only',
  fileUrl: import.meta.url,

  /**
   * A table rebuild has to manage its own transaction: `PRAGMA foreign_keys` is
   * a silent no-op inside an open one, so the runner's wrapper would leave the
   * pragma unapplied and the guard below would be checking nothing.
   */
  ownTransaction: true,

  up(db) {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_hours'"
    ).all();
    if (tables.length === 0) return;

    const columns = db.prepare('PRAGMA table_info(external_hours)').all().map(c => c.name);
    /* Already rebuilt. Re-running must be a no-op, not a second rebuild. */
    if (!columns.includes('status')) return;

    /**
     * Unknown-column guard.
     *
     * If a later migration added a column this rebuild does not know about,
     * copying an explicit list would silently drop it. Refusing is the only safe
     * answer — a rebuild that quietly discards data is the failure mode the
     * whole guard list in §8.3 exists to prevent.
     */
    const EXPECTED = new Set([
      'id', 'user_id', 'organization_name', 'activity_name', 'description',
      'occurred_on', 'hours', 'status', 'reviewed_by', 'reviewed_at', 'review_note',
      'created_at', 'updated_at',
    ]);
    const unknown = columns.filter(c => !EXPECTED.has(c));
    if (unknown.length) {
      throw new Error(
        `032 refuses to rebuild external_hours: unexpected column(s) ${unknown.join(', ')}. `
        + 'Add them to this migration\'s column list before running it, or the rebuild would drop them.'
      );
    }
    const missing = [...EXPECTED].filter(c => !columns.includes(c));
    if (missing.length) {
      throw new Error(`032 refuses to rebuild external_hours: missing column(s) ${missing.join(', ')}.`);
    }

    /* Remembered so it can be RESTORED rather than forced on at the end. This
       migration did not set the connection's foreign-key state and has no
       business deciding it; 001 restores it conditionally for the same reason. */
    const fkWasOn = db.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1;

    db.exec('PRAGMA foreign_keys = OFF');
    /**
     * Assert the pragma took effect, and fail CLOSED.
     *
     * Inside a transaction `PRAGMA foreign_keys` is silently a no-op, and a
     * rebuild performed with foreign keys live would cascade-delete the rows
     * this migration exists to preserve. §8.3 lists this guard because nothing
     * else catches that.
     *
     * The test is `!== 0`, not "is it 1 or true". The earlier spelling passed
     * whenever the read returned anything unexpected — `undefined` from a
     * missing row, a driver that answers `'0'`/`'1'` as strings — which is the
     * wrong direction for a guard whose whole job is refusing to proceed when
     * it cannot confirm the state. 001_authz_roles.js, the reference rebuild,
     * asserts it this way; this one now matches.
     */
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 0) {
      throw new Error('032 could not disable foreign keys; refusing to rebuild external_hours.');
    }

    db.exec('BEGIN');
    try {
      const before = db.prepare('SELECT COUNT(*) AS n FROM external_hours').get().n;

      db.exec(`
        CREATE TABLE external_hours_new (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          organization_name TEXT NOT NULL,
          activity_name TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          /* A calendar date (YYYY-MM-DD), not a timestamp. External service is
             reported after the fact and the hour of day is not knowable. */
          occurred_on   TEXT NOT NULL,
          hours         REAL NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        )
      `);

      /* Explicit column list, never SELECT * — column ORDER differs between
         databases depending on the path they took to get here. */
      db.exec(`
        INSERT INTO external_hours_new
          (id, user_id, organization_name, activity_name, description, occurred_on, hours, created_at, updated_at)
        SELECT id, user_id, organization_name, activity_name, description, occurred_on, hours, created_at, updated_at
        FROM external_hours
      `);

      const after = db.prepare('SELECT COUNT(*) AS n FROM external_hours_new').get().n;
      if (after !== before) {
        throw new Error(`032 lost rows rebuilding external_hours: ${before} before, ${after} after.`);
      }

      db.exec('DROP TABLE external_hours');
      db.exec('ALTER TABLE external_hours_new RENAME TO external_hours');
      db.exec('CREATE INDEX IF NOT EXISTS idx_external_hours_user ON external_hours(user_id, occurred_on DESC)');

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error(`032 left ${violations.length} foreign-key violation(s); rolling back.`);
      }

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      /* Restored, not forced. Turning it ON unconditionally would leave the
         connection in a state this migration never found it in. */
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
  },
};
