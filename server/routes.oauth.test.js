import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/**
 * OAuth sign-in, sign-up, linking and unlinking.
 *
 * Runs against the mock provider transport, which is opt-in via
 * OAUTH_ALLOW_MOCK and takes the provider's claims from the `code` parameter.
 * That is exactly the shape the first test here guards: the transport used to
 * switch itself on whenever GOOGLE_CLIENT_ID was unset, which made a forgotten
 * environment variable into an unauthenticated sign-in-as-anyone endpoint.
 */
describe('oauth', () => {
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
  const begin = async (provider, body = {}, sessionCookie) => {
    const res = await srv.call('POST', `/api/oauth/${provider}/url`, body, sessionCookie);
    if (res.status !== 200) return { res, state: null, cookies: null };
    const url = new URL(res.body.url);
    const state = url.searchParams.get('state');
    const setCookie = res.headers.get('set-cookie') || '';
    const nonceCookie = setCookie.match(/(wev_oauth_state_[a-f0-9]{8}=[^;]+)/)?.[1];
    return { res, state, nonceCookie };
  };

  /**
   * The callback needs the state-nonce cookie, and sometimes the session
   * cookie too. testServer's `call` only speaks the session cookie, so this
   * posts directly with a composed Cookie header.
   */
  const callback = async (provider, { code, state, nonceCookie, sessionCookie }) => {
    const jar = [nonceCookie, sessionCookie && `wev_session=${sessionCookie}`].filter(Boolean).join('; ');
    const res = await fetch(`${srv.base}/api/oauth/${provider}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(jar && { Cookie: jar }) },
      body: JSON.stringify({ code, state })
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty body */ }
    const cookie = (res.headers.get('set-cookie') || '').match(/wev_session=([^;]+)/)?.[1] || null;
    return { status: res.status, body, cookie };
  };

  const identity = (over = {}) => JSON.stringify({
    email: `oauth-${Math.random().toString(36).slice(2, 9)}@example.org`,
    sub: `sub-${Math.random().toString(36).slice(2, 9)}`,
    name: 'OAuth Person',
    emailVerified: true,
    ...over
  });

  // ── The bypasses ──────────────────────────────────────────────────

  it('refuses a callback whose state was never issued by us', async () => {
    const res = await callback('google', {
      code: identity(),
      state: 'not.a.real.jwt',
      nonceCookie: 'wev_oauth_state_deadbeef=deadbeef'
    });
    expect(res.status).toBe(400);
    expect(res.cookie).toBeNull();
  });

  it('refuses a valid state presented without its nonce cookie (login CSRF)', async () => {
    const { state } = await begin('google');
    const res = await callback('google', { code: identity(), state });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/security validation/i);
    expect(res.cookie).toBeNull();
  });

  it('refuses a state minted for one provider replayed at another', async () => {
    const { state, nonceCookie } = await begin('google');
    const res = await callback('microsoft', { code: identity(), state, nonceCookie });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider mismatch/i);
  });

  /**
   * Server-side single use of the state nonce.
   *
   * The audit found replay prevented ONLY by clearing the HttpOnly nonce cookie.
   * A browser honours that, but a client that simply retains the cookie could
   * present the same state again — the server kept no record of having seen it.
   * The `oauth_states` row is now consumed on first use, so the second attempt
   * fails on the server rather than on the client's good manners.
   *
   * Not exploitable on its own (the authorization code is single-use at the real
   * provider) but it is the layer that should not depend on that.
   */
  it('refuses a state that has already been used, even with the cookie replayed', async () => {
    const { state, nonceCookie } = await begin('google');
    const code = identity();

    const first = await callback('google', { code, state, nonceCookie });
    expect(first.status).toBe(200);

    // Same state, same nonce cookie, deliberately re-presented.
    const second = await callback('google', { code, state, nonceCookie });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/expired or already used/i);
  });

  it('consumes the oauth_states row on first use', async () => {
    const { state, nonceCookie } = await begin('google');
    const nonce = JSON.parse(
      Buffer.from(state.split('.')[1], 'base64url').toString()
    ).nonce;

    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    const before = db.prepare('SELECT COUNT(*) AS c FROM oauth_states WHERE nonce = ?').get(nonce).c;

    await callback('google', { code: identity(), state, nonceCookie });

    const after = db.prepare('SELECT COUNT(*) AS c FROM oauth_states WHERE nonce = ?').get(nonce).c;
    db.close();

    expect(before).toBe(1);
    expect(after).toBe(0);
  });

  it('refuses a state whose nonce was never issued', async () => {
    // A structurally valid, correctly signed state for a nonce with no row —
    // which is what a forged or long-expired state looks like.
    const { state, nonceCookie } = await begin('google');
    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    db.prepare('DELETE FROM oauth_states').run();
    db.close();

    const res = await callback('google', { code: identity(), state, nonceCookie });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired or already used/i);
  });

  /**
   * Regression, privilege escalation. The pending-signup blob was written
   * straight into the users table on the way back, with no validation at all,
   * so `role: "admin"` in it self-registered an administrator — bypassing the
   * ['student','organizer'] guard the ordinary signup route has always had.
   */
  it('refuses to let a pending signup assign itself the admin role', async () => {
    const { res } = await begin('google', {
      signupData: {
        name: 'Sneaky Person', username: 'sneaky_admin', role: 'admin',
        grade: 'N/A', school: 'Nowhere', skills: []
      }
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('role');

    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    const row = db.prepare('SELECT 1 FROM users WHERE username = ?').get('sneaky_admin');
    db.close();
    expect(row).toBeUndefined();
  });

  it('refuses a pending signup with an invalid grade or username', async () => {
    const bad = await begin('google', {
      signupData: { name: 'X', username: 'ok_name', role: 'student', grade: 'Kindergarten' }
    });
    expect(bad.res.status).toBe(400);
    expect(bad.res.body.field).toBe('grade');

    const worse = await begin('google', {
      signupData: { name: 'X', username: '1nvalid!', role: 'student', grade: '10' }
    });
    expect(worse.res.status).toBe(400);
    expect(worse.res.body.field).toBe('username');
  });

  /**
   * Regression, credential exposure. The pending signup used to travel as a
   * base64 query parameter — landing in every proxy access log — and was then
   * stored in oauth_signup_sessions as plaintext JSON including the password.
   */
  it('never stores a password in the pending-signup row', async () => {
    await begin('google', {
      signupData: {
        name: 'Pending Person', username: 'pending_person', role: 'student',
        grade: '10', password: 'SuperSecret123', skills: []
      }
    });

    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    const rows = db.prepare('SELECT signup_data FROM oauth_signup_sessions').all();
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.signup_data).not.toContain('SuperSecret123');
      expect(JSON.parse(r.signup_data)).not.toHaveProperty('password');
    }
  });

  // ── The happy paths ───────────────────────────────────────────────

  it('signs a brand new person up through the provider and signs them in', async () => {
    const email = `newgrad-${Math.random().toString(36).slice(2, 9)}@example.org`;
    const username = `newgrad_${Math.random().toString(36).slice(2, 7)}`;
    const { state, nonceCookie } = await begin('google', {
      signupData: { name: 'New Grad', username, role: 'student', grade: '11', skills: [] }
    });

    const res = await callback('google', {
      code: identity({ email, sub: `sub-${username}` }), state, nonceCookie
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('login');
    expect(res.body.user.username).toBe(username);
    expect(res.body.user.role).toBe('student');
    expect(res.cookie).toBeTruthy();
    // Google attests to the address, so no second confirmation is demanded.
    expect(res.body.emailVerified).toBe(true);
  });

  it('recognises the same provider identity on the next visit', async () => {
    const email = `returning-${Math.random().toString(36).slice(2, 9)}@example.org`;
    const sub = `sub-returning-${Math.random().toString(36).slice(2, 7)}`;
    const username = `returning_${Math.random().toString(36).slice(2, 7)}`;

    const first = await begin('google', {
      signupData: { name: 'Returning Person', username, role: 'student', grade: '9', skills: [] }
    });
    const created = await callback('google', { code: identity({ email, sub }), state: first.state, nonceCookie: first.nonceCookie });
    expect(created.body.action).toBe('login');

    const second = await begin('google');
    const again = await callback('google', { code: identity({ email, sub }), state: second.state, nonceCookie: second.nonceCookie });
    expect(again.status).toBe(200);
    expect(again.body.action).toBe('login');
    expect(again.body.user.id).toBe(created.body.user.id);
  });

  /**
   * Microsoft's Graph attributes carry no proof-of-control claim and can be
   * set arbitrarily inside a tenant the caller administers, so an address
   * arriving that way must still be confirmed by mail.
   */
  it('does not treat a Microsoft address as confirmed', async () => {
    const email = `msuser-${Math.random().toString(36).slice(2, 9)}@example.org`;
    const username = `msuser_${Math.random().toString(36).slice(2, 7)}`;
    const { state, nonceCookie } = await begin('microsoft', {
      signupData: { name: 'MS User', username, role: 'student', grade: '10', skills: [] }
    });

    const res = await callback('microsoft', {
      code: JSON.stringify({ email, sub: `ms-${username}`, name: 'MS User' }),
      state, nonceCookie
    });
    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(false);

    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    const row = db.prepare('SELECT email_verified FROM users WHERE username = ?').get(username);
    const pending = db.prepare('SELECT 1 FROM email_verification_tokens WHERE user_id = (SELECT id FROM users WHERE username = ?)').get(username);
    db.close();
    expect(row.email_verified).toBe(0);
    expect(pending).toBeTruthy();
  });

  it('asks an unknown provider identity to complete a signup form', async () => {
    const { state, nonceCookie } = await begin('google');
    const res = await callback('google', { code: identity(), state, nonceCookie });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('signup_required');
    expect(res.body.signupToken).toBeTruthy();
    expect(res.cookie).toBeNull();
  });

  // ── Linking ───────────────────────────────────────────────────────

  it('demands the account password before joining a provider to an existing account', async () => {
    const { state, nonceCookie } = await begin('google');
    const res = await callback('google', {
      code: identity({ email: 'leo.chen28@gmail.com', sub: 'sub-leo-google' }),
      state, nonceCookie
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('link_required');
    expect(res.body.linkToken).toBeTruthy();
    // Critically, no session was minted just for proving control of the address.
    expect(res.cookie).toBeNull();

    const wrong = await srv.call('POST', '/api/oauth/link', { linkToken: res.body.linkToken, password: 'NotThePassword1' });
    expect(wrong.status).toBe(401);

    const right = await srv.call('POST', '/api/oauth/link', { linkToken: res.body.linkToken, password: 'password123' });
    expect(right.status).toBe(200);
    expect(right.cookie).toBeTruthy();
  });

  /**
   * Regression. The signed-in user was read from an `Authorization: Bearer`
   * header this app stopped using when sessions moved into a cookie, so
   * connecting a provider from Settings never recognised the session and
   * always fell through to the password prompt.
   */
  it('links without a password when the request carries that user\'s own session', async () => {
    const sessionCookie = await srv.login('priya.patel.nhs@outlook.com');
    expect(sessionCookie).toBeTruthy();

    const { state, nonceCookie } = await begin('microsoft', {}, sessionCookie);
    const res = await callback('microsoft', {
      code: JSON.stringify({ email: 'priya.patel.nhs@outlook.com', sub: 'ms-priya', name: 'Priya' }),
      state, nonceCookie, sessionCookie
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('auto_linked');

    const accounts = await srv.call('GET', '/api/oauth/accounts', undefined, sessionCookie);
    expect(accounts.body.some(a => a.provider === 'microsoft')).toBe(true);
  });

  it('will not disconnect the only way a provider-only account can sign in', async () => {
    const email = `onlyprov-${Math.random().toString(36).slice(2, 9)}@example.org`;
    const username = `onlyprov_${Math.random().toString(36).slice(2, 7)}`;
    const { state, nonceCookie } = await begin('google', {
      signupData: { name: 'Only Provider', username, role: 'student', grade: '10', skills: [] }
    });
    const created = await callback('google', { code: identity({ email, sub: `sub-${username}` }), state, nonceCookie });
    expect(created.cookie).toBeTruthy();

    const res = await srv.call('POST', '/api/oauth/disconnect', { provider: 'google' }, created.cookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('last_sign_in_method');

    const still = await srv.call('GET', '/api/oauth/accounts', undefined, created.cookie);
    expect(still.body.length).toBe(1);
  });

  it('reports which providers are actually usable', async () => {
    const res = await srv.call('GET', '/api/oauth/providers');
    expect(res.status).toBe(200);
    const apple = res.body.find(p => p.id === 'apple');
    expect(apple.implemented).toBe(false);
    expect(apple.enabled).toBe(false);
  });

  it('answers 501 rather than failing silently for Apple', async () => {
    const res = await srv.call('POST', '/api/oauth/apple/url', {});
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/not available yet/i);
  });
});
