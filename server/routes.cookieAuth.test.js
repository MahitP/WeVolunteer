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

/** Parses a Set-Cookie header into { value, attrs } — attrs lowercased for
 *  case-insensitive matching, since servers vary on capitalisation. */
function parseCookie(setCookie, name) {
  if (!setCookie) return null;
  const parts = setCookie.split(';').map(s => s.trim());
  const [k, ...rest] = parts[0].split('=');
  if (k !== name) return null;
  return {
    value: rest.join('='),
    attrs: parts.slice(1).map(a => a.toLowerCase())
  };
}

describe('login and signup issue a session cookie', () => {
  it('sets wev_session on a successful login', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen28@gmail.com', password: 'password123' })
    });
    expect(res.status).toBe(200);

    const cookie = parseCookie(res.headers.get('set-cookie'), 'wev_session');
    expect(cookie).not.toBeNull();
    expect(cookie.value.length).toBeGreaterThan(20);
  });

  it('marks the cookie HttpOnly, Lax, and rooted at /', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen28@gmail.com', password: 'password123' })
    });
    const cookie = parseCookie(res.headers.get('set-cookie'), 'wev_session');

    expect(cookie.attrs).toContain('httponly');
    expect(cookie.attrs).toContain('samesite=lax');
    expect(cookie.attrs).toContain('path=/');
  });

  it('does not mark the cookie Secure outside production', async () => {
    // Development runs over plain HTTP through the Vite proxy. A Secure cookie
    // is silently dropped there, which presents as "login works, every later
    // request is 401" — a failure with no visible cause.
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen28@gmail.com', password: 'password123' })
    });
    const cookie = parseCookie(res.headers.get('set-cookie'), 'wev_session');
    expect(cookie.attrs).not.toContain('secure');
  });

  it('sets no cookie when the password is wrong', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen28@gmail.com', password: 'wrong-password' })
    });
    expect(res.status).toBe(401);
    expect(parseCookie(res.headers.get('set-cookie'), 'wev_session')).toBeNull();
  });

  it('sets the cookie on signup as well, so a new account is signed in', async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const res = await fetch(`${srv.base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `cookie-${suffix}@example.org`, password: 'password123',
        name: 'Cookie Test', role: 'student', grade: '10', username: `cookie_${suffix}`
      })
    });
    expect(res.status).toBe(201);
    expect(parseCookie(res.headers.get('set-cookie'), 'wev_session')).not.toBeNull();
  });
});

describe('authenticateToken accepts the session cookie', () => {
  it('authenticates a request carrying a valid session cookie', async () => {
    const loginRes = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen28@gmail.com', password: 'password123' })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const cookieString = setCookie.split(';')[0]; // Extract just the name=value part

    const meRes = await fetch(`${srv.base}/api/auth/me`, {
      headers: { 'Cookie': cookieString }
    });
    
    expect(meRes.status).toBe(200);
    const body = await meRes.json();
    expect(body.email).toBe('leo.chen28@gmail.com');
  });

  it('rejects a request with no cookie and no header', async () => {
    const res = await fetch(`${srv.base}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed cookie', async () => {
    const res = await fetch(`${srv.base}/api/auth/me`, {
      headers: { 'Cookie': 'wev_session=not-a-valid-jwt' }
    });
    expect(res.status).toBe(403);
  });
});

describe('server-side logout', () => {
  it('clears the cookie and increments token_version to invalidate the old session', async () => {
    const loginRes = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen28@gmail.com', password: 'password123' })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const cookieString = setCookie.split(';')[0];
    
    const logoutRes = await fetch(`${srv.base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Cookie': cookieString }
    });
    
    expect(logoutRes.status).toBe(200);
    const logoutCookie = logoutRes.headers.get('set-cookie');
    expect(logoutCookie).toMatch(/wev_session=;/); // Value cleared
    
    const meRes = await fetch(`${srv.base}/api/auth/me`, {
      headers: { 'Cookie': cookieString }
    });
    // Old cookie is now rejected because token_version was incremented
    expect(meRes.status).toBe(401);
  });
});
