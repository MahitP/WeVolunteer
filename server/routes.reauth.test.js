/**
 * The four step-up reauth endpoints, over real HTTP.
 *
 * `reauth.test.js` already pins the lifecycle rules against the module's own
 * return values. This file is about the layer above: what a CLIENT can observe,
 * and the three places where an HTTP boundary can quietly undo a correct
 * lifecycle.
 *
 *   1. `methods` must describe what THIS account can answer. Offering
 *      'password' to an account whose password_hash is the '!OAUTH_ONLY!'
 *      sentinel sends the user to a prompt no answer satisfies, and five wrong
 *      answers later the challenge is locked.
 *
 *   2. The OAuth redirect must actually force a re-authentication. `prompt` and
 *      `max_age` are the only things in the whole flow that distinguish "the
 *      person at the keyboard just proved who they are" from "the IdP still has
 *      a cookie for someone". Drop them and step-up degrades into a redirect
 *      that always succeeds — with every other test in this file still green,
 *      which is exactly why the assertions below read the generated URL rather
 *      than trusting the call site.
 *
 *   3. The callback must check the returned `sub` against THIS user's linked
 *      row. Without it, an attacker holding a stolen session clicks "verify
 *      with Google", signs in as themselves, and is re-verified as the victim.
 *
 * Passing `requireAAL2` is deliberately NOT treated as authorisation anywhere
 * below. The gate is an early refusal; the params binding, the session binding
 * and single use are all re-checked by `consumeChallenge` inside the handler's
 * transaction, which is Task 6's work. The cross-action test here asserts the
 * gate's half only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// db.js opens its connection at module scope, so nothing that reaches it may be
// imported statically here — see the long explanation in testServer.js.
let srv, db, utils, authz, reauth, sensitive;
let probeServer, probeBase;

const PASSWORD = 'CorrectHorse1';
const JWT_SECRET = 'test-secret-not-for-production'; // what testServer.js sets
let PASSWORD_HASH;

let seq = 0;

/** A user row straight in the database, optionally with linked providers. */
function makeUser({ passwordHash, providers = [] } = {}) {
  const id = `reauth-route-${++seq}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role,
                       verified, email_verified, created_at)
    VALUES (?, ?, ?, ?, ?, 'Adult', 'student', 1, 1, ?)
  `).run(id, 'Route Person', `${id}@example.org`, id, passwordHash ?? PASSWORD_HASH, now);

  for (const [provider, sub] of providers) {
    db.prepare(`
      INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`oauth-${id}-${provider}`, id, provider, sub, `${id}@example.org`, now, now);
  }
  return id;
}

/**
 * A signed session for a fixture user.
 *
 * `jti: null` mints the shape `authenticateToken` still admits but
 * `openChallenge` cannot bind to — tokens predating per-session revocation,
 * which stay valid for up to seven days after a deploy. (Provider sign-ins were
 * a second, permanent source of them until Task 6 gave oauthRoutes.js the shared
 * `issueSession`.) That case has to be a clean 401, never a 500.
 */
function sessionFor(userId, { jti = crypto.randomUUID() } = {}) {
  const u = db.prepare('SELECT id, role, email, name, token_version FROM users WHERE id = ?').get(userId);
  const payload = { id: u.id, email: u.email, name: u.name, tokenVersion: u.token_version ?? 0 };
  // Written through a computed key so this fixture never spells out a role
  // comparison; Guard 1 does not scan tests, but the habit is the point.
  payload.role = u.role;
  if (jti) payload.jti = jti;
  return { token: jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' }), userId, jti: jti || null };
}

/** One HTTP call against the real app. */
async function api(method, path, { body, session, challengeId, redirect = 'follow' } = {}) {
  const res = await fetch(srv.base + path, {
    method,
    redirect,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Cookie: `wev_session=${session.token}` } : {}),
      ...(challengeId ? { 'X-Reauth-Challenge': challengeId } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* redirect or empty body */ }
  return { status: res.status, body: parsed, location: res.headers.get('location') };
}

const challenge = (session, action, params) =>
  api('POST', '/api/auth/reauth/challenge', { session, body: { action, params } });

const verifyPassword = (session, challengeId, password) =>
  api('POST', '/api/auth/reauth/password', { session, body: { challengeId, password } });

const row = (id) => db.prepare('SELECT * FROM reauth_challenges WHERE id = ?').get(id);

/** The mock provider transport reads its claims straight out of `code`. */
const providerCode = (over = {}) => JSON.stringify({
  email: 'someone@example.org', sub: 'sub-default', name: 'Person', emailVerified: true, ...over
});

beforeAll(async () => {
  process.env.OAUTH_ALLOW_MOCK = 'true';
  // High on purpose: every test in this file shares one per-IP bucket, and the
  // limiter itself is exercised in routes.reauth.rateLimit.test.js where a low
  // limit is the point rather than a source of order-dependent flakiness.
  process.env.REAUTH_RATE_LIMIT = '1000';

  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  utils = await import('./utils.js');
  authz = await import('./authz.js');
  reauth = await import('./reauth.js');
  sensitive = await import('./sensitiveActions.js');
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 10);

  /**
   * A probe app for the cross-action test.
   *
   * No production route sits behind `requireAAL2` until Task 6, and inventing
   * one in app.js just to delete it later would be worse than this. The probe
   * mounts the REAL `authenticateToken` and the REAL `requireAAL2` against the
   * same throwaway database, so the grant under test is one this file obtained
   * through the real endpoints and is spent over a real HTTP request.
   */
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const probe = express();
  probe.use(express.json());
  probe.use(cookieParser());
  probe.get('/probe/delete', utils.authenticateToken, authz.requireAAL2('account.delete'),
    (req, res) => res.json({ ok: true, action: req.principal.aalAction }));
  probe.get('/probe/email', utils.authenticateToken, authz.requireAAL2('email.change'),
    (req, res) => res.json({ ok: true, action: req.principal.aalAction }));

  probeServer = probe.listen(0, '127.0.0.1');
  await new Promise(resolve => probeServer.once('listening', resolve));
  probeBase = `http://127.0.0.1:${probeServer.address().port}`;
}, 60000);

