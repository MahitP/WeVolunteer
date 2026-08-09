/**
 * The step-up challenge lifecycle — the code between a stolen session and
 * account deletion.
 *
 * Every `describe` below is one attack, not one function. A challenge is a
 * short-lived, single-use, four-way-bound grant: it authorises exactly one
 * ACTION, with exactly those PARAMS, from exactly that SESSION, for exactly
 * five minutes, once. Drop any one of those bindings and the grant becomes a
 * general-purpose skeleton key for the window it is alive:
 *
 *   - no action binding   → verifying to change your email deletes your account
 *   - no params binding   → verifying for a@x.com moves your address to the
 *                           attacker's, the subtle bug in most implementations
 *   - no session binding  → a grant obtained in one session is spent in another
 *   - no single-use       → a replayed grant is a second free sensitive action
 *
 * The tests are written against the module's own return values rather than
 * through HTTP, because `reauth.js` deliberately knows nothing about requests:
 * it returns `{ ok, error }` and the routes in Task 5 map that to status codes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';

// db.js opens its connection at module scope, so nothing that reaches it may be
// imported statically here — see the long explanation in testServer.js.
let srv, db, reauth, paramsHash;

const PASSWORD = 'CorrectHorse1';
let PASSWORD_HASH;

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  reauth = await import('./reauth.js');
  ({ paramsHash } = await import('./sensitiveActions.js'));
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 10);
});

afterAll(async () => { await srv?.close?.(); });

let seq = 0;

/**
 * A user row straight in the database.
 *
 * `providers` is a list of `[provider, sub]` pairs written into
 * `oauth_accounts` exactly as oauthRoutes.js writes them: `provider_user_id`
 * holds the provider's `sub` claim.
 */
