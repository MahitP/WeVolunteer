/**
 * Short-lived, single-use grants proving a fresh identity check.
 *
 * Server-side rows rather than a JWT claim: a claim cannot be revoked inside its
 * own lifetime, and this is the mechanism standing between a stolen session and
 * account deletion.
 */
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reauth_challenges (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      action      TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      method      TEXT,
      session_jti TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      granted_at  TEXT,
      consumed_at TEXT,
      attempts    INTEGER NOT NULL DEFAULT 0,
      ip_hash     TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reauth_user ON reauth_challenges(user_id, expires_at)');
}

export default { version: 3, name: 'reauth_challenges', up, fileUrl: import.meta.url };
