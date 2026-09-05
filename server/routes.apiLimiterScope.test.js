import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Two students behind one address must not share an API budget.
 *
 * ── The defect ──
 *
 * `apiLimiter` covers EVERY `/api` request and had no `keyGenerator`, so
 * `express-rate-limit` keyed it on `req.ip` alone: 600 requests per fifteen
 * minutes for a whole school's shared egress address. A signed-in session makes
 * several requests on every screen, so a few dozen students browsing at lunchtime
 * exhaust the budget for the building — and the next student to open the app is
 * refused with 429 on a request that was neither abusive nor theirs to pay for.
 *
 * This is exactly the failure that was already found and fixed for sign-in.
 * `loginLimiter` is keyed on `ip + account` for this reason, and its header
 * records the measurement: ten students each mistyping once locked out everybody.
 * `mailLimiter` was re-keyed for the same reason. `apiLimiter` is the broadest
 * limiter in the application and was the one left on a bare address.
 *
 * ── The fix, and why it loosens nothing ──
 *
 * A request carrying a VALID session is keyed on the account; everything else is
 * keyed on the address, exactly as before. The per-bucket number does not change.
 * So an anonymous flood is bounded identically, one account is bounded
 * identically, and the only behaviour that changes is that one person's browsing
 * no longer spends another person's allowance.
 *
 * The session is verified, not merely parsed. Keying on an unverified cookie
 * would let an attacker mint a fresh key per request and buy an unlimited
 * budget, which is worse than the defect being fixed.
 */
describe('the API limiter is scoped to the session, not the building', () => {
  let srv;

  beforeAll(async () => {
    /* Low enough to reach in a handful of requests. Every request in this file
       originates from 127.0.0.1, so under the old keying they all share one
       bucket — which is the whole point. */
    process.env.API_RATE_LIMIT = '8';
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
  }, 60000);

  afterAll(async () => {
    await srv?.close();
    delete process.env.API_RATE_LIMIT;
  });

  it('does not let one student exhaust another student\'s budget', async () => {
    const leo = await srv.login('leo.chen@example.com');
    const priya = await srv.login('priya.patel@example.com');

    /* Leo browses past the limit. Some of these are refused, and that is
       correct — his own budget is his own. */
    const leoStatuses = [];
    for (let i = 0; i < 14; i++) {
      leoStatuses.push((await srv.call('GET', '/api/auth/me', undefined, leo)).status);
    }
    expect(leoStatuses, 'Leo should have hit his own limit').toContain(429);

    /* Priya, on the same address, has spent nothing. Before the fix this was a
       429: the bucket was the address, and Leo had emptied it. */
    const hers = await srv.call('GET', '/api/auth/me', undefined, priya);
    expect(
      hers.status,
      'a second student on the same address was refused because the first had browsed'
    ).toBe(200);
  });

  it('still limits an anonymous caller by address', async () => {
    /**
     * The half that must not regress. A request with no session — or with a
     * forged one — falls back to the address, so an anonymous flood is bounded
     * exactly as it was before.
     *
     * `/api/legal/documents` is unauthenticated, so the statuses below are the
     * limiter's answer rather than an authentication failure.
     */
    const statuses = [];
    for (let i = 0; i < 16; i++) {
      statuses.push((await srv.call('GET', '/api/legal/documents')).status);
    }
    expect(statuses, 'an anonymous caller must still be limited').toContain(429);
  });

  it('does not accept a forged session as an identity', async () => {
    /**
     * The attack the verification exists to stop: if the key were derived from
     * an unverified cookie, an attacker would rotate the cookie per request and
     * never share a bucket with themselves.
     *
     * A garbage cookie must therefore be treated as anonymous — keyed on the
     * address — which is what makes the fallback safe. Sixteen requests with
     * SIXTEEN DIFFERENT invalid cookies must still reach the address limit.
     */
    const statuses = [];
    for (let i = 0; i < 16; i++) {
      const res = await fetch(`${srv.base}/api/legal/documents`, {
        headers: { Cookie: `wev_session=forged-token-${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses, 'rotating a forged cookie bought an unlimited budget').toContain(429);
  });
});
