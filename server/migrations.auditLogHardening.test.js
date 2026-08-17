import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-audit-test-'));
process.env.WEV_DB_PATH = path.join(dir, 'audit.db');

let db;
let recordAudit;

beforeAll(async () => {
  // Use the test database bootstrap which runs all migrations
  const dbModule = await import('./db.js');
  dbModule.initDatabase();
  await dbModule.completeDatabaseInit();
  db = dbModule.db;
  
  const auditLogModule = await import('./auditLog.js');
  recordAudit = auditLogModule.recordAudit;

  // Seed the admin user once for all tests
  await db.prepare(`
    INSERT INTO users (id, name, username, email, password_hash, role, verified, account_status, grade, created_at)
    VALUES (?, 'Admin User', 'admin_user', 'admin@test.local', 'hash', 'super_admin', 1, 'active', 'Adult', '2000-01-01T00:00:00.000Z')
  `).run('user-admin');
});

describe('Migration 019: Audit Log Hardening', () => {
  it('creates performance indexes on admin_audit_logs', () => {
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type = 'index' AND tbl_name = 'admin_audit_logs'
    `).all().map(i => i.name);
    
    expect(indexes).toContain('idx_admin_audit_logs_admin');
    expect(indexes).toContain('idx_admin_audit_logs_target');
    expect(indexes).toContain('idx_admin_audit_logs_action');
    expect(indexes).toContain('idx_admin_audit_logs_created');
  });

  it('prevents ANY updates to admin_audit_logs (admin_audit_logs_no_update)', async () => {
    const { id } = await recordAudit(db, {
      adminId: 'user-admin',
      action: 'MIGRATION_TEST',
      details: 'initial'
    });

    await expect(async () => {
      db.prepare('UPDATE admin_audit_logs SET details = ? WHERE id = ?').run('changed', id);
    }).rejects.toThrow(/admin_audit_logs is append-only: records cannot be altered/);

    await expect(async () => {
      db.prepare('UPDATE admin_audit_logs SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', id);
    }).rejects.toThrow(/admin_audit_logs is append-only: records cannot be altered/);
  });

  it('prevents deletions of recent admin_audit_logs (admin_audit_logs_no_delete)', async () => {
    const { id } = await recordAudit(db, {
      adminId: 'user-admin',
      action: 'MIGRATION_TEST',
      details: 'recent'
    });

    await expect(async () => {
      db.prepare('DELETE FROM admin_audit_logs WHERE id = ?').run(id);
    }).rejects.toThrow(/admin_audit_logs is append-only: only the retention worker may delete aged logs/);
  });

  it('allows retention worker to delete logs older than 365 days', async () => {
    // Seed an old log using the createdAt backdate option
    const { id } = await recordAudit(db, {
      adminId: 'user-admin',
      action: 'MIGRATION_TEST_OLD',
      details: 'old',
      createdAt: '2000-01-01T00:00:00.000Z'
    });

    // The trigger should allow this deletion because created_at is < 364 days ago
    /* Succeeds, so it is simply awaited: `expect(fn).not.toThrow()` observes a
       synchronous throw only, and on PostgreSQL the statement rejects instead —
       so the assertion would pass while the delete was being refused. */
    await db.prepare('DELETE FROM admin_audit_logs WHERE id = ?').run(id);

    const stillExists = await db.prepare('SELECT 1 FROM admin_audit_logs WHERE id = ?').get(id);
    expect(stillExists).toBeUndefined();
  });

  it('prevents deletion of users who have authored audit logs (cascade hazard)', async () => {
    // Create a throwaway user to test deletion
    await db.prepare(`
      INSERT INTO users (id, name, username, email, password_hash, role, verified, account_status, grade, created_at)
      VALUES (?, 'Cascade Test User', 'cascade_test', 'cascade@test.local', 'hash', 'admin', 1, 'active', 'Adult', '2000-01-01T00:00:00.000Z')
    `).run('user-cascade-tester');

    // Give them an audit log
    await recordAudit(db, {
      adminId: 'user-cascade-tester',
      action: 'MIGRATION_TEST',
      details: 'test'
    });

    // Deleting the user should be blocked by users_no_delete_with_audit_logs
    await expect(async () => {
      db.prepare('DELETE FROM users WHERE id = ?').run('user-cascade-tester');
    }).rejects.toThrow(/cannot delete user: they have created audit logs which must be retained/);
  });
});
