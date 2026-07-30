import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The case-insensitive username constraint (audit finding C4).
 *
 * `username TEXT UNIQUE` and `idx_users_username` are both case-SENSITIVE while
 * every application-level check runs `COLLATE NOCASE`. That gap let two
 * concurrent signups create `Alice` and `alice`, after which login's
 * `WHERE ... OR username = ? COLLATE NOCASE` — a `.get()`, so one arbitrary row
 * of the two — permanently locked one of those two people out of username
 * sign-in with an "Incorrect password." they could do nothing about.
 *
 * Each scenario builds a database in the pre-fix state (schema migrated, the
 * case-insensitive index dropped, the collision inserted) and then runs
 * initDatabase over it, which is the upgrade path a real deployment takes.
 *
 * initDatabase opens the database at module load, so each run gets its own
 * subprocess for a clean module registry — the pattern
 * routes.emailVerifiedMigration.test.js already uses.
 */

let dir;

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wev-uname-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function initAgainst(dbFile) {
  const root = process.cwd().replace(/\\/g, '/');
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
    process.env.JWT_SECRET = 'test';
    process.env.DEMO_MODE = 'false';
    const { initDatabase } = await import('${root}/server/db.js');
    initDatabase();
  `], { cwd: process.cwd(), stdio: 'pipe' });
}

/**
 * A database as it stood before the fix: fully migrated, but with the
 * case-insensitive index removed so the collision the old schema permitted can
 * actually be inserted.
 */
function seedCollision(rows) {
  const dbFile = path.join(dir, 'pre-fix.db');
  initAgainst(dbFile);

  const db = new DatabaseSync(dbFile);
  db.exec('DROP INDEX IF EXISTS idx_users_username_nocase');
  const insert = db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role, created_at)
    VALUES (?, ?, ?, ?, 'x', 'N/A', 'student', ?)
  `);
  for (const r of rows) insert.run(r.id, r.name, r.email, r.username, r.created_at);
  db.close();

  return dbFile;
}

const open = (dbFile) => new DatabaseSync(dbFile);

const TWO_ALICES = [
  { id: 'user-old', name: 'Alice One', email: 'a1@x.org', username: 'Alice', created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'user-new', name: 'Alice Two', email: 'a2@x.org', username: 'alice', created_at: '2026-06-01T00:00:00.000Z' }
];

describe('case-insensitive username reconciliation (C4)', () => {
  it('reproduces the collision the pre-fix schema allowed', () => {
    // Guards the test itself: if this ever fails, the scenario below is no
    // longer exercising the bug and its pass means nothing.
    const dbFile = seedCollision(TWO_ALICES);
    const db = open(dbFile);
    const count = db.prepare("SELECT COUNT(*) AS c FROM users WHERE LOWER(username) = 'alice'").get().c;
    db.close();
    expect(count).toBe(2);
  });

  it('lets the oldest account keep the username and suffixes the newer one', () => {
    const dbFile = seedCollision(TWO_ALICES);
    initAgainst(dbFile);

    const db = open(dbFile);
    const older = db.prepare('SELECT username FROM users WHERE id = ?').get('user-old');
    const newer = db.prepare('SELECT username FROM users WHERE id = ?').get('user-new');
    db.close();

    expect(older.username).toBe('Alice');
    expect(newer.username).toBe('alice2');
  });

  it('tells the renamed account what happened and records it', () => {
    const dbFile = seedCollision(TWO_ALICES);
    initAgainst(dbFile);

    const db = open(dbFile);
    const notif = db.prepare("SELECT title, body FROM notifications WHERE user_id = 'user-new'").get();
    const audit = db.prepare("SELECT action FROM admin_audit_logs WHERE target_user_id = 'user-new'").get();
    const untouched = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'user-old'").get().c;
    db.close();

    expect(notif).toBeTruthy();
    expect(notif.title).toMatch(/username changed/i);
    // Names both the old and the new value, so the person can act on it.
    expect(notif.body).toContain('alice');
    expect(notif.body).toContain('alice2');
    expect(audit.action).toBe('USERNAME_DEDUPED');
    // The account that kept its name is not notified about a non-event.
    expect(untouched).toBe(0);
  });

  it('refuses a case-variant insert once the index exists', () => {
    const dbFile = seedCollision([TWO_ALICES[0]]);
    initAgainst(dbFile);

    const db = open(dbFile);
    expect(() => {
      db.prepare(`
        INSERT INTO users (id, name, email, username, password_hash, grade, role, created_at)
        VALUES ('user-x', 'X', 'x@x.org', 'ALICE', 'x', 'N/A', 'student', '2026-07-01T00:00:00.000Z')
      `).run();
    }).toThrow(/UNIQUE/i);
    db.close();
  });

  it('keeps a suffixed username inside the 20-character limit', () => {
    // Exactly 20 characters — the validator's maximum — so the suffix has to
    // displace a character rather than produce a name signup would now reject.
    const long = 'abcdefghijklmnopqrst';
    const dbFile = seedCollision([
      { id: 'user-old', name: 'A', email: 'a1@x.org', username: long, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'user-new', name: 'B', email: 'a2@x.org', username: long.toUpperCase(), created_at: '2026-06-01T00:00:00.000Z' }
    ]);
    initAgainst(dbFile);

    const db = open(dbFile);
    const newer = db.prepare('SELECT username FROM users WHERE id = ?').get('user-new');
    db.close();

    expect(newer.username.length).toBeLessThanOrEqual(20);
    // The account's own capitalisation is preserved — the rename resolves a
    // collision, it does not restyle someone's chosen handle.
    expect(newer.username).toBe('ABCDEFGHIJKLMNOPQRS2');
  });

  it('leaves a database with no collisions alone', () => {
    const dbFile = seedCollision([
      { id: 'user-a', name: 'A', email: 'a@x.org', username: 'alice', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'user-b', name: 'B', email: 'b@x.org', username: 'bob', created_at: '2026-01-02T00:00:00.000Z' }
    ]);
    initAgainst(dbFile);

    const db = open(dbFile);
    expect(db.prepare('SELECT username FROM users WHERE id = ?').get('user-a').username).toBe('alice');
    expect(db.prepare('SELECT username FROM users WHERE id = ?').get('user-b').username).toBe('bob');
    expect(db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c).toBe(0);
    db.close();
  });
});
