/**
 * Assurance level: `requireAAL2` and the per-request resolution behind it.
 *
 * Two halves, tested two ways on purpose.
 *
 * `requireAAL2` is pure — it reads values already sitting on the principal —
 * so it is tested with plain objects and no server at all. That is the whole
 * point of keeping it in `authz.js`: a gate you can reason about without a
 * database is a gate you can reason about.
 *
 * Resolution is the opposite: it is entirely about which rows in
 * `reauth_challenges` may raise a request's assurance, so those tests drive a
 * real challenge through `openChallenge` → `grantByPassword` and then present
 * it over HTTP to a route mounted behind the real `authenticateToken`.
 *
 * ── The five bindings ──
 *
 * A grant raises assurance only for the action, the user, and the session it
 * was opened for, only while it is unexpired, and only until it is spent. Each
 * of those has a test below whose failure is the only thing standing between a
 * stolen session and a free sensitive action.
 *
 * ── The two properties that are not about security ──
 *
 * 1. Nothing here consumes. `authenticateToken` runs before the handler, and a
 *    middleware that spends the grant on the way in burns it even when the
 *    handler then rejects the request for an unrelated reason — leaving the
 *    user to re-verify for a request that never happened. Consumption belongs
 *    in the handler's transaction, next to the work it authorises.
 *
 * 2. A request with no challenge id costs nothing. `authenticateToken` runs on
 *    every authenticated request in the app, so a query added here is a query
 *    added to everything. Both a call-counting unit test and a statement-level
 *    count over a real HTTP round trip assert that.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// db.js opens its connection at module scope, so nothing that reaches it may be
// imported statically here — see the long explanation in testServer.js.
let srv, db, utils, authz, reauth;
let probeServer, probeBase;

const PASSWORD = 'password123';

/** A demo account's id and current session, plus that session's jti. */
function sessionOf(token) {
  const claims = jwt.decode(token);
  return { token, userId: claims.id, jti: claims.jti };
}

let alice, aliceOther, bob;

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  utils = await import('./utils.js');
  authz = await import('./authz.js');
  reauth = await import('./reauth.js');

  alice = sessionOf(await srv.login('leo.chen28@gmail.com', PASSWORD));
  aliceOther = sessionOf(await srv.login('leo.chen28@gmail.com', PASSWORD));
  bob = sessionOf(await srv.login('jkatzenback@vikings.org', PASSWORD));

  expect(alice.jti, 'the two Alice sessions must be distinguishable').not.toBe(aliceOther.jti);
  expect(alice.userId).not.toBe(bob.userId);

  /**
   * A second, minimal Express app rather than a route bolted onto the real one.
   *
   * The routes that need AAL2 arrive in Task 5; this task ships the gate and
   * the resolution. Mounting a probe here exercises the real
   * `authenticateToken` and the real `requireAAL2` over a real HTTP request,
   * against the same throwaway database, without inventing a production route
   * that would then have to be deleted.
   */
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;

  const probe = express();
  probe.use(express.json());
  probe.use(cookieParser());
  probe.get('/probe/delete', utils.authenticateToken, authz.requireAAL2('account.delete'), (req, res) => {
    res.json({ ok: true, aal: req.principal.aal, aalAction: req.principal.aalAction });
  });
  probe.get('/probe/email', utils.authenticateToken, authz.requireAAL2('email.change'), (req, res) => {
    res.json({ ok: true });
  });
  // No gate: reports whatever assurance resolution decided, so a test can watch
  // the resolution itself rather than only the gate's verdict.
  probe.get('/probe/open', utils.authenticateToken, (req, res) => {
    res.json({ aal: req.principal.aal, aalAction: req.principal.aalAction ?? null });
  });

  probeServer = probe.listen(0, '127.0.0.1');
  await new Promise(resolve => probeServer.once('listening', resolve));
  probeBase = `http://127.0.0.1:${probeServer.address().port}`;
}, 60000);

afterAll(async () => {
  await new Promise(resolve => (probeServer ? probeServer.close(resolve) : resolve()));
  await srv?.close?.();
});

