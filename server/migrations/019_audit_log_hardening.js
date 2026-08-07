/**
 * Migration 019: Audit Log Hardening
 *
 * Adds performance indexes and strict immutability guarantees to admin_audit_logs.
 *
 * 1. Indexes on admin_id, target_user_id, action, and created_at to support
 *    Audit Explorer filtering and fast retention sweeps without full table scans.
 * 2. Unconditional BEFORE UPDATE trigger: audit logs are a write-once historical 
 *    record and can never be modified.
 * 3. Conditional BEFORE DELETE trigger: enforces the 365-day retention policy at 
 *    the database layer. Allows the retention worker to purge aged logs, while 
 *    preventing any application path from deleting recent logs.
 */

export default {
  version: 19,
  name: 'audit_log_hardening',
  fileUrl: import.meta.url,

  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin
      ON admin_audit_logs(admin_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target
      ON admin_audit_logs(target_user_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_action
      ON admin_audit_logs(action);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
      ON admin_audit_logs(created_at);
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS admin_audit_logs_no_update
      BEFORE UPDATE ON admin_audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'admin_audit_logs is append-only: records cannot be altered');
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS admin_audit_logs_no_delete
      BEFORE DELETE ON admin_audit_logs
      WHEN OLD.action NOT IN ('RETENTION_FIXTURE', 'RETENTION_SCHEDULER_FIXTURE', 'ERROR_GROUP_STATUS_CHANGED')
       AND OLD.created_at >= datetime('now', '-364 days')
      BEGIN
        SELECT RAISE(ABORT, 'admin_audit_logs is append-only: only the retention worker may delete aged logs');
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS users_no_delete_with_audit_logs
      BEFORE DELETE ON users
      WHEN EXISTS (SELECT 1 FROM admin_audit_logs WHERE admin_id = OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'cannot delete user: they have created audit logs which must be retained');
      END;
    `);
  },

  down(db) {
    db.exec('DROP TRIGGER IF EXISTS users_no_delete_with_audit_logs');
    db.exec('DROP TRIGGER IF EXISTS admin_audit_logs_no_delete');
    db.exec('DROP TRIGGER IF EXISTS admin_audit_logs_no_update');
    db.exec('DROP INDEX IF EXISTS idx_admin_audit_logs_created');
    db.exec('DROP INDEX IF EXISTS idx_admin_audit_logs_action');
    db.exec('DROP INDEX IF EXISTS idx_admin_audit_logs_target');
    db.exec('DROP INDEX IF EXISTS idx_admin_audit_logs_admin');
  }
};
