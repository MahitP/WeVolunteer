import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let srv, student, organizer, admin;
beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  student = await srv.login('leo.chen@example.com');
  organizer = await srv.login('jordan.whitfield@example.org');
  admin = await srv.login('admin@example.gov');
}, 60000);
afterAll(async () => { await srv?.close(); });

describe('requireCap', () => {
  it('lets a capable role through', async () => {
    const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, admin);
    expect(res.status).toBe(200);
  });

  it('rejects an incapable role with 403 and no data', async () => {
    for (const token of [student, organizer]) {
      const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, token);
      expect(res.status).toBe(403);
      expect(Array.isArray(res.body)).toBe(false);
      expect(res.body.error).toBeTruthy();
    }
  });

  it('rejects an unauthenticated request with 401, not 403', async () => {
    const res = await srv.call('GET', '/api/admin/organizers/pending');
    expect(res.status).toBe(401);
  });

  it('lets a super_admin reach an admin route — the bug this whole task exists to prevent', async () => {
    const db = (await import('./db.js')).db;
    await db.prepare("UPDATE users SET role = 'super_admin' WHERE email = 'admin@example.gov'").run();
    // Identity is re-derived from the database per request, so the existing
    // cookie now describes a super_admin without re-login.
    const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, admin);
    expect(res.status).toBe(200);
    await db.prepare("UPDATE users SET role = 'admin' WHERE email = 'admin@example.gov'").run();
  });

  /**
   * A per-user grant must change a real authorization outcome over HTTP.
   *
   * This replaces a test titled "attaches a principal carrying unexpired
   * grants" that granted a capability and then asserted GET /api/auth/me
   * returned 200 — which is true with or without the grant, and true with the
   * whole grants feature deleted. It named coverage it did not provide, which
   * is worse than no test: it made the feature look verified end to end when
   * nothing exercised it past the database row.
   *
   * `report.resolve` is admin-only among the role tables, is not super-only
   * (so it is grantable at all), and gates GET /api/admin/reports through
   * requireCap. A student holds it by no other route, so a flip here can only
   * be the grant.
   */
  it('flips a route 403 -> 200 for a granted capability, and back on revoke', async () => {
    const db = (await import('./db.js')).db;
    const { grantCapability, revokeCapability } = await import('./userCapabilities.js');

    const before = await srv.call('GET', '/api/admin/reports', undefined, student);
    expect(before.status, 'a student must not reach an admin report route unaided').toBe(403);

    await grantCapability({ db, userId: 'user-student-1', capability: 'report.resolve', grantedBy: 'user-admin' });
    const granted = await srv.call('GET', '/api/admin/reports', undefined, student);
    expect(granted.status, 'the grant must be what admits them').toBe(200);

    await revokeCapability({ db, userId: 'user-student-1', capability: 'report.resolve' });
    const revoked = await srv.call('GET', '/api/admin/reports', undefined, student);
    expect(revoked.status, 'and revoking it must shut the door again').toBe(403);
  });

  it('does not let an expired grant admit anyone', async () => {
    const db = (await import('./db.js')).db;
    const { grantCapability, revokeCapability } = await import('./userCapabilities.js');

    await grantCapability({
      db, userId: 'user-student-1', capability: 'report.resolve', grantedBy: 'user-admin',
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    const res = await srv.call('GET', '/api/admin/reports', undefined, student);
    expect(res.status).toBe(403);

    await revokeCapability({ db, userId: 'user-student-1', capability: 'report.resolve' });
  });
});
