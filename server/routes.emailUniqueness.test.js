import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './testServer.js';

/**
 * F-11: email uniqueness must be case-insensitive, on write and on lookup,
 * with pre-existing case-variant duplicates reconciled non-destructively.
 */
describe('case-insensitive email uniqueness (API)', () => {
  let srv;

  beforeAll(async () => {
    srv = await startTestServer();
  });

  afterAll(async () => {
    await srv.close();
  });

  const signup = (email, overrides = {}) => srv.call('POST', '/api/auth/signup', {
    email, password: 'password123', name: 'Test User',
    username: `u${Math.random().toString(36).slice(2, 9)}`,
    role: 'student', grade: '10',
    ...overrides
  });

  it('refuses a case-variant duplicate signup with 400 naming email', async () => {
    const first = await signup('alex@x.com');
    expect(first.status).toBe(201);

    const second = await signup('ALEX@x.com');
    expect(second.status).toBe(400);
    expect(second.body.error.toLowerCase()).toContain('email');
  });

  it('lets a mixed-case signup log in with any casing of the same address', async () => {
    const su = await signup('MixedCase@Example.com');
    expect(su.status).toBe(201);

    const tokenLower = await srv.login('mixedcase@example.com');
    expect(tokenLower).toBeTruthy();

    const tokenUpper = await srv.login('MIXEDCASE@EXAMPLE.COM');
    expect(tokenUpper).toBeTruthy();
  });

  it('normalises a signup email (trim + lowercase) on write', async () => {
    const su = await signup('Trim@Example.com ');
    expect(su.status).toBe(201);
    expect(su.body.user.email).toBe('trim@example.com');

    const me = await srv.call('GET', '/api/auth/me', undefined, su.cookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('trim@example.com');
  });
});

/**
 * Migration tests run in a subprocess (clean module registry, throwaway
 * WEV_DB_PATH) since initDatabase() opens its database at module load —
 * following the pattern in routes.emailVerifiedMigration.test.js.
 */
function initAgainst(dbFile, env = {}) {
  const root = process.cwd().replace(/\\/g, '/');
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
    ${Object.entries(env).map(([k, v]) => `process.env.${k} = ${JSON.stringify(v)};`).join('\n')}
    const { initDatabase } = await import('${root}/server/db.js');
    initDatabase();
  `], { cwd: process.cwd(), stdio: 'pipe' });
}

/**
 * Builds a pre-existing database with a case-variant email collision:
 * - dup-low  (dup@x.com)       has fewer credited hours -> should be renamed
 * - dup-high (DUP@x.com)       has more credited hours  -> survivor, unchanged
 * Both have an attendance row so data-loss can be asserted against.
 */
function makeDuplicateDb(dir) {
  const dbFile = path.join(dir, 'dupes.db');
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
    CREATE TABLE events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      category TEXT, location TEXT NOT NULL, application_deadline TEXT NOT NULL,
      organizer_id TEXT NOT NULL, status TEXT DEFAULT 'open', auto_approve INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE slots (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
      start_datetime TEXT NOT NULL, end_datetime TEXT NOT NULL, max_spots INTEGER NOT NULL
    );
    CREATE TABLE attendance (
      event_id TEXT NOT NULL, slot_id TEXT NOT NULL, user_id TEXT NOT NULL,
      present INTEGER NOT NULL, hours_awarded REAL NOT NULL,
      PRIMARY KEY(slot_id, user_id)
    );
  `);

  db.prepare(`INSERT INTO users (id, name, email, password_hash, grade, role, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('dup-low', 'Low Hours Dup', 'dup@x.com', 'x', '10', 'student', '2020-01-01T00:00:00.000Z');
  db.prepare(`INSERT INTO users (id, name, email, password_hash, grade, role, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('dup-high', 'High Hours Dup', 'DUP@x.com', 'x', '10', 'student', '2020-01-02T00:00:00.000Z');

  db.prepare(`INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('ev-1', 'Event', 'desc', 'Other', 'Loc', '2026-01-01T00:00:00.000Z', 'dup-high', '2020-01-01T00:00:00.000Z');
  db.prepare(`INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('slot-1', 'ev-1', 'Slot', 'desc', '2020-01-01T00:00:00.000Z', '2020-01-01T02:00:00.000Z', 5);

  db.prepare(`INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)`)
    .run('ev-1', 'slot-1', 'dup-low', 1, 1.0);
  db.prepare(`INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)`)
    .run('ev-1', 'slot-1', 'dup-high', 1, 9.0);

  db.close();
  return dbFile;
}

function readState(dbFile) {
  const db = new DatabaseSync(dbFile);
  const users = db.prepare('SELECT rowid, id, email, token_version FROM users ORDER BY id').all();
  const attendance = db.prepare('SELECT user_id, hours_awarded FROM attendance ORDER BY user_id').all();
  const indexes = db.prepare('PRAGMA index_list(users)').all();
  db.close();
  return { users, attendance, indexes };
}

describe('email dedupe migration (F-11, defensive/no data loss)', () => {
  it('keeps the higher-hours account unchanged, renames the other, bumps its token_version, adds the index, and touches no attendance row', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-email-dedupe-'));
    const dbFile = makeDuplicateDb(dir);

    initAgainst(dbFile);

    const { users, attendance, indexes } = readState(dbFile);

    const survivor = users.find(u => u.id === 'dup-high');
    const renamed = users.find(u => u.id === 'dup-low');

    expect(survivor.email).toBe('DUP@x.com'); // unchanged
    expect(survivor.token_version).toBe(0);

    expect(renamed.email).toContain('+dup-');
    expect(renamed.email).toMatch(/^dup\+dup-\d+@x\.com$/);
    expect(renamed.token_version).toBe(1);

    // Neither account was deleted.
    expect(users.length).toBe(2);

    // Neither attendance row was touched or lost.
    expect(attendance.length).toBe(2);
    expect(attendance.find(a => a.user_id === 'dup-low').hours_awarded).toBe(1.0);
    expect(attendance.find(a => a.user_id === 'dup-high').hours_awarded).toBe(9.0);

    expect(indexes.some(i => i.name === 'idx_users_email_nocase')).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent: a second initDatabase() run changes nothing further and does not error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-email-dedupe-idem-'));
    const dbFile = makeDuplicateDb(dir);

    initAgainst(dbFile);
    const after1 = readState(dbFile);

    expect(() => initAgainst(dbFile)).not.toThrow();
    const after2 = readState(dbFile);

    expect(after2.users).toEqual(after1.users);
    expect(after2.attendance).toEqual(after1.attendance);
    expect(after2.users.length).toBe(2);

    rmSync(dir, { recursive: true, force: true });
  });
});
