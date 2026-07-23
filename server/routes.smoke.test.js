import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('route test harness', () => {
  let srv;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });

  it('serves the seeded events list', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('GET', '/api/events', undefined, token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('authenticates a seeded user', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    expect(token).toBeTruthy();
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('leo.chen28@gmail.com');
  });

  it('does not touch the real database file', () => {
    expect(process.env.SBV_DB_PATH).toContain('sbv-test-');
  });
});
