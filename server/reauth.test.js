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

    const fifth = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: 'Wrong5' });
    expect(fifth.error).toBe('locked');
    expect(row(ch.id).attempts).toBe(5);

    // The assertion that matters: the correct password no longer helps. A lock
    // that the right guess can still open is not a lock.
    const correct = await reauth.grantByPassword({ db, challengeId: ch.id, userId, password: PASSWORD });
    expect(correct).toEqual({ ok: false, error: 'locked' });
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
    expect(res).toEqual({ ok: false, error: 'locked' });
    expect(row(ch.id).granted_at).toBe(null);
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
