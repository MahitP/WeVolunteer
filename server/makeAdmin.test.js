import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { PROMOTABLE_ROLES } from '../bin/make-admin.mjs';
import { SELF_ASSIGNABLE_ROLES } from './accountValidation.js';

const ROOT = process.cwd();
const SCRIPT_PATH = path.join(ROOT, 'bin', 'make-admin.mjs');

/**
 * A fixture faithful enough to test what the script now does.
 *
 * It used to be three columns and no audit table, which was adequate while the
 * script's whole behaviour was one UPDATE. It now writes an audit row in the
 * same transaction — administrator promotion was previously the only privilege
 * change on the platform that left no trace — so a fixture without
 * `admin_audit_logs` cannot exercise it, and one without `system-cli` is
 * refused before the script does anything.
 *
 * `id` is TEXT to match the real schema. It was `INTEGER PRIMARY KEY
 * AUTOINCREMENT`, which is a rowid alias and cannot hold `'system-cli'`.
 */
function createTestDb(dir) {
  const dbPath = path.join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      token_version INTEGER NOT NULL DEFAULT 0
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
  /* The reserved actor, seeded by migration 022 in a real database. */
  db.prepare("INSERT INTO users (id, email, role) VALUES ('system-cli', 'system-cli@wevolunteer.invalid', 'student')").run();
  return { dbPath, db };
}

function runScript(dbPath, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, WEV_DB_PATH: dbPath }
    });
    return { code: 0, stdout, stderr: '', combined: stdout };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
      combined: String(err.stdout || '') + String(err.stderr || '')
    };
  }
}

describe('bin/make-admin.mjs', () => {
  it('PROMOTABLE_ROLES remains aligned with SELF_ASSIGNABLE_ROLES', () => {
    expect(PROMOTABLE_ROLES).toEqual(SELF_ASSIGNABLE_ROLES);
  });

  it('fails with usage message when email argument is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'make-admin-test-'));
    const { dbPath } = createTestDb(dir);
    try {
      const res = runScript(dbPath, []);
      expect(res.code).not.toBe(0);
      expect(res.combined).toContain('Usage: node bin/make-admin.mjs <email>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when target user email is not found', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'make-admin-test-'));
    const { dbPath } = createTestDb(dir);
    try {
      const res = runScript(dbPath, ['missing@example.com']);
      expect(res.code).not.toBe(0);
      expect(res.combined).toContain('User with email missing@example.com not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('promotes a student to admin successfully', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'make-admin-test-'));
    const { dbPath, db } = createTestDb(dir);
    try {
      db.prepare("INSERT INTO users (id, email, role) VALUES ('u-student', 'student@example.com', 'student')").run();

      const res = runScript(dbPath, ['student@example.com']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Successfully promoted student@example.com to admin (was student).');

      const user = db.prepare('SELECT role FROM users WHERE email = ?').get('student@example.com');
      expect(user.role).toBe('admin');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('promotes an organizer to admin successfully', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'make-admin-test-'));
    const { dbPath, db } = createTestDb(dir);
    try {
      db.prepare("INSERT INTO users (id, email, role) VALUES ('u-org', 'org@example.com', 'organizer')").run();

      const res = runScript(dbPath, ['org@example.com']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Successfully promoted org@example.com to admin (was organizer).');

      const user = db.prepare('SELECT role FROM users WHERE email = ?').get('org@example.com');
      expect(user.role).toBe('admin');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles existing admin user safely without modification', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'make-admin-test-'));
    const { dbPath, db } = createTestDb(dir);
    try {
      db.prepare("INSERT INTO users (id, email, role) VALUES ('u-admin', 'admin@example.com', 'admin')").run();

      const res = runScript(dbPath, ['admin@example.com']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('User admin@example.com is already an admin.');

      const user = db.prepare('SELECT role FROM users WHERE email = ?').get('admin@example.com');
      expect(user.role).toBe('admin');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to promote or modify super_admin user with explicit refusal', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'make-admin-test-'));
    const { dbPath, db } = createTestDb(dir);
    try {
      db.prepare("INSERT INTO users (id, email, role) VALUES ('u-owner', 'owner@example.com', 'super_admin')").run();

      const res = runScript(dbPath, ['owner@example.com']);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain('Refused: owner@example.com is a super administrator.');
      expect(res.stderr).toContain('DEMOTION of the platform owner');

      const user = db.prepare('SELECT role FROM users WHERE email = ?').get('owner@example.com');
      expect(user.role).toBe('super_admin');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to modify non-promotable roles like partner', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'make-admin-test-'));
    const { dbPath, db } = createTestDb(dir);
    try {
      db.prepare("INSERT INTO users (id, email, role) VALUES ('u-partner', 'partner@example.com', 'partner')").run();

      const res = runScript(dbPath, ['partner@example.com']);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain('Refused: partner@example.com has the role "partner"');

      const user = db.prepare('SELECT role FROM users WHERE email = ?').get('partner@example.com');
      expect(user.role).toBe('partner');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
