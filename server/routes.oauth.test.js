import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';
import { TEST_SIGNUP_DEFAULTS } from './testConsent.js';

/**
 * OAuth sign-in, sign-up, linking and unlinking.
 *
 * Runs against the mock provider transport, which is opt-in via
 * OAUTH_ALLOW_MOCK and takes the provider's claims from the `code` parameter.
 * That is exactly the shape the first test here guards: the transport used to
 * switch itself on whenever GOOGLE_CLIENT_ID was unset, which made a forgotten
 * environment variable into an unauthenticated sign-in-as-anyone endpoint.
 *
 * ── What v1.2b Task 6 changed about linking ──
 *
 * `POST /api/oauth/link` took an account password alongside an unauthenticated
 * 15-minute link token, which made it a pure password oracle. It is now an
 * authenticated route behind `requireAAL2('oauth.link')` with the provider bound
 * in, and the grant is spent inside the insert's transaction. Two consequences
 * are tested below: the caller must be signed in as the account the token names,
 * and an account with no password is no longer refused outright.
 */
describe('oauth', () => {
  let srv;
  // What testServer.js sets, so a test can mint the same link token the callback
  // mints. Kept as a constant rather than read from config.js, which reaches db.js.
  const JWT_SECRET = 'test-secret-not-for-production';

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
      signupData: { ...TEST_SIGNUP_DEFAULTS,
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
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'X', username: 'ok_name', role: 'student', grade: 'Kindergarten' }
    });
    expect(bad.res.status).toBe(400);
    expect(bad.res.body.field).toBe('grade');

    const worse = await begin('google', {
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'X', username: '1nvalid!', role: 'student', grade: '10' }
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
      signupData: { ...TEST_SIGNUP_DEFAULTS,
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
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'New Grad', username, role: 'student', grade: '11', skills: [] }
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
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'Returning Person', username, role: 'student', grade: '9', skills: [] }
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
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'MS User', username, role: 'student', grade: '10', skills: [] }
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

  /**
   * A link token for whoever already holds the address the provider returned.
   *
   * This is what somebody sees who presses "Continue with Google" while signed
   * out, on an address that already has a WeVolunteer account.
   */
  const linkTokenFor = async (email, sub, provider = 'google') => {
    const { state, nonceCookie } = await begin(provider);
    const res = await callback(provider, { code: identity({ email, sub }), state, nonceCookie });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('link_required');
    expect(res.body.linkToken).toBeTruthy();
    // Critically, no session was minted just for proving control of the address.
    expect(res.cookie).toBeNull();
    return res.body.linkToken;
  };

  const link = (linkToken, cookie, challengeId) =>
    srv.call('POST', '/api/oauth/link', { linkToken }, cookie, challengeId ? srv.reauthHeader(challengeId) : {});

  it('joins a provider to an existing account once identity is re-verified', async () => {
    const linkToken = await linkTokenFor('leo.chen28@gmail.com', 'sub-leo-google');

    // The person signs in the ordinary way, then verifies.
    const cookie = await srv.login('leo.chen28@gmail.com');
    const challengeId = await srv.stepUp(cookie, 'oauth.link', { params: { provider: 'google' } });

    const res = await link(linkToken, cookie, challengeId);
    expect(res.status).toBe(200);

    const accounts = await srv.call('GET', '/api/oauth/accounts', undefined, cookie);
    expect(accounts.body.some(a => a.provider === 'google')).toBe(true);

    /**
     * No new session is issued, and that is deliberate.
     *
     * It used to be, because the caller had just proved a password while signed
     * out. Re-issuing now would replace a jti-bearing session with the jti-less
     * one this file's `issueSession` used to mint — and a session with no jti can
     * have no challenge bound to it, so linking a provider would silently cost
     * the user the ability to verify anything else.
     */
    expect(res.cookie).toBeNull();
    const stillWorks = await srv.stepUp(cookie, 'oauth.link', { params: { provider: 'google' } });
    expect(stillWorks).toBeTruthy();
  });

  it('refuses a link presenting no verification at all', async () => {
    const linkToken = await linkTokenFor('leo.chen28@gmail.com', 'sub-leo-noverify');
    const cookie = await srv.login('leo.chen28@gmail.com');

    const res = await link(linkToken, cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('oauth.link');
  });

  it('refuses a link with no session at all', async () => {
    // It was an UNauthenticated endpoint: the token plus a password was the whole
    // proof. The session is now half of that proof, so there has to be one.
    const linkToken = await linkTokenFor('leo.chen28@gmail.com', 'sub-leo-nosession');
    const res = await srv.call('POST', '/api/oauth/link', { linkToken });
    expect(res.status).toBe(401);
  });

  it('refuses a grant obtained for a different action', async () => {
    const linkToken = await linkTokenFor('leo.chen28@gmail.com', 'sub-leo-crossaction');
    const cookie = await srv.login('leo.chen28@gmail.com');
    const forExport = await srv.stepUp(cookie, 'data.export');

    const res = await link(linkToken, cookie, forExport);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('oauth.link');
  });

  /**
   * The params binding. A verification obtained to connect Google must not
   * connect Microsoft — a different provider, a different `sub` namespace, and a
   * different row on the account. `requireAAL2` cannot catch this: it compares
   * the action only. `consumeChallenge` does, inside the handler's transaction,
   * against the provider actually about to be written.
   */
  it('refuses a grant bound to a different provider than the token names', async () => {
    const linkToken = await linkTokenFor('leo.chen28@gmail.com', 'sub-leo-boundprov');
    const cookie = await srv.login('leo.chen28@gmail.com');
    const forMicrosoft = await srv.stepUp(cookie, 'oauth.link', { params: { provider: 'microsoft' } });

    const res = await link(linkToken, cookie, forMicrosoft);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('params_mismatch');
  });

  it('spends the grant exactly once', async () => {
    const linkToken = await linkTokenFor('leo.chen28@gmail.com', 'sub-leo-single');
    const cookie = await srv.login('leo.chen28@gmail.com');
    const challengeId = await srv.stepUp(cookie, 'oauth.link', { params: { provider: 'google' } });

    expect((await link(linkToken, cookie, challengeId)).status).toBe(200);

    // A grant that survived its own use would be a second free provider link for
    // the rest of its five minutes.
    const replay = await link(linkToken, cookie, challengeId);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('reauth_required');
  });

  /**
   * The check that replaced the password, and the reason it is not optional.
   *
   * The token names the account to link, and used to be tied to the person
   * presenting it only by that account's password. Without a comparison against
   * the session, somebody who controls a provider account bearing a victim's
   * address could sign in as THEMSELVES, verify with their own credential, and
   * spend that grant to attach their provider identity to the victim's account —
   * after which "Continue with Google" signs them in as the victim.
   */
  it('refuses a link token that names a different account than the caller', async () => {
    const linkToken = await linkTokenFor('leo.chen28@gmail.com', 'sub-attacker-google');

    // Signed in as somebody else entirely, verified perfectly well as themselves.
    const attacker = await srv.login('emiller2027@gmail.com');
    const challengeId = await srv.stepUp(attacker, 'oauth.link', { params: { provider: 'google' } });

    const res = await link(linkToken, attacker, challengeId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('link_token_other_account');

    // Nothing was written against either account.
    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    const row = db.prepare('SELECT 1 FROM oauth_accounts WHERE provider_user_id = ?').get('sub-attacker-google');
    db.close();
    expect(row).toBeUndefined();
  });

  /**
   * The 409 this endpoint used to answer an account with no password.
   *
   * "That account has no password. Sign in with your existing provider instead."
   * — which was the only honest answer while a password was the only proof it
   * accepted, and which meant losing access to a single Google account was
   * losing the WeVolunteer account. Re-consent makes the question answerable, so
   * the refusal is gone.
   *
   * The link token is minted here rather than obtained from the callback,
   * because the callback has its OWN, separate 409 for this case
   * (`link_requires_other_provider`) which Task 6 left in place — see
   * task-6-report.md. The payload is exactly what the callback signs.
   */
  it('no longer refuses an account that has no password', async () => {
    const email = `secondprov-${Math.random().toString(36).slice(2, 9)}@example.org`;
    const username = `secondprov_${Math.random().toString(36).slice(2, 7)}`;
    const googleSub = `sub-${username}`;

    const { state, nonceCookie } = await begin('google', {
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'Two Providers', username, role: 'student', grade: '10', skills: [] }
    });
    const created = await callback('google', { code: identity({ email, sub: googleSub }), state, nonceCookie });
    expect(created.status).toBe(200);
    const cookie = created.cookie;
    expect(cookie).toBeTruthy();

    const linkToken = jwt.sign(
      {
        action: 'link', userId: created.body.user.id, provider: 'microsoft',
        providerUserId: `ms-${username}`, providerEmail: email
      },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    // Its only credential is the provider it already has, which is exactly what
    // it re-consents with.
    const challengeId = await srv.stepUpOAuth(cookie, 'oauth.link', {
      params: { provider: 'microsoft' }, provider: 'google', sub: googleSub
    });

    const res = await link(linkToken, cookie, challengeId);
    expect(res.status).toBe(200);

    const accounts = await srv.call('GET', '/api/oauth/accounts', undefined, cookie);
    expect(accounts.body.map(a => a.provider).sort()).toEqual(['google', 'microsoft']);

    // And with two ways in, the last-credential guard releases the first one —
    // untouched by this work, and the thing that made the 409 above defensible.
    //
    // Removing a provider is itself gated on `oauth.unlink` since the v1.2b
    // audit (F-2), so this re-consents again: still the account's only kind of
    // credential, and the grant binds the provider being removed.
    const unlinkChallenge = await srv.stepUpOAuth(cookie, 'oauth.unlink', {
      params: { provider: 'google' }, provider: 'google', sub: googleSub
    });
    const disconnected = await srv.call(
      'POST', '/api/oauth/disconnect', { provider: 'google' }, cookie, srv.reauthHeader(unlinkChallenge)
    );
    expect(disconnected.status).toBe(200);
  });

  /**
   * ── The `auto_linked` door (v1.2b Task 6b) ──
   *
   * `POST /api/oauth/link` serves the caller who is NOT signed in as the account
   * being linked (`link_required`). When the caller IS signed in as it — the
   * Settings case, and the one users actually reach — the link is made here, in
   * the callback, instead. Both require the provider's address to match the
   * account's; what differs is the session.
   * Both write the same `oauth_accounts` row, and that row is a new way to sign
   * in: the callback's returning-user branch logs in anyone presenting the
   * identity from then on. So both need the same proof, or the rule this
   * release states is only true of the door nobody uses.
   *
   * The challenge cannot be presented as a header here, because the callback
   * arrives mid-redirect from the provider. It is opened before the redirect
   * and carried across it in the signed state — which is why these tests pass
   * `challengeId` to `begin()` rather than to `callback()`.
   *
   * Regression preserved from before this gate: the signed-in user was once
   * read from an `Authorization: Bearer` header this app stopped using when
   * sessions moved into a cookie, so connecting a provider from Settings never
   * recognised the session and always fell through to the password prompt.
   */
  /**
   * A password account nobody else in this file touches.
   *
   * These tests share one database and run in order, and the FIRST auto-link
   * succeeds — after which `oauth_accounts` holds a row for that identity and
   * every later callback takes the returning-user branch and answers `login`
   * instead of ever reaching the gate. Reusing one seeded account made four of
   * these tests assert against a code path they were no longer exercising, and
   * pass. A fresh account per test is what keeps each one about its own claim.
   */
  let autoLinkSeq = 0;
  const AUTO_LINK_PASSWORD = 'AutoLink123';
  const linkableAccount = async () => {
    const tag = `autolink${++autoLinkSeq}${Math.random().toString(36).slice(2, 7)}`;
    const email = `${tag}@example.org`;
    const { cookie } = await srv.signupConfirmed({
      email, password: AUTO_LINK_PASSWORD, name: 'Auto Link',
      username: tag, role: 'student', grade: '10', skills: []
    });
    expect(cookie, 'fixture setup: signup did not return a session').toBeTruthy();
    return { email, cookie, sub: `ms-${tag}` };
  };

  it('links without a password when the session carries a verified oauth.link grant', async () => {
    const { email, cookie, sub } = await linkableAccount();

    const challengeId = await srv.stepUp(cookie, 'oauth.link', { params: { provider: 'microsoft' }, password: AUTO_LINK_PASSWORD });
    const { state, nonceCookie } = await begin('microsoft', { challengeId }, cookie);
    const res = await callback('microsoft', {
      code: identity({ email, sub }), state, nonceCookie, sessionCookie: cookie
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('auto_linked');

    const accounts = await srv.call('GET', '/api/oauth/accounts', undefined, cookie);
    expect(accounts.body.some(a => a.provider === 'microsoft')).toBe(true);
  });

  it('refuses to auto-link on a live session alone, naming the action to verify', async () => {
    const { email, cookie, sub } = await linkableAccount();

    // No challengeId. This is exactly what the flow did before Task 6b, and it
    // succeeded: holding the cookie was the whole proof for adding a credential.
    const { state, nonceCookie } = await begin('microsoft', {}, cookie);
    const res = await callback('microsoft', {
      code: identity({ email, sub }), state, nonceCookie, sessionCookie: cookie
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action, 'the client cannot open the right challenge without this').toBe('oauth.link');

    const accounts = await srv.call('GET', '/api/oauth/accounts', undefined, cookie);
    expect(accounts.body.some(a => a.provider === 'microsoft'), 'refused, but linked anyway').toBe(false);
  });

  it('refuses a grant for a different action', async () => {
    const { email, cookie, sub } = await linkableAccount();

    // A perfectly valid grant — for deleting the account. Verifying to do one
    // thing must not authorise another; that is the action binding.
    const challengeId = await srv.stepUp(cookie, 'account.delete', { password: AUTO_LINK_PASSWORD });
    const { state, nonceCookie } = await begin('microsoft', { challengeId }, cookie);
    const res = await callback('microsoft', {
      code: identity({ email, sub }), state, nonceCookie, sessionCookie: cookie
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('action_mismatch');

    const accounts = await srv.call('GET', '/api/oauth/accounts', undefined, cookie);
    expect(accounts.body.some(a => a.provider === 'microsoft')).toBe(false);
  });

  it('refuses a grant bound to a different provider', async () => {
    const { email, cookie, sub } = await linkableAccount();

    // Verified to connect Google; the callback is Microsoft. The handler spends
    // the provider it is ABOUT TO WRITE, not the one the client claimed, so
    // these cannot come apart.
    const challengeId = await srv.stepUp(cookie, 'oauth.link', { params: { provider: 'google' }, password: AUTO_LINK_PASSWORD });
    const { state, nonceCookie } = await begin('microsoft', { challengeId }, cookie);
    const res = await callback('microsoft', {
      code: identity({ email, sub }), state, nonceCookie, sessionCookie: cookie
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('params_mismatch');

    const accounts = await srv.call('GET', '/api/oauth/accounts', undefined, cookie);
    expect(accounts.body.some(a => a.provider === 'microsoft')).toBe(false);
  });

  it('spends the grant, so the same verification cannot link twice', async () => {
    const { email, cookie, sub } = await linkableAccount();
    const challengeId = await srv.stepUp(cookie, 'oauth.link', { params: { provider: 'microsoft' }, password: AUTO_LINK_PASSWORD });

    const first = await begin('microsoft', { challengeId }, cookie);
    const linked = await callback('microsoft', {
      code: identity({ email, sub }),
      state: first.state, nonceCookie: first.nonceCookie, sessionCookie: cookie
    });
    expect(linked.status).toBe(200);

    /**
     * A second whole flow reusing the SAME grant, and a DIFFERENT provider
     * identity — so the returning-user branch does not catch it and the
     * request genuinely reaches the gate again. The state is single-use via
     * `oauth_states`, so this needs a fresh one, which is exactly the point:
     * the state being spent is not what stops the replay. The challenge is.
     */
    const second = await begin('microsoft', { challengeId }, cookie);
    const replay = await callback('microsoft', {
      code: identity({ email, sub: `${sub}-second` }),
      state: second.state, nonceCookie: second.nonceCookie, sessionCookie: cookie
    });

    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('consumed');
  });

  /**
   * The regression that matters most. Login and signup do not add a credential
   * to an existing account — login requires the identity to be linked already,
   * signup creates the account the identity will own — so neither may have
   * acquired a verification requirement from this change.
   */
  it('leaves plain sign-in through a linked provider needing no verification', async () => {
    const { email, cookie, sub } = await linkableAccount();
    const challengeId = await srv.stepUp(cookie, 'oauth.link', { params: { provider: 'microsoft' }, password: AUTO_LINK_PASSWORD });
    const linkFlow = await begin('microsoft', { challengeId }, cookie);
    expect((await callback('microsoft', {
      code: identity({ email, sub }),
      state: linkFlow.state, nonceCookie: linkFlow.nonceCookie, sessionCookie: cookie
    })).status).toBe(200);

    // Now sign in with it, from no session at all and no challenge.
    const { state, nonceCookie } = await begin('microsoft');
    const res = await callback('microsoft', { code: identity({ email, sub }), state, nonceCookie });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('login');
    expect(res.cookie, 'sign-in did not issue a session').toBeTruthy();
  });

  it('will not disconnect the only way a provider-only account can sign in', async () => {
    const email = `onlyprov-${Math.random().toString(36).slice(2, 9)}@example.org`;
    const username = `onlyprov_${Math.random().toString(36).slice(2, 7)}`;
    const { state, nonceCookie } = await begin('google', {
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'Only Provider', username, role: 'student', grade: '10', skills: [] }
    });
    const created = await callback('google', { code: identity({ email, sub: `sub-${username}` }), state, nonceCookie });
    expect(created.cookie).toBeTruthy();

    // A real grant, so the request reaches the lockout guard rather than
    // stopping at `requireAAL2('oauth.unlink')` — otherwise this would assert
    // the gate and quietly stop testing the guard it is named for.
    const unlinkChallenge = await srv.stepUpOAuth(created.cookie, 'oauth.unlink', {
      params: { provider: 'google' }, provider: 'google', sub: `sub-${username}`
    });
    const res = await srv.call(
      'POST', '/api/oauth/disconnect', { provider: 'google' }, created.cookie,
      srv.reauthHeader(unlinkChallenge)
    );
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

  /**
   * The button must not be offered for a provider with no credentials, even
   * though this suite runs with OAUTH_ALLOW_MOCK=true.
   *
   * ── The bug ──
   *
   * `OAUTH_PROVIDERS_ENABLED` read `OAUTH_ALLOW_MOCK || <credentials present>`,
   * and OAUTH_ALLOW_MOCK defaults to `!IS_PRODUCTION`. So in ordinary development
   * every provider reported `enabled: true` regardless of configuration, and
   * ProviderButtons rendered a live "Continue with Microsoft" button.
   *
   * Pressing it did NOT reach the mock. The mock transport lives in
   * `verifyCallback`, which only runs after the provider redirects back;
   * `getAuthUrl` has no mock branch and builds a real
   * login.microsoftonline.com URL. With MICROSOFT_CLIENT_ID unset that URL
   * carried `client_id=`, and Microsoft answered:
   *
   *     AADSTS900144: The request body must contain the following parameter:
   *     'client_id'
   *
   * — a dead end on an advertised sign-in path. Google escaped it only because
   * real Google credentials happened to be present in .env.
   *
   * ── Why the listing and `resolveProvider` deliberately disagree ──
   *
   * They answer different questions. This endpoint answers "can a person with a
   * browser complete this flow", which needs a real client id. `resolveProvider`
   * answers "will this server process this provider", which under an explicit
   * mock opt-in is still yes — that is what lets the rest of this file drive the
   * callback with a mock identity. In production OAUTH_ALLOW_MOCK is off and
   * refuses to boot, so the two answers converge.
   */
  it('does not advertise a provider that has no credentials, even under the mock', async () => {
    expect(process.env.MICROSOFT_CLIENT_ID).toBeFalsy();

    const res = await srv.call('GET', '/api/oauth/providers');
    const microsoft = res.body.find(p => p.id === 'microsoft');

    // Implemented — the code is there and correct — but not usable here.
    expect(microsoft.implemented).toBe(true);
    expect(microsoft.enabled).toBe(false);
  });

  it('answers 501 rather than failing silently for Apple', async () => {
    const res = await srv.call('POST', '/api/oauth/apple/url', {});
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/not available yet/i);
  });
});
