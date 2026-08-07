import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The owner is promoted by this suite, not seeded.
 *
 * `seedSuperAdmin()` used to insert `owner@wevolunteer.local` whenever DEMO_MODE
 * was set. It is gone: it was the only code in the repository that could create
 * an owner, and "no code path exists" is a stronger guarantee than any
 * permission check. `db.js` now refuses to boot a demo database containing one.
 *
 * `srv.loginAsOwner` runs the same UPDATE `bin/grant-ownership.mjs` runs,
 * against this suite's throwaway database.
 */
const OWNER_EMAIL = 'dsanger@outlook.com';

/**
 * `audit.read` is SUPER_ONLY as of M1c, so every success case below signs in as
 * the OWNER, not as an administrator.
 *
 * These tests were originally written against `admin` — which passed, because at
 * the time administrators held `audit.read`. That was the defect: the Audit
 * Explorer shipped readable by the very people whose actions it records. The
 * capability move is what makes the four 403s below correct rather than a
 * regression, and `refuses an ordinary administrator` is the assertion that
 * stops it silently coming back.
 */
describe('Admin Audit Explorer API', () => {
  let srv, owner, admin, student, db;

  beforeAll(async () => {
    srv = await startTestServer();
    owner = await srv.loginAsOwner(OWNER_EMAIL);
    admin = await srv.login('admin@example.gov');
    student = await srv.login('leo.chen28@gmail.com');
    const dbModule = await import('./db.js');
    db = dbModule.db;

    // Seed some specific audit logs for testing filtering and pagination
    const testAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@example.gov');
    const testTarget = db.prepare('SELECT id FROM users WHERE email = ?').get('leo.chen28@gmail.com');
    
    const insertLog = db.prepare(`
      INSERT INTO ` + `admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < 25; i++) {
      const id = `audit-test-${i}`;
      const action = i < 5 ? 'ACCOUNT_SUSPENDED' : (i < 10 ? 'ACCOUNT_WARNED' : 'TEST_ACTION');
      const target = i % 2 === 0 ? testTarget.id : null;
      // Make dates descending starting from 2000-08-01 to bypass the 365-day retention trigger during cleanup
      const date = new Date(Date.UTC(2000, 7, 1 + i, 12, 0, 0)).toISOString();
      insertLog.run(id, testAdmin.id, action, target, `Detail ${i} with term SEARCHABLE`, date);
    }
  }, 60000);

  afterAll(async () => { 
    // Clean up test data
    db.prepare("DELETE FROM admin_audit_logs WHERE id LIKE 'audit-test-%'").run();
    await srv?.close(); 
  });

  it('requires audit.read capability', async () => {
    const res = await srv.call('GET', '/api/admin/audit-logs', undefined, student);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  /**
   * The assertion the whole capability move exists for.
   *
   * An administrator is not a hostile actor, and this is not primarily about
   * misuse: it is that a record of what administrators did to students, and to
   * one another, is only meaningful as accountability if the people it describes
   * are not the ones holding the key. Returning `audit.read` to the `admin` list
   * — the single-line change that would undo M1c — fails here and nowhere else,
   * because every other test in this file would still pass with it.
   */
  it('refuses an ordinary administrator, not just a student', async () => {
    const res = await srv.call('GET', '/api/admin/audit-logs', undefined, admin);
    expect(
      res.status,
      'an administrator must not be able to read the trail that records administrators'
    ).toBe(403);
  });

  it('allows the owner', async () => {
    const res = await srv.call('GET', '/api/admin/audit-logs?limit=1', undefined, owner);
    expect(res.status).toBe(200);
  });

  it('paginates results', async () => {
    const res1 = await srv.call('GET', '/api/admin/audit-logs?limit=10&page=1', undefined, owner);
    expect(res1.status).toBe(200);
    expect(res1.body.logs).toHaveLength(10);
    expect(res1.body.page).toBe(1);
    expect(res1.body.total).toBeGreaterThanOrEqual(25);

    const res2 = await srv.call('GET', '/api/admin/audit-logs?limit=10&page=2', undefined, owner);
    expect(res2.status).toBe(200);
    expect(res2.body.logs).toHaveLength(10);
    
    // Ensure different pages have different results
    expect(res1.body.logs[0].id).not.toBe(res2.body.logs[0].id);
  });

  it('filters by action', async () => {
    const res = await srv.call('GET', '/api/admin/audit-logs?action=ACCOUNT_SUSPENDED', undefined, owner);
    expect(res.status).toBe(200);
    // At least the 5 we inserted
    expect(res.body.logs.length).toBeGreaterThanOrEqual(5);
    res.body.logs.forEach(log => {
      expect(log.action).toBe('ACCOUNT_SUSPENDED');
    });
  });

  it('filters by date range', async () => {
    const startDate = new Date(Date.UTC(2000, 7, 2, 0, 0, 0)).toISOString();
    const endDate = new Date(Date.UTC(2000, 7, 4, 23, 59, 59)).toISOString();
    
    const res = await srv.call('GET', `/api/admin/audit-logs?startDate=${startDate}&endDate=${endDate}`, undefined, owner);
    expect(res.status).toBe(200);
    // Should match exactly 3 days (indices 1, 2, 3 -> dates Aug 2, Aug 3, Aug 4)
    const logs = res.body.logs.filter(l => l.id.startsWith('audit-test-'));
    expect(logs).toHaveLength(3);
  });

  it('filters by search term in details', async () => {
    const res = await srv.call('GET', '/api/admin/audit-logs?search=SEARCHABLE&limit=50', undefined, owner);
    expect(res.status).toBe(200);
    const logs = res.body.logs.filter(l => l.id.startsWith('audit-test-'));
    expect(logs).toHaveLength(25);
  });
});
