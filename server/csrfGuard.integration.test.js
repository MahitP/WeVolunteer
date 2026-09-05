/**
 * The CSRF guard, against a real running server with a real session.
 *
 * csrfGuard.test.js proves the middleware's logic. It cannot prove the
 * middleware is MOUNTED, that it sits before the routers, or that it survives a
 * reordering of app.js — and a guard that is correct but unreachable is exactly
 * the false green this suite exists to avoid. These cases go over HTTP, with a
 * session obtained through the real login flow, against routes that genuinely
 * change state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, student;

beforeAll(async () => {
  srv = await startTestServer();
  student = await srv.login('leo.chen@example.com');
}, 60000);

afterAll(async () => { await srv?.close(); });

/**
 * A state-changing route that an authenticated student may genuinely call, so a
 * refusal is attributable to the guard rather than to authorization. Profile
 * update is chosen because it is unambiguously a write and unambiguously
 * permitted for this role.
 */
const PATH = '/api/auth/profile';
const BODY = { bio: 'Testing CSRF.' };

describe('the sibling-subdomain attack is refused over HTTP', () => {
  /**
   * The whole reason this guard exists. wevolunteers.org POSTing to
   * app.wevolunteers.org is SAME-SITE, so SameSite=Lax attaches the session and
   * the request arrives fully authenticated as the victim.
   */
  it('refuses a same-site write carrying a valid session', async () => {
    const res = await srv.call('PATCH', PATH, BODY, student, { 'Sec-Fetch-Site': 'same-site' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_REFUSED');
  });

  it('refuses a cross-site write carrying a valid session', async () => {
    const res = await srv.call('PATCH', PATH, BODY, student, { 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_REFUSED');
  });

  /**
   * The control. If this failed, the two cases above would be passing because
   * the route is broken rather than because the guard works.
   */
  it('allows the same write from the app\'s own origin', async () => {
    const res = await srv.call('PATCH', PATH, BODY, student, { 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).not.toBe(403);
  });

  it('allows the same write from a client that sends no Sec-Fetch-Site', async () => {
    const res = await srv.call('PATCH', PATH, BODY, student);
    expect(res.status).not.toBe(403);
  });
});

describe('the guard runs before authentication and rate limiting', () => {
  /**
   * A refused cross-site write must not first consume the victim's rate-limiter
   * budget: the attacker chooses the volume, so a guard mounted after the
   * limiters converts a blocked CSRF attempt into a denial of service against
   * the account it failed to attack.
   *
   * Asserted by volume — far more requests than any per-account limiter allows —
   * all still answering CSRF_REFUSED rather than 429.
   */
  it('refuses many same-site writes without falling through to a 429', async () => {
    const results = [];
    for (let i = 0; i < 40; i++) {
      results.push(await srv.call('PATCH', PATH, BODY, student, { 'Sec-Fetch-Site': 'same-site' }));
    }
    expect(results.every(r => r.status === 403)).toBe(true);
    expect(results.every(r => r.body?.code === 'CSRF_REFUSED')).toBe(true);
  });

  it('leaves the legitimate same-origin path working afterwards', async () => {
    const res = await srv.call('PATCH', PATH, BODY, student, { 'Sec-Fetch-Site': 'same-origin' });
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(403);
  });
});

describe('reads are untouched', () => {
  it('allows a cross-site GET, which cannot change state', async () => {
    const res = await srv.call('GET', '/api/auth/me', undefined, student, { 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(200);
  });
});

describe('unauthenticated cross-site writes are not the guard\'s business', () => {
  /**
   * With no session cookie there is no ambient credential to abuse, so the
   * guard defers and the ordinary 401 applies. This matters: refusing here
   * instead would break health checks, the accessibility harness and curl,
   * which the CORS layer deliberately admits.
   */
  it('falls through to 401 rather than 403', async () => {
    const res = await srv.call('PATCH', PATH, BODY, undefined, { 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(401);
  });
});
