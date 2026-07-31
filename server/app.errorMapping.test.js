import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Regression cover for the audit finding that an oversized request body was
 * reported as a server fault.
 *
 * `express.json({ limit: '100kb' })` rejects a large body by throwing an error
 * with `type: 'entity.too.large'`. The error handler only special-cased
 * `entity.parse.failed` (→ 400) and let everything else fall through to
 * `500 Internal server error`, so a client sending too much data was told the
 * server had broken. That is wrong twice over: the caller cannot tell it was
 * their fault and should shrink the payload, and every occurrence looks like a
 * server defect in error monitoring, which buries real 500s.
 */

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('request-body error mapping', () => {
  it('answers 413 for a body over the 100kb limit', async () => {
    const res = await srv.call('POST', '/api/auth/login', {
      email: 'x'.repeat(200_000),
      password: 'y'
    });
    expect(res.status).toBe(413);
  });

  it('says what went wrong and what to do, in the API error shape', async () => {
    const res = await srv.call('POST', '/api/auth/login', {
      email: 'x'.repeat(200_000),
      password: 'y'
    });
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/too large|too big/i);
    expect(res.body.code).toBe('payload_too_large');
  });

  it('still answers 400 for malformed JSON', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json'
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid json/i);
  });

  it('leaves a normal request unaffected', async () => {
    const res = await srv.call('POST', '/api/auth/login', { email: 'nobody@x.org', password: 'whatever' });
    expect([401, 429]).toContain(res.status);
  });
});
