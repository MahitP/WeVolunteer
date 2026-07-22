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
      const res = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
      expect(res.status).toBe(200);
    }
    // The fourth is refused. Before the fix this stayed 200 for ever, because
    // successful requests were skipped by the limiter.
    const blocked = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    expect(blocked.status).toBe(429);
  });

  it('rate-limits resend-verification through the same mail limiter', async () => {
    // The shared bucket is already over the limit from the previous test, so a
    // resend request is refused at the limiter before auth — proving the
    // endpoint is mounted on the mail limiter rather than being unlimited.
    const res = await srv.call('POST', '/api/auth/resend-verification');
    expect(res.status).toBe(429);
  });
});
