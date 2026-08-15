import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_SIGNUP_DEFAULTS } from './testConsent.js';
import { installMailbox } from './testMailbox.js';

describe('auth: email verification (flag on)', () => {
  let srv;
  let mailbox;

  beforeAll(async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
    mailbox = installMailbox();
  });
  afterAll(async () => {
    mailbox.restore();
    await srv.close();
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  });

  /**
   * The token is read out of the message that was actually sent, the way the
   * person receiving it does. The column it used to be read from holds a
   * SHA-256 digest since migration 048, so nothing can recover it from the
   * table — which is the point of that migration.
   */
  const tokenFor = (email) => mailbox.waitForToken(email, 'verify');

  // Clears first, so a token from an earlier case can never be mistaken for
  // the one this signup triggers.
  const signup = (email) => {
    mailbox.clear();
    return srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email, password: 'Password123', name: 'Test Person', role: 'student', grade: '10',
      username: `u${Math.random().toString(36).slice(2, 9)}`
    });
  };

  it('creates a new account unverified and issues a token', async () => {
    const res = await signup('unverified@example.org');
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
    expect(await tokenFor('unverified@example.org')).toBeTruthy();
  });

  it('marks the account verified when the token is presented', async () => {
    const res = await signup('confirms@example.org');
    const token = await tokenFor('confirms@example.org');

    const verify = await srv.call('POST', '/api/auth/verify-email', { token });
    expect(verify.status).toBe(200);

    const me = await srv.call('GET', '/api/auth/me', undefined, res.cookie);
    expect(me.body.emailVerified).toBe(true);
  });

  it('rejects an unknown token', async () => {
    const res = await srv.call('POST', '/api/auth/verify-email', { token: 'not-a-real-token' });
    expect(res.status).toBe(400);
  });

  it('burns the token so it cannot be replayed', async () => {
    const res = await signup('replay@example.org');
    expect(res.status).toBe(201);
    const token = await tokenFor('replay@example.org');
    expect((await srv.call('POST', '/api/auth/verify-email', { token })).status).toBe(200);
    expect((await srv.call('POST', '/api/auth/verify-email', { token })).status).toBe(400);
  });

  it('resends a fresh token to the signed-in user', async () => {
    const res = await signup('resend@example.org');
    const first = await tokenFor('resend@example.org');

    // Forget the signup message, so the token read below can only be the one
    // the resend produced.
    mailbox.clear();
    const resend = await srv.call('POST', '/api/auth/resend-verification', undefined, res.cookie);
    expect(resend.status).toBe(200);
    expect(await tokenFor('resend@example.org')).not.toBe(first);
  });

  it('requires authentication to resend', async () => {
    const res = await srv.call('POST', '/api/auth/resend-verification');
    expect(res.status).toBe(401);
  });

  it('blocks an unverified user from a normal action route', async () => {
    const res = await signup('gated@example.org');
    const apps = await srv.call('GET', '/api/applications', undefined, res.cookie);
    expect(apps.status).toBe(403);
    expect(apps.body.code).toBe('email_unverified');
  });

  it('still allows the allowlisted routes for an unverified user', async () => {
    const res = await signup('allowlisted@example.org');
    const token = res.cookie;

    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);

    const resend = await srv.call('POST', '/api/auth/resend-verification', undefined, token);
    expect(resend.status).toBe(200);

    const notifications = await srv.call('GET', '/api/notifications', undefined, token);
    expect(notifications.status).toBe(200);
  });

  it('unblocks the same token once the account is verified', async () => {
    const res = await signup('unblock@example.org');
    const token = res.cookie;

    const blocked = await srv.call('GET', '/api/applications', undefined, token);
    expect(blocked.status).toBe(403);

    const verifyToken = await tokenFor('unblock@example.org');
    const verify = await srv.call('POST', '/api/auth/verify-email', { token: verifyToken });
    expect(verify.status).toBe(200);

    const allowed = await srv.call('GET', '/api/applications', undefined, token);
    expect(allowed.status).toBe(200);
  });
});
