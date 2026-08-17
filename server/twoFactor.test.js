import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';

let srv;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

describe('2FA features', () => {
  it('POST /api/auth/login-2fa throttling: returns 429 after 5 failed attempts', async () => {
    // Create and confirm a user
    const { user } = await srv.signupConfirmed({
      email: 'tfa.throttle@example.org',
      password: 'Password123',
      name: 'Throttle Test',
      username: 'tfa_throttle',
      role: 'student',
      grade: '10'
    });

    // Manually enable 2FA
    const { db } = await import('./db.js');
    await db.prepare('UPDATE users SET tfa_enabled = 1, tfa_secret = ? WHERE id = ?').run('fake_secret', user.id);

    // Login to get preauth cookie
    const loginRes = await srv.call('POST', '/api/auth/login', {
      email: 'tfa.throttle@example.org',
      password: 'Password123'
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.require2FA).toBe(true);

    const setCookie = loginRes.headers.get('set-cookie');
    const preauthMatch = setCookie.match(/wev_preauth=([^;]+)/);
    expect(preauthMatch).toBeTruthy();
    const preauthCookie = preauthMatch[1];

    // Attempt 5 invalid logins
    for (let i = 0; i < 5; i++) {
      const res = await srv.call('POST', '/api/auth/login-2fa', { method: 'totp', code: '000000' }, null, {
        Cookie: `wev_preauth=${preauthCookie}`
      });
      expect(res.status).toBe(401);
    }

    // 6th attempt should be throttled (429)
    const res6 = await srv.call('POST', '/api/auth/login-2fa', { method: 'totp', code: '000000' }, null, {
      Cookie: `wev_preauth=${preauthCookie}`
    });
    expect(res6.status).toBe(429);
  });

  it('AAL2 gating on POST /api/2fa/generate and POST /api/2fa/enable', async () => {
    const { cookie } = await srv.signupConfirmed({
      email: 'tfa.gating@example.org',
      password: 'Password123',
      name: 'Gating Test',
      username: 'tfa_gating',
      role: 'student',
      grade: '10'
    });

    // Without AAL2 challenge, generate should fail
    const genRes = await srv.call('POST', '/api/2fa/generate', undefined, cookie);
    expect(genRes.status).toBe(403);
    expect(genRes.body.code).toBe('reauth_required');

    // Without AAL2 challenge, enable should fail
    const enableRes = await srv.call('POST', '/api/2fa/enable', { token: '123456' }, cookie);
    expect(enableRes.status).toBe(403);
    expect(enableRes.body.code).toBe('reauth_required');
  });

  it('email 2FA endpoints correctly set tfa_email_enabled to 1', async () => {
    const { cookie, user } = await srv.signupConfirmed({
      email: 'tfa.email@example.org',
      password: 'Password123',
      name: 'Email 2FA Test',
      username: 'tfa_email',
      role: 'student',
      grade: '10'
    });

    // Need AAL2 to enable email 2FA
    const headers = await srv.verified(cookie, '2fa.enable', { password: 'Password123' });

    const res = await srv.call('POST', '/api/2fa/email/enable', undefined, cookie, headers);
    expect(res.status).toBe(200);

    // Verify in DB
    const { db } = await import('./db.js');
    const updatedUser = await db.prepare('SELECT tfa_email_enabled FROM users WHERE id = ?').get(user.id);

    expect(updatedUser.tfa_email_enabled).toBe(1);
  });
});
