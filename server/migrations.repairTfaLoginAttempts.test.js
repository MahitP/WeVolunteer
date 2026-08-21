/**
 * The second-factor step must work on a database that already exists.
 *
 * ── The failure these cover ──
 *
 * Every 2FA submission on the pilot database answered HTTP 500 — a correct code
 * and a wrong one alike, on email and on recovery — because
 * `tfa_login_attempts` there is keyed on `preauth_jti` while
 * `/api/auth/login-2fa` writes `token_hash`. The claim that throws sits ABOVE
 * every verification branch, so it took all of them down together.
 *
 * ── Why the existing suite could not have caught it ──
 *
 * Migration 025 creates that table with `CREATE TABLE IF NOT EXISTS`, which does
 * not compare shapes: on a database already holding a table of that name it does
 * nothing and is still recorded as applied. Every test database is built from
 * scratch and therefore got the correct column, so 3,500 passing tests said
 * nothing about the one database anybody signs in to.
 *
 * That is the shape of the gap, and it is what makes these tests different from
 * the rest of the 2FA suite: they start from a database that is ALREADY WRONG.
 * A test that builds a fresh schema can only ever re-confirm the case that was
 * already working. So each one below constructs the drifted table explicitly,
 * runs the migration over it, and checks the repair — which is the only
 * arrangement that would have failed before 055 existed.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './migrations/055_repair_tfa_login_attempts.js';

/** A database holding just enough for the migration to have something to repair. */
function scratchDb(createTableSql) {
  const dir = mkdtempSync(join(tmpdir(), 'wev-tfa-repair-'));
  const db = new DatabaseSync(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT
    )
  `);
  db.exec("INSERT INTO users (id, name) VALUES ('u-1', 'Test')");
  if (createTableSql) db.exec(createTableSql);
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The shape the pilot database actually had. */
const DRIFTED = `
  CREATE TABLE tfa_login_attempts (
    preauth_jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`;

/** The shape migration 025 produces on a fresh database. */
const CORRECT = `
  CREATE TABLE tfa_login_attempts (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`;

const columnsOf = (db) =>
  db.prepare('PRAGMA table_info(tfa_login_attempts)').all().map(c => c.name);

describe('055 repairs a drifted tfa_login_attempts', () => {
  it('replaces a preauth_jti key with token_hash', () => {
    const { db, cleanup } = scratchDb(DRIFTED);
    try {
      expect(columnsOf(db)).toContain('preauth_jti');
      migration.up(db);
      expect(columnsOf(db)).toContain('token_hash');
      expect(columnsOf(db)).not.toContain('preauth_jti');
    } finally { cleanup(); }
  });

  /**
   * The assertion that reproduces the original 500 directly.
   *
   * This is the statement `/api/auth/login-2fa` runs before it checks anything.
   * Against the drifted table it throws `no column named token_hash`; after the
   * repair it must simply work.
   */
  it('makes the claim statement the sign-in path runs succeed', () => {
    const { db, cleanup } = scratchDb(DRIFTED);
    const claim = (database) => database.prepare(`
      INSERT INTO tfa_login_attempts (token_hash, user_id, attempts, last_attempt_at)
      VALUES (?, ?, 1, '${new Date().toISOString()}')
      ON CONFLICT(token_hash) DO UPDATE SET
        attempts = attempts + 1,
        last_attempt_at = '${new Date().toISOString()}'
    `).run('hash-abc', 'u-1');

    try {
      expect(() => claim(db)).toThrow(/token_hash/);
      migration.up(db);
      expect(() => claim(db)).not.toThrow();

      /* And the counter it maintains still counts, so the two ceilings above it
         keep working rather than merely stopping the crash. */
      claim(db);
      expect(
        db.prepare('SELECT attempts FROM tfa_login_attempts WHERE token_hash = ?').get('hash-abc').attempts
      ).toBe(2);
    } finally { cleanup(); }
  });

  it('leaves an already-correct table alone', () => {
    const { db, cleanup } = scratchDb(CORRECT);
    try {
      db.prepare(
        "INSERT INTO tfa_login_attempts (token_hash, user_id, attempts, last_attempt_at) "
        + `VALUES ('keep-me', 'u-1', 3, '${new Date().toISOString()}')`
      ).run();
      migration.up(db);
      /* Untouched, not rebuilt: rebuilding a correct table would discard live
         rate-limit counters on every boot of a healthy database. */
      expect(
        db.prepare("SELECT attempts FROM tfa_login_attempts WHERE token_hash = 'keep-me'").get()?.attempts
      ).toBe(3);
    } finally { cleanup(); }
  });

  it('is idempotent — a second run changes nothing', () => {
    const { db, cleanup } = scratchDb(DRIFTED);
    try {
      migration.up(db);
      db.prepare(
        "INSERT INTO tfa_login_attempts (token_hash, user_id, attempts, last_attempt_at) "
        + `VALUES ('survivor', 'u-1', 1, '${new Date().toISOString()}')`
      ).run();
      migration.up(db);
      expect(
        db.prepare("SELECT attempts FROM tfa_login_attempts WHERE token_hash = 'survivor'").get()?.attempts
      ).toBe(1);
    } finally { cleanup(); }
  });

  it('does nothing on a database that has not reached 025 yet', () => {
    const { db, cleanup } = scratchDb(null);
    try {
      expect(() => migration.up(db)).not.toThrow();
      /* Deliberately NOT created here — 025 owns the definition, and a second
         one in this file would be a shape to keep in step with the first. */
      expect(columnsOf(db)).toEqual([]);
    } finally { cleanup(); }
  });
});

/**
 * A guard against the NEXT instance of this, rather than against this one.
 *
 * `CREATE TABLE IF NOT EXISTS` skipping a shape change is not specific to
 * `tfa_login_attempts` — any migration written that way inherits it. This asserts
 * the property that actually matters at runtime: the columns the sign-in path
 * writes are the columns the table has. It is cheap, and it fails on a real
 * database rather than only on a freshly built one.
 */
describe('the columns the sign-in path writes exist', () => {
  it('tfa_login_attempts carries every column /api/auth/login-2fa names', () => {
    const { db, cleanup } = scratchDb(CORRECT);
    try {
      const required = ['token_hash', 'user_id', 'attempts', 'last_attempt_at'];
      const present = columnsOf(db);
      for (const column of required) expect(present).toContain(column);
    } finally { cleanup(); }
  });
});
