/**
 * Rate limiting on the step-up password path.
 *
 * ── Why this is its own file ──
 *
 * express-rate-limit keeps its counters in the app's memory, keyed by client
 * address, and every request in a vitest file comes from 127.0.0.1 — so one
 * shared bucket spans the whole file. Testing the limit alongside the
 * functional tests would make those tests order-dependent on how many wrong
 * passwords happened to be tried before them. `REAUTH_RATE_LIMIT` is set low
 * here and high in routes.reauth.test.js, before the harness (and therefore
 * app.js and config.js) is imported.
 *
 * ── What the limiter is for, given the challenge already counts attempts ──
 *
 * `reauth.js` locks a single challenge after five wrong guesses. On its own
 * that bounds nothing: a caller can open a fresh challenge for every guess,
 * which costs one extra request and resets the counter. The per-challenge
 * limit is about one challenge; this limiter is about the endpoint, and only
 * the pair of them bounds guessing.
 *
 * That is exactly the shape of the test below — one wrong guess against each of
 * six DIFFERENT challenges, so nothing here is the per-challenge lock firing.
 * The two refusals are deliberately distinguishable: `code: 'locked'` from the
 * lifecycle, `code: 'rate_limited'` from the limiter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

let srv, db;
const PASSWORD = 'CorrectHorse1';
const JWT_SECRET = 'test-secret-not-for-production'; // what testServer.js sets
let session;

beforeAll(async () => {
  process.env.REAUTH_RATE_LIMIT = '5';
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));

  const id = 'reauth-rl-user';
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role,
                       verified, email_verified, created_at)
    VALUES (?, ?, ?, ?, ?, 'Adult', 'student', 1, 1, ?)
  `).run(id, 'Limited Person', `${id}@example.org`, id, await bcrypt.hash(PASSWORD, 10), now);

  const u = db.prepare('SELECT id, role, email, name FROM users WHERE id = ?').get(id);
  session = jwt.sign(
    { id: u.id, role: u.role, email: u.email, name: u.name, tokenVersion: 0, jti: crypto.randomUUID() },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}, 60000);

afterAll(async () => {
  await srv?.close?.();
  delete process.env.REAUTH_RATE_LIMIT;
});

async function post(path, body) {
  const res = await fetch(srv.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `wev_session=${session}` },
    body: JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

describe('the step-up password endpoint is rate limited', () => {
  it('refuses the sixth wrong guess in the window, across fresh challenges', async () => {
    const statuses = [];
    const codes = [];

    for (let i = 0; i < 6; i++) {
      // A NEW challenge each time, so the per-challenge attempt counter (which
      // locks at five) can never be what produces the refusal below.
      const opened = await post('/api/auth/reauth/challenge', { action: 'account.delete' });
      expect(opened.status).toBe(201);

      const attempt = await post('/api/auth/reauth/password', {
        challengeId: opened.body.challengeId,
        password: `wrong-${i}`
      });
      statuses.push(attempt.status);
      codes.push(attempt.body?.code);
    }

    // Five allowed through to the lifecycle, each an honest wrong-password answer.
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(0, 5)).toEqual(Array(5).fill('invalid_password'));

    // The sixth never reaches the lifecycle.
    expect(statuses[5]).toBe(429);
    expect(codes[5]).toBe('rate_limited');
  });

  it('does not limit opening challenges into silence — the refusal names itself', async () => {
    // Whatever the limiter refuses must still be a JSON body in the same shape
    // as the rest of the API; the client parses every error as JSON, and
    // express-rate-limit's text/plain default left it printing a bare status.
    const opened = await post('/api/auth/reauth/challenge', { action: 'account.delete' });
    const blocked = await post('/api/auth/reauth/password', {
      challengeId: opened.body.challengeId,
      password: 'still-wrong'
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/try again in about/i);
    expect(blocked.body.retryAfterMinutes).toBeGreaterThan(0);
  });
});
