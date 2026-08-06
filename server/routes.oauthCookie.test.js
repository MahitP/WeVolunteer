/**
 * The session cookie an OAuth sign-in mints, and its attributes.
 *
 * ── The gap this closes ──
 *
 * `routes.cookieAuth.test.js` asserts that the session cookie is `HttpOnly`, `Lax`,
 * rooted at `/`, and not `Secure` outside production — but only on the **password**
 * login and signup paths. `routes.oauth.test.js` covers the OAuth flows thoroughly
 * (state replay, cross-provider replay, nonce cookies, linking, grants) and checks
 * that a cookie is RETURNED, never what it is set to.
 *
 * So the provider sign-in path had no assertion about the cookie's attributes at
 * all, and that is the half of "OAuth is broken" that is hardest to see: a cookie
 * with the wrong `SameSite` or a `Secure` flag set on plain HTTP is silently dropped
 * by the browser, which presents as "sign-in succeeds and then every request is
 * 401" — a failure with no error message anywhere.
 *
 * These are the same properties `cookieAuth` pins for `/login`, asserted on the path
 * that mints a session from a provider instead of from a password. The two paths mint
 * sessions through one function (`issueSession` in authRoutes.js) precisely so they
 * cannot drift; this is what would notice if they did.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('the session cookie minted by an OAuth sign-in', () => {
  let srv;

  beforeAll(async () => {
    process.env.OAUTH_ALLOW_MOCK = 'true';
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    delete process.env.OAUTH_ALLOW_MOCK;
  });

  /** Drives the real /url endpoint so the state JWT and its nonce cookie match. */
  async function begin(provider = 'google') {
    const res = await srv.call('POST', `/api/oauth/${provider}/url`, {});
    expect(res.status, 'could not begin an OAuth flow').toBe(200);
    const url = new URL(res.body.url);
    return {
      state: url.searchParams.get('state'),
      nonceCookie: (res.headers.get('set-cookie') || '')
        .match(/(wev_oauth_state_[a-f0-9]{8}=[^;]+)/)?.[1],
    };
  }

  /** Posts the callback with the composed cookie jar, returning the raw Set-Cookie. */
  async function callback(provider, { code, state, nonceCookie }) {
    const res = await fetch(`${srv.base}/api/oauth/${provider}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(nonceCookie && { Cookie: nonceCookie }) },
      body: JSON.stringify({ code, state }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    return { status: res.status, body, setCookie: res.headers.get('set-cookie') || '' };
  }

  const identity = (over = {}) => JSON.stringify({
    email: `oauth-cookie-${Math.random().toString(36).slice(2, 9)}@example.org`,
    sub: `sub-${Math.random().toString(36).slice(2, 9)}`,
    name: 'Cookie Person',
    emailVerified: true,
    ...over,
  });

  /**
   * A complete provider signup, which is the shortest path to a minted session:
   * an unknown identity returns `signup_required` with a token, and posting the
   * signup form with it creates the account and signs it in.
   */
  async function signUpThroughProvider() {
    const { state, nonceCookie } = await begin('google');
    const first = await callback('google', { code: identity(), state, nonceCookie });
    expect(first.status).toBe(200);
    expect(first.body.action).toBe('signup_required');

    const res = await srv.call('POST', '/api/auth/signup', {
      name: 'Cookie Person',
      username: `ck${Math.random().toString(36).slice(2, 9)}`,
      role: 'student',
      grade: '11',
      graduationYear: 2028,
      avatar: '👤',
      school: 'Test High',
      skills: [],
      dateOfBirth: '2009-05-04',
      consent: { termsOfService: true, privacyPolicy: true },
      email: first.body.email,
      signupToken: first.body.signupToken,
    });
    return res;
  }

  it('signs the new account in and returns a wev_session cookie', async () => {
    const res = await signUpThroughProvider();
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.headers.get('set-cookie') || '').toMatch(/wev_session=/);
  });

  it('marks it HttpOnly, Lax, and rooted at /', async () => {
    const res = await signUpThroughProvider();
    const c = res.headers.get('set-cookie') || '';
    // HttpOnly is what stops injected script reading the session; the CSP and this
    // are the pair that make cookie transport an upgrade over localStorage.
    expect(c).toMatch(/HttpOnly/i);
    // Lax is what stands in for a CSRF token in the single-origin topology
    // (config.js documents the reasoning). Losing it silently reintroduces CSRF.
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\//i);
  });

  it('does not mark it Secure outside production', async () => {
    // Development runs over plain HTTP through the Vite proxy, so a Secure cookie is
    // dropped by the browser — which presents as "OAuth works, then every request is
    // 401", with nothing in any log to explain it.
    const res = await signUpThroughProvider();
    expect(res.headers.get('set-cookie') || '').not.toMatch(/;\s*Secure/i);
  });

  it('produces a cookie that actually authenticates the next request', async () => {
    // The end-to-end property. Every attribute above can be right while the token
    // itself is unusable, so this spends the cookie on a real authenticated route.
    const res = await signUpThroughProvider();
    const token = (res.headers.get('set-cookie') || '').match(/wev_session=([^;]+)/)?.[1];
    expect(token, 'no session token to spend').toBeTruthy();

    // `/api/auth/me` spreads the formatted user at the top level, not under `user`.
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body.email).toMatch(/oauth-cookie-/);
  });

  it('sets no session cookie on a refused callback', async () => {
    // A forged state must not mint anything. Asserted on the header rather than the
    // status, because "refused with a session attached" is the failure that matters.
    const bad = await callback('google', {
      code: identity(), state: 'forged-state', nonceCookie: undefined,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.setCookie).not.toMatch(/wev_session=/);
  });

  it('sets no session cookie on the signup_required step', async () => {
    // The first callback for an unknown identity hands back a signup token, not a
    // session. A cookie here would sign somebody in before they had an account.
    const { state, nonceCookie } = await begin('google');
    const first = await callback('google', { code: identity(), state, nonceCookie });
    expect(first.body.action).toBe('signup_required');
    expect(first.setCookie).not.toMatch(/wev_session=/);
  });
});
