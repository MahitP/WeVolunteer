import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', 'schema-check.mjs');

const run = (target) => spawnSync(process.execPath, [SCRIPT, target], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_ENGINE: 'sqlite', DATABASE_URL: '', DEMO_MODE: '' },
  encoding: 'utf8',
});

/**
 * The 2FA outage, reproduced in miniature.
 *
 * pilot.db carried a `tfa_login_attempts` table created outside the migration
 * system, keyed on `preauth_jti`. Migration 025's `CREATE TABLE IF NOT EXISTS`
 * saw a table of that name and did nothing, so `INSERT … ON CONFLICT(token_hash)`
 * threw on every second-factor sign-in, by every method. No test could see it,
 * because every test builds a fresh database. This is the check that can.
 */
describe('bin/schema-check.mjs', () => {
  let clean;

  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-schema-check-'));
    clean = path.join(dir, 'clean.db');
    /* A database built by the migrations themselves, so the check is compared
       against exactly what it builds as its reference. */
    const init = spawnSync(process.execPath, ['--input-type=module', '-e', `
      process.env.WEV_DB_PATH = ${JSON.stringify(clean)};
      process.env.DATABASE_ENGINE = 'sqlite';
      process.env.DEMO_MODE = '';
      const { initDatabase, completeDatabaseInit } = await import('./server/db.js');
      initDatabase();
      await completeDatabaseInit();
    `], { cwd: ROOT, encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
  }, 120_000);

  it('reports a database built by the migrations as matching', () => {
    const res = run(clean);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toMatch(/matches what the migrations build/);
  });

  it('reports a table whose unique key differs from the migrations — the 2FA outage', () => {
    const drifted = clean.replace('clean.db', 'drifted.db');
    copyFileSync(clean, drifted);
    const db = new DatabaseSync(drifted);
    db.exec(`DROP TABLE tfa_login_attempts;
             CREATE TABLE tfa_login_attempts (preauth_jti TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0);`);
    db.close();

    const res = run(drifted);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/tfa_login_attempts/);
    expect(res.stdout).toMatch(/token_hash/);
  });

  it('opens the target read-only', () => {
    const before = new DatabaseSync(clean, { readOnly: true });
    const n = before.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n;
    before.close();
    run(clean);
    const after = new DatabaseSync(clean, { readOnly: true });
    expect(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n).toBe(n);
    after.close();
  });
});
