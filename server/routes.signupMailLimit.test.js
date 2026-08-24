import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_SIGNUP_DEFAULTS } from './testConsent.js';

/**
 * Signup's per-address bound, and the failure policy it replaced.
 *
 * ── Why this is a second file ──
 *
 * `express-rate-limit` instances are constructed at module load, so a limiter's
 * ceiling is fixed by the environment as it stood when `app.js` was first
 * imported. `startTestServer()` reuses the module-cached `db.js` and therefore
 * the already-built limiters, so a second call inside one file cannot give a
 * different budget — the first draft of this suite tried, and its later blocks
 * silently skipped. One limit configuration per file is the constraint.
 *
 * This file sets the network ceiling wide open on purpose, so that what it
 * measures is the per-ADDRESS bound and the treatment of ordinary failures,
 * neither of which should depend on the volume budget.
 *
 * The counting half — that a *successful* signup is counted at all, which is the
 * defect that motivated the change — is in `routes.signupRateLimit.test.js`.
 */

let srv;

beforeAll(async () => {
  process.env.SIGNUP_RATE_LIMIT = '400';
  process.env.MAIL_RATE_LIMIT = '3';
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
  delete process.env.SIGNUP_RATE_LIMIT;
  delete process.env.MAIL_RATE_LIMIT;
});

describe('a campus is not locked out by ordinary mistakes', () => {
  it('lets a valid signup through after more than ten failed ones from the same address', async () => {
    /**
     * Twelve rejected attempts, each on its own address so the per-address
     * limiter is not what answers.
     *
     * Twelve is over `authLimiter`'s ten-failure ceiling, which used to apply to
     * this route and would have refused everything from the eleventh on. A
     * signup form fails for ordinary reasons and a school shares one public
     * address, so that ceiling made the eleventh student in a building to
     * mistype something wait fifteen minutes.
     */
    for (let i = 0; i < 12; i++) {
      const bad = await srv.call('POST', '/api/auth/signup', {
        ...TEST_SIGNUP_DEFAULTS,
        email: `oops${i}@example.com`,
        password: 'short',
        name: 'Oops',
        role: 'student',
        grade: '11',
        username: `oops_${i}`,
      });
      expect(bad.status, `attempt ${i} should have failed on its merits: ${JSON.stringify(bad.body)}`)
        .toBeGreaterThanOrEqual(400);
      expect(bad.status, `attempt ${i} was rate-limited rather than rejected on its merits`).not.toBe(429);
    }

    const good = await srv.call('POST', '/api/auth/signup', {
      ...TEST_SIGNUP_DEFAULTS,
      email: 'thirteenth@example.com',
      password: 'Password123',
      name: 'Thirteenth Student',
      role: 'student',
      grade: '11',
      username: 'thirteenth',
    });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
  });
});

describe('one address cannot be mailed repeatedly through signup', () => {
  it('bounds attempts naming the same email even with the network budget wide open', async () => {
    /**
     * The mail-relay half. Signup sends a verification email to whatever address
     * it is handed, so the per-address bound is what stops the endpoint being
     * used to deliver repeatedly to one person — and unlike a per-IP ceiling it
     * costs a campus nothing, because a campus does not sign the same address up
     * six times.
     */
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await srv.call('POST', '/api/auth/signup', {
        ...TEST_SIGNUP_DEFAULTS,
        email: 'victim@example.com',
        password: 'Password123',
        name: 'Victim',
        role: 'student',
        grade: '11',
        username: `victim_${i}`,
      });
      statuses.push(res.status);
    }

    expect(statuses, `the same address was never bounded: ${statuses.join(',')}`).toContain(429);
  });
});
