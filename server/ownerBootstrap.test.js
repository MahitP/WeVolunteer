import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';

/**
 * `bin/bootstrap-owners.mjs` — the only way an owner account comes into being.
 *
 * ── What is actually being tested ──
 *
 * Not that it writes a row. That it writes a row nobody can sign into.
 *
 * The owner's instruction was "create them with bcrypt password hashes" and
 * "do not expose the passwords anywhere", and those only reconcile one way: the
 * account gets a real hash of a random value that is generated in memory and
 * dropped, so no preimage exists anywhere in the world and the account is
 * unusable until its owner proves control of the mailbox through the reset
 * flow. A test that only checked `role = 'super_admin'` would pass just as
 * happily against a script that used a default password.
 */

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'bin/bootstrap-owners.mjs');

let dbPath;
let db;

const EMAIL = 'bootstrap-test-owner@example.invalid';
const SECOND = 'bootstrap-test-second@example.invalid';

/* The addresses this file bootstraps. Ownership is limited to
   PLATFORM_OWNER_EMAILS, so the fixture names them as an operator would. */
const FIXTURE_OWNERS = [EMAIL, SECOND, 'declined-owner@example.invalid', 'squatted-owner@example.invalid'].join(',');

const run = (args, input = 'y\n') => execFileSync('node', [SCRIPT, ...args], {
  env: { ...process.env, WEV_DB_PATH: dbPath, PLATFORM_OWNER_EMAILS: FIXTURE_OWNERS },
  input,
  encoding: 'utf8',
});

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-owner-boot-'));
  dbPath = path.join(dir, 'boot.db');
  process.env.WEV_DB_PATH = dbPath;
  const mod = await import('./db.js');
  mod.initDatabase();
  await mod.completeDatabaseInit();
  db = new DatabaseSync(dbPath);
}, 60000);

const owner = (email) => db.prepare(
  'SELECT id, role, verified, email_verified, account_status, password_hash FROM users WHERE email = ?'
).get(email);

