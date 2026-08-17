/**
 * Removing a sign-in credential needs the same proof as adding one.
 *
 * ── The asymmetry this closes (v1.2b audit, F-2) ──
 *
 * `POST /api/oauth/link` was gated on `requireAAL2('oauth.link')`, and the
 * engineering guide recorded the rule as "adding a sign-in credential requires
 * step-up". `POST /api/oauth/disconnect` — which mutates the same
 * `oauth_accounts` table in the opposite direction — asked only for a session.
 *
 * The v1.2b plan did look at `disconnect` and marked it "already correct", but
 * it judged the endpoint against LOCKOUT ("never leave an account with no way
 * back in") rather than against ASSURANCE. Those are different properties: the
 * last-credential guard stops a user stranding themselves, and does nothing
 * about somebody holding a borrowed session stripping a provider off an account
 * that still has a password. That costs the account holder the sign-in route
 * they actually use, and removes one of the two ways they could have satisfied
 * a future step-up.
 *
 * `oauth.unlink` binds `provider`, exactly as `oauth.link` does, so a grant
 * authorises removing ONE named provider.
 *
 * The lockout guard is deliberately still checked BEFORE the grant is spent: a
 * refused disconnect must not cost the user a verification for something that
 * never happened.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

const PW = 'Password123';
const OAUTH_ONLY = '!OAUTH_ONLY!';

let srv, db;

beforeAll(async () => {
  process.env.OAUTH_ALLOW_MOCK = 'true';
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => {
  await srv.close();
  delete process.env.OAUTH_ALLOW_MOCK;
});

let seq = 0;
const account = () => {
  seq += 1;
  return {
    email: `unlink.${seq}@example.org`, password: PW, name: 'Unlink Subject',
    role: 'student', grade: '9', school: 'Test High School',
    username: `unlink_${seq}`
  };
};

const linkProvider = (userId, provider, sub) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO oauth_accounts
      (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`oauth-${provider}-${userId}`, userId, provider, sub, `${provider}@example.org`, now, now, now);
};

const isLinked = (userId, provider) =>
  !!db.prepare('SELECT 1 FROM oauth_accounts WHERE user_id = ? AND provider = ?').get(userId, provider);

describe('oauth disconnect: the gate', () => {
  it('refuses a session that has not verified, and names the action', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-1');

    const res = await srv.call('POST', '/api/oauth/disconnect', { provider: 'google' }, cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('oauth.unlink');
    expect(isLinked(user.id, 'google')).toBe(true);
  });

  it('removes the provider once a grant bound to it is presented', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-2');

    const header = await srv.verified(cookie, 'oauth.unlink', {
      password: PW, params: { provider: 'google' }
    });
    const res = await srv.call('POST', '/api/oauth/disconnect', { provider: 'google' }, cookie, header);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(isLinked(user.id, 'google')).toBe(false);
  });

  it('does not accept a grant bound to a different provider', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-3');
    linkProvider(user.id, 'microsoft', 'sub-ms-3');

    const header = await srv.verified(cookie, 'oauth.unlink', {
      password: PW, params: { provider: 'microsoft' }
    });
    const res = await srv.call('POST', '/api/oauth/disconnect', { provider: 'google' }, cookie, header);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('params_mismatch');
    expect(isLinked(user.id, 'google')).toBe(true);
  });

  it('does not accept an oauth.link grant for the same provider', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-4');

    const header = await srv.verified(cookie, 'oauth.link', {
      password: PW, params: { provider: 'google' }
    });
    const res = await srv.call('POST', '/api/oauth/disconnect', { provider: 'google' }, cookie, header);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(isLinked(user.id, 'google')).toBe(true);
  });

  it('is single use', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-5');
    linkProvider(user.id, 'microsoft', 'sub-ms-5');

    const challengeId = await srv.stepUp(cookie, 'oauth.unlink', {
      password: PW, params: { provider: 'google' }
    });
    const header = srv.reauthHeader(challengeId);

    expect((await srv.call('POST', '/api/oauth/disconnect', { provider: 'google' }, cookie, header)).status).toBe(200);

    // Re-link and try the same grant again. 403 rather than 409 `consumed`:
    // `requireAAL2` asks `peekChallenge`, which already refuses a spent row, so
    // the early refusal answers before the handler runs. Same shape
    // authz.aal.test.js asserts for a consumed grant.
    linkProvider(user.id, 'google', 'sub-google-5');
    const replay = await srv.call('POST', '/api/oauth/disconnect', { provider: 'google' }, cookie, header);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('reauth_required');
    expect(isLinked(user.id, 'google')).toBe(true);
  });
});

describe('oauth disconnect: the lockout guard is preserved and comes first', () => {
  it('still refuses to remove a provider-only account\'s last sign-in method', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-6');
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(OAUTH_ONLY, user.id);

    // A provider-only account has no password, so it verifies by re-consent.
    const challengeId = await srv.stepUpOAuth(cookie, 'oauth.unlink', {
      params: { provider: 'google' }, provider: 'google', sub: 'sub-google-6'
    });

    const res = await srv.call(
      'POST', '/api/oauth/disconnect', { provider: 'google' }, cookie, srv.reauthHeader(challengeId)
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('last_sign_in_method');
    expect(isLinked(user.id, 'google')).toBe(true);

    // …and the refusal did not cost the verification.
    const row = await db.prepare('SELECT consumed_at FROM reauth_challenges WHERE id = ?').get(challengeId);
    expect(row.consumed_at).toBeNull();
  });

  it('lets a provider-only account with two providers remove one, by re-consent', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-7');
    linkProvider(user.id, 'microsoft', 'sub-ms-7');
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(OAUTH_ONLY, user.id);

    const challengeId = await srv.stepUpOAuth(cookie, 'oauth.unlink', {
      params: { provider: 'microsoft' }, provider: 'google', sub: 'sub-google-7'
    });
    const res = await srv.call(
      'POST', '/api/oauth/disconnect', { provider: 'microsoft' }, cookie, srv.reauthHeader(challengeId)
    );
    expect(res.status).toBe(200);
    expect(isLinked(user.id, 'microsoft')).toBe(false);
    expect(isLinked(user.id, 'google')).toBe(true);
  });

  it('answers "not connected" without spending the grant', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-8');

    const challengeId = await srv.stepUp(cookie, 'oauth.unlink', {
      password: PW, params: { provider: 'microsoft' }
    });
    const res = await srv.call(
      'POST', '/api/oauth/disconnect', { provider: 'microsoft' }, cookie, srv.reauthHeader(challengeId)
    );
    expect(res.status).toBe(404);

    const row = await db.prepare('SELECT consumed_at FROM reauth_challenges WHERE id = ?').get(challengeId);
    expect(row.consumed_at).toBeNull();
  });
});

describe('oauth link: unchanged by the unlink work', () => {
  it('still refuses an unverified request', async () => {
    const { cookie } = await srv.signupConfirmed(account());
    const res = await srv.call('POST', '/api/oauth/link', { linkToken: 'whatever' }, cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('oauth.link');
  });

  it('an oauth.unlink grant does not satisfy the link gate', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    linkProvider(user.id, 'google', 'sub-google-9');

    const header = await srv.verified(cookie, 'oauth.unlink', {
      password: PW, params: { provider: 'google' }
    });
    const res = await srv.call('POST', '/api/oauth/link', { linkToken: 'whatever' }, cookie, header);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });
});
