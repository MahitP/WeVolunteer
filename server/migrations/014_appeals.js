/**
 * Appeals system for Moderation Workflow.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS appeals (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      report_id    TEXT REFERENCES reports(id) ON DELETE RESTRICT,
      status       TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved')),
      decision     TEXT CHECK(decision IS NULL OR decision IN ('stands','reversed')),
      reasoning    TEXT,
      reviewer_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_appeals_queue ON appeals(status, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_appeals_user  ON appeals(user_id, created_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS appeal_tokens (
      token        TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at   TEXT NOT NULL,
      used_at      TEXT
    )
  `);
}

export default {
  version: 14,
  name: 'appeals',
  up,
  fileUrl: import.meta.url,
};
