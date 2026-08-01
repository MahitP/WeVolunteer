/**
 * Per-user capability grants.
 *
 * Exists so a job title does not become a role. An NHS advisor is usually also a
 * teacher and sometimes an organizer; adding a role per title multiplies the
 * authorization matrix for no benefit. A scoped, expirable, audited grant is the
 * cheaper primitive.
 */
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_capabilities (
      user_id    TEXT NOT NULL,
      capability TEXT NOT NULL,
      -- '' = global; else school/event id. Defaults to '' rather than NULL
      -- because scope is part of the PRIMARY KEY below, and SQLite treats
      -- NULLs as distinct from one another in a unique index — a NULL scope
      -- would let the identical grant be inserted repeatedly instead of
      -- being deduplicated.
      scope      TEXT NOT NULL DEFAULT '',
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      PRIMARY KEY (user_id, capability, scope),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_usercaps_user ON user_capabilities(user_id)');
}

export default { version: 2, name: 'user_capabilities', up };
