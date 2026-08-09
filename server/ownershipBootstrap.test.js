import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const grantScript = path.join(__dirname, '..', 'bin', 'grant-ownership.mjs');
const revokeScript = path.join(__dirname, '..', 'bin', 'revoke-ownership.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-ownership-test-'));
let dbPath;
let db;

beforeEach(async () => {
  dbPath = path.join(dir, `audit-${Date.now()}-${Math.random()}.db`);
  process.env.WEV_DB_PATH = dbPath;

  // Import db.js dynamically to get a fresh instance if possible, 
  // but since it's cached we must directly instantiate a new DatabaseSync
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(dbPath);

  // Run migrations manually for this fresh file
  const { initDatabase } = await import('./db.js');
  
  // initDatabase creates tables on the cached db instance, so we can't use it directly if cached.
  // Actually, we can just run a child process to initialize the DB!
  const init = spawnSync(process.execPath, ['-e', `
    process.env.WEV_DB_PATH = '${dbPath}';
    const { initDatabase } = require('./server/db.js');
    initDatabase();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });

  /**
   * The child's exit status is CHECKED, because it silently was not.
   *
   * When `db.js` briefly acquired a top-level `await` in its module graph — via a
   * new import of `scripts/seed_badges.js`, whose CLI guard used one — this
   * `require()` started failing with `ERR_REQUIRE_ASYNC_MODULE`. The child died
   * before creating a single table, nothing looked at that, and all nine cases
   * below failed with `no such table: users`: a message that points at the
   * fixture on line 37 and says nothing about the child process on line 30.
   *
   * Asserting the status here turns a five-minute hunt into the actual error.
   */
  if (init.status !== 0) {
    throw new Error(
      `database initialisation child failed (status ${init.status}).\n`
      + `stderr: ${init.stderr}\nstdout: ${init.stdout}`
    );
  }

  db.exec(`
    INSERT INTO users (id, name, username, email, password_hash, role, verified, account_status, grade, created_at, token_version)
    VALUES 
    ('u1', 'User 1', 'u1', 'u1@test.local', 'hash', 'student', 1, 'active', 'Adult', '2000-01-01T00:00:00.000Z', 1),
    ('u2', 'User 2', 'u2', 'unverified@test.local', 'hash', 'student', 0, 'active', 'Adult', '2000-01-01T00:00:00.000Z', 1),
    ('u3', 'User 3', 'u3', 'suspended@test.local', 'hash', 'student', 1, 'suspended', 'Adult', '2000-01-01T00:00:00.000Z', 1),
    ('u4', 'User 4', 'u4', 'admin@test.local', 'hash', 'admin', 1, 'active', 'Adult', '2000-01-01T00:00:00.000Z', 1),
    ('u5', 'User 5', 'u5', 'super1@test.local', 'hash', 'super_admin', 1, 'active', 'Adult', '2000-01-01T00:00:00.000Z', 1),
    ('u6', 'User 6', 'u6', 'super2@test.local', 'hash', 'super_admin', 1, 'active', 'Adult', '2000-01-01T00:00:00.000Z', 1)
  `);
});

function runCli(scriptPath, args, input = 'y\n') {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, WEV_DB_PATH: dbPath },
    input,
    encoding: 'utf-8'
  });
}

describe('bin/grant-ownership.mjs', () => {
  it('refuses to grant if user is missing', () => {
    const res = runCli(grantScript, ['nobody@test.local', 'reason']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not found/);
  });

  it('refuses to grant if user is unverified', () => {
    const res = runCli(grantScript, ['unverified@test.local', 'reason']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not verified/);
  });

  it('refuses to grant if user is not active', () => {
    const res = runCli(grantScript, ['suspended@test.local', 'reason']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not active/);
  });

  it('ignores if user is already super_admin', () => {
    const res = runCli(grantScript, ['super1@test.local', 'reason']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/already a super administrator/);
  });

  it('cancels if user types N', () => {
    const res = runCli(grantScript, ['u1@test.local', 'reason'], 'N\n');
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Cancelled/);
    
    const user = db.prepare('SELECT role FROM users WHERE email = ?').get('u1@test.local');
    expect(user.role).toBe('student');
  });

  it('grants ownership, invalidates token, and records audit on success', () => {
    const res = runCli(grantScript, ['admin@test.local', 'Promotion reasoning'], 'y\n');
    expect(res.status).toBe(0);

    const user = db.prepare('SELECT role, token_version FROM users WHERE email = ?').get('admin@test.local');
    expect(user.role).toBe('super_admin');
    expect(user.token_version).toBe(2);

    const audit = db.prepare('SELECT action, details, admin_id, target_user_id FROM admin_audit_logs WHERE target_user_id = ?').get('u4');
    expect(audit.action).toBe('OWNER_GRANTED');
    /**
     * The details are structured, not the bare reason.
     *
     * `method=CLI` leads because it is the fact that changes how the rest of the
     * row is read: there is no product path to ownership, so a row that does not
     * say where the change came from leaves its single most useful fact out.
     *
     * The ACTOR is asserted too, and it is the part that changed.
     *
     * These rows used to record the subject as the actor, because
     * `admin_audit_logs.admin_id` is a foreign key to `users` and a shell
     * operator has no account. Read alone, a bootstrap row therefore said "this
     * person granted themselves ownership" — not what happened, and worse,
     * `admin_id` is the field a report groups by, so every CLI action was
     * attributed to its own subject.
     *
     * Migration 022 seeds `system-cli` for exactly this, so the actor and the
     * target are now different rows and neither is a lie.
     */
    expect(audit.admin_id).toBe('system-cli');
    expect(audit.admin_id).not.toBe(audit.target_user_id);
    expect(audit.details).toContain('method=CLI');
    expect(audit.details).toContain('command=bin/grant-ownership.mjs');
    expect(audit.details).toContain('operator=');
    expect(audit.details).toContain('reason=Promotion reasoning');
  });
});

describe('bin/revoke-ownership.mjs', () => {
  it('refuses if user is not a super_admin', () => {
    const res = runCli(revokeScript, ['admin@test.local', 'reason']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/not a super administrator/);
  });

  it('refuses to revoke if they are the ONLY super_admin', () => {
    // Delete the second super_admin so only one remains
    db.prepare("DELETE FROM users WHERE email = 'super2@test.local'").run();

    const res = runCli(revokeScript, ['super1@test.local', 'reason']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/last remaining super_admin/);
  });

  it('revokes ownership if there is more than one super_admin', () => {
    const res = runCli(revokeScript, ['super1@test.local', 'Retiring'], 'y\n');
    expect(res.status).toBe(0);

    const user = db.prepare('SELECT role, token_version FROM users WHERE email = ?').get('super1@test.local');
    expect(user.role).toBe('admin');
    expect(user.token_version).toBe(2);

    const audit = db.prepare('SELECT action, details, admin_id, target_user_id FROM admin_audit_logs WHERE target_user_id = ?').get('u5');
    expect(audit.action).toBe('OWNER_REVOKED');
    expect(audit.details).toContain('method=CLI');
    expect(audit.details).toContain('operator=');
    expect(audit.details).toContain('reason=Retiring');
  });
});
