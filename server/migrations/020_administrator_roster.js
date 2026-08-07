/**
 * Migration 020: Administrator Roster
 *
 * 1. `users.last_sign_in_at` — when this account last signed in. Written by
 *    `issueSession`, read by the roster's "last seen" column. An administrator
 *    who has not signed in for months is a standing grant of privilege nobody is
 *    using, which is the thing a roster exists to make visible.
 *
 * 2. A composite index on `admin_audit_logs(admin_id, action, created_at)`.
 *    The roster counts decisions per actor; without this the count is a full
 *    scan of the audit table on every page load, and that table only grows.
 *    Column order matters: `admin_id` is the equality predicate, `action`
 *    narrows, `created_at` orders — so the index serves filtering and sorting
 *    from one structure.
 */

export default {
  version: 20,
  name: 'administrator_roster',
  fileUrl: import.meta.url,

  up(db) {
    /**
     * Guarded: SQLite's ADD COLUMN has no IF NOT EXISTS, and the registry's
     * idempotency test runs `up` against a database that may already carry the
     * column. The original version issued a bare ALTER TABLE and threw on a
     * second application.
     */
    const existing = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
    if (!existing.has('last_sign_in_at')) {
      db.exec('ALTER TABLE users ADD COLUMN last_sign_in_at TEXT');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor_aggregation
      ON admin_audit_logs(admin_id, action, created_at)
    `);
  },
};
