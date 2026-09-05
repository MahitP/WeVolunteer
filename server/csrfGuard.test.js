import { describe, it, expect, vi } from 'vitest';
import { csrfGuard } from './csrfGuard.js';
import { COOKIE_NAME } from './config.js';

/**
 * The attack this file is about:
 *
 *   A page on wevolunteers.org (the marketing site, or anything else ever
 *   hosted on a sibling subdomain) submits a POST to app.wevolunteers.org.
 *   Those are the SAME SITE, so `SameSite=Lax` attaches the session cookie and
 *   the request arrives fully authenticated as the victim.
 *
 * `Sec-Fetch-Site: same-site` is what the browser says about that request, and
 * it is the only signal here that distinguishes it from a legitimate one.
 */
function mk({ method = 'POST', site, cookie = `${COOKIE_NAME}=abc`, cookies } = {}) {
  const headers = {};
  if (site) headers['sec-fetch-site'] = site;
  if (cookie) headers.cookie = cookie;
  return { method, headers, cookies };
}

function run(req) {
  const next = vi.fn();
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  csrfGuard(req, res, next);
  return { next, res, blocked: res.statusCode === 403 };
}

describe('csrfGuard — refuses', () => {
  it('a same-site POST from a sibling subdomain (the split-domain attack)', () => {
    const { blocked, res } = run(mk({ site: 'same-site' }));
    expect(blocked).toBe(true);
    expect(res.body.code).toBe('CSRF_REFUSED');
  });

  it('a cross-site POST', () => {
    expect(run(mk({ site: 'cross-site' })).blocked).toBe(true);
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`a ${method} — every state-changing method is covered`, () => {
      expect(run(mk({ method, site: 'same-site' })).blocked).toBe(true);
    });
  }

  it('reads the raw Cookie header, so it does not fail open if cookie-parser moves', () => {
    // req.cookies deliberately absent — only the raw header is present.
    const { blocked } = run({
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', cookie: `other=1; ${COOKIE_NAME}=abc` },
    });
    expect(blocked).toBe(true);
  });

  it('does not name the offending origin in the response', () => {
    const { res } = run({
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-site', origin: 'https://marketing.wevolunteers.org', cookie: `${COOKIE_NAME}=a` },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/marketing/);
  });
});

describe('csrfGuard — allows', () => {
  it('a same-origin POST, which is the entire normal case', () => {
    expect(run(mk({ site: 'same-origin' })).next).toHaveBeenCalled();
  });

  it('Sec-Fetch-Site: none — a typed URL or a non-browser client', () => {
    expect(run(mk({ site: 'none' })).next).toHaveBeenCalled();
  });

  it('safe methods, which cannot change state', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(run(mk({ method, site: 'cross-site' })).next).toHaveBeenCalled();
    }
  });

  /**
   * CSRF is an ambient-credential attack. With no session cookie there is
   * nothing to abuse, and refusing these would break the non-browser callers
   * the CORS layer deliberately admits — health checks, the a11y harness, curl.
   */
  it('a cross-site request carrying NO session cookie', () => {
    expect(run(mk({ site: 'cross-site', cookie: null })).next).toHaveBeenCalled();
  });

  it('a request with a different cookie but no session cookie', () => {
    expect(run(mk({ site: 'cross-site', cookie: 'theme=dark' })).next).toHaveBeenCalled();
  });

  /**
   * Not a bypass: a client that omits Sec-Fetch-Site is not a browser, so it
   * had to attach the cookie deliberately — which an attacker cannot cause. The
   * Origin allowlist in app.js is the layer that covers this case.
   */
  it('a request from a client that sends no Sec-Fetch-Site at all', () => {
    expect(run(mk({ site: undefined })).next).toHaveBeenCalled();
  });

  it('an unrecognised Sec-Fetch-Site value rather than guessing', () => {
    expect(run(mk({ site: 'weird-future-value' })).next).toHaveBeenCalled();
  });
});

/**
 * The cookie name must come from config, not be re-spelled here. A guard that
 * checks for the wrong cookie name allows everything, and would still pass
 * every test above if those tests hardcoded the same wrong name.
 */
describe('csrfGuard — wiring', () => {
  it('keys on the configured session cookie name', () => {
    expect(COOKIE_NAME).toBeTruthy();
    const withSession = run({ method: 'POST', headers: { 'sec-fetch-site': 'same-site', cookie: `${COOKIE_NAME}=x` } });
    const withoutSession = run({ method: 'POST', headers: { 'sec-fetch-site': 'same-site', cookie: 'notthesession=x' } });
    expect(withSession.blocked).toBe(true);
    expect(withoutSession.blocked).toBe(false);
  });
});
