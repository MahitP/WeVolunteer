import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `db` is imported inside `beforeAll`, never at the top of the file.
 *
 * `db.js` opens its connection at module scope, so the FIRST import decides
 * which file it binds to. A static `import { db } from './db.js'` here is
 * evaluated before `startTestServer()` sets WEV_DB_PATH, which binds the whole
 * suite to the repository's real database and writes fixtures into it.
 *
 * `testServer.js` asserts the opened path via `PRAGMA database_list` for exactly
 * this reason, and it caught this file doing it.
 */
let srv, db;
beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => {
  await srv?.close();
});

describe('Administrator Promotion and Revocation', () => {
  it('prevents students from promoting', async () => {
    const studentToken = await srv.login('leo.chen28@gmail.com');
    const res = await fetch(srv.base + '/api/admin/users/123/promote', {
      method: 'POST',
      headers: { Cookie: `wev_session=${studentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test' })
    });
    expect(res.status).toBe(403);
  });

  it('requires step-up authentication for promotion', async () => {
    const ownerToken = await srv.login('owner@wevolunteer.local');
    const res = await fetch(srv.base + '/api/admin/users/user-student-2/promote', {
      method: 'POST',
      headers: { Cookie: `wev_session=${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test' })
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('reauth_required');
  });

  it('allows owner to promote a student with valid step-up', async () => {
    const ownerToken = await srv.login('owner@wevolunteer.local');
    
    // 1. Get challenge
    const cRes = await fetch(srv.base + '/api/auth/reauth/challenge', {
      method: 'POST',
      headers: { Cookie: `wev_session=${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'admin.promote', params: { targetUserId: 'user-student-2' } })
    });
    const { challengeId } = await cRes.json();
    
    // 2. Complete challenge
    await fetch(srv.base + '/api/auth/reauth/password', {
      method: 'POST',
      headers: { Cookie: `wev_session=${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, password: 'password123' })
    });

    // 3. Promote user
    const res = await fetch(srv.base + '/api/admin/users/user-student-2/promote', {
      method: 'POST',
      headers: { 
        Cookie: `wev_session=${ownerToken}`, 
        'Content-Type': 'application/json',
        'X-Reauth-Challenge': challengeId
      },
      body: JSON.stringify({ reason: 'They are very helpful' })
    });
    
    expect(res.status).toBe(200);

    // Verify database changes
    const user = db.prepare("SELECT role, promoted_by, promotion_reason FROM users WHERE id = 'user-student-2'").get();
    expect(user.role).toBe('admin');
    expect(user.promotion_reason).toBe('They are very helpful');
    
    // Verify audit log
    const log = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'ADMIN_PROMOTED' AND target_user_id = 'user-student-2'").get();
    expect(log).toBeDefined();
    
    // Verify notification
    const notif = db.prepare("SELECT * FROM notifications WHERE user_id = 'user-student-2' AND title LIKE '%administrator%'").get();
    expect(notif).toBeDefined();
  });

  it('prevents revoking the owner', async () => {
    const ownerToken = await srv.login('owner@wevolunteer.local');
    const res = await fetch(srv.base + '/api/admin/users/user-super/revoke', {
      method: 'POST',
      headers: { 
        Cookie: `wev_session=${ownerToken}`, 
        'Content-Type': 'application/json',
        // In reality, step-up check happens before business logic, but testing it anyway
        'X-Reauth-Challenge': 'fake-token'
      }
    });
    
    // Because reauth is required before business logic, let's actually do the reauth to test the logic
    const cRes = await fetch(srv.base + '/api/auth/reauth/challenge', {
      method: 'POST',
      headers: { Cookie: `wev_session=${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'admin.revoke', params: { targetUserId: 'user-super' } })
    });
    const { challengeId } = await cRes.json();
    
    await fetch(srv.base + '/api/auth/reauth/password', {
      method: 'POST',
      headers: { Cookie: `wev_session=${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, password: 'password123' })
    });

    const res2 = await fetch(srv.base + '/api/admin/users/user-super/revoke', {
      method: 'POST',
      headers: { 
        Cookie: `wev_session=${ownerToken}`, 
        'Content-Type': 'application/json',
        'X-Reauth-Challenge': challengeId
      }
    });
    
    expect(res2.status).toBe(403);
    expect((await res2.json()).error).toMatch(/cannot revoke the platform owner/i);
  });

  it('allows owner to revoke an admin', async () => {
    const ownerToken = await srv.login('owner@wevolunteer.local');
    
    // 1. Get challenge
    const cRes = await fetch(srv.base + '/api/auth/reauth/challenge', {
      method: 'POST',
      headers: { Cookie: `wev_session=${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'admin.revoke', params: { targetUserId: 'user-admin' } })
    });
    const { challengeId } = await cRes.json();
    
    // 2. Complete challenge
    await fetch(srv.base + '/api/auth/reauth/password', {
      method: 'POST',
      headers: { Cookie: `wev_session=${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, password: 'password123' })
    });

    // 3. Revoke admin
    const res = await fetch(srv.base + '/api/admin/users/user-admin/revoke', {
      method: 'POST',
      headers: { 
        Cookie: `wev_session=${ownerToken}`, 
        'Content-Type': 'application/json',
        'X-Reauth-Challenge': challengeId
      }
    });
    
    expect(res.status).toBe(200);

    // Verify database changes
    const user = db.prepare("SELECT role FROM users WHERE id = 'user-admin'").get();
    expect(user.role).toBe('student');
    
    // Verify explicit grants were wiped
    const grants = db.prepare("SELECT count(*) as count FROM user_capabilities WHERE user_id = 'user-admin'").get();
    expect(grants.count).toBe(0);
    
    // Verify audit log
    const log = db.prepare("SELECT * FROM admin_audit_logs WHERE action = 'ADMIN_REVOKED' AND target_user_id = 'user-admin'").get();
    expect(log).toBeDefined();
    
    // Verify notification
    const notif = db.prepare("SELECT * FROM notifications WHERE user_id = 'user-admin' AND title LIKE '%revoked%'").get();
    expect(notif).toBeDefined();
  });
});