function makeUser({ passwordHash = null, providers = [] } = {}) {
  const id = `reauth-user-${++seq}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, created_at)
    VALUES (?, ?, ?, ?, ?, 'Adult', 'student', 1, ?)
  `).run(id, 'Test Person', `${id}@example.org`, id, passwordHash ?? PASSWORD_HASH, now);

  for (const [provider, sub] of providers) {
    db.prepare(`
      INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`oauth-${id}-${provider}`, id, provider, sub, `${id}@example.org`, now, now);
  }
  return id;
}

const row = (id) => db.prepare('SELECT * FROM reauth_challenges WHERE id = ?').get(id);
const setExpiry = (id, iso) =>
  db.prepare('UPDATE reauth_challenges SET expires_at = ? WHERE id = ?').run(iso, id);

/** Opens a challenge with sensible defaults; returns the openChallenge result. */
function open({ userId, action = 'account.delete', params = {}, sessionJti = 'jti-a', ipHash = 'ip-a' }) {
  return reauth.openChallenge({ db, userId, action, params, sessionJti, ipHash });
}

/** Opens and grants in one step — the starting point for the consume tests. */
async function granted(opts) {
  const ch = open(opts);
  const res = await reauth.grantByPassword({
    db, challengeId: ch.id, userId: opts.userId, password: PASSWORD
  });
  expect(res.ok, 'fixture setup: the grant itself failed').toBe(true);
  return ch;
}

describe('openChallenge', () => {
  it('records a pending, bound, un-granted challenge', () => {
    const userId = makeUser();
    const ch = open({ userId, action: 'email.change', params: { newEmail: 'a@x.com' }, sessionJti: 'jti-open' });

    expect(ch.id).toBeTruthy();
    expect(ch.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const r = row(ch.id);
    expect(r.user_id).toBe(userId);
    expect(r.action).toBe('email.change');
    expect(r.params_hash).toBe(paramsHash('email.change', { newEmail: 'a@x.com' }));
    expect(r.session_jti).toBe('jti-open');
    expect(r.ip_hash).toBe('ip-a');
    expect(r.method).toBe(null);
    expect(r.granted_at).toBe(null);
    expect(r.consumed_at).toBe(null);
    expect(r.attempts).toBe(0);
  });

  it('refuses an action that is not in the registry', () => {
    const userId = makeUser();
    expect(() => open({ userId, action: 'account.rename' })).toThrow(/account\.rename/);
  });

  it('refuses to open a challenge that is not bound to a session', () => {
    // An unbound grant is not a step-up: anyone holding the challenge id could
    // spend it from anywhere.
    const userId = makeUser();
    expect(() => open({ userId, sessionJti: null })).toThrow(/session/i);
  });
});

// RULE: expires at exactly 5 minutes.
describe('the window is exactly five minutes', () => {
  it('sets expires_at exactly 300000 ms after created_at', () => {
    const userId = makeUser();
    const ch = open({ userId });
    const r = row(ch.id);

    expect(new Date(r.expires_at) - new Date(r.created_at)).toBe(5 * 60 * 1000);
    expect(ch.expiresAt).toBe(r.expires_at);
  });

  it('stores both timestamps as ISO-8601 UTC, never SQLite datetime() (TD-10)', () => {
    // expires_at is compared as a STRING, so a `2026-08-01 12:00:00` from
    // datetime('now') would sort against `2026-08-01T12:00:00.000Z` in a way
    // that silently never expires.
    const r = row(open({ userId: makeUser() }).id);
    for (const value of [r.created_at, r.expires_at]) {
      expect(value).toBe(new Date(value).toISOString());
    }
  });

  it('will not grant a challenge that has expired', async () => {
    const userId = makeUser();
    const ch = open({ userId });
    setExpiry(ch.id, new Date(Date.now() - 1000).toISOString());

    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });

    expect(res).toEqual({ ok: false, error: 'expired' });
    expect(row(ch.id).granted_at).toBe(null);
  });

  it('will not consume a grant that has since expired', async () => {
    const userId = makeUser();
    const ch = await granted({ userId });
    setExpiry(ch.id, new Date(Date.now() - 1000).toISOString());

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: false, error: 'expired' });
    expect(row(ch.id).consumed_at).toBe(null);
  });
});

// RULE: `methods` omits 'password' for a provider-only account.
describe('methods reflect what this account can actually satisfy', () => {
  it('offers both to an account with a password and a linked provider', () => {
    const userId = makeUser({ providers: [['google', 'sub-both']] });
    expect(open({ userId }).methods).toEqual(['password', 'oauth']);
  });

  it("omits 'password' for a provider-only account", () => {
    // The sentinel is not a hash. Offering a password prompt to someone who has
    // no password to give is an unanswerable question, and the only way out of
    // it would be account recovery.
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-only']] });
    const ch = open({ userId });

    expect(ch.methods).not.toContain('password');
    expect(ch.methods).toEqual(['oauth']);
  });

  it("omits 'oauth' for an account with no linked provider", () => {
    expect(open({ userId: makeUser() }).methods).toEqual(['password']);
  });
});

describe('grantByPassword', () => {
  it('grants on the right password and records the method', async () => {
    const userId = makeUser();
    const ch = open({ userId });

    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });

    expect(res.ok).toBe(true);
    const r = row(ch.id);
    expect(r.granted_at).not.toBe(null);
    expect(r.method).toBe('password');
    expect(r.consumed_at).toBe(null);
  });

  it('refuses the wrong password without granting', async () => {
    const userId = makeUser();
    const ch = open({ userId });

    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: 'WrongHorse1' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_password');
    expect(row(ch.id).granted_at).toBe(null);
  });

  it('treats a double-submitted verify form as success, not an error', async () => {
    const userId = makeUser();
    const ch = open({ userId });

    const first = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });
    const grantedAt = row(ch.id).granted_at;
    const second = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(row(ch.id).granted_at, 'the second grant moved the clock forward').toBe(grantedAt);
  });

  it('still demands the password on an already-granted challenge', async () => {
    // The idempotent path above must be reachable only AFTER verification, or
    // one correct grant would make every later wrong guess succeed.
    const userId = makeUser();
    const ch = await granted({ userId });

    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: 'WrongHorse1' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_password');
  });

  it("will not grant another user's challenge, even with that caller's own correct password", async () => {
    const owner = makeUser();
    const stranger = makeUser();
    const ch = open({ userId: owner });

    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId: stranger, password: PASSWORD });

    expect(res).toEqual({ ok: false, error: 'not_found' });
    expect(row(ch.id).granted_at).toBe(null);
  });
});

// RULE: the password path rejects the '!OAUTH_ONLY!' sentinel explicitly.
describe("the '!OAUTH_ONLY!' sentinel is rejected explicitly", () => {
  it('reports that no password exists rather than "wrong password"', async () => {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-x']] });
    const ch = open({ userId });

    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: 'anything' });

    // Without the explicit check this reads as `invalid_password` — a user with
    // no password to give would be told their password is wrong, five times,
    // and then be locked out of the challenge entirely.
    expect(res).toEqual({ ok: false, error: 'password_unavailable' });
    expect(row(ch.id).granted_at).toBe(null);
  });

  it('does not spend an attempt on a prompt the account cannot answer', async () => {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-y']] });
    const ch = open({ userId });

    await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: 'anything' });

    expect(row(ch.id).attempts, 'an unanswerable prompt burned the brute-force budget').toBe(0);
  });

  it('does not accept the sentinel string itself as the password', async () => {
    const userId = makeUser({ passwordHash: '!OAUTH_ONLY!', providers: [['google', 'sub-z']] });
    const ch = open({ userId });

    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: '!OAUTH_ONLY!' });

    expect(res.ok).toBe(false);
    expect(row(ch.id).granted_at).toBe(null);
  });
});

// RULE: the OAuth path verifies the returned sub against the linked row.
describe('grantByOAuth', () => {
  it('grants when the returned sub matches the linked account', async () => {
    const userId = makeUser({ providers: [['google', 'google-sub-1']] });
    const ch = open({ userId });

    const res = await reauth.grantByOAuth({
      db, challengeId: ch.id, userId, provider: 'google', subject: 'google-sub-1'
    });

    expect(res.ok).toBe(true);
    const r = row(ch.id);
    expect(r.granted_at).not.toBe(null);
    expect(r.method).toBe('oauth');
  });

  it('refuses a sub that does not match the linked account', async () => {
    // Otherwise ANY account at that provider satisfies the challenge: the
    // attacker signs in with their own Google account and is re-verified as you.
    const userId = makeUser({ providers: [['google', 'google-sub-linked']] });
    const ch = open({ userId });

    const res = await reauth.grantByOAuth({
      db, challengeId: ch.id, userId, provider: 'google', subject: 'attacker-sub'
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('provider_mismatch');
    expect(row(ch.id).granted_at).toBe(null);
  });

  it("refuses another user's linked sub at the same provider", async () => {
    const victim = makeUser({ providers: [['google', 'victim-sub']] });
    makeUser({ providers: [['google', 'other-sub']] });
    const ch = open({ userId: victim });

    const res = await reauth.grantByOAuth({
      db, challengeId: ch.id, userId: victim, provider: 'google', subject: 'other-sub'
    });

    expect(res.ok).toBe(false);
    expect(row(ch.id).granted_at).toBe(null);
  });

  it('refuses a provider this account has not linked', async () => {
    const userId = makeUser({ providers: [['google', 'google-sub-2']] });
    const ch = open({ userId });

    const res = await reauth.grantByOAuth({
      db, challengeId: ch.id, userId, provider: 'microsoft', subject: 'google-sub-2'
    });

    expect(res).toEqual({ ok: false, error: 'provider_not_linked' });
    expect(row(ch.id).granted_at).toBe(null);
  });

  it('refuses an absent sub', async () => {
    const userId = makeUser({ providers: [['google', 'google-sub-3']] });
    const ch = open({ userId });

    const res = await reauth.grantByOAuth({ db, challengeId: ch.id, userId, provider: 'google', subject: null });

    expect(res.ok).toBe(false);
    expect(row(ch.id).granted_at).toBe(null);
  });
});

// RULE: 5 failed attempts locks the challenge.
describe('five failed attempts lock the challenge', () => {
  it('locks on the fifth wrong password and stays locked for the right one', async () => {
    const userId = makeUser();
    const ch = open({ userId });

    for (let i = 1; i <= 4; i++) {
      const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: `Wrong${i}` });
      expect(res.error, `attempt ${i}`).toBe('invalid_password');
    }

    /**
     * `account_locked`, not `locked`, since MAX_ACCOUNT_ATTEMPTS was brought
     * down to meet MAX_ATTEMPTS: the fifth wrong answer now empties the
     * account's budget at the same moment it kills the row, and the account is
     * the stricter of the two facts. The distinction is not cosmetic — `locked`
     * tells the user to start again, which is precisely what no longer helps.
     * See reauthRefreshBypass.test.js for why that mattered.
     */
    const fifth = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: 'Wrong5' });
    expect(fifth.error).toBe('account_locked');
    expect(row(ch.id).attempts).toBe(5);

    // The assertion that matters: the correct password no longer helps. A lock
    // that the right guess can still open is not a lock.
    const correct = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });
    expect(correct).toEqual({ ok: false, error: 'account_locked' });
    expect(row(ch.id).granted_at).toBe(null);
  });

  it('counts OAuth sub mismatches toward the same budget', async () => {
    const userId = makeUser({ providers: [['google', 'right-sub']] });
    const ch = open({ userId });

    for (let i = 0; i < 5; i++) {
      await reauth.grantByOAuth({ db, challengeId: ch.id, userId, provider: 'google', subject: `guess-${i}` });
    }

    const res = await reauth.grantByOAuth({
      db, challengeId: ch.id, userId, provider: 'google', subject: 'right-sub'
    });
    /* `account_locked`: five mismatches is the whole account budget now, so the
       account is what refuses the correct sub. The property under test is
       unchanged — a mismatch costs an attempt, and the right answer arriving
       after the budget is gone does not help. */
    expect(res).toEqual({ ok: false, error: 'account_locked' });
    expect(row(ch.id).granted_at).toBe(null);
  });

  /**
   * The bypass this test exists for.
   *
   * `notGrantable` does not refuse an already-granted challenge — that is what
   * makes a double-submitted verify form work — so the password path stays open
   * between a grant and its consumption. `recordFailedAttempt` used to be
   * guarded on `granted_at IS NULL`, which meant every guess in that window
   * updated no row: `attempts` stayed where it was, the caller was told four
   * tries remained, and the fifth guess was as free as the first. A grant lives
   * five minutes, and it is reached by verifying with a provider and then
   * guessing — no race, no unusual state.
   *
   * Verifying by OAuth first is what makes the point sharp: the guesser has
   * demonstrably not proved the password, and the account has one.
   */
  it('bounds guessing on a challenge that is already granted but not yet spent', async () => {
    const userId = makeUser({ providers: [['google', 'granted-sub']] });
    const ch = open({ userId, action: 'email.change', params: { newEmail: 'a@x.com' } });

    const grant = await reauth.grantByOAuth({
      db, challengeId: ch.id, userId, provider: 'google', subject: 'granted-sub'
    });
    expect(grant.ok, 'fixture setup: the OAuth grant failed').toBe(true);
    expect(row(ch.id).granted_at).not.toBe(null);
    expect(row(ch.id).consumed_at).toBe(null);

    for (let i = 1; i <= 4; i++) {
      const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: `Wrong${i}` });
      expect(res.error, `attempt ${i} in the granted window`).toBe('invalid_password');
      expect(res.attemptsRemaining, `attempt ${i} reported a budget that never moves`).toBe(5 - i);
    }

    /* `account_locked` for the same reason as above: the fifth failure is now
       the last one the ACCOUNT has, so that is the refusal it earns. What this
       test is about is unchanged — the counter moved on a granted challenge. */
    const fifth = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: 'Wrong5' });
    expect(fifth.error).toBe('account_locked');
    expect(row(ch.id).attempts, 'the counter was frozen by the granted_at guard').toBe(5);
  });

  it('a locked challenge cannot be consumed', async () => {
    const userId = makeUser();
    const ch = open({ userId });
    for (let i = 0; i < 5; i++) {
      await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: `Wrong${i}` });
    }

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });

    expect(res.ok).toBe(false);
    expect(row(ch.id).consumed_at).toBe(null);
  });
});

/**
 * RULE: the per-challenge counter is not a bound on guessing; the account is.
 *
 * MAX_ATTEMPTS measures one challenge, and a challenge costs one request to
 * replace. Without an account-level ceiling a holder of a stolen session guesses
 * for ever at one extra round trip per five attempts — the per-challenge limit
 * looks like a brute-force defence and is not one.
 *
 * `app.js`'s reauthLimiter bounds the same thing per IP. These tests are about
 * the half it does not cover, which is why they drive the module directly.
 */
/**
 * Explicit budgets on this block, measured rather than guessed.
 *
 * Each test below drives the account ceiling by spending it in full, so each one performs
 * MAX_ACCOUNT_ATTEMPTS real bcrypt comparisons — the cost is the point, because the ceiling is
 * what stops an attacker opening a fresh challenge per guess.
 *
 * These used to spend three whole challenges, because MAX_ACCOUNT_ATTEMPTS was three times
 * MAX_ATTEMPTS. It no longer is, and `exhaustAccountBudget` below spends the budget rather than
 * a hardcoded number of challenges — so these tests keep testing the ceiling if the two
 * constants ever diverge again, instead of quietly testing a third of it.
 *
 * In isolation they ran 1.7-2.0s against vitest's 5000ms default at the old cost. Under the
 * parallel load of the full suite one was measured at 5094ms and timed out. Nothing was hung:
 * the work simply did not fit, which makes it a flake rather than a defect in the code under
 * test — and flakiness is a defect in its own right here, on the gate every other gate depends
 * on. The generous timeout is kept: the cost fell with the constant, but the reason the
 * default was too tight (parallel load, not the work itself) did not go away.
 *
 * The global default stays 5000ms so a genuinely hung test still fails fast, and the ceiling
 * these tests cover is not weakened to fit a timer.
 */
describe('the account-level guessing ceiling', () => {
  /**
   * Spends the account's whole guessing budget on wrong answers.
   *
   * Opens a fresh challenge whenever the current one hits its own per-challenge
   * limit, which is what an attacker does and what a user pressing refresh does
   * by accident. Written against the CONSTANTS rather than against a fixed
   * number of challenges: while MAX_ACCOUNT_ATTEMPTS was 15 and MAX_ATTEMPTS was
   * 5 this loop opened three challenges, and now it opens one — with no test
   * below needing to know which.
   *
   * `verify` is the answer path being charged, so the OAuth case can spend the
   * same budget through its own door.
   */
  async function exhaustAccountBudget(userId, tag, verify) {
    const spend = verify ?? ((challengeId, i) =>
      reauth.grantByPassword({ db, challengeId, userId, password: `Wrong-${tag}-${i}` }));

    let ch = null;
    let onThisChallenge = 0;
    for (let i = 0; i < reauth.MAX_ACCOUNT_ATTEMPTS; i++) {
      if (!ch || onThisChallenge >= reauth.MAX_ATTEMPTS) {
        ch = open({ userId, sessionJti: `jti-${tag}-${i}` });
        onThisChallenge = 0;
      }
      await spend(ch.id, i);
      onThisChallenge++;
    }

    /* The budget really is gone — otherwise every assertion below passes for the
       wrong reason, which is the failure mode this whole block exists to catch. */
    expect(ch, `${tag}: no challenge was ever opened`).not.toBe(null);
    expect(row(ch.id).attempts, `${tag}: the last challenge recorded no attempts`)
      .toBeGreaterThan(0);
  }

  it('stops guessing across fresh challenges, not just within one', async () => {
    const userId = makeUser();

    // The account's whole budget, spent on wrong answers — spread over as many
    // challenges as it takes, each new one starting its own counter at zero.
    await exhaustAccountBudget(userId, 'acct');

    // A brand-new challenge, therefore un-locked by every per-challenge rule.
    const fresh = open({ userId, sessionJti: 'jti-acct-fresh' });
    const res = await reauth.grantByPassword({ db, challengeId: fresh.id, userId, password: 'Wrong-again' });

    expect(res).toEqual({ ok: false, error: 'account_locked' });
    expect(row(fresh.id).attempts, 'a refused-by-account guess still charged the challenge').toBe(0);
  }, 20000);

  it('refuses the correct password too — a ceiling the right guess opens is not one', async () => {
    const userId = makeUser();
    await exhaustAccountBudget(userId, 'right');

    const fresh = open({ userId, sessionJti: 'jti-right-fresh' });
    const res = await reauth.grantByPassword({ db, challengeId: fresh.id, userId, password: PASSWORD });

    expect(res).toEqual({ ok: false, error: 'account_locked' });
    expect(row(fresh.id).granted_at).toBe(null);
  }, 20000);

  it('is scoped to the account — one user cannot spend another user\'s budget', async () => {
    const noisy = makeUser();
    const quiet = makeUser();

    await exhaustAccountBudget(noisy, 'noisy');

    const ch = open({ userId: quiet, sessionJti: 'jti-quiet' });
    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId: quiet, password: PASSWORD });

    expect(res).toEqual({ ok: true });
  }, 20000);

  it('counts only the window, so an old spree does not lock an account for ever', async () => {
    const userId = makeUser();

    // A full spree: at this instant the account can do nothing.
    await exhaustAccountBudget(userId, 'stale');

    // Age it past the window. Written directly because the alternative is a
    // fifteen-minute test.
    const old = new Date(Date.now() - reauth.ACCOUNT_ATTEMPT_WINDOW_MS - 1000).toISOString();
    db.prepare('UPDATE reauth_challenges SET created_at = ? WHERE user_id = ?').run(old, userId);

    /**
     * The lock has to lift, or the ceiling is a permanent account lockout that
     * anyone who knows an address can trigger. The window is the entire reason
     * the ceiling is safe to enforce, so it is asserted with the CORRECT
     * password: the account is fully usable again, not merely counting again.
     */
    const fresh = open({ userId, sessionJti: 'jti-window-fresh' });
    const res = await reauth.grantByPassword({ db, challengeId: fresh.id, userId, password: PASSWORD });

    expect(res).toEqual({ ok: true });
  }, 20000);

  it('applies to the OAuth path on the same budget', async () => {
    const userId = makeUser({ providers: [['google', 'oauth-ceiling-sub']] });
    await exhaustAccountBudget(userId, 'oauth', (challengeId, i) =>
      reauth.grantByOAuth({
        db, challengeId, userId, provider: 'google', subject: `wrong-oauth-${i}`
      }));

    const fresh = open({ userId, sessionJti: 'jti-oauth-fresh' });
    const res = await reauth.grantByOAuth({
      db, challengeId: fresh.id, userId, provider: 'google', subject: 'oauth-ceiling-sub'
    });

    expect(res).toEqual({ ok: false, error: 'account_locked' });
  });
});

describe('consumeChallenge — the happy paths', () => {
  it('consumes a password grant once and marks it spent', async () => {
    const userId = makeUser();
    const ch = await granted({ userId, action: 'data.export' });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'data.export', params: {}, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: true });
    expect(row(ch.id).consumed_at).not.toBe(null);
  });

  it('consumes an OAuth grant', async () => {
    const userId = makeUser({ providers: [['google', 'happy-sub']] });
    const ch = open({ userId, action: 'oauth.link', params: { provider: 'microsoft' } });
    await reauth.grantByOAuth({ db, challengeId: ch.id, userId, provider: 'google', subject: 'happy-sub' });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'oauth.link', params: { provider: 'microsoft' }, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: true });
    expect(row(ch.id).consumed_at).not.toBe(null);
  });

  it('refuses to consume a challenge that was never granted', async () => {
    const userId = makeUser();
    const ch = open({ userId });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: false, error: 'not_granted' });
    expect(row(ch.id).consumed_at).toBe(null);
  });

  it('refuses to consume an unknown challenge id', async () => {
    const res = await reauth.consumeChallenge({
      db, challengeId: 'no-such-challenge', userId: makeUser(), action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });
    expect(res).toEqual({ ok: false, error: 'not_found' });
  });
});

// RULE: single use, set atomically.
describe('a grant is spendable exactly once', () => {
  it('refuses the second consume of the same grant', async () => {
    const userId = makeUser();
    const ch = await granted({ userId });

    const first = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });
    const second = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, error: 'consumed' });
  });

  it('yields exactly one winner when the same grant is consumed concurrently', async () => {
    /**
     * What this establishes, precisely: consumption is a single conditional
     * `UPDATE ... WHERE consumed_at IS NULL` whose `changes` count decides the
     * winner, so there is no window between the read and the write for a second
     * caller to slip into. It does NOT prove behaviour under OS-level parallel
     * writers — `node:sqlite` is synchronous, so these five calls interleave
     * only at await points and never mid-statement. A read-then-write
     * implementation would still fail this test (both callers would see
     * consumed_at NULL before either wrote) which is the shape being guarded.
     */
    const userId = makeUser();
    const ch = await granted({ userId });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => reauth.consumeChallenge({
        db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
      }))
    );

    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.error === 'consumed')).toHaveLength(4);
  });

  it('cannot be re-granted after being consumed', async () => {
    const userId = makeUser();
    const ch = await granted({ userId });
    await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });

    const res = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });

    expect(res).toEqual({ ok: false, error: 'consumed' });
  });

  /**
   * `peekChallenge` and `consumeChallenge` must not disagree about whether a
   * grant is alive.
   *
   * `requireAAL2` asks `peekChallenge`, which refuses a locked row; the UPDATE
   * in `consumeChallenge` did not check `attempts` at all. That could not be
   * reached before the T3 fix round — the counter froze the instant a challenge
   * was granted, so no granted row ever held five attempts — and became
   * reachable the moment guessing in the granted window started counting.
   */
  it('cannot be consumed after guessing locked it, even though it was granted', async () => {
    const userId = makeUser();
    const ch = await granted({ userId });

    for (let i = 0; i < reauth.MAX_ATTEMPTS; i++) {
      await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: `Wrong${i}` });
    }
    expect(row(ch.id).attempts).toBe(reauth.MAX_ATTEMPTS);
    expect(row(ch.id).granted_at, 'the grant itself should survive — only its spendability dies').not.toBe(null);

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: false, error: 'locked' });
    expect(row(ch.id).consumed_at).toBe(null);

    // And the middleware agrees, which is the point.
    expect(reauth.peekChallenge({ db, challengeId: ch.id, userId })).toEqual({ ok: false, error: 'locked' });
  });
});

/**
 * RULE: commitGrant re-states its preconditions because bcrypt yields.
 *
 * `grantByPassword` reads the row, then awaits a ~100 ms bcrypt comparison,
 * then writes. Everything it decided from that first read is stale by the time
 * the write happens, which is why `commitGrant`'s WHERE clause repeats the
 * lock, expiry and consumption gates rather than trusting `notGrantable`.
 *
 * Those repeated predicates survived mutation testing untested — deleting
 * `attempts < ?` from commitGrant broke nothing, because the earlier gate
 * always fired first in every test. It fires first only when the row does not
 * change mid-call. This test changes it mid-call.
 *
 * It is deterministic, not timing-dependent: `bcryptjs` is pure JavaScript and
 * its async API yields to the event loop, so `grantByPassword` is guaranteed to
 * be suspended at that await when the synchronous UPDATE below runs.
 */
describe('the grant is re-checked after bcrypt, not before it', () => {
  it('refuses a correct password whose challenge was locked during the comparison', async () => {
    const userId = makeUser();
    const ch = open({ userId, sessionJti: 'jti-race' });

    const pending = reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });

    // Synchronous, therefore before bcrypt resolves: the parallel guessers that
    // a real attacker would have running against the same challenge.
    db.prepare('UPDATE reauth_challenges SET attempts = ? WHERE id = ?')
      .run(reauth.MAX_ATTEMPTS, ch.id);

    const res = await pending;

    // notGrantable() saw attempts = 0 and let this through. Only the duplicated
    // `attempts < ?` in commitGrant's WHERE clause can refuse it.
    expect(res).toEqual({ ok: false, error: 'locked' });
    expect(row(ch.id).granted_at).toBe(null);
  });

  it('refuses a correct password whose challenge expired during the comparison', async () => {
    const userId = makeUser();
    const ch = open({ userId, sessionJti: 'jti-race-expiry' });

    const pending = reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });
    setExpiry(ch.id, new Date(Date.now() - 1000).toISOString());

    const res = await pending;

    expect(res).toEqual({ ok: false, error: 'expired' });
    expect(row(ch.id).granted_at).toBe(null);
  });
});

// RULE: bound to action.
describe('a grant is bound to its action', () => {
  it('will not let a grant for one action authorise another', async () => {
    const userId = makeUser();
    const ch = await granted({ userId, action: 'email.change', params: { newEmail: 'a@x.com' } });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: false, error: 'action_mismatch' });
    expect(row(ch.id).consumed_at, 'the grant was spent on an action it never authorised').toBe(null);
  });

  it('treats an unregistered action as a mismatch rather than throwing', async () => {
    // consumeChallenge runs inside the handler's transaction; a throw there
    // would roll back the caller's work rather than simply denying it.
    const userId = makeUser();
    const ch = await granted({ userId });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.rename', params: {}, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: false, error: 'action_mismatch' });
    expect(row(ch.id).consumed_at).toBe(null);
  });
});

// RULE: bound to params_hash.
describe('a grant is bound to the params it was opened for', () => {
  it('will not move the address the user did not verify', async () => {
    const userId = makeUser();
    const ch = await granted({ userId, action: 'email.change', params: { newEmail: 'a@x.com' } });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId,
      action: 'email.change', params: { newEmail: 'attacker@x.com' }, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: false, error: 'params_mismatch' });
    expect(row(ch.id).consumed_at).toBe(null);
  });

  it('binds only the params the action declares, in a key-order-independent way', async () => {
    // `oauth.link` binds `provider` and nothing else, so an unbound field and a
    // reordered body must both still match — a binding that fails legitimate
    // calls gets removed by the next person who hits it.
    const userId = makeUser();
    const ch = await granted({ userId, action: 'oauth.link', params: { provider: 'google', extra: 1 } });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId,
      action: 'oauth.link', params: { extra: 1, provider: 'google' }, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: true });
  });
});

// RULE: bound to session_jti.
describe('a grant is bound to the session that opened it', () => {
  it('cannot be spent from a different session', async () => {
    const userId = makeUser();
    const ch = await granted({ userId, sessionJti: 'jti-original' });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: 'jti-stolen'
    });

    expect(res).toEqual({ ok: false, error: 'session_mismatch' });
    expect(row(ch.id).consumed_at).toBe(null);
  });

  it('cannot be spent with no session at all', async () => {
    const userId = makeUser();
    const ch = await granted({ userId, sessionJti: 'jti-original' });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId, action: 'account.delete', params: {}, sessionJti: null
    });

    expect(res.ok).toBe(false);
    expect(row(ch.id).consumed_at).toBe(null);
  });

  it("cannot be spent by a different user holding the id", async () => {
    const owner = makeUser();
    const stranger = makeUser();
    const ch = await granted({ userId: owner });

    const res = await reauth.consumeChallenge({
      db, challengeId: ch.id, userId: stranger, action: 'account.delete', params: {}, sessionJti: 'jti-a'
    });

    expect(res).toEqual({ ok: false, error: 'not_found' });
    expect(row(ch.id).consumed_at).toBe(null);
  });
});
