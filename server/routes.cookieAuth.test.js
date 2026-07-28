import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

/**
 * Returns one directive's full text from a CSP header, e.g. "script-src 'self'".
 *
 * Directive-scoped rather than substring matching, because a substring test
 * cannot tell where a source landed. `csp.toContain("script-src 'self'")`
 * passes just as happily against `script-src 'self' 'unsafe-inline'` — it is a
 * prefix — so the assertion that is supposed to be load-bearing here would go
 * green on exactly the regression it exists to catch.
 *
 * The trailing space in the startsWith check is doing real work: helmet emits
 * `script-src-attr 'none'` by default, and a bare prefix match on "script-src"
 * would return that instead. Matching `name + ' '` keeps the two apart.
 */
function directive(csp, name) {
  return csp
    .split(';')
    .map(d => d.trim())
    .find(d => d === name || d.startsWith(name + ' '));
}

describe('Content-Security-Policy', () => {
  it('is sent on the health endpoint', async () => {
    const res = await fetch(`${srv.base}/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
  });

  it('restricts script to self, which is what stops injected script running', async () => {
    const res = await fetch(`${srv.base}/health`);
    const csp = res.headers.get('content-security-policy');

    // Strict equality, not containment: script-src must be 'self' and nothing
    // else. Anything appended — an origin, 'unsafe-inline', 'unsafe-eval' —
    // fails here, which is the point.
    expect(directive(csp, 'script-src')).toBe("script-src 'self'");
  });

  it('allows the Google Fonts origins on the directives that actually need them', async () => {
    const res = await fetch(`${srv.base}/health`);
    const csp = res.headers.get('content-security-policy');

    // Scoped per directive: googleapis serves the stylesheet, gstatic serves
    // the font files. Asserting they appear somewhere in the header would pass
    // even if one had been attached to script-src by mistake.
    expect(directive(csp, 'style-src')).toContain('https://fonts.googleapis.com');
    expect(directive(csp, 'font-src')).toContain('https://fonts.gstatic.com');
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
