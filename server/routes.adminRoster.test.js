import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { recordAudit } from './auditLog.js';

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
const OWNER_EMAIL = 'derek.sorensen@example.com';

let srv;
let db;
beforeAll(async () => { 
  srv = await startTestServer(); 
  db = (await import('./db.js')).db;
});
afterAll(async () => { await srv.close(); });

describe('GET /api/admin/roster', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(srv.base + '/api/admin/roster');
    expect(res.status).toBe(401);
  });

  it('rejects student requests', async () => {
    const token = await srv.login('leo.chen@example.com');
    const res = await fetch(srv.base + '/api/admin/roster', {
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(403);
  });

  it('rejects admin requests (because only super_admin has admin.create by default)', async () => {
    const token = await srv.login('admin@example.gov');
    const res = await fetch(srv.base + '/api/admin/roster', {
      headers: { Cookie: `wev_session=${token}` }
    });
    // Wait, admin@example.gov is 'admin'. They don't have admin.create, so it should be 403.
    expect(res.status).toBe(403);
  });

  it('allows owner (super_admin) requests and returns proper roster data', async () => {
    const ownerToken = await srv.loginAsOwner(OWNER_EMAIL);
    
    const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get();
    const studentUser = db.prepare("SELECT id FROM users WHERE email = 'leo.chen@example.com'").get();

    // Let's create an audit log for an admin to test decision counts
    if (adminUser && studentUser) {
      recordAudit(db, {
        adminId: adminUser.id,
        action: 'APPROVE_ORGANIZER',
        details: 'Test approve',
        targetUserId: studentUser.id
      });
    }

    const res = await fetch(srv.base + '/api/admin/roster', {
      headers: { Cookie: `wev_session=${ownerToken}` }
    });
    
    expect(res.status).toBe(200);
    const data = await res.json();
    
    // We expect both owner and admin to be in the roster
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);
    
    const owner = data.find(u => u.isOwner === true);
    expect(owner).toBeDefined();
    expect(owner.email).toBe(OWNER_EMAIL);
    expect(owner.capabilities).toContain('admin.create');
    
    const admin = data.find(u => u.email === 'admin@example.gov');
    expect(admin).toBeDefined();
    expect(admin.isOwner).toBe(false);
    expect(admin.decisionCount).toBeGreaterThan(0);
    expect(Array.isArray(admin.capabilities)).toBe(true);
  });
});
