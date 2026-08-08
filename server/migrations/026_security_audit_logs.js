export default {
  version: 26,
  name: 'security_audit_logs',
  fileUrl: import.meta.url,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS security_audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_security_audit_logs_user
      ON security_audit_logs(user_id, created_at DESC)
    `);
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_security_audit_logs_type
      ON security_audit_logs(event_type, created_at DESC)
    `);

    // Strict append-only constraints matching admin_audit_logs
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS security_audit_logs_no_update
      BEFORE UPDATE ON security_audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'security_audit_logs is append-only: records cannot be altered');
      END;
    `);

    // We do NOT add a trigger that prevents deleting a user when they have a security audit log.
    // Security audit logs belong to the user and cascade-delete when the user deletes their account.
  }
};
