import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('Content-Security-Policy', () => {
  it('is sent on the health endpoint', async () => {
    const res = await fetch(`${srv.base}/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
  });

  it('restricts script to self, which is what stops injected script running', async () => {
    const res = await fetch(`${srv.base}/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('allows the Google Fonts stylesheet and font origins the app actually uses', async () => {
    const res = await fetch(`${srv.base}/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
  });

  it('forbids framing and plugin content', async () => {
    const res = await fetch(`${srv.base}/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('is sent on API responses too, not only static ones', async () => {
    const res = await fetch(`${srv.base}/api/events`);
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });
});
