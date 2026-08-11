import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('Admin CSV Export Route', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(srv.base + '/api/admin/reports/export');
    expect(res.status).toBe(401);
  });

  it('rejects student requests', async () => {
    const token = await srv.login('leo.chen@example.com');
    const res = await fetch(srv.base + '/api/admin/reports/export', {
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(403);
  });

  it('rejects organizer requests', async () => {
    const token = await srv.login('jordan.whitfield@example.org');
    const res = await fetch(srv.base + '/api/admin/reports/export', {
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(403);
  });

  it('returns a valid CSV file for admins', async () => {
    const token = await srv.login('admin@example.gov');
    const res = await fetch(srv.base + '/api/admin/reports/export', {
      headers: { Cookie: `wev_session=${token}` }
    });
    
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="wevolunteer_students_export.csv"');
    
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('ID,Name,Email,School/Affiliation,Joined Date,Total Credited Hours');
    expect(text).toContain('Leo Chen');
  });
});

describe('Admin Audit Logging', () => {
  it('logs when an admin approves an organizer', async () => {
    // 1. Get an admin token
    const token = await srv.login('admin@example.gov');
    
    // 2. We need a pending organizer first. The seed data has 'user-org-pending'
    const res = await fetch(srv.base + '/api/admin/organizers/user-org-pending/approve', {
      method: 'POST',
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(200);

    // 3. Verify the audit log was created
    const { db } = await import('./db.js');
    const logs = db.prepare("SELECT * FROM admin_audit_logs WHERE target_user_id = 'user-org-pending' AND action = 'APPROVE_ORGANIZER'").all();
    expect(logs.length).toBe(1);
    expect(logs[0].admin_id).toBe('user-admin');
    expect(logs[0].details).toBe('Approved pending organizer account');
  });

  it('logs when an admin denies an organizer', async () => {
    // We need to create a temporary pending organizer to deny
    const { body } = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email: 'badorg@example.com',
      password: 'Password123',
      name: 'Bad Org',
      role: 'organizer',
      grade: 'Adult',
      username: 'bad_org'
    });
    const user = body.user;
    
    const token = await srv.login('admin@example.gov');
    const res = await fetch(srv.base + `/api/admin/organizers/${user.id}/deny`, {
      method: 'POST',
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(200);

    // Verify the audit log was created
    const { db } = await import('./db.js');
    const logs = db.prepare("SELECT * FROM admin_audit_logs WHERE target_user_id = ? AND action = 'DENY_ORGANIZER'").all(user.id);
    expect(logs.length).toBe(1);
    expect(logs[0].admin_id).toBe('user-admin');
    expect(logs[0].details).toBe('Denied and deleted pending organizer account request');
  });
});

