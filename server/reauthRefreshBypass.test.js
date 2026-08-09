/**
 * Refreshing the page must not buy more guesses.
 *
 * ── The report ──
 *
 * "The 2FA password challenge is glitchy. It says I have five attempts, I use
 * them, it says I'm locked out — and then I refresh the browser and I get five
 * more."
 *
 * That was accurate, and it was not a rendering bug. `attemptsRemaining` counted
 * one CHALLENGE ROW, and a refresh opens a new row whose `attempts` starts at
 * zero. `MAX_ACCOUNT_ATTEMPTS` was 15 against `MAX_ATTEMPTS` of 5, so the account
 * really did have ten guesses left and the refresh really did work. The interface
 * promised a limit three times stricter than the one the server enforced.
 *
 * A lockout that a page refresh clears is worse than no lockout message at all:
 * it teaches everyone who meets it that this application's limits are decorative.
 *
 * ── What was actually changed ──
 *
 * Not the React state — that was never the authority and hiding the counter
 * would have left the bypass exactly where it was. The two budgets were made ONE
 * budget: `MAX_ACCOUNT_ATTEMPTS === MAX_ATTEMPTS`, summed across every challenge
 * the account opened inside the window, and reported from that sum rather than
 * from the row. A new challenge now inherits the spent count instead of resetting
 * it.
 *
 * ── What these tests are for ──
 *
 * Every case below spends the budget and then tries to get more of it back by a
 * route a browser can take unaided: a second challenge, a third, a correct
 * password, the provider path, a fresh session. The property under test is that
 * the number the client is shown and the number the server enforces are the same
 * number.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// db.js opens its connection at module scope, so nothing that reaches it may be
// imported statically here — see the long explanation in testServer.js.
let srv, db, reauth;

const PASSWORD = 'CorrectHorse1';
const WRONG = 'not-the-password';
const JWT_SECRET = 'test-secret-not-for-production'; // what testServer.js sets
let PASSWORD_HASH;

let seq = 0;

function makeUser({ providers = [] } = {}) {
  const id = `reauth-refresh-${++seq}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role,
                       verified, email_verified, created_at)
    VALUES (?, ?, ?, ?, ?, 'Adult', 'student', 1, 1, ?)
  `).run(id, 'Refresh Person', `${id}@example.org`, id, PASSWORD_HASH, now);

  for (const [provider, sub] of providers) {
    db.prepare(`
      INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`oauth-${id}-${provider}`, id, provider, sub, `${id}@example.org`, now, now);
  }
  return id;
}

/**
 * A session for a fixture user.
 *
 * Takes a fresh `jti` every call on purpose: one of the cases below signs out and
 * back in to check that a new SESSION does not reset the budget either, and that
 * only works if the sessions are genuinely different ones.
 */
