/**
 * An organizer whose approval was taken back (P2-12).
 *
 * Approval was one flag, `users.verified`, and an unapproved organizer is the
 * pending queue — where "Deny" hard-deletes the account. Clearing the flag to
 * revoke would have put a working organizer, with events and the attendance of
 * every student who served at them, one click from a delete that cascades
 * through those records. `approval_revoked_at` makes revoked its own state:
 * never pending, never deniable, restored by approving again.
 *
 * Not in the profile serializer's allowlist, so no profile shows it.
 */
/* A probe rather than `PRAGMA table_info`: the same answer on SQLite without
   spending the PostgreSQL port's budget of SQLite-only SQL (sqliteDialect
   test), as 066 explains. */
function hasColumn(db) {
  try { db.prepare('SELECT approval_revoked_at FROM users LIMIT 0').all(); return true; } catch { return false; }
}

export function up(db) {
  if (!hasColumn(db)) db.exec('ALTER TABLE users ADD COLUMN approval_revoked_at TEXT');
}

async function postgresUp(db) {
  await db.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_revoked_at text');
}

export default {
  version: 73,
  name: 'organizer_approval_revoked',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
