import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * `bin/clear-stale-tfa-secret.mjs` — removing an authenticator secret that was
 * generated and never confirmed.
 *
 * ── The state ──
 *
 * `POST /api/2fa/generate` writes `users.tfa_secret` and leaves `tfa_enabled` at
 * 0, so abandoning the setup screen cannot lock anybody out. Nothing has ever
 * cleaned the column up, so an abandoned enrolment leaves an encrypted secret in
 * the row indefinitely. Two accounts on the pilot deployment were in that state,
 * both `super_admin`.
 *
 * The sign-in path no longer accepts it (`enabledSecondFactors` in
 * server/utils.js, and the `method_unavailable` refusal in authRoutes.js), so
 * this is data hygiene rather than a live vulnerability. It is still a real
 * credential sitting in a column nobody can see or remove through the product.
 *
 * ── What these tests are defending ──
 *
 * The blast radius, which is the only thing that makes this tool safe to point at
 * a production database:
 *
 *   1. **It refuses an ENABLED authenticator.** There the secret is the live
 *      factor; clearing it leaves the account demanding codes for a secret the
 *      server no longer holds — a lockout with recovery codes as the only way
 *      back. That is the exact failure `/api/2fa/generate`'s `already_enrolled`
 *      refusal exists to prevent, and it must not be reachable from a shell.
 *   2. **It changes one column on one row.** `reset-2fa.mjs` — the lockout
 *      remedy — additionally clears `tfa_email_enabled`, deletes every recovery
 *      code and bumps `token_version`. Every one of those is wrong for an account
 *      that is not locked out, and doing them here would take the working factor
 *      away from somebody who came for a cleanup.
 *   3. **It records what it did.** A privileged write to a credential column that
 *      leaves no trace is indistinguishable afterwards from tampering.
 */

const ROOT = process.cwd();
const SCRIPT_PATH = path.join(ROOT, 'bin', 'clear-stale-tfa-secret.mjs');

/**
 * Enough schema to exercise the script, in the shapes the real database uses:
 * `id` TEXT (so `'system-cli'` fits), the four 2FA columns, recovery codes and
 * the audit table the write shares its transaction with.
 */
function createTestDb(dir) {
  const dbPath = path.join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      account_status TEXT NOT NULL DEFAULT 'active',
      password_hash TEXT NOT NULL DEFAULT 'hash',
      token_version INTEGER NOT NULL DEFAULT 0,
      tfa_enabled INTEGER DEFAULT 0,
      tfa_secret TEXT,
      tfa_email_enabled INTEGER DEFAULT 0
    );
    CREATE TABLE recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ('${new Date().toISOString()}')
    );
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO users (id, email, role) VALUES ('system-cli', 'system-cli@wevolunteer.invalid', 'student')").run();
  return { dbPath, db };
}

