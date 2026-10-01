import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', 'seed-qa-profile.mjs');

/**
 * `seed-qa-profile.mjs` writes attendance and credited hours straight into a
 * database. It decided what it may touch by FILENAME — it refused `pilot.db`,
 * `production.db` and `wevolunteer.db` — so a copy of real data under any other
 * name went through: the repository root holds `pilot-backup-20260808-225321.db`
 * and `pilot.db.backup-…` files carrying the same minors' records.
 *
 * Real data is recognised by what it contains (an owner account, a deleted
 * account's tombstone, an administrative audit record), which is what the shared
 * guard in `bin/lib/db-safety.mjs` checks. This pins the script to it.
 */
describe('bin/seed-qa-profile.mjs refuses real data by content, not by name', () => {
  it('refuses a database holding an owner account, whatever the file is called', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-qa-seed-guard-'));
    const dbPath = path.join(dir, 'pilot-backup-20260808-225321.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, account_status TEXT);
             INSERT INTO users VALUES ('owner-1', 'owner@example.org', 'super_admin', 'active');`);
    db.close();

    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, WEV_DB_PATH: dbPath, DATABASE_ENGINE: 'sqlite', DATABASE_URL: '', NODE_ENV: 'development' },
      encoding: 'utf8',
    });

    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stderr).toMatch(/REFUSING/);
    expect(res.stderr).toMatch(/owner \(super_admin\) account/);

    const after = new DatabaseSync(dbPath, { readOnly: true });
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name);
    after.close();
    expect(tables, 'the guard ran before anything was written').toEqual(['users']);
  });
});