/** GET the probe app with a session cookie and, optionally, a challenge id. */
async function hit(path, { session, challengeId } = {}) {
  const res = await fetch(probeBase + path, {
    headers: {
      ...(session ? { Cookie: `wev_session=${session.token}` } : {}),
      ...(challengeId ? { 'X-Reauth-Challenge': challengeId } : {})
    }
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body };
}

/** An open, granted challenge for one action, bound to one session. */
async function grantedChallenge({ session, action = 'account.delete', params = {} }) {
  const { id } = reauth.openChallenge({
    db, userId: session.userId, action, params, sessionJti: session.jti
  });
  const granted = await reauth.grantByPassword({
    db, challengeId: id, userId: session.userId, password: PASSWORD
  });
  expect(granted.ok, `fixture: the challenge must actually be granted (${granted.error})`).toBe(true);
  return id;
}

const challengeRow = (id) => db.prepare('SELECT * FROM reauth_challenges WHERE id = ?').get(id);

/* ── requireAAL2: the gate itself, with no server and no database ──────────── */

function mockRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

describe('requireAAL2 — the gate', () => {
  const gate = () => authz.requireAAL2('account.delete');

  it('refuses to be constructed without an action', () => {
    expect(() => authz.requireAAL2()).toThrow(/action is required/);
    expect(() => authz.requireAAL2('')).toThrow(/action is required/);
  });

  it('returns a middleware named assuranceGate', () => {
    expect(gate().name).toBe('assuranceGate');
  });

  it('answers 401, not 403, when there is no principal at all', () => {
    const res = mockRes();
    const next = vi.fn();
    gate()({}, res, next);

    // "sign in" and "prove it is still you" are different instructions, and the
    // second one is useless to someone who is not signed in.
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 403 with code reauth_required for an AAL1 principal', () => {
    const res = mockRes();
    const next = vi.fn();
    gate()({ principal: authz.principalFor({ id: 'u1', role: 'student' }) }, res, next);

    expect(res.statusCode).toBe(403);
    // The distinct code is the whole point: a bare 403 tells the client
    // "you may never do this", which sends the UI down a dead end.
    expect(res.payload.code).toBe('reauth_required');
    expect(res.payload.action).toBe('account.delete');
    expect(next).not.toHaveBeenCalled();
  });

  it('does not accept a grant for a DIFFERENT action', () => {
    const res = mockRes();
    const next = vi.fn();
    const principal = authz.principalFor({ id: 'u1', role: 'student' }, {
      aal: 2, aalAction: 'email.change'
    });
    gate()({ principal }, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.payload.code).toBe('reauth_required');
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a grant for its own action', () => {
    const res = mockRes();
    const next = vi.fn();
    const principal = authz.principalFor({ id: 'u1', role: 'student' }, {
      aal: 2, aalAction: 'account.delete'
    });
    gate()({ principal }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it('performs no I/O — authz.js still imports nothing relative', async () => {
    // authz.test.js owns this assertion in general; repeated here because
    // requireAAL2 is the function most likely to tempt someone into importing
    // reauth.js or sensitiveActions.js to validate its argument.
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('./authz.js', import.meta.url), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    const relative = [...code.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]*)['"]/g)];
    expect(relative.map(m => m[1])).toEqual([]);
  });
});

/* ── resolveAssurance: what it costs, and when it declines to look ─────────── */

describe('resolveAssurance — cost', () => {
  it('issues no lookup at all when the request carries no challenge id', () => {
    const peek = vi.fn(() => ({ ok: true, challenge: { action: 'account.delete', sessionJti: 'j' } }));

    expect(utils.resolveAssurance({ challengeId: undefined, userId: 'u1', sessionJti: 'j' }, peek)).toBeNull();
    expect(utils.resolveAssurance({ challengeId: '', userId: 'u1', sessionJti: 'j' }, peek)).toBeNull();

    // authenticateToken runs on every authenticated request in the app. A
    // lookup here is a lookup everywhere.
    expect(peek).not.toHaveBeenCalled();
  });

  it('issues no lookup for a token with no jti, and does not throw', () => {
    const peek = vi.fn(() => ({ ok: true, challenge: { action: 'account.delete', sessionJti: 'j' } }));

    // Every challenge is bound to a session jti at creation, so a session that
    // has none can never match one. Resolving that without a query — and
    // without an exception — is the whole requirement.
    expect(utils.resolveAssurance({ challengeId: 'reauth-x', userId: 'u1', sessionJti: undefined }, peek)).toBeNull();
    expect(peek).not.toHaveBeenCalled();
  });

  it('issues exactly one lookup when a challenge id is present', () => {
    const peek = vi.fn(() => ({ ok: true, challenge: { action: 'account.delete', sessionJti: 'j' } }));

    expect(utils.resolveAssurance({ challengeId: 'reauth-x', userId: 'u1', sessionJti: 'j' }, peek))
      .toBe('account.delete');
    expect(peek).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledWith({ challengeId: 'reauth-x', userId: 'u1' });
  });

  it('declines a grant opened in a different session', () => {
    const peek = vi.fn(() => ({ ok: true, challenge: { action: 'account.delete', sessionJti: 'other' } }));

    expect(utils.resolveAssurance({ challengeId: 'reauth-x', userId: 'u1', sessionJti: 'j' }, peek)).toBeNull();
  });

  it('declines whatever peekChallenge refused', () => {
    const peek = vi.fn(() => ({ ok: false, error: 'consumed' }));

    expect(utils.resolveAssurance({ challengeId: 'reauth-x', userId: 'u1', sessionJti: 'j' }, peek)).toBeNull();
  });
});

/* ── peekChallenge: a read that cannot change anything ─────────────────────── */

describe('peekChallenge', () => {
  it('reports a granted, unexpired, unconsumed challenge and leaves it untouched', async () => {
    const id = await grantedChallenge({ session: alice });
    const before = challengeRow(id);

    const res = reauth.peekChallenge({ db, challengeId: id, userId: alice.userId });

    expect(res.ok).toBe(true);
    expect(res.challenge).toMatchObject({
      id, userId: alice.userId, action: 'account.delete', sessionJti: alice.jti
    });
    // The whole reason this function exists instead of consumeChallenge.
    expect(challengeRow(id)).toEqual(before);
  });

  it('never reveals another user\'s challenge', async () => {
    const id = await grantedChallenge({ session: alice });
    const res = reauth.peekChallenge({ db, challengeId: id, userId: bob.userId });

    expect(res.ok).toBe(false);
    // Indistinguishable from an id that does not exist — the id is not a secret
    // worth confirming.
    expect(res.error).toBe(reauth.REAUTH_ERRORS.NOT_FOUND);
  });

  it('refuses a challenge that was opened but never granted', () => {
    const { id } = reauth.openChallenge({
      db, userId: alice.userId, action: 'account.delete', sessionJti: alice.jti
    });
    const res = reauth.peekChallenge({ db, challengeId: id, userId: alice.userId });

    expect(res.ok).toBe(false);
    expect(res.error).toBe(reauth.REAUTH_ERRORS.NOT_GRANTED);
  });

  it('does not throw on a missing id', () => {
    expect(reauth.peekChallenge({ db, challengeId: null, userId: alice.userId }).ok).toBe(false);
  });
});

/* ── End to end: which grants actually raise a request's assurance ─────────── */

describe('assurance over HTTP', () => {
  it('is AAL1 with no challenge id, and the gate says reauth_required', async () => {
    const open = await hit('/probe/open', { session: alice });
    expect(open.body).toEqual({ aal: 1, aalAction: null });

    const gated = await hit('/probe/delete', { session: alice });
    expect(gated.status).toBe(403);
    expect(gated.body.code).toBe('reauth_required');
  });

  it('is 401 with no session at all, before assurance is even considered', async () => {
    const res = await hit('/probe/delete');
    expect(res.status).toBe(401);
  });

  it('raises a valid grant to AAL2 and lets the request through', async () => {
    const id = await grantedChallenge({ session: alice });
    const res = await hit('/probe/delete', { session: alice, challengeId: id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, aal: 2, aalAction: 'account.delete' });
  });

  it('does NOT consume the grant on the way in', async () => {
    const id = await grantedChallenge({ session: alice });

    await hit('/probe/delete', { session: alice, challengeId: id });
    expect(challengeRow(id).consumed_at, 'the middleware must not spend the grant').toBeNull();

    // Still spendable afterwards, which is the property that matters: the
    // handler, not the middleware, decides when the grant is used up.
    const second = await hit('/probe/delete', { session: alice, challengeId: id });
    expect(second.status).toBe(200);

    const spent = await reauth.consumeChallenge({
      db, challengeId: id, userId: alice.userId, action: 'account.delete', sessionJti: alice.jti
    });
    expect(spent.ok, 'the handler must still be able to spend it').toBe(true);
  });

  // ── The five bindings ──

  it('a grant for one action does not satisfy the gate for another', async () => {
    const id = await grantedChallenge({ session: alice, action: 'account.delete' });

    // Resolution is honest about what the grant is for …
    const open = await hit('/probe/open', { session: alice, challengeId: id });
    expect(open.body).toEqual({ aal: 2, aalAction: 'account.delete' });

    // … and the other gate refuses it.
    const res = await hit('/probe/email', { session: alice, challengeId: id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  it('a consumed grant confers nothing', async () => {
    const id = await grantedChallenge({ session: alice });
    const spent = await reauth.consumeChallenge({
      db, challengeId: id, userId: alice.userId, action: 'account.delete', sessionJti: alice.jti
    });
    expect(spent.ok).toBe(true);

    const res = await hit('/probe/delete', { session: alice, challengeId: id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  it('an expired grant confers nothing', async () => {
    const id = await grantedChallenge({ session: alice });
    db.prepare('UPDATE reauth_challenges SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), id);

    const res = await hit('/probe/delete', { session: alice, challengeId: id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  it('a grant belonging to a different user confers nothing', async () => {
    // Bob verifies himself, then Alice presents Bob's challenge id.
    const id = await grantedChallenge({ session: bob });

    const res = await hit('/probe/open', { session: alice, challengeId: id });
    expect(res.body).toEqual({ aal: 1, aalAction: null });

    // And Bob's own grant is untouched by Alice having waved it around.
    expect(challengeRow(id).consumed_at).toBeNull();
  });

  it('a grant from a different session of the SAME user confers nothing', async () => {
    // The stolen-session case: the attacker holds a valid cookie for Alice and
    // the id of a challenge Alice granted in her own browser.
    const id = await grantedChallenge({ session: aliceOther });

    const res = await hit('/probe/open', { session: alice, challengeId: id });
    expect(res.body).toEqual({ aal: 1, aalAction: null });
  });

  it('a forged challenge id confers nothing and does not error', async () => {
    const res = await hit('/probe/open', { session: alice, challengeId: 'reauth-does-not-exist' });
    expect(res.body).toEqual({ aal: 1, aalAction: null });
  });
});

/* ── The measured cost, over a real request ────────────────────────────────── */

describe('query cost of assurance resolution', () => {
  /** Counts prepared statements naming reauth_challenges during one request. */
  async function challengeQueriesDuring(run) {
    const spy = vi.spyOn(db, 'prepare');
    try {
      await run();
      return spy.mock.calls.filter(([sql]) => String(sql).includes('reauth_challenges')).length;
    } finally {
      spy.mockRestore();
    }
  }

  it('costs zero challenge queries when no challenge id is presented', async () => {
    const count = await challengeQueriesDuring(() => hit('/probe/open', { session: alice }));
    expect(count).toBe(0);
  });

  it('costs exactly one challenge query when a challenge id is presented', async () => {
    const id = await grantedChallenge({ session: alice });
    const count = await challengeQueriesDuring(() => hit('/probe/open', { session: alice, challengeId: id }));
    expect(count).toBe(1);
  });

  it('costs exactly one challenge query even for an id that matches nothing', async () => {
    // The refusal path must not be more expensive than the success path, or the
    // difference is a timing oracle for "does this id exist".
    const count = await challengeQueriesDuring(
      () => hit('/probe/open', { session: alice, challengeId: 'reauth-nope' })
    );
    expect(count).toBe(1);
  });
});
