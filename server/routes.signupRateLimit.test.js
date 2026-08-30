import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_SIGNUP_DEFAULTS } from './testConsent.js';

/**
 * Account creation was effectively unlimited, and simultaneously too tight.
 *
 * ── The hole ──
 *
 * `/api/auth/signup` was mounted on `authLimiter`, which carries
 * `skipSuccessfulRequests: true`. A successful signup answers 201, so it was
 * never counted. The only ceiling on creating accounts was the blanket per-IP
 * `/api` limiter at 600 per 15 minutes — about 2,400 accounts an hour from one
 * address, each one a bcrypt hash, a user row, and **a verification email to a
 * caller-supplied address**.
 *
 * That last part is the amplification that matters. Signup takes an arbitrary
 * email and sends mail to it, so an unlimited signup endpoint is also an open
 * mail relay pointed at whoever the caller names, over the platform's own
 * sending reputation.
 *
 * This is not a new class of bug in this codebase. `routes.rateLimit.test.js`
 * records the identical defect on forgot-password — "always returns 200 by
 * design, so the auth limiter's skipSuccessfulRequests would never count it" —
 * and it was fixed there by moving the route onto `mailLimiter`. Signup was not
 * given the same treatment, and it is the one endpoint where the same mistake
 * also creates rows.
 *
 * ── The other half, in the opposite direction ──
 *
 * `authLimiter` allows ten FAILURES per address per 15 minutes. A school egresses
 * from one public address, and a signup form fails for ordinary reasons — a
 * password too short, a username taken, a mistyped email. So the eleventh
 * student in a building to fumble the form was refused, and on signup morning
 * that is not an edge case. It is the exact shared-address problem
 * `loginIpCeilingLimiter` and `mailLimiter` were built to remove, still present
 * on the one form every account has to pass through once.
 *
 * So the fix is not "tighten it". It is: count every request, and set the
 * ceiling where a campus will not meet it.
 *
 * ── What actually bounds abuse here ──
 *
 * Stated plainly, because the IP number is the least important part of this. On
 * a shared address an IP limit cannot tell an attacker from a campus, so it is a
 * volume brake and nothing more. The controls that bound abuse per-identity are
 * `mailLimiter`, which caps requests naming the same address, and email
 * verification, which leaves an unverified account inert.
 */

let srv;

beforeAll(async () => {
  /* Low enough to reach in a handful of requests. Every signup below uses a
     fresh address, so the per-address mail limiter never answers and what this
     file measures is the network ceiling counting successes. */
  process.env.SIGNUP_RATE_LIMIT = '8';
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
  delete process.env.SIGNUP_RATE_LIMIT;
});

const LIMIT = 8;

let n = 0;
/** A valid signup for a fresh address every time. */
function fresh(over = {}) {
  n += 1;
  return {
    ...TEST_SIGNUP_DEFAULTS,
    email: `quota${n}@example.com`,
    password: 'Password123',
    name: `Quota ${n}`,
    role: 'student',
    grade: '11',
    username: `quota_${n}`,
    ...over,
  };
}

const signup = (payload) => srv.call('POST', '/api/auth/signup', payload);

describe('successful signups are counted', () => {
  it('eventually refuses, rather than creating accounts for ever', async () => {
    const statuses = [];
    /* One more than the limit. Every one of these succeeds on its merits, which
       is the point: before the fix the limiter skipped them all and this loop
       would have returned 201 indefinitely. */
    for (let i = 0; i < LIMIT + 1; i++) {
      statuses.push((await signup(fresh())).status);
    }

    expect(
      statuses.filter(s => s === 201).length,
      `every signup succeeded — successes are not being counted: ${statuses.join(',')}`
    ).toBeLessThanOrEqual(LIMIT);
    expect(statuses, `never refused: ${statuses.join(',')}`).toContain(429);
  });

  it('answers a refusal as JSON that names the wait', async () => {
    const res = await signup(fresh());
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.retryAfterMinutes).toBeGreaterThan(0);
    /* Guards the library's text/plain default coming back on an upgrade, the
       same assertion routes.rateLimit.test.js makes for the mail endpoints. */
    expect(String(res.body.error)).not.toContain('429');
  });
});