describe('bootstrap-owners.mjs', () => {
  it('creates an account that is an owner, verified, and active', () => {
    run([EMAIL]);
    const row = owner(EMAIL);
    expect(row).toBeDefined();
    expect(row.role).toBe('super_admin');
    expect(row.verified).toBe(1);
    expect(row.email_verified).toBe(1);
    expect(row.account_status).toBe('active');
  });

  /**
   * A real bcrypt hash, and deliberately not the OAUTH_ONLY sentinel.
   *
   * The sentinel would make sign-in say "this account signs in with Google",
   * pointing the owner at a button connected to nothing. A real hash produces
   * the ordinary "incorrect password" and the ordinary reset path.
   */
  it('stores a genuine bcrypt hash rather than a sentinel or a blank', () => {
    const { password_hash: hash } = owner(EMAIL);
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(hash).toHaveLength(60);
    expect(hash).not.toContain('OAUTH_ONLY');
  });

  /**
   * The assertion this file exists for.
   *
   * Every password a person might reasonably have chosen, and every password
   * this repository has ever used in a fixture, must fail against it. The
   * seeded owner removed in v1.2.0 used `password123`, and it is checked by
   * name: that exact value passing here would mean the bootstrap had quietly
   * reintroduced the account whose credentials are in the git history.
   */
  it('sets a password nobody knows — no plausible guess opens it', () => {
    const { password_hash: hash } = owner(EMAIL);
    for (const guess of [
      'password123', 'password', 'Password123!', 'owner', 'admin',
      'wevolunteer', 'changeme', '', EMAIL, 'super_admin',
    ]) {
      expect(
        bcrypt.compareSync(guess, hash),
        `"${guess}" opens the bootstrapped owner account`
      ).toBe(false);
    }
  });

  /** Two runs of the same address must not mint a second owner or reset the first. */
  it('is idempotent', () => {
    const before = owner(EMAIL);
    const out = run([EMAIL]);
    const after = owner(EMAIL);
    expect(out).toMatch(/already an owner/i);
    expect(after.id).toBe(before.id);
    expect(after.password_hash).toBe(before.password_hash);
  });

  /**
   * Promotion keeps the existing credential. Somebody already signs in with that
   * account, and replacing their password during a promotion would lock them out
   * of the very account being promoted.
   */
  it('promotes an existing account without touching its password', () => {
    const now = new Date().toISOString();
    const knownHash = bcrypt.hashSync('their-own-password', 10);
    db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified,
                         email_verified, account_status, created_at, token_version)
      VALUES ('u-promote', 'Existing Person', ?, 'existingperson', ?, '11', 'student', 1, 1, 'active', ?, 0)
    `).run(SECOND, knownHash, now);

    run([SECOND]);

    const row = owner(SECOND);
    expect(row.role).toBe('super_admin');
    expect(row.id).toBe('u-promote');
    expect(
      bcrypt.compareSync('their-own-password', row.password_hash),
      'promotion replaced the credential of an account somebody already uses'
    ).toBe(true);
  });

  /** Q3: every ownership change is on the record, and says it came from a shell. */
  it('records an OWNER_GRANTED audit row naming the method', () => {
    const row = db.prepare(
      "SELECT action, details FROM admin_audit_logs WHERE action = 'OWNER_GRANTED' ORDER BY created_at DESC"
    ).get();
    expect(row).toBeDefined();
    expect(row.details).toContain('method=CLI');
    expect(row.details).toContain('operator=');
  });

  it('does nothing at all when the confirmation is not given', () => {
    const before = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'super_admin'").get().c;
    run(['declined-owner@example.invalid'], 'n\n');
    const after = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'super_admin'").get().c;
    expect(after).toBe(before);
    expect(owner('declined-owner@example.invalid')).toBeUndefined();
  });

  /**
   * The addresses of the real owners must not be in the repository. The script
   * takes them as arguments for exactly this reason, and a future edit that
   * "helpfully" defaults them would undo it silently.
   */
  it('hardcodes no email address of its own', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const addresses = src.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
    const real = addresses.filter(a => !a.endsWith('.invalid') && !a.includes('example'));
    expect(real, 'an owner address is written into the script').toEqual([]);
  });
});


describe('bootstrap-owners and the owner allowlist', () => {
  it('refuses the whole run when any address is off the list, and changes nothing', () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'").get().n;
    let out = '';
    try {
      execFileSync('node', [SCRIPT, EMAIL, 'stranger@example.invalid'], {
        env: { ...process.env, WEV_DB_PATH: dbPath, PLATFORM_OWNER_EMAILS: EMAIL },
        input: 'y\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      out = String(err.stderr);
      expect(err.status).toBe(1);
    }
    expect(out).toMatch(/stranger@example\.invalid is not one of the platform's owner addresses/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'").get().n).toBe(before);
    expect(db.prepare("SELECT 1 FROM users WHERE email = 'stranger@example.invalid'").get()).toBeUndefined();
  });
});

describe('bootstrap-owners and an address nobody has confirmed', () => {
  it('refuses to promote an existing account whose address was never confirmed', () => {
    db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified,
                         email_verified, account_status, created_at, token_version)
      VALUES ('u-squat', 'Got There First', 'squatted-owner@example.invalid', 'gotthere', ?, '11', 'student', 1, 0, 'active', ?, 0)
    `).run(bcrypt.hashSync('squatters-password', 10), new Date().toISOString());

    let stderr = '';
    try {
      run(['squatted-owner@example.invalid']);
    } catch (err) {
      stderr = String(err.stderr);
      expect(err.status).toBe(1);
    }
    expect(stderr).toMatch(/has never been confirmed/);
    const row = db.prepare("SELECT role, email_verified FROM users WHERE id = 'u-squat'").get();
    expect(row.role).toBe('student');
    expect(row.email_verified).toBe(0);
  });
});
