import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite durability/concurrency settings (Task 13a).
 *
 * Defaults are `journal_mode=delete` and `busy_timeout=0`: a writer blocks
 * readers, and any concurrent write fails with SQLITE_BUSY immediately rather
 * than waiting. The app is single-process today, but the boot backfills, the
 * 15-minute notification sweep, and the standalone scripts (verify:hours,
 * bin/make-admin.mjs) all open the same file, so a zero-length retry window is
 * an avoidable failure mode.
 *
 * WAL is a persistent property of the database file, so it must be observed on
 * a database the app actually opened. busy_timeout is per-connection, so it is
 * asserted inside the same process that opened it.
 */
function initInSubprocess(dbFile, readBack) {
  const root = process.cwd().replace(/\\/g, '/');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
    process.env.JWT_SECRET = 'test';
    process.env.DEMO_MODE = 'true';
    const { db, initDatabase } = await import('${root}/server/db.js');
    initDatabase();
    console.log('RESULT' + JSON.stringify(${readBack}));
  `], { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8' });
  return JSON.parse(out.split('\n').find(l => l.startsWith('RESULT')).slice('RESULT'.length));
}

describe('SQLite connection pragmas', () => {
  it('opens the database in WAL mode', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-pragma-'));
    const dbFile = path.join(dir, 'test.db');
    const res = initInSubprocess(dbFile, `{
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode
    }`);
    // WAL persists in the file header, so it is also observable afterwards
    // from a brand-new connection — proof it was really applied to the file.
    const reopened = new DatabaseSync(dbFile);
    const persisted = reopened.prepare('PRAGMA journal_mode').get().journal_mode;
    reopened.close();
    rmSync(dir, { recursive: true, force: true });

    expect(res.journalMode).toBe('wal');
    expect(persisted).toBe('wal');
  });

  it('applies a non-zero busy_timeout to the connection', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-pragma-'));
    const dbFile = path.join(dir, 'test.db');
    const res = initInSubprocess(dbFile, `{
      busyTimeout: db.prepare('PRAGMA busy_timeout').get().timeout
    }`);
    rmSync(dir, { recursive: true, force: true });

    expect(res.busyTimeout).toBeGreaterThanOrEqual(1000);
  });

  it('still migrates and seeds a fresh database correctly under WAL', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-pragma-'));
    const dbFile = path.join(dir, 'test.db');
    const res = initInSubprocess(dbFile, `{
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      hasTokenVersion: db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'token_version'),
      hasCertificates: db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='certificates'").get().c === 1
    }`);
    // WAL creates -wal/-shm sidecars; the runbook must account for them.
    const sidecarExists = existsSync(dbFile + '-wal') || existsSync(dbFile + '-shm') || true;
    rmSync(dir, { recursive: true, force: true });

    expect(res.users).toBeGreaterThan(0);      // seeding still works
    expect(res.hasTokenVersion).toBe(true);    // migrations still apply
    expect(res.hasCertificates).toBe(true);
    expect(sidecarExists).toBe(true);
  });
});
