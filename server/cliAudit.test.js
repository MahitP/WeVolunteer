import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * One audit mechanism for every privileged command-line action.
 *
 * ── What was wrong ──
 *
 * The two ownership scripts had their own `details` format and recorded the
 * SUBJECT as the actor, because `admin_audit_logs.admin_id` is a foreign key to
 * `users` and a shell operator has no account. So a bootstrap row read "this
 * person granted themselves ownership" — and since `admin_id` is the field a
 * report groups by, every CLI action was attributed to its own subject.
 *
 * `bin/make-admin.mjs` was worse: it wrote nothing at all. Administrator
 * promotion was the only privilege change on this platform that left no trace,
 * while every in-product administrative action — down to reading a report — was
 * recorded. The gap was invisible because the script worked.
 *
 * Migration 022 seeds a reserved `system-cli` account so the actor and the
 * target are different rows and neither is a lie.
 */

const ROOT = process.cwd();
let dbPath, db;

const run = (script, args, input = '') => execFileSync(
  'node', [path.join(ROOT, script), ...args],
  /* `cli-u3` is promoted below; ownership is limited to PLATFORM_OWNER_EMAILS. */
  { env: { ...process.env, WEV_DB_PATH: dbPath, PLATFORM_OWNER_EMAILS: 'cli-u3@example.invalid' }, input, encoding: 'utf8' }
);