/** An account in the state this tool exists for, unless overridden. */
function seedAccount(db, over = {}) {
  const row = {
    id: 'user-1',
    email: 'owner@school.org',
    role: 'super_admin',
    tfa_enabled: 0,
    tfa_secret: 'v1:aXY=:dGFn:Y2lwaGVy',
    tfa_email_enabled: 1,
    ...over
  };
  db.prepare(`
    INSERT INTO users (id, email, role, tfa_enabled, tfa_secret, tfa_email_enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.email, row.role, row.tfa_enabled, row.tfa_secret, row.tfa_email_enabled);

  for (let i = 0; i < 10; i++) {
    db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)')
      .run(`rc-${i}`, row.id, `hash-${i}`);
  }
  return row;
}

function runScript(dbPath, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
      env: { ...process.env, WEV_DB_PATH: dbPath }
    });
    return { code: 0, combined: stdout };
  } catch (err) {
    return {
      code: err.status ?? 1,
      combined: String(err.stdout || '') + String(err.stderr || '')
    };
  }
}

const withDb = (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clear-stale-tfa-'));
  const { dbPath, db } = createTestDb(dir);
  try {
    return fn({ dbPath, db });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const readUser = (db) =>
  db.prepare('SELECT tfa_enabled, tfa_secret, tfa_email_enabled, token_version, password_hash FROM users WHERE id = ?').get('user-1');

describe('bin/clear-stale-tfa-secret.mjs', () => {
  it('needs an address and a reason', () => withDb(({ dbPath }) => {
    const res = runScript(dbPath, ['owner@school.org']);
    expect(res.code).not.toBe(0);
    expect(res.combined).toContain('Usage: node bin/clear-stale-tfa-secret.mjs');
  }));

  it('refuses an address that matches no account', () => withDb(({ dbPath }) => {
    const res = runScript(dbPath, ['nobody@school.org', 'reason', '--yes']);
    expect(res.code).not.toBe(0);
    expect(res.combined).toMatch(/No account with the address/i);
  }));

  /* ── The refusal that makes it safe to point at production ─────────────── */

  it('REFUSES to clear the secret of an enabled authenticator', () => withDb(({ dbPath, db }) => {
    seedAccount(db, { tfa_enabled: 1 });

    const res = runScript(dbPath, ['owner@school.org', 'should not run', '--yes']);

    expect(res.code).not.toBe(0);
    expect(res.combined).toMatch(/ENABLED authenticator/i);
    /* And it names the command that IS right for that case, so the operator is
       not left guessing at the one moment they are most likely to improvise. */
    expect(res.combined).toContain('bin/reset-2fa.mjs');

    // The live factor is untouched.
    expect(readUser(db).tfa_secret).toBe('v1:aXY=:dGFn:Y2lwaGVy');
    expect(db.prepare('SELECT COUNT(*) n FROM admin_audit_logs').get().n).toBe(0);
  }));

  /* ── The blast radius ──────────────────────────────────────────────────── */

  it('clears the secret and nothing else', () => withDb(({ dbPath, db }) => {
    seedAccount(db);
    const before = readUser(db);

    const res = runScript(dbPath, ['owner@school.org', 'abandoned enrolment', '--yes']);
    expect(res.code, res.combined).toBe(0);

    const after = readUser(db);
    expect(after.tfa_secret).toBeNull();

    /**
     * Everything `reset-2fa.mjs` would also have changed, asserted unchanged.
     * This is the difference between a cleanup and an outage: the account here is
     * signing in with email codes, and `tfa_email_enabled = 0` would wall a
     * super_admin out of every administrative page until they re-enrolled.
     */
    expect(after.tfa_enabled).toBe(before.tfa_enabled);
    expect(after.tfa_email_enabled).toBe(1);
    expect(after.token_version, 'sessions were ended').toBe(before.token_version);
    expect(after.password_hash).toBe(before.password_hash);
    expect(db.prepare('SELECT COUNT(*) n FROM recovery_codes').get().n, 'recovery codes destroyed').toBe(10);
  }));

  it('records what it did, against the reserved CLI actor', () => withDb(({ dbPath, db }) => {
    seedAccount(db);
    runScript(dbPath, ['owner@school.org', 'abandoned enrolment', '--yes']);

    const row = db.prepare('SELECT * FROM admin_audit_logs').get();
    expect(row.action).toBe('TFA_STALE_SECRET_CLEARED');
    expect(row.admin_id).toBe('system-cli');
    expect(row.target_user_id).toBe('user-1');
    expect(row.details).toContain('command=bin/clear-stale-tfa-secret.mjs');
    expect(row.details).toContain('reason=abandoned enrolment');

    /* A distinct action from TFA_RESET_CLI. They have very different meanings —
       one removes a factor somebody was using — and a reader of the trail must
       not have to open the source to tell them apart. */
    expect(row.action).not.toBe('TFA_RESET_CLI');
  }));

  it('is a successful no-op when there is nothing to clear', () => withDb(({ dbPath, db }) => {
    seedAccount(db, { tfa_secret: null });

    const res = runScript(dbPath, ['owner@school.org', 'already clean', '--yes']);

    /* Exit 0, so running this across several accounts does not abort on the ones
       that are already in the desired state. */
    expect(res.code).toBe(0);
    expect(res.combined).toMatch(/no stored authenticator secret/i);
    expect(db.prepare('SELECT COUNT(*) n FROM admin_audit_logs').get().n, 'a no-op wrote an audit row').toBe(0);
  }));

  it('leaves other accounts alone', () => withDb(({ dbPath, db }) => {
    seedAccount(db);
    db.prepare(`
      INSERT INTO users (id, email, role, tfa_enabled, tfa_secret, tfa_email_enabled)
      VALUES ('user-2', 'other@school.org', 'student', 0, 'v1:other:secret:here', 1)
    `).run();

    runScript(dbPath, ['owner@school.org', 'scoped', '--yes']);

    expect(db.prepare("SELECT tfa_secret FROM users WHERE id = 'user-2'").get().tfa_secret)
      .toBe('v1:other:secret:here');
  }));
});
