/**
 * One nullable column: when this problem was alerted on, if it ever was.
 *
 * ── Why the state is per-group rather than one "last alerted" timestamp ──
 *
 * The obvious design is a single stored timestamp and a query for "groups first
 * seen since then". It is smaller and it loses alerts. Anything that moves the
 * clock relative to the sweep — a restart between ticks, a missed tick, a
 * backfilled `first_seen_at`, two ticks racing after a slow one — silently
 * drops the groups that fell in the gap, and a dropped alert is indistinguishable
 * from nothing having broken. That is the one failure an alerting path must not
 * have.
 *
 * `alerted_at IS NULL` cannot drop anything. A group that has never been alerted
 * on stays eligible for ever, so a missed tick delays an alert instead of
 * cancelling it, and a restart mid-send re-sends rather than skipping. The
 * duplicate is the cheap error; the silence is the expensive one.
 *
 * It also makes the throttle free: the most recent non-NULL `alerted_at` IS the
 * last-alert time, so no second piece of state is needed to rate-limit sending.
 *
 * ── Additive, so §8.3's guards do not apply ──
 *
 * One `ALTER TABLE ... ADD COLUMN` of a nullable column with no default. No
 * table is rebuilt, no column is dropped, no constraint changes. §8.3's six
 * destructive-rebuild guards exist for the one sanctioned rebuild (001) and are
 * not applicable here — said out loud so the next reader does not go looking for
 * them and conclude they were forgotten.
 *
 * `ownTransaction` is deliberately unset: the registry wraps this in
 * BEGIN/COMMIT, which is correct for additive DDL.
 *
 * ── Why it is here and not `addColumnIfMissing` ──
 *
 * `error_groups` is created by migration 004, and `runMigrations` runs LAST in
 * `initDatabase()` — after every `addColumnIfMissing` call. On a first boot the
 * table does not exist yet when those run, so the additive-guard path cannot
 * reach it. Keeping the column with the migration that owns the table also
 * leaves one owner for its schema rather than two.
 *
 * ── Rollback ──
 *
 * The registry is forward-only. Recovery is manual, and SQLite supports
 * dropping a plain column:
 *
 *     ALTER TABLE error_groups DROP COLUMN alerted_at;
 *     DELETE FROM schema_migrations WHERE version = 5;
 *
 * Do NOT delete that row while the column still exists — re-running `up`
 * against a database it has already changed is the failure ENGINEERING_GUIDE
 * §8.5 exists to prevent.
 */
function up(db) {
  /**
   * Guarded rather than bare, because `ADD COLUMN` is not `IF NOT EXISTS` in
   * SQLite and the registry's own idempotency test runs `up` against a database
   * that may already carry it. Reading `table_info` is the same check
   * `addColumnIfMissing` in db.js makes, for the same reason.
   */
  const columns = db.prepare('PRAGMA table_info(error_groups)').all();
  if (columns.some(c => c.name === 'alerted_at')) return;

  db.exec('ALTER TABLE error_groups ADD COLUMN alerted_at TEXT');

  /**
   * Existing rows are backfilled to "already alerted", not left NULL.
   *
   * A database that has been collecting errors since v1.2c shipped may hold
   * hundreds of open server groups. Leaving them NULL would make the first
   * sweep after this deploy treat every historical problem as brand new and
   * send one enormous alert about things nobody can act on — the classic way an
   * alerting channel gets muted in its first hour, which costs you every real
   * alert afterwards.
   *
   * `last_seen_at` rather than the current time: it is the truthful answer to
   * "when was this last known about", and it keeps the throttle's "most recent
   * alert" reading from jumping to now on a deploy.
   */
  db.exec('UPDATE error_groups SET alerted_at = last_seen_at WHERE alerted_at IS NULL');
}

export default { version: 5, name: 'error_alerts', up, fileUrl: import.meta.url };
