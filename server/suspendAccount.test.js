import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const script = path.join(__dirname, '..', 'bin', 'suspend-account.mjs');

/**
 * `bin/suspend-account.mjs` — taking an account out of service from a shell.
 *
 * Before this existed, `bin/` could grant ownership, revoke it, promote an
 * administrator and clear a second factor, but could not stop an account from
 * working. The situation that needs it is the one where the web UI is not an
 * option: an account nobody should be holding, possibly the account of the
 * person you are locking out.
 *
 * The two properties worth proving are the two that are easy to get wrong. The
 * status change alone is NOT enough — `authenticateToken` re-reads the user on
 * every request and compares `token_version`, so without the bump a suspended
 * account keeps working on its existing cookie for up to seven days. And a
 * super administrator must be refused, because suspending the last one from a
 * shell leaves a platform with nobody able to undo it.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-suspend-test-'));
let dbPath;
let db;

beforeEach(async () => {
  dbPath = path.join(dir, `suspend-${Date.now()}-${Math.random()}.db`);

  const { DatabaseSync } = await import('node:sqlite');

  const init = spawnSync(process.execPath, ['-e', `
    process.env.WEV_DB_PATH = '${dbPath}';
    const { initDatabase, completeDatabaseInit } = require('./server/db.js');
    initDatabase();
    completeDatabaseInit().then(() => {});
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });

  /* Same reasoning as ownershipBootstrap.test.js: an unchecked child that dies
     before creating a table reports itself as "no such table: users" from the
     fixture, which points at the wrong line entirely. */
  if (init.status !== 0) {
    throw new Error(
      `database initialisation child failed (status ${init.status}).\n`
      + `stderr: ${init.stderr}\nstdout: ${init.stdout}`
    );
  }

  db = new DatabaseSync(dbPath);
  db.exec(`
    INSERT INTO users (id, name, username, email, password_hash, role, verified, account_status, grade, created_at, token_version)
    VALUES
    ('s1', 'Student', 's1', 'student@test.local', 'hash', 'student', 1, 'active', '11', '2000-01-01T00:00:00.000Z', 3),
    ('a1', 'Admin', 'a1', 'admin@test.local', 'hash', 'admin', 1, 'active', 'Adult', '2000-01-01T00:00:00.000Z', 1),
    ('p1', 'Super', 'p1', 'super@test.local', 'hash', 'super_admin', 1, 'active', 'Adult', '2000-01-01T00:00:00.000Z', 1),
    ('x1', 'Gone', 'x1', 'deleted@test.local', 'hash', 'student', 1, 'deleted', 'Adult', '2000-01-01T00:00:00.000Z', 1),
    ('z1', 'Already', 'z1', 'already@test.local', 'hash', 'student', 1, 'suspended', 'Adult', '2000-01-01T00:00:00.000Z', 1)
  `);
  db.exec(`UPDATE users SET suspension_reason = 'the original reason' WHERE id = 'z1'`);
});

function run(args, input = 'y\n') {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, WEV_DB_PATH: dbPath },
    input,
    encoding: 'utf-8',
  });
}

/* Awaited even though the handle is a synchronous `DatabaseSync`. Awaiting a
   non-promise is a no-op, so one spelling is right on both engines — and the
   fixture-debt ratchet in asyncShapes.test.js counts every unawaited
   `prepare()` chain precisely so new files do not add to the port. */
const row = async (id) => await db.prepare(
  'SELECT role, account_status, token_version, suspension_reason, suspended_by, suspended_at FROM users WHERE id = ?'
).get(id);

const audits = async () => await db.prepare(
  "SELECT action, target_user_id, details FROM admin_audit_logs WHERE action = 'ACCOUNT_SUSPENDED_CLI'"
).all();

describe('bin/suspend-account.mjs', () => {
  it('requires both an email and a reason', async () => {
    const res = run(['someone@test.local']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Usage: node bin\/suspend-account\.mjs/);
  });

  it('refuses an account that does not exist', async () => {
    const res = run(['nobody@test.local', 'a reason']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not found/);
  });

  it('suspends an ordinary account and records why', async () => {
    const res = run(['student@test.local', 'left the programme']);
    expect(res.status, res.stderr).toBe(0);

    const after = (await row('s1'));
    expect(after.account_status).toBe('suspended');
    expect(after.suspension_reason).toBe('left the programme');
    expect(after.suspended_by).toBe('system-cli');
    expect(after.suspended_at).toBeTruthy();

    const trail = (await audits());
    expect(trail).toHaveLength(1);
    expect(trail[0].target_user_id).toBe('s1');
    /* The subject and the role it held are in the trail, because "who was this"
       is unanswerable later from an id alone once the row has changed. */
    expect(trail[0].details).toMatch(/subject=student@test\.local/);
    expect(trail[0].details).toMatch(/previousRole=student/);
    expect(trail[0].details).toMatch(/left the programme/);
  });

  it('ends existing sessions rather than only blocking the next sign-in', async () => {
    /* The load-bearing half. `account_status` alone stops the next sign-in and
       leaves every issued cookie working until it expires — up to seven days of
       a suspended account continuing to act. */
    const before = (await row('s1')).token_version;
    const res = run(['student@test.local', 'a reason']);
    expect(res.status, res.stderr).toBe(0);
    expect((await row('s1')).token_version).toBe(before + 1);
  });

  it('refuses a super administrator and names the way round it', async () => {
    const res = run(['super@test.local', 'a reason']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/super administrator/i);
    /* An error that says only "refused" leaves the operator stuck. */
    expect(res.stderr).toMatch(/revoke-ownership\.mjs/);

    const after = (await row('p1'));
    expect(after.account_status).toBe('active');
    expect(after.role).toBe('super_admin');
  });

  it('leaves an already-suspended account alone, reason included', async () => {
    const res = run(['already@test.local', 'a different reason']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/already suspended/);
    /* Re-stamping would overwrite when and why the original suspension
       happened, which is the part of the record that matters. */
    expect((await row('z1')).suspension_reason).toBe('the original reason');
    expect((await audits())).toHaveLength(0);
  });

  it('treats a deleted account as already handled', async () => {
    const res = run(['deleted@test.local', 'a reason']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/already deleted/);
    expect((await row('x1')).account_status).toBe('deleted');
    expect((await audits())).toHaveLength(0);
  });

  it('changes nothing when the confirmation is declined', async () => {
    const before = (await row('a1'));
    const res = run(['admin@test.local', 'a reason'], 'N\n');
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Cancelled/);

    const after = (await row('a1'));
    expect(after.account_status).toBe('active');
    expect(after.token_version).toBe(before.token_version);
    expect((await audits())).toHaveLength(0);
  });
});
