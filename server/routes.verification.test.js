import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('auth: email verification (flag on)', () => {
  let srv;

  beforeAll(async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  });

  const tokenFor = (userId) => {
    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    const row = db.prepare(
      'SELECT token FROM email_verification_tokens WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1'
    ).get(userId);
    db.close();
    return row?.token;
  };

  const signup = (email) => srv.call('POST', '/api/auth/signup', {
    email, password: 'password123', name: 'Test Person', role: 'student', grade: '10',
    username: `u${Math.random().toString(36).slice(2, 9)}`
  });

  it('creates a new account unverified and issues a token', async () => {
    const res = await signup('unverified@example.org');
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
    expect(tokenFor(res.body.user.id)).toBeTruthy();
  });

  it('marks the account verified when the token is presented', async () => {
    const res = await signup('confirms@example.org');
    const token = tokenFor(res.body.user.id);

    const verify = await srv.call('POST', '/api/auth/verify-email', { token });
    expect(verify.status).toBe(200);

    const me = await srv.call('GET', '/api/auth/me', undefined, res.body.token);
    expect(me.body.emailVerified).toBe(true);
  });

  it('rejects an unknown token', async () => {
    const res = await srv.call('POST', '/api/auth/verify-email', { token: 'not-a-real-token' });
    expect(res.status).toBe(400);
  });

  it('burns the token so it cannot be replayed', async () => {
    const res = await signup('replay@example.org');
    const token = tokenFor(res.body.user.id);
    expect((await srv.call('POST', '/api/auth/verify-email', { token })).status).toBe(200);
    expect((await srv.call('POST', '/api/auth/verify-email', { token })).status).toBe(400);
  });

  it('resends a fresh token to the signed-in user', async () => {
    const res = await signup('resend@example.org');
    const first = tokenFor(res.body.user.id);

    const resend = await srv.call('POST', '/api/auth/resend-verification', undefined, res.body.token);
    expect(resend.status).toBe(200);
    expect(tokenFor(res.body.user.id)).not.toBe(first);
  });

  it('requires authentication to resend', async () => {
    const res = await srv.call('POST', '/api/auth/resend-verification');
    expect(res.status).toBe(401);
  });

  it('blocks an unverified user from a normal action route', async () => {
    const res = await signup('gated@example.org');
    const apps = await srv.call('GET', '/api/applications', undefined, res.body.token);
    expect(apps.status).toBe(403);
    expect(apps.body.code).toBe('email_unverified');
  });

  it('still allows the allowlisted routes for an unverified user', async () => {
    const res = await signup('allowlisted@example.org');
    const token = res.body.token;

    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);

    const resend = await srv.call('POST', '/api/auth/resend-verification', undefined, token);
    expect(resend.status).toBe(200);

    const notifications = await srv.call('GET', '/api/notifications', undefined, token);
    expect(notifications.status).toBe(200);
  });

  it('unblocks the same token once the account is verified', async () => {
    const res = await signup('unblock@example.org');
    const token = res.body.token;

    const blocked = await srv.call('GET', '/api/applications', undefined, token);
    expect(blocked.status).toBe(403);

    const verifyToken = tokenFor(res.body.user.id);
    const verify = await srv.call('POST', '/api/auth/verify-email', { token: verifyToken });
    expect(verify.status).toBe(200);

    const allowed = await srv.call('GET', '/api/applications', undefined, token);
    expect(allowed.status).toBe(200);
  });
});
