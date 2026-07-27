import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Upgrade regression guard (P1-A).
 *
 * When email_verified is added to an EXISTING database, every current account
 * must become verified — otherwise turning REQUIRE_EMAIL_VERIFICATION on would
 * lock every existing user out behind a wall they never had a token for. The
 * backfill must therefore run regardless of the flag, and only on the one-time
 * column addition.
 *
 * initDatabase opens the database at module load, so each scenario runs in its
 * own subprocess to get a clean module registry.
 */
function initAgainst(dbFile, env) {
  const root = process.cwd().replace(/\\/g, '/');
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
    process.env.JWT_SECRET = 'test';
    ${Object.entries(env).map(([k, v]) => `process.env.${k} = ${JSON.stringify(v)};`).join('\n')}
    const { initDatabase } = await import('${root}/server/db.js');
    initDatabase();
  `], { cwd: process.cwd(), stdio: 'pipe' });
}

/** Builds a pre-feature database: users table without email_verified, one row. */
function makeLegacyDb(dir) {
  const dbFile = path.join(dir, 'legacy.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      grade TEXT CHECK(grade IN ('9','10','11','12','Adult','N/A')) NOT NULL,
      role TEXT CHECK(role IN ('student','organizer','admin')) NOT NULL,
      verified INTEGER DEFAULT 1, avatar TEXT, bio TEXT, school TEXT, skills TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT INTO users (id, name, email, password_hash, grade, role, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-1', 'Legacy Student', 'legacy@school.test', 'x', '10', 'student', new Date().toISOString());
  db.close();
  return dbFile;
}

const verifiedOf = (dbFile, id) => {
  const db = new DatabaseSync(dbFile);
  const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(id);
  db.close();
  return row.email_verified;
};

describe('email_verified upgrade backfill (P1-A)', () => {
  it('verifies existing users when the column is added with verification REQUIRED', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-ev-on-'));
    const dbFile = makeLegacyDb(dir);
    initAgainst(dbFile, { REQUIRE_EMAIL_VERIFICATION: 'true' });
    const result = verifiedOf(dbFile, 'legacy-1');
    rmSync(dir, { recursive: true, force: true });
    expect(result).toBe(1);
  });

  it('verifies existing users when the column is added with verification OFF', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-ev-off-'));
    const dbFile = makeLegacyDb(dir);
    initAgainst(dbFile, {});
    const result = verifiedOf(dbFile, 'legacy-1');
    rmSync(dir, { recursive: true, force: true });
    expect(result).toBe(1);
  });

  it('does not re-verify a genuinely unverified signup on a later boot with the flag ON', () => {
    // Second boot with the flag on must not reach back and verify someone who
    // signed up unverified after the column already existed.
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-ev-keep-'));
    const dbFile = makeLegacyDb(dir);
    initAgainst(dbFile, { REQUIRE_EMAIL_VERIFICATION: 'true' });

    // Simulate a post-migration unverified signup.
    let db = new DatabaseSync(dbFile);
    db.prepare(`INSERT INTO users (id, name, email, password_hash, grade, role, email_verified, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
      .run('new-1', 'New Signup', 'new@school.test', 'x', '10', 'student', new Date().toISOString());
    db.close();

    initAgainst(dbFile, { REQUIRE_EMAIL_VERIFICATION: 'true' });
    const result = verifiedOf(dbFile, 'new-1');
    rmSync(dir, { recursive: true, force: true });
    expect(result).toBe(0);
  });
});
