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
