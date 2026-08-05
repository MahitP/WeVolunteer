/**
 * Suspension detail on `users`.
 *
 * ── The gap this closes ──
 *
 * `account_status` has accepted `'suspended'` since v1.1, and both sign-in
 * paths have refused suspended accounts for just as long (authRoutes.js,
 * oauthRoutes.js), as does `authenticateToken` on every request. But nothing in
 * the application ever SET the value. `user.suspend` was a registered
 * capability with no route behind it, so the platform could recognise a
 * suspended account and had no way to produce one.
 *
 * The practical consequence, on a service that deliberately lets adults message
 * minors: an administrator holding a credible safety report could mark the
 * report resolved and delete a comment. They could not remove the person. These
 * three columns are what `POST /api/admin/users/:id/suspend` writes.
 *
 * ── Why a migration rather than `addColumnIfMissing` ──
 *
 * `runMigrations` runs LAST in `initDatabase()`, after every additive guard. A
 * column added by `addColumnIfMissing` therefore exists on `users` *before*
 * migration 001 rebuilds that table — and 001's unknown-column guard
 * (ENGINEERING_GUIDE §8.3) refuses to copy a table carrying columns its explicit
 * column list does not name, because copying without them would silently delete
 * the data. That is the guard working correctly, and it is a hard boot failure
 * on any fresh database.
 *
 * Adding the columns to 001's own column list instead would change its source,
 * and the registry re-verifies each migration's checksum on every boot — so
 * that fix breaks every database that has already run it (§8.5). Ordering after
 * the rebuild is the only placement that is correct for both a fresh database
 * and an existing one. This is the same reasoning migration 005 records for
 * `error_groups.alerted_at`, arrived at from the opposite direction: 005's
 * table did not exist yet, this one is rebuilt after.
 *
 * ── Additive, so §8.3's rebuild guards do not apply ──
 *
 * Three nullable `ALTER TABLE ... ADD COLUMN` statements, no default, no table
 * rebuilt, no constraint changed. Said out loud so the next reader does not go
 * looking for the six destructive-rebuild guards and conclude they were
 * forgotten. `ownTransaction` is deliberately unset: the registry's BEGIN/COMMIT
 * is correct for additive DDL.
 *
 * ── Why `suspended_by` is stored on the row ──
 *
 * The audit log already records who suspended whom. It is also subject to a
 * 1-year retention policy, and a suspension can outlast it — an account
 * suspended for a safety reason is not expected to come back. "Who did this,
 * and why" must survive on the row itself, because it is what an appeal is
 * reviewed against and what the Admin Responsibilities Policy commits to being
 * able to answer.
 *
 * No backfill. Every existing row is `account_status = 'active'` or `'deleted'`
 * — there cannot be a suspended account with a missing reason, because there
 * cannot be a suspended account at all until the route that writes one ships
 * with this.
 *
 * ── Rollback ──
 *
 * The registry is forward-only. Recovery is manual:
 *
 *     ALTER TABLE users DROP COLUMN suspended_by;
 *     ALTER TABLE users DROP COLUMN suspension_reason;
 *     ALTER TABLE users DROP COLUMN suspended_at;
 *     DELETE FROM schema_migrations WHERE version = 6;
 *
 * Do NOT delete that row while the columns still exist — re-running `up`
 * against a database it has already changed is the failure §8.5 exists to
 * prevent. (The guard below makes that particular re-run safe, but the rule
 * stands for the registry as a whole.)
 */
function up(db) {
  /**
   * Guarded per column, because SQLite's ADD COLUMN has no IF NOT EXISTS and
   * the registry's own idempotency test runs `up` against a database that may
   * already carry them. Same check `addColumnIfMissing` makes in db.js.
   */
  const existing = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));

  if (!existing.has('suspended_at')) {
    db.exec('ALTER TABLE users ADD COLUMN suspended_at TEXT');
  }
  if (!existing.has('suspension_reason')) {
    db.exec('ALTER TABLE users ADD COLUMN suspension_reason TEXT');
  }
  if (!existing.has('suspended_by')) {
    db.exec('ALTER TABLE users ADD COLUMN suspended_by TEXT');
  }
}

export default { version: 6, name: 'account_suspension', up, fileUrl: import.meta.url };