afterAll(async () => {
  await new Promise(resolve => (probeServer ? probeServer.close(resolve) : resolve()));
  await srv?.close?.();
  delete process.env.OAUTH_ALLOW_MOCK;
  delete process.env.REAUTH_RATE_LIMIT;
});

async function hitProbe(path, { session, challengeId }) {
  const res = await fetch(probeBase + path, {
    headers: {
      Cookie: `wev_session=${session.token}`,
      ...(challengeId ? { [sensitive.REAUTH_CHALLENGE_HEADER]: challengeId } : {})
    }
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body };
}

/* ── POST /api/auth/reauth/challenge ─────────────────────────────────────── */

describe('POST /api/auth/reauth/challenge', () => {
  it('refuses an action that is not in the registry, with 400', async () => {
    const session = sessionFor(makeUser());
    // One character off a real action. A typo must be a build-time-visible 400,
    // never a challenge that can be opened and never spent.
    const res = await challenge(session, 'account.delet', {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_action');
  });

  it('refuses a missing action with 400 rather than throwing', async () => {
    const session = sessionFor(makeUser());
    const res = await challenge(session, undefined, {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_action');
  });

  it('opens a bound challenge and reports the methods this account can answer', async () => {
    const userId = makeUser();
    const session = sessionFor(userId);
    const before = Date.now();
    const res = await challenge(session, 'email.change', { newEmail: 'new@example.org' });

    expect(res.status).toBe(201);
    expect(res.body.challengeId).toMatch(/^reauth-/);
    expect(res.body.methods).toEqual(['password']);
    expect(res.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // Five minutes, generated in JS as ISO-8601 UTC (TD-10) — not datetime('now').
    const ttl = new Date(res.body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(4 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000 + 5000);

    const r = row(res.body.challengeId);
    expect(r.user_id).toBe(userId);
    expect(r.action).toBe('email.change');
    expect(r.session_jti).toBe(session.jti);
    // The params the caller named are bound in, so this grant cannot later be
    // spent to move the address somewhere else.
    expect(r.params_hash).toBe(sensitive.paramsHash('email.change', { newEmail: 'new@example.org' }));
    expect(r.granted_at).toBe(null);
    expect(r.ip_hash).toBeTruthy();
    // Never the raw address of a minor.
    expect(r.ip_hash).not.toMatch(/127\.0\.0\.1|::1/);
  });

  it('does NOT offer password to a provider-only account', async () => {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-po-1']] });
    const res = await challenge(sessionFor(userId), 'account.delete', {});

    expect(res.status).toBe(201);
    expect(res.body.methods).not.toContain('password');
    expect(res.body.methods).toEqual(['oauth']);
  });

  it('offers both methods to an account that has a password AND a provider', async () => {
    const userId = makeUser({ providers: [['microsoft', 'sub-both-1']] });
    const res = await challenge(sessionFor(userId), 'account.delete', {});
    expect(res.body.methods.sort()).toEqual(['oauth', 'password']);
  });

  it('refuses, rather than opening an unanswerable challenge, when the account can prove nothing', async () => {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!' }); // no providers either
    const res = await challenge(sessionFor(userId), 'account.delete', {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_verification_method');
  });

  it('answers 401 with a distinguishable code — never 500 — for a session with no jti', async () => {
    const session = sessionFor(makeUser(), { jti: null });
    const res = await challenge(session, 'account.delete', {});

    /**
     * `openChallenge` THROWS on a missing jti, deliberately: a grant bound to no
     * session is spendable by anyone holding the id. `authenticateToken` still
     * admits jti-less tokens (they predate per-session revocation and stay valid
     * for up to seven days after a deploy), so this route is the only place the
     * two facts meet. An unhandled throw here is a 500 that tells the user
     * nothing and files a routine, recoverable situation as a server defect.
     */
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_not_bindable');
    // The instruction has to be actionable: signing in again mints a jti.
    expect(res.body.error).toMatch(/sign in again/i);
  });

  it('requires a session at all', async () => {
    const res = await api('POST', '/api/auth/reauth/challenge', { body: { action: 'account.delete' } });
    expect(res.status).toBe(401);
  });
});

/* ── POST /api/auth/reauth/password ──────────────────────────────────────── */

describe('POST /api/auth/reauth/password', () => {
  it('grants on the correct password', async () => {
    const session = sessionFor(makeUser());
    const opened = await challenge(session, 'account.delete', {});
    const res = await verifyPassword(session, opened.body.challengeId, PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(true);
    const r = row(opened.body.challengeId);
    expect(r.granted_at).toBeTruthy();
    expect(r.method).toBe('password');
    // Granting is not spending. Consumption belongs in the handler's own
    // transaction (Task 6), so the row must still be unconsumed here.
    expect(r.consumed_at).toBe(null);
  });

  it('rejects the wrong password with a countdown, without granting', async () => {
    const session = sessionFor(makeUser());
    const opened = await challenge(session, 'account.delete', {});
    const res = await verifyPassword(session, opened.body.challengeId, 'not-the-password');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_password');
    expect(res.body.attemptsRemaining).toBe(4);
    expect(row(opened.body.challengeId).granted_at).toBe(null);
  });

  it("tells a provider-only account why, instead of 'wrong password'", async () => {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-po-2']] });
    const session = sessionFor(userId);
    // The client should have read `methods` and never shown the prompt — but a
    // stale tab will, and '!OAUTH_ONLY!' is not a bcrypt hash, so a naive
    // compare returns false and reads as "wrong password" to someone who has no
    // password to be wrong about.
    const opened = await challenge(session, 'account.delete', {});
    const res = await verifyPassword(session, opened.body.challengeId, 'anything at all');

    expect(res.body.code).toBe('password_unavailable');
    expect(res.body.code).not.toBe('invalid_password');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no password/i);
    expect(res.body.error).toMatch(/provider/i);
    // And it must not have cost the user one of five guesses at a question they
    // were never able to answer.
    expect(row(opened.body.challengeId).attempts).toBe(0);
  });

  it("does not treat the sentinel itself as the password", async () => {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-po-3']] });
    const session = sessionFor(userId);
    const opened = await challenge(session, 'account.delete', {});
    const res = await verifyPassword(session, opened.body.challengeId, '!OAUTH_ONLY!');

    expect(res.status).toBe(409);
    expect(row(opened.body.challengeId).granted_at).toBe(null);
  });

  it("cannot be pointed at somebody else's challenge", async () => {
    const owner = sessionFor(makeUser());
    const stranger = sessionFor(makeUser());
    const opened = await challenge(owner, 'account.delete', {});

    const res = await verifyPassword(stranger, opened.body.challengeId, PASSWORD);
    expect(res.status).toBe(404);
    expect(row(opened.body.challengeId).granted_at).toBe(null);
  });

  it('locks the challenge after five wrong guesses', async () => {
    const session = sessionFor(makeUser());
    const opened = await challenge(session, 'account.delete', {});
    for (let i = 0; i < 5; i++) {
      await verifyPassword(session, opened.body.challengeId, `wrong-${i}`);
    }
    /* 429 either way; the code is `account_locked` because five wrong guesses is
       now the account's entire budget, not just this challenge's. The status and
       the refusal of the correct password are what this test is about. */
    const locked = await verifyPassword(session, opened.body.challengeId, PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('account_locked');
    expect(row(opened.body.challengeId).granted_at).toBe(null);
  });

  it('400s a missing challenge id rather than reaching the lifecycle', async () => {
    const session = sessionFor(makeUser());
    const res = await verifyPassword(session, undefined, PASSWORD);
    expect(res.status).toBe(400);
  });
});

/* ── The gate, end to end ────────────────────────────────────────────────── */

describe('a grant is spendable only for the action it was opened for', () => {
  it('satisfies requireAAL2 for its own action and refuses another, over HTTP', async () => {
    const session = sessionFor(makeUser());

    const opened = await challenge(session, 'email.change', { newEmail: 'a@x.com' });
    const granted = await verifyPassword(session, opened.body.challengeId, PASSWORD);
    expect(granted.status).toBe(200);
    const challengeId = opened.body.challengeId;

    const own = await hitProbe('/probe/email', { session, challengeId });
    expect(own.status).toBe(200);
    expect(own.body.action).toBe('email.change');

    /**
     * The same live grant, presented to a different action. If this ever
     * returns 200, verifying in order to change an email address also
     * authorises deleting the account — the single most valuable confusion an
     * attacker with a stolen session can hope for.
     */
    const other = await hitProbe('/probe/delete', { session, challengeId });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('reauth_required');
    expect(other.body.action).toBe('account.delete');
  });

  it('does not raise assurance for a grant belonging to a different session', async () => {
    const userId = makeUser();
    const here = sessionFor(userId);
    const elsewhere = sessionFor(userId);

    const opened = await challenge(here, 'email.change', { newEmail: 'a@x.com' });
    await verifyPassword(here, opened.body.challengeId, PASSWORD);

    const res = await hitProbe('/probe/email', { session: elsewhere, challengeId: opened.body.challengeId });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });
});

/* ── GET /api/auth/reauth/oauth/:provider ────────────────────────────────── */

describe('GET /api/auth/reauth/oauth/:provider', () => {
  async function redirectFor(provider, { session, challengeId }) {
    return api('GET', `/api/auth/reauth/oauth/${provider}?challengeId=${encodeURIComponent(challengeId)}`, {
      session, redirect: 'manual'
    });
  }

  async function openFor(providerName, sub = `sub-${crypto.randomUUID()}`) {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [[providerName, sub]] });
    const session = sessionFor(userId);
    const opened = await challenge(session, 'account.delete', {});
    expect(opened.status).toBe(201);
    return { userId, session, sub, challengeId: opened.body.challengeId };
  }

  it('forces a fresh Google sign-in: prompt=login AND max_age=0', async () => {
    const { session, challengeId } = await openFor('google');
    const res = await redirectFor('google', { session, challengeId });

    expect(res.status).toBe(302);
    const url = new URL(res.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');

    /**
     * The whole phase rests on these two parameters.
     *
     * Without them Google reissues an assertion from the session it already
     * has, and "step-up" becomes "the IdP still has a cookie for somebody" —
     * which is not a fresh proof of identity and is precisely the weakness the
     * username-typing deletion path had. `prompt=login` asks for
     * re-authentication; `max_age=0` says no cached authentication of any age
     * is acceptable, which is the belt to that braces.
     */
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    // The ordinary sign-in prompt must not survive into this flow: it lets
    // Google answer from an existing session.
    expect(url.searchParams.get('prompt')).not.toBe('select_account');

    // `state` is bound to this challenge, not merely present.
    const state = jwt.verify(url.searchParams.get('state'), JWT_SECRET);
    expect(state.challengeId).toBe(challengeId);
    expect(state.provider).toBe('google');
    expect(state.jti).toBe(session.jti);
  });

  it('forces a fresh Microsoft sign-in: prompt=login', async () => {
    const { session, challengeId } = await openFor('microsoft');
    const res = await redirectFor('microsoft', { session, challengeId });

    expect(res.status).toBe(302);
    const url = new URL(res.location);
    expect(url.hostname).toBe('login.microsoftonline.com');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('prompt')).not.toBe('select_account');
  });

  it('leaves the ordinary sign-in flow on select_account', async () => {
    // The forced re-authentication is scoped to step-up. Turning it on for
    // every sign-in would re-prompt returning students on every visit.
    const res = await api('POST', '/api/oauth/google/url', { body: {} });
    expect(res.status).toBe(200);
    expect(new URL(res.body.url).searchParams.get('prompt')).toBe('select_account');
    expect(new URL(res.body.url).searchParams.get('max_age')).toBe(null);
  });

  it('writes nothing — the redirect is a pure function of the challenge', async () => {
    const { session, challengeId } = await openFor('google');
    const before = row(challengeId);
    await redirectFor('google', { session, challengeId });
    expect(row(challengeId)).toEqual(before);
  });

  it('404s an unknown challenge instead of sending the user to the provider', async () => {
    const session = sessionFor(makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-x1']] }));
    const res = await redirectFor('google', { session, challengeId: 'reauth-does-not-exist' });
    expect(res.status).toBe(404);
    expect(res.location).toBe(null);
  });

  it("404s another user's challenge", async () => {
    const { challengeId } = await openFor('google');
    const stranger = sessionFor(makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-x2']] }));
    const res = await redirectFor('google', { session: stranger, challengeId });
    expect(res.status).toBe(404);
  });

  it('404s an unsupported provider and 501s Apple', async () => {
    const { session, challengeId } = await openFor('google');
    expect((await redirectFor('facebook', { session, challengeId })).status).toBe(404);
    expect((await redirectFor('apple', { session, challengeId })).status).toBe(501);
  });

  it('401s a jti-less session rather than minting an unbindable state', async () => {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-x3']] });
    const bound = sessionFor(userId);
    const opened = await challenge(bound, 'account.delete', {});
    const jtiless = sessionFor(userId, { jti: null });

    const res = await redirectFor('google', { session: jtiless, challengeId: opened.body.challengeId });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('session_not_bindable');
  });
});

/* ── POST /api/auth/reauth/oauth/:provider/callback ──────────────────────── */

describe('POST /api/auth/reauth/oauth/:provider/callback', () => {
  async function beginOAuth(providerName = 'google', sub = `sub-${crypto.randomUUID()}`) {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [[providerName, sub]] });
    const session = sessionFor(userId);
    const opened = await challenge(session, 'account.delete', {});
    const redirected = await api(
      'GET',
      `/api/auth/reauth/oauth/${providerName}?challengeId=${encodeURIComponent(opened.body.challengeId)}`,
      { session, redirect: 'manual' }
    );
    const state = new URL(redirected.location).searchParams.get('state');
    return { userId, session, sub, challengeId: opened.body.challengeId, state };
  }

  const complete = (providerName, { session, code, state }) =>
    api('POST', `/api/auth/reauth/oauth/${providerName}/callback`, { session, body: { code, state } });

  it('grants when the returned sub matches the linked account', async () => {
    const { session, sub, challengeId, state } = await beginOAuth('google');
    const res = await complete('google', { session, state, code: providerCode({ sub }) });

    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(true);
    const r = row(challengeId);
    expect(r.granted_at).toBeTruthy();
    expect(r.method).toBe('oauth');
    expect(r.consumed_at).toBe(null);
  });

  it('refuses a sub that is not the one linked to this account', async () => {
    const { session, challengeId, state } = await beginOAuth('google');

    /**
     * The attack this closes: a stolen session, "verify with Google", and the
     * attacker signs in as THEMSELVES. The provider honestly attests who is at
     * the keyboard; only this comparison ties that to the account being acted
     * on.
     */
    const res = await complete('google', { session, state, code: providerCode({ sub: 'attackers-own-google-id' }) });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('provider_mismatch');
    expect(row(challengeId).granted_at).toBe(null);
    // A mismatch is a guessable wrong answer, so it costs an attempt.
    expect(row(challengeId).attempts).toBe(1);
  });

  it('refuses a state minted for a different session', async () => {
    const a = await beginOAuth('google');
    const other = sessionFor(a.userId); // same user, different session
    const res = await complete('google', { session: other, state: a.state, code: providerCode({ sub: a.sub }) });

    expect(res.status).toBe(400);
    expect(row(a.challengeId).granted_at).toBe(null);
  });

  it('refuses a state minted for a different user', async () => {
    const a = await beginOAuth('google');
    const stranger = sessionFor(makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-s1']] }));
    const res = await complete('google', { session: stranger, state: a.state, code: providerCode({ sub: a.sub }) });

    expect(res.status).toBe(400);
    expect(row(a.challengeId).granted_at).toBe(null);
  });

  it('refuses a state naming a different user even when the session binding matches', async () => {
    /**
     * Isolating the `userId` predicate.
     *
     * The "different session" case above is caught by the `jti` check before
     * `userId` is ever consulted — mutation testing confirmed that deleting the
     * `userId` comparison broke nothing, because a session id is unique to one
     * account today and so implies it. That implication is a property of how
     * sessions happen to be minted, not something this route is told, so the
     * check stays and this test is what holds it up: a state carrying the
     * caller's own jti but somebody else's userId must still be refused.
     */
    const a = await beginOAuth('google');
    const victim = await beginOAuth('google');
    const crossed = jwt.sign(
      {
        purpose: 'reauth',
        challengeId: victim.challengeId,
        userId: victim.userId,
        provider: 'google',
        jti: a.session.jti
      },
      JWT_SECRET,
      { expiresIn: '5m' }
    );
    const res = await complete('google', { session: a.session, state: crossed, code: providerCode({ sub: victim.sub }) });

    expect(res.status).toBe(400);
    expect(row(victim.challengeId).granted_at).toBe(null);
  });

  it('refuses a state replayed at a different provider', async () => {
    const a = await beginOAuth('google');
    const res = await complete('microsoft', { session: a.session, state: a.state, code: providerCode({ sub: a.sub }) });
    expect(res.status).toBe(400);
    expect(row(a.challengeId).granted_at).toBe(null);
  });

  it('refuses a forged state', async () => {
    const a = await beginOAuth('google');
    const forged = jwt.sign(
      { action: 'reauth', challengeId: a.challengeId, userId: a.userId, provider: 'google', jti: a.session.jti },
      'not-the-signing-key',
      { expiresIn: '5m' }
    );
    const res = await complete('google', { session: a.session, state: forged, code: providerCode({ sub: a.sub }) });
    expect(res.status).toBe(400);
    expect(row(a.challengeId).granted_at).toBe(null);
  });

  it('refuses a state whose purpose is not reauth', async () => {
    // A sign-in state JWT is signed with the same key. It must not be spendable
    // here: those are minted without any session and prove nothing about the
    // caller.
    const a = await beginOAuth('google');
    const wrongPurpose = jwt.sign(
      { action: 'link', challengeId: a.challengeId, userId: a.userId, provider: 'google', jti: a.session.jti },
      JWT_SECRET,
      { expiresIn: '5m' }
    );
    const res = await complete('google', { session: a.session, state: wrongPurpose, code: providerCode({ sub: a.sub }) });
    expect(res.status).toBe(400);
    expect(row(a.challengeId).granted_at).toBe(null);
  });

  it('refuses when the provider is not linked to this account at all', async () => {
    const { session, challengeId, state } = await beginOAuth('google');
    db.prepare('DELETE FROM oauth_accounts WHERE user_id = ?').run(
      db.prepare('SELECT user_id FROM reauth_challenges WHERE id = ?').get(challengeId).user_id
    );
    const res = await complete('google', { session, state, code: providerCode({ sub: 'anything' }) });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('provider_not_linked');
    // No amount of guessing makes an unlinked provider linked, so nothing is spent.
    expect(row(challengeId).attempts).toBe(0);
  });

  it('400s a missing code', async () => {
    const { session, state } = await beginOAuth('google');
    const res = await complete('google', { session, state, code: undefined });
    expect(res.status).toBe(400);
  });
});