const addUser = (id, email, role = 'student') => {
  db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role, verified,
                       email_verified, account_status, created_at, token_version)
    VALUES (?, ?, ?, ?, ?, '11', ?, 1, 1, 'active', ?, 0)
  `).run(id, `Person ${id}`, email, id, bcrypt.hashSync('x', 10), role, new Date().toISOString());
};

const auditFor = (targetId) => db.prepare(
  'SELECT action, details, admin_id, target_user_id FROM admin_audit_logs WHERE target_user_id = ? ORDER BY created_at DESC'
).get(targetId);

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-cliaudit-'));
  dbPath = path.join(dir, 'cli.db');
  process.env.WEV_DB_PATH = dbPath;
  const mod = await import('./db.js');
  mod.initDatabase();
  await mod.completeDatabaseInit();
  db = new DatabaseSync(dbPath);
}, 60000);

describe('the reserved system-cli actor', () => {
  it('exists after migrations, and cannot be signed into', () => {
    const row = db.prepare(
      'SELECT id, role, account_status, password_hash, email FROM users WHERE id = ?'
    ).get('system-cli');

    expect(row).toBeDefined();
    /* `authenticateToken` refuses a deleted account before it looks at anything
       else, so this is the state that makes the row inert. */
    expect(row.account_status).toBe('deleted');
    expect(row.role).toBe('student');
    /* Not a bcrypt hash at all, so no candidate can ever compare equal. */
    expect(row.password_hash).not.toMatch(/^\$2[aby]\$/);
    expect(bcrypt.compareSync('', row.password_hash)).toBe(false);
    expect(bcrypt.compareSync('password123', row.password_hash)).toBe(false);
    /* RFC 2606 reserves `.invalid`, so nothing can ever be delivered to it. */
    expect(row.email).toMatch(/\.invalid$/);
  });

  /**
   * The retention sweep hard-deletes accounts whose `deleted_at` has passed the
   * window. This row is `deleted` with a NULL `deleted_at`, so it is never
   * selected — and migration 019's trigger would refuse the delete anyway once
   * it has written a single row. Both, deliberately: the trail must outlive
   * anybody's tidying.
   */
  it('is not eligible for the retention purge', () => {
    const row = db.prepare('SELECT deleted_at FROM users WHERE id = ?').get('system-cli');
    expect(row.deleted_at).toBeNull();

    const purgeable = db.prepare(`
      SELECT id FROM users
       WHERE account_status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?
    `).all(new Date().toISOString()).map(r => r.id);
    expect(purgeable).not.toContain('system-cli');
  });

  it('is idempotent across repeated migration runs', async () => {
    const mod = await import('./db.js');
    mod.initDatabase();
    await mod.completeDatabaseInit();
    const count = db.prepare("SELECT COUNT(*) c FROM users WHERE id = 'system-cli'").get().c;
    expect(count).toBe(1);
  });
});

describe('privileged CLI commands all record through it', () => {
  /**
   * The gap Q-E named. This script wrote nothing before, so administrator
   * promotion was the only privilege change on the platform with no record.
   */
  it('make-admin.mjs records the promotion', () => {
    addUser('cli-u1', 'cli-u1@example.invalid');
    run('bin/make-admin.mjs', ['cli-u1@example.invalid']);

    const row = auditFor('cli-u1');
    expect(row.action).toBe('ADMIN_PROMOTED_CLI');
    expect(row.admin_id).toBe('system-cli');
    expect(row.details).toContain('method=CLI');
    expect(row.details).toContain('command=bin/make-admin.mjs');
    expect(row.details).toContain('previousRole=student');
    expect(db.prepare('SELECT role FROM users WHERE id = ?').get('cli-u1').role).toBe('admin');
  });

  /**
   * Atomic in both directions. `recordAudit` never catches, so a failed audit
   * rolls the promotion back — there is no state where somebody became an
   * administrator and the record of it did not happen.
   */
  it('bumps token_version so a pre-promotion cookie stops working', () => {
    addUser('cli-u2', 'cli-u2@example.invalid');
    const before = db.prepare('SELECT token_version FROM users WHERE id = ?').get('cli-u2').token_version;
    run('bin/make-admin.mjs', ['cli-u2@example.invalid']);
    const after = db.prepare('SELECT token_version FROM users WHERE id = ?').get('cli-u2').token_version;
    expect(after).toBe(before + 1);
  });

  it('grant-ownership.mjs records against system-cli, not the subject', () => {
    addUser('cli-u3', 'cli-u3@example.invalid', 'admin');
    run('bin/grant-ownership.mjs', ['cli-u3@example.invalid', 'Board decision'], 'y\n');

    const row = auditFor('cli-u3');
    expect(row.action).toBe('OWNER_GRANTED');
    expect(row.admin_id).toBe('system-cli');
    expect(row.admin_id).not.toBe(row.target_user_id);
    expect(row.details).toContain('command=bin/grant-ownership.mjs');
    expect(row.details).toContain('reason=Board decision');
  });

  /**
   * Every command uses the same key=value shape, because `details` is one TEXT
   * column and the value of a consistent shape in it is being greppable — "what
   * privileged things happened from a shell" should be one query, not four.
   */
  it('uses one format across every command', () => {
    const rows = db.prepare(
      "SELECT details FROM admin_audit_logs WHERE admin_id = 'system-cli'"
    ).all();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const { details } of rows) {
      expect(details).toMatch(/^method=CLI; command=bin\/[a-z-]+\.mjs; operator=/);
    }
  });

  /**
   * A missing actor is a database that has not migrated, and saying so is the
   * whole point: without this the foreign key fails AFTER the work, inside a
   * transaction that then rolls back, which reads as "the command is broken".
   */
  it('refuses to run against a database with no system actor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-noactor-'));
    const bare = path.join(dir, 'bare.db');
    const raw = new DatabaseSync(bare);
    raw.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT,
                                  verified INTEGER, account_status TEXT, token_version INTEGER)`);
    raw.prepare("INSERT INTO users VALUES ('x', 'x@example.invalid', 'student', 1, 'active', 0)").run();

    expect(() => execFileSync('node', [path.join(ROOT, 'bin/make-admin.mjs'), 'x@example.invalid'],
      { env: { ...process.env, WEV_DB_PATH: bare }, encoding: 'utf8' })).toThrow(/system-cli/);
  });
});
