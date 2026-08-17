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
 * ── What the limiter is for, given the lifecycle already counts attempts ──
 *
 * `reauth.js` bounds guessing PER ACCOUNT: five wrong answers across every
 * challenge the account opens in the window, so opening a fresh challenge no
 * longer buys anything (reauthRefreshBypass.test.js is that property). This
 * limiter is keyed on the client ADDRESS instead, and that is the half the
 * account budget cannot cover — one caller working through many accounts from
 * one machine spends a separate five-guess budget on each of them, and only the
 * limiter sees that they are the same caller.
 *
 * That is the shape of the test below: one wrong guess against a DIFFERENT
 * ACCOUNT each time, so neither the per-challenge lock nor the per-account
 * ceiling can be what produces the refusal. Before the account budget was
 * tightened this file could reuse one account, and the fifth guess started
 * being refused by the ceiling instead of the limiter — a green test proving
 * the wrong control.
 *
 * The refusals are deliberately distinguishable: `code: 'locked'` and
 * `code: 'account_locked'` from the lifecycle, `code: 'rate_limited'` here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

let srv, db;
const PASSWORD = 'CorrectHorse1';
const JWT_SECRET = 'test-secret-not-for-production'; // what testServer.js sets
let session;           // the shared account, for the cases that want one bucket
let makeSession;       // a fresh account per call, for the limiter proper

beforeAll(async () => {
  process.env.REAUTH_RATE_LIMIT = '5';
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));

  const id = 'reauth-rl-user';
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role,
                       verified, email_verified, created_at)
    VALUES (?, ?, ?, ?, ?, 'Adult', 'student', 1, 1, ?)
  `).run(id, 'Limited Person', `${id}@example.org`, id, await bcrypt.hash(PASSWORD, 10), now);

  const sign = (u) => jwt.sign(
    { id: u.id, role: u.role, email: u.email, name: u.name, tokenVersion: 0, jti: crypto.randomUUID() },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  session = sign(await db.prepare('SELECT id, role, email, name FROM users WHERE id = ?').get(id));

  /**
   * A brand-new account, so the per-account ceiling is never the thing refusing.
   *
   * The limiter is keyed on the client address and every request here comes from
   * 127.0.0.1, so distinct accounts share the limiter's bucket while having
   * entirely separate guessing budgets — which is precisely the separation this
   * file needs in order to attribute a refusal to the limiter.
   */
  let n = 0;
  const hash = await bcrypt.hash(PASSWORD, 10);
  makeSession = () => {
    const uid = `reauth-rl-user-${++n}`;
    db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role,
                         verified, email_verified, created_at)
      VALUES (?, ?, ?, ?, ?, 'Adult', 'student', 1, 1, ?)
    `).run(uid, 'Limited Person', `${uid}@example.org`, uid, hash, new Date().toISOString());
    return sign(db.prepare('SELECT id, role, email, name FROM users WHERE id = ?').get(uid));
  };
}, 60000);

afterAll(async () => {
  await srv?.close?.();
  delete process.env.REAUTH_RATE_LIMIT;
});

async function post(path, body, as = session) {
  const res = await fetch(srv.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `wev_session=${as}` },
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
      // A new ACCOUNT, and therefore a new challenge, each time — so neither the
      // per-challenge counter nor the per-account ceiling can be what produces
      // the refusal below. Only the limiter spans all six.
      const who = makeSession();
      const opened = await post('/api/auth/reauth/challenge', { action: 'account.delete' }, who);
      expect(opened.status).toBe(201);

      const attempt = await post('/api/auth/reauth/password', {
        challengeId: opened.body.challengeId,
        password: `wrong-${i}`
      }, who);
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
