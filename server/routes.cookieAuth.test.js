import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';

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
      body: JSON.stringify({ email: 'leo.chen@example.com', password: 'password123' })
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
      body: JSON.stringify({ email: 'leo.chen@example.com', password: 'password123' })
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
      body: JSON.stringify({ email: 'leo.chen@example.com', password: 'password123' })
    });
    const cookie = parseCookie(res.headers.get('set-cookie'), 'wev_session');
    expect(cookie.attrs).not.toContain('secure');
  });

  it('sets no cookie when the password is wrong', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen@example.com', password: 'wrong-password' })
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
        ...TEST_SIGNUP_DEFAULTS,
        email: `cookie-${suffix}@example.org`, password: 'Password123',
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
      body: JSON.stringify({ email: 'leo.chen@example.com', password: 'password123' })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const cookieString = setCookie.split(';')[0]; // Extract just the name=value part

    const meRes = await fetch(`${srv.base}/api/auth/me`, {
      headers: { 'Cookie': cookieString }
    });
    
    expect(meRes.status).toBe(200);
    const body = await meRes.json();
    expect(body.email).toBe('leo.chen@example.com');
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
  const signIn = async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen@example.com', password: 'password123' })
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie').split(';')[0];
  };

  it('clears the session cookie', async () => {
    const cookieString = await signIn();

    const logoutRes = await fetch(`${srv.base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Cookie': cookieString }
    });

    expect(logoutRes.status).toBe(200);

    const logoutCookie = logoutRes.headers.get('set-cookie');
    expect(logoutCookie).toMatch(/wev_session=;/);
    // The clearing cookie must carry an expiry in the past. clearCookie sets
    // `expires` to the epoch, but res.cookie recomputes it from `maxAge`
    // whenever maxAge is present — so passing the full cookieOptions() through
    // would quietly set a seven-day cookie instead of deleting one.
    expect(logoutCookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
    expect(logoutCookie).not.toMatch(/Max-Age=[1-9]/);
  });

  /**
   * Logging out of one device must not log the account out of the others.
   *
   * Logout used to increment token_version, which invalidates every session the
   * account holds — so signing out of a shared school computer also signed the
   * same student out on their own phone, with no way to do one without the
   * other. The deliberate global case has its own route, asserted below.
   */
  it('leaves the account signed in on other devices', async () => {
    const phone = await signIn();
    const laptop = await signIn();

    const logoutRes = await fetch(`${srv.base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Cookie': laptop }
    });
    expect(logoutRes.status).toBe(200);

    const phoneRes = await fetch(`${srv.base}/api/auth/me`, {
      headers: { 'Cookie': phone }
    });
    expect(phoneRes.status).toBe(200);
  });

  it('sign-out-others invalidates every other session', async () => {
    const phone = await signIn();
    const laptop = await signIn();

    const res = await fetch(`${srv.base}/api/auth/sign-out-others`, {
      method: 'POST',
      headers: { 'Cookie': laptop }
    });
    expect(res.status).toBe(200);

    // The other device is gone...
    const phoneRes = await fetch(`${srv.base}/api/auth/me`, {
      headers: { 'Cookie': phone }
    });
    expect(phoneRes.status).toBe(401);

    // ...and the device that asked stays signed in, on a reissued cookie.
    const reissued = res.headers.get('set-cookie').split(';')[0];
    const stillMe = await fetch(`${srv.base}/api/auth/me`, {
      headers: { 'Cookie': reissued }
    });
    expect(stillMe.status).toBe(200);
  });
});

describe('severed Authorization header fallback', () => {
  it('rejects a request with an Authorization header but no cookie', async () => {
    const loginRes = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen@example.com', password: 'password123' })
    });
    const setCookie = loginRes.headers.get('set-cookie');
    const token = setCookie.match(/wev_session=([^;]+)/)?.[1];

    const meRes = await fetch(`${srv.base}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    expect(meRes.status).toBe(401);
  });
  
  it('does not return a token in the JSON body of login or signup', async () => {
    const loginRes = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.chen@example.com', password: 'password123' })
    });
    const loginBody = await loginRes.json();
    expect(loginBody.token).toBeUndefined();
    
    const signupRes = await fetch(`${srv.base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...TEST_SIGNUP_DEFAULTS, email: 'test_no_token@example.com', password: 'Password123', name: 'Test', role: 'student', grade: '9', username: 'test_no_token' })
    });
    const signupBody = await signupRes.json();
    expect(signupBody.token).toBeUndefined();
  });
});
