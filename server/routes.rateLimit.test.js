import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Mail-endpoint rate limiting (P1-B, P1-C).
 *
 * forgot-password always returns 200 by design, so the auth limiter's
 * skipSuccessfulRequests would never count it — verified before this fix as
 * unlimited 200s. resend-verification was on no auth limiter at all. Both are
 * now on a dedicated mailLimiter that counts every request.
 *
 * MAIL_RATE_LIMIT is set low before the harness (and therefore app.js/config)
 * is imported, so the limiter trips within a handful of requests. All requests
 * originate from 127.0.0.1, so they share one rate-limit bucket.
 */
describe('mail endpoints are rate limited', () => {
  let srv;

  beforeAll(async () => {
    process.env.MAIL_RATE_LIMIT = '3';
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    delete process.env.MAIL_RATE_LIMIT;
  });

  it('counts successful forgot-password requests and eventually returns 429', async () => {
    // Three allowed (the limit), all 200 — and, crucially, all counted.
    for (let i = 0; i < 3; i++) {
      const res = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen@example.com' });
      expect(res.status).toBe(200);
    }
    // The fourth is refused. Before the fix this stayed 200 for ever, because
    // successful requests were skipped by the limiter.
    const blocked = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen@example.com' });
    expect(blocked.status).toBe(429);
  });

  it('rate-limits resend-verification through the same mail limiter', async () => {
    /**
     * Rewritten when the mail limiter stopped keying on IP.
     *
     * This case used to assert 429 on its FIRST resend-verification call, relying on
     * the bucket being already exhausted by the forgot-password test above — i.e. on
     * one shared per-IP bucket spanning two endpoints and two different accounts.
     *
     * That coupling was the bug, not the feature. A school campus egresses from one
     * public address, so a per-IP bucket meant the whole building shared five
     * verification-mail requests per 15 minutes — and with
     * REQUIRE_EMAIL_VERIFICATION defaulting to ON, a student who cannot resend
     * cannot use their account. The limiter now keys on the target address, or on
     * the session for authenticated endpoints like this one.
     *
     * So the endpoint still has to be limited — that is what this test is for — but
     * it now needs its own requests to get there rather than borrowing another
     * endpoint's count. `skipSuccessfulRequests` is off on this limiter, so the 401s
     * from `authenticateToken` are still counted.
     */
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await srv.call('POST', '/api/auth/resend-verification');
      statuses.push(res.status);
    }

    // Unauthenticated, so the early calls are refused by auth (401) — proving the
    // limiter let them through — and a later one is refused by the limiter itself.
    expect(statuses[0]).toBe(401);
    expect(statuses, `never rate-limited: ${statuses.join(',')}`).toContain(429);
  });

  /**
   * A limited response must be JSON in the same shape as every other API error.
   *
   * express-rate-limit's default is `text/plain`, which the client could not
   * parse — so it fell back to printing the bare status and a locked-out
   * student was told "Request failed (429)". Asserting the content type here is
   * the point of the test: a future upgrade that restores the text default
   * would silently reintroduce that message.
   */
  it('answers a limited request with JSON the client can display', async () => {
    const res = await fetch(`${srv.base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen@example.com' })
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = await res.json();
    expect(body.code).toBe('rate_limited');
    expect(typeof body.error).toBe('string');
    // A human sentence, not a status code echoed back at the user.
    expect(body.error).toMatch(/try again/i);
    expect(body.error).not.toMatch(/429/);
    expect(body.retryAfterMinutes).toBeGreaterThan(0);
  });
});