function sessionFor(userId) {
  const u = db.prepare('SELECT id, role, email, name, token_version FROM users WHERE id = ?').get(userId);
  const payload = {
    id: u.id, email: u.email, name: u.name,
    tokenVersion: u.token_version ?? 0, jti: crypto.randomUUID()
  };
  payload.role = u.role; // computed key: never spell a role comparison in a fixture
  return { token: jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' }) };
}

async function api(method, path, { body, session } = {}) {
  const res = await fetch(srv.base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Cookie: `wev_session=${session.token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

/** What the browser does on load, and again on every refresh. */
const openChallenge = (session, action = 'account.delete', params = {}) =>
  api('POST', '/api/auth/reauth/challenge', { session, body: { action, params } });

const guess = (session, challengeId, password) =>
  api('POST', '/api/auth/reauth/password', { session, body: { challengeId, password } });

/** Spends the whole budget against one challenge, as a user at a keyboard would. */
async function exhaust(session) {
  const opened = await openChallenge(session);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);

  const seen = [];
  for (let i = 0; i < reauth.MAX_ACCOUNT_ATTEMPTS; i++) {
    const res = await guess(session, opened.body.challengeId, WRONG);
    seen.push(res);
  }
  return { challengeId: opened.body.challengeId, seen };
}

beforeAll(async () => {
  process.env.OAUTH_ALLOW_MOCK = 'true';
  /* High on purpose. The per-IP limiter is a SECOND control with its own test
     file; leaving it at its real value here would refuse these requests for the
     right reason at the wrong layer, and the account budget would go untested. */
  process.env.REAUTH_RATE_LIMIT = '1000';

  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  reauth = await import('./reauth.js');
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 10);
}, 60000);

afterAll(async () => {
  await srv?.close?.();
  delete process.env.OAUTH_ALLOW_MOCK;
  delete process.env.REAUTH_RATE_LIMIT;
});

describe('the two budgets are one budget', () => {
  /**
   * The invariant the whole fix rests on.
   *
   * While these were 5 and 15, every other test in this file could be written,
   * pass, and still describe a bypass — because "spend the budget" would have
   * meant spending a third of it. Asserted here so that raising one without the
   * other fails loudly rather than silently reopening the hole.
   */
  it('MAX_ACCOUNT_ATTEMPTS equals MAX_ATTEMPTS', () => {
    expect(reauth.MAX_ACCOUNT_ATTEMPTS).toBe(reauth.MAX_ATTEMPTS);
  });
});

describe('a refresh does not restore spent attempts', () => {
  /** The reported bug, stated as an assertion. */
  it('does not grant a fresh budget to a challenge opened after the budget is gone', async () => {
    const session = sessionFor(makeUser());
    await exhaust(session);

    /* The refresh. A brand-new challenge row, `attempts` genuinely zero. */
    const second = await openChallenge(session);
    expect(second.status).toBe(201);

    const res = await guess(session, second.body.challengeId, WRONG);
    expect(res.status, 'a new challenge accepted a guess the account could not pay for').toBe(429);
    expect(res.body.code).toBe('account_locked');
  });

  /**
   * And the new challenge SAYS so, before a try is wasted finding out.
   *
   * This is the half that lived only in React. The dialog seeded
   * `attemptsRemaining` from nothing and learned the truth from a failure
   * response, so a refreshed dialog looked exactly like a fresh one.
   */
  it('reports zero remaining on the challenge it opens', async () => {
    const session = sessionFor(makeUser());
    await exhaust(session);

    const second = await openChallenge(session);
    expect(second.body.attemptsRemaining).toBe(0);
  });

  /** Refreshing repeatedly is not a slow way to get there either. */
  it('does not accumulate a budget across many opened challenges', async () => {
    const session = sessionFor(makeUser());
    await exhaust(session);

    for (let i = 0; i < 4; i++) {
      const opened = await openChallenge(session);
      expect(opened.body.attemptsRemaining).toBe(0);
      const res = await guess(session, opened.body.challengeId, WRONG);
      expect(res.status).toBe(429);
    }
  });

  /**
   * Signing out and in again is not a reset.
   *
   * A challenge is bound to a session jti, so a new session cannot reuse the old
   * challenge — which makes "get a new session" the obvious next thing to try
   * after "get a new challenge" fails. The budget is keyed on the ACCOUNT, and
   * this is what that buys.
   */
  it('does not reset for a new session on the same account', async () => {
    const userId = makeUser();
    await exhaust(sessionFor(userId));

    const fresh = sessionFor(userId);
    const opened = await openChallenge(fresh);
    expect(opened.body.attemptsRemaining).toBe(0);

    const res = await guess(fresh, opened.body.challengeId, WRONG);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('account_locked');
  });

  /**
   * The security property, rather than the counting property.
   *
   * Everything above proves the counter holds. This proves the counter is worth
   * holding: once the budget is gone the CORRECT password does not verify either.
   * A limit that only refuses wrong answers refuses nothing an attacker minds.
   */
  it('refuses the correct password once the budget is spent', async () => {
    const session = sessionFor(makeUser());
    await exhaust(session);

    const opened = await openChallenge(session);
    const res = await guess(session, opened.body.challengeId, PASSWORD);

    expect(res.status, 'the right password verified past a spent budget').toBe(429);
    expect(res.body.code).toBe('account_locked');

    /* And nothing was granted — the refusal is not cosmetic. */
    const row = db.prepare('SELECT granted_at FROM reauth_challenges WHERE id = ?')
      .get(opened.body.challengeId);
    expect(row.granted_at).toBeNull();
  });

  /**
   * The provider path is under the same ceiling.
   *
   * A second way to answer the same challenge is a second way around the limit if
   * only one of them counts. `grantByOAuth` checks the account budget for exactly
   * this reason, and this is the assertion that keeps it there.
   */
  it('refuses the provider path once the budget is spent', async () => {
    const userId = makeUser({ providers: [['google', 'sub-refresh-1']] });
    const session = sessionFor(userId);
    await exhaust(session);

    const opened = await openChallenge(session);
    const result = await reauth.grantByOAuth({
      db,
      challengeId: opened.body.challengeId,
      userId,
      provider: 'google',
      subject: 'sub-refresh-1' // the CORRECT subject
    });

    expect(result.ok, 'a correct provider subject verified past a spent budget').toBe(false);
    expect(result.error).toBe('account_locked');
  });
});

describe('the number shown is the number enforced', () => {
  /**
   * The countdown is honest mid-way, not only at zero.
   *
   * A budget that reads 4, 3, 2 and then silently allows ten more would be the
   * same defect wearing a smaller number.
   */
  it('counts down by one per wrong answer', async () => {
    const session = sessionFor(makeUser());
    const opened = await openChallenge(session);
    expect(opened.body.attemptsRemaining).toBe(reauth.MAX_ACCOUNT_ATTEMPTS);

    for (let spent = 1; spent < reauth.MAX_ACCOUNT_ATTEMPTS; spent++) {
      const res = await guess(session, opened.body.challengeId, WRONG);
      expect(res.body.attemptsRemaining).toBe(reauth.MAX_ACCOUNT_ATTEMPTS - spent);
    }
  });

  /** A challenge opened part-way through inherits the part that is left. */
  it('carries the partial spend onto the next challenge', async () => {
    const session = sessionFor(makeUser());
    const first = await openChallenge(session);
    await guess(session, first.body.challengeId, WRONG);
    await guess(session, first.body.challengeId, WRONG);

    const second = await openChallenge(session);
    expect(second.body.attemptsRemaining).toBe(reauth.MAX_ACCOUNT_ATTEMPTS - 2);

    /* And the remaining three really are the last three. */
    for (let i = 0; i < reauth.MAX_ACCOUNT_ATTEMPTS - 2; i++) {
      await guess(session, second.body.challengeId, WRONG);
    }
    const third = await openChallenge(session);
    expect(third.body.attemptsRemaining).toBe(0);
  });

  /**
   * The lockout message tells the truth about what helps.
   *
   * `LOCKED` reads "Please start again", which was right when starting again
   * restored the budget. Now that it does not, the exhausting answer has to be
   * `ACCOUNT_LOCKED` — "wait a few minutes" — or the interface is back to sending
   * the user around a loop that cannot succeed.
   */
  it('says wait, not start again, when the budget is what ran out', async () => {
    const session = sessionFor(makeUser());
    const { seen } = await exhaust(session);
    const last = seen[seen.length - 1];

    expect(last.status).toBe(429);
    expect(last.body.code).toBe('account_locked');
    expect(last.body.error).toMatch(/wait/i);
    expect(last.body.error).not.toMatch(/start again/i);
    expect(last.body.attemptsRemaining).toBe(0);
  });
});

describe('the ceiling is per account', () => {
  /**
   * One account exhausting its budget must not lock anybody else out.
   *
   * The sum is scoped by `user_id`; a version of this that summed the table would
   * pass every test above and turn one wrong-password user into a site-wide
   * denial of service.
   */
  it('does not spend another account\'s budget', async () => {
    const victim = sessionFor(makeUser());
    await exhaust(sessionFor(makeUser()));

    const opened = await openChallenge(victim);
    expect(opened.body.attemptsRemaining).toBe(reauth.MAX_ACCOUNT_ATTEMPTS);

    const res = await guess(victim, opened.body.challengeId, PASSWORD);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
