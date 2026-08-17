import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Regression cover for logout not revoking the session.
 *
 * The session is a stateless JWT in an HttpOnly cookie with a 7-day expiry.
 * `POST /api/auth/logout` only ran `res.clearCookie`, so the token itself stayed
 * valid for the remainder of those seven days. Anyone holding a copy — taken
 * from a shared library machine, a shoulder-surfed devtools panel, a synced
 * browser profile — could keep using the account after the student had pressed
 * "Sign out" and believed they were done.
 *
 * The only revocation that existed was `token_version`, which is deliberately
 * ALL-device: bumping it on logout is what the "sign out of one device signs you
 * out everywhere" bug used to be, and that was fixed on purpose. So the fix here
 * has to be per-session, not per-account.
 *
 * Each token now carries a `jti`, and logout records that one id as revoked.
 * `authenticateToken` and the Socket.IO handshake both refuse a revoked id. The
 * account's other sessions are untouched, which is the property the earlier fix
 * established and this must not undo.
 *
 * Tokens minted before this change carry no `jti`. Those cannot be revoked
 * individually and are allowed through — they age out within seven days, and
 * refusing them would sign out every signed-in user on deploy.
 */

let srv;
beforeAll(async () => { srv = await startTestServer(); }, 60000);
afterAll(async () => { await srv?.close(); });

const STUDENT = 'leo.chen@example.com';

describe('logout revokes only the session that logged out', () => {
  it('the session works before logging out', async () => {
    const token = await srv.login(STUDENT);
    expect((await srv.call('GET', '/api/auth/me', undefined, token)).status).toBe(200);
  });

  it('refuses the same cookie after logout', async () => {
    const token = await srv.login(STUDENT);
    expect((await srv.call('POST', '/api/auth/logout', {}, token)).status).toBe(200);
    const after = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(after.status, 'the token still authenticated after logout').toBe(401);
  });

  // The property the earlier per-device fix established.
  it('leaves the account\'s other devices signed in', async () => {
    const deviceA = await srv.login(STUDENT);
    const deviceB = await srv.login(STUDENT);

    await srv.call('POST', '/api/auth/logout', {}, deviceA);

    expect((await srv.call('GET', '/api/auth/me', undefined, deviceA)).status).toBe(401);
    expect(
      (await srv.call('GET', '/api/auth/me', undefined, deviceB)).status,
      'logging out one device must not sign out the others'
    ).toBe(200);
  });

  it('can log out several devices independently', async () => {
    const a = await srv.login(STUDENT);
    const b = await srv.login(STUDENT);
    const c = await srv.login(STUDENT);

    await srv.call('POST', '/api/auth/logout', {}, b);
    expect((await srv.call('GET', '/api/auth/me', undefined, a)).status).toBe(200);
    expect((await srv.call('GET', '/api/auth/me', undefined, b)).status).toBe(401);
    expect((await srv.call('GET', '/api/auth/me', undefined, c)).status).toBe(200);

    await srv.call('POST', '/api/auth/logout', {}, a);
    expect((await srv.call('GET', '/api/auth/me', undefined, a)).status).toBe(401);
    expect((await srv.call('GET', '/api/auth/me', undefined, c)).status).toBe(200);
  });

  it('a fresh sign-in after logout works', async () => {
    const old = await srv.login(STUDENT);
    await srv.call('POST', '/api/auth/logout', {}, old);
    const fresh = await srv.login(STUDENT);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(old);
    expect((await srv.call('GET', '/api/auth/me', undefined, fresh)).status).toBe(200);
  });

  it('revokes the session for every protected route, not just /me', async () => {
    const token = await srv.login(STUDENT);
    await srv.call('POST', '/api/auth/logout', {}, token);
    for (const p of ['/api/events', '/api/notifications', '/api/applications', '/api/certificates']) {
      expect((await srv.call('GET', p, undefined, token)).status, p).toBe(401);
    }
  });

  it('logging out twice with the same cookie is harmless', async () => {
    const token = await srv.login(STUDENT);
    expect((await srv.call('POST', '/api/auth/logout', {}, token)).status).toBe(200);
    // The second attempt is now an unauthenticated request, which is correct.
    const second = await srv.call('POST', '/api/auth/logout', {}, token);
    expect([200, 401]).toContain(second.status);
  });
});

describe('the token carries a per-session id', () => {
  it('issues a distinct jti per sign-in', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const a = await srv.login(STUDENT);
    const b = await srv.login(STUDENT);
    const da = jwt.decode(a), dbb = jwt.decode(b);
    expect(da.jti, 'no jti — a session cannot be revoked individually').toBeTruthy();
    expect(dbb.jti).toBeTruthy();
    expect(da.jti).not.toBe(dbb.jti);
  });

  it('still carries tokenVersion, so all-device revocation keeps working', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const token = await srv.login(STUDENT);
    expect(jwt.decode(token)).toHaveProperty('tokenVersion');
  });
});

describe('sign-out-others is unaffected', () => {
  it('still invalidates other devices and keeps the current one', async () => {
    const a = await srv.login(STUDENT);
    const b = await srv.login(STUDENT);
    const res = await srv.call('POST', '/api/auth/sign-out-others', {}, b);
    expect(res.status).toBe(200);
    expect((await srv.call('GET', '/api/auth/me', undefined, a)).status).toBe(401);
    // The route re-issues a cookie for the caller.
    const reissued = res.cookie || b;
    expect((await srv.call('GET', '/api/auth/me', undefined, reissued)).status).toBe(200);
  });
});

describe('revocations do not grow without bound', () => {
  it('purges entries whose token has already expired', async () => {
    const { db } = await import('./db.js');
    const { purgeExpiredRevocations } = await import('./utils.js');

    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const user = (await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()).id;
    await db.prepare('INSERT INTO revoked_sessions (jti, user_id, revoked_at, expires_at) VALUES (?,?,datetime(\'now\'),?)')
      .run('expired-jti', user, past);
    await db.prepare('INSERT INTO revoked_sessions (jti, user_id, revoked_at, expires_at) VALUES (?,?,datetime(\'now\'),?)')
      .run('live-jti', user, future);

    await purgeExpiredRevocations();

    const rows = (await db.prepare('SELECT jti FROM revoked_sessions').all()).map(r => r.jti);
    expect(rows, 'an expired token needs no denylist entry — it is already invalid').not.toContain('expired-jti');
    expect(rows, 'a live revocation must be kept').toContain('live-jti');
  });
});
