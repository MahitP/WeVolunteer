import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './testServer.js';

// One server for the whole file. See the note above.
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('auth: email verification state', () => {
  it('returns emailVerified on the user object', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body).toHaveProperty('emailVerified');
  });

  it('marks a seeded user verified when verification is not required', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.body.emailVerified).toBe(true);
  });

  it('marks a new signup verified when verification is not required', async () => {
    const res = await srv.call('POST', '/api/auth/signup', {
      email: 'verify.check@example.org', password: 'password123',
      name: 'Verify Check', role: 'student', grade: '10'
    });
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(true);
  });
});

describe('auth: password reset', () => {
  const tokenFor = (userId) => {
    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    const row = db.prepare(
      'SELECT token FROM password_reset_tokens WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1'
    ).get(userId);
    db.close();
    return row?.token;
  };

  it('issues a reset token for a known address', async () => {
    const res = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    expect(res.status).toBe(200);
    expect(tokenFor('user-student-1')).toBeTruthy();
  });

  it('does not reveal whether an address exists', async () => {
    const known = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    const unknown = await srv.call('POST', '/api/auth/forgot-password', { email: 'nobody@example.org' });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('resets the password and lets the user sign in with it', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    const token = tokenFor('user-student-1');

    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'brand-new-pass' });
    expect(res.status).toBe(200);

    const relogin = await srv.call('POST', '/api/auth/login', {
      email: 'leo.chen28@gmail.com', password: 'brand-new-pass'
    });
    expect(relogin.status).toBe(200);
  });

  it('burns the token so it cannot be replayed', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'priya.patel.nhs@outlook.com' });
    const token = tokenFor('user-student-2');

    const first = await srv.call('POST', '/api/auth/reset-password', { token, password: 'first-change' });
    expect(first.status).toBe(200);

    const replay = await srv.call('POST', '/api/auth/reset-password', { token, password: 'second-change' });
    expect(replay.status).toBe(400);
  });

  it('rejects an expired token', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'emiller2027@gmail.com' });
    const token = tokenFor('user-student-3');

    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    db.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token = ?')
      .run('2020-01-01T00:00:00.000Z', token);
    db.close();

    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'too-late-pass' });
    expect(res.status).toBe(400);
  });

  it('rejects a password below the minimum length', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'advait.g@yahoo.com' });
    const token = tokenFor('user-advait');
    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'abc' });
    expect(res.status).toBe(400);
  });
});
