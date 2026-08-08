export default {
  version: 25,
  name: 'tfa_hardening',
  fileUrl: import.meta.url,
  up(db) {
    const tableInfo = db.prepare('PRAGMA table_info(users)').all();
    if (!tableInfo.some(c => c.name === 'tfa_email_enabled')) {
      db.exec('ALTER TABLE users ADD COLUMN tfa_email_enabled INTEGER DEFAULT 0');
    }
    
    // Rename columns from 024 migration to match what the codebase expects
    if (tableInfo.some(c => c.name === 'two_factor_enabled') && !tableInfo.some(c => c.name === 'tfa_enabled')) {
      db.exec('ALTER TABLE users RENAME COLUMN two_factor_enabled TO tfa_enabled');
      db.exec('ALTER TABLE users RENAME COLUMN two_factor_secret TO tfa_secret');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS tfa_email_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tfa_email_codes_user ON tfa_email_codes(user_id, expires_at)
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS tfa_login_attempts (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        last_attempt_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    const usersWithCodes = db.prepare('SELECT DISTINCT user_id FROM recovery_codes').all();
    if (usersWithCodes.length > 0) {
      const disableTfa = db.prepare('UPDATE users SET tfa_enabled = 0 WHERE id = ?');
      for (const row of usersWithCodes) {
        disableTfa.run(row.user_id);
      }
    }
    
    db.exec('DELETE FROM recovery_codes');
  }
};
