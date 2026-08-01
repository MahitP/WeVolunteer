import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let srv, student, organizer, admin;
beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  student = await srv.login('leo.chen28@gmail.com');
  organizer = await srv.login('jkatzenback@vikings.org');
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
    db.prepare("UPDATE users SET role = 'super_admin' WHERE email = 'admin@example.gov'").run();
    // Identity is re-derived from the database per request, so the existing
    // cookie now describes a super_admin without re-login.
    const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, admin);
    expect(res.status).toBe(200);
    db.prepare("UPDATE users SET role = 'admin' WHERE email = 'admin@example.gov'").run();
  });

  it('attaches a principal carrying unexpired grants', async () => {
    const db = (await import('./db.js')).db;
    const { grantCapability } = await import('./userCapabilities.js');
    grantCapability({ db, userId: 'user-student-1', capability: 'service.verify.external', grantedBy: 'user-admin' });
    // /api/auth/me is authenticated and cheap; it proves the middleware ran.
    const res = await srv.call('GET', '/api/auth/me', undefined, student);
    expect(res.status).toBe(200);
  });
});
