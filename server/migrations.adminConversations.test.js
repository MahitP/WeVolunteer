/**
 * Migration 018 — the `conversations` rebuild.
 *
 * ── Why this file is more careful than an additive migration's test ──
 *
 * This is the second sanctioned destructive rebuild in the repo, and the table it
 * rebuilds has three ON DELETE CASCADE children — one of which,
 * `conversation_reports` → `report_evidence`, is the frozen record behind safety
 * reports. A rebuild that runs with foreign keys enforced does not error: it
 * silently empties all three and reports success, because the cascade DELETES the
 * children rather than orphaning them, so `PRAGMA foreign_key_check` finds nothing
 * to complain about.
 *
 * So the assertions that matter are the ones about what SURVIVED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import adminConversations from './migrations/018_admin_conversations.js';

let dir, db;

/** The pre-018 schema, as db.js creates it, with the children that cascade. */
function seedPre018(database) {
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      organizer_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_message_id TEXT,
      last_message_at TEXT,
      lifecycle_state TEXT CHECK(lifecycle_state IN ('active', 'read_only')) DEFAULT 'active',
      read_only_reason TEXT,
      read_only_at TEXT,
      archived_by_system_at TEXT,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(organizer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(student_id, organizer_id, event_id)
    );
    CREATE TABLE conversation_participants (
      conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role_at_creation TEXT NOT NULL, joined_at TEXT,
      PRIMARY KEY(conversation_id, user_id),
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, edited_at TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE conversation_reports (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, reporter_id TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_conversations_event ON conversations(event_id);
  `);

  database.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u_stu', 'Student');
  database.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u_org', 'Organizer');
  database.prepare('INSERT INTO events (id, title) VALUES (?, ?)').run('e1', 'Snack Shack');
  database.prepare(`INSERT INTO conversations
      (id, event_id, student_id, organizer_id, created_by, created_at)
      VALUES ('c1', 'e1', 'u_stu', 'u_org', 'u_org', '2026-07-01T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO conversation_participants
      (conversation_id, user_id, role_at_creation, joined_at)
      VALUES ('c1','u_stu','student','x'), ('c1','u_org','organizer','x')`).run();
  database.prepare(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
      VALUES ('m1','c1','u_org','hello','x'), ('m2','c1','u_stu','hi','x')`).run();
  database.prepare("INSERT INTO conversation_reports (id, conversation_id, reporter_id) VALUES ('r1','c1','u_stu')").run();
}

const counts = () => ({
  conversations: db.prepare('SELECT COUNT(*) c FROM conversations').get().c,
  participants: db.prepare('SELECT COUNT(*) c FROM conversation_participants').get().c,
  messages: db.prepare('SELECT COUNT(*) c FROM messages').get().c,
  reports: db.prepare('SELECT COUNT(*) c FROM conversation_reports').get().c,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-mig18-'));
  db = new DatabaseSync(path.join(dir, 'm.db'));
  // ON, as the real database runs it. The migration must turn it off itself.
  db.exec('PRAGMA foreign_keys = ON');
  seedPre018(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('018_admin_conversations', () => {
  it('keeps every message, participant and report through the rebuild', () => {
    const before = counts();
    adminConversations.up(db);
    expect(counts()).toEqual(before);
    expect(db.prepare('SELECT body FROM messages WHERE id = ?').get('m1').body).toBe('hello');
  });

  it('classifies every existing thread as student_organizer', () => {
    adminConversations.up(db);
    expect(db.prepare('SELECT kind FROM conversations WHERE id = ?').get('c1').kind)
      .toBe('student_organizer');
  });

  it('preserves each column in the right column, not shifted by one', () => {
    adminConversations.up(db);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get('c1');
    expect(row.event_id).toBe('e1');
    expect(row.student_id).toBe('u_stu');
    expect(row.organizer_id).toBe('u_org');
    expect(row.created_by).toBe('u_org');
    expect(row.created_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('is idempotent', () => {
    adminConversations.up(db);
    const after = counts();
    expect(() => adminConversations.up(db)).not.toThrow();
    expect(counts()).toEqual(after);
  });

  it('leaves no foreign key violations', () => {
    adminConversations.up(db);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('recreates both indexes the DROP took with it', () => {
    adminConversations.up(db);
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='conversations'"
    ).all().map(r => r.name);

    expect(names).toContain('idx_conversations_event');
    expect(names).toContain('idx_conversations_admin_thread');
  });

  it('restores the foreign_keys pragma it turned off', () => {
    adminConversations.up(db);
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });

  /**
   * The unknown-column guard. Without it the explicit copy silently DROPS a column
   * this migration does not know about — and the data in it is somebody's messages.
   */
  it('refuses to run against a table carrying a column it does not know', () => {
    db.exec('ALTER TABLE conversations ADD COLUMN pinned_at TEXT');
    expect(() => adminConversations.up(db)).toThrow(/unexpected columns.*pinned_at/s);

    // And it refused BEFORE mutating anything.
    expect(counts().messages).toBe(2);
  });

  it('declares ownTransaction, without which the pragma is a silent no-op', () => {
    expect(adminConversations.ownTransaction).toBe(true);
    expect(adminConversations.version).toBe(18);
    expect(adminConversations.fileUrl).toBeTruthy();
  });

  it('admits an admin thread afterwards, which was the point', () => {
    adminConversations.up(db);
    expect(() => db.prepare(`
      INSERT INTO conversations (id, kind, event_id, student_id, organizer_id, created_by, created_at)
      VALUES ('c2', 'admin_student', NULL, 'u_stu', NULL, 'u_org', 'now')
    `).run()).not.toThrow();
  });
});
