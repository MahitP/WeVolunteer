import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';

/**
 * The account-enumeration surface, pinned.
 *
 * ── The finding, and why most of it is deliberate ──
 *
 * `POST /api/auth/login` distinguishes "no such account" from "wrong password".
 * That is an enumeration oracle, and on a platform whose users are mostly minors
 * it means anyone can confirm whether a given child has an account here.
 *
 * It is kept, for a reason that is worth stating plainly rather than hiding: the
 * signup form needs live availability checks for both email and username
 * (`/api/auth/check-email`, `/api/auth/check-username`), because a username field
 * with no live tick is a worse experience for everyone. Those endpoints answer
 * the same question, so making login generic while leaving them open would move
 * the oracle rather than close it — and it would cost real usability, since a
 * student who mistypes their username cannot otherwise tell that from a
 * forgotten password.
 *
 * What bounds it instead:
 *   • every one of these endpoints sits behind a rate limiter (app.js)
 *   • login additionally throttles per resolved ACCOUNT, so the answer cannot be
 *     harvested in bulk from rotating source addresses
 *   • the reversal switch exists and is one constant: GENERIC_LOGIN_ERRORS
 *
 * ── What must NOT leak, and is asserted below ──
 *
 * Password reset and verification are the flows where a leak would be gratuitous:
 * they are unauthenticated, they are reachable without knowing anything, and they
 * have no usability argument for being specific. Those must be uniform.
 *
 * This file exists so the distinction cannot drift silently. If someone makes
 * forgot-password specific, or makes login generic without also closing the
 * check endpoints, a test says so.
 */

let srv;
beforeAll(async () => { srv = await startTestServer(); }, 60000);
afterAll(async () => { await srv?.close(); });

const REAL = 'leo.chen@example.com';
const FAKE = 'definitely-not-a-user-99@example.org';

describe('password reset does not reveal whether an account exists', () => {
  it('answers identically for a real and an unknown address', async () => {
    const real = await srv.call('POST', '/api/auth/forgot-password', { email: REAL });
    const fake = await srv.call('POST', '/api/auth/forgot-password', { email: FAKE });

    expect(real.status).toBe(fake.status);
    expect(real.status).toBe(200);
    // Byte-identical bodies: a difference in wording is itself the oracle.
    expect(JSON.stringify(real.body)).toBe(JSON.stringify(fake.body));
  });

  it('does not name the account in the response', async () => {
    const res = await srv.call('POST', '/api/auth/forgot-password', { email: REAL });
    expect(JSON.stringify(res.body)).not.toContain(REAL);
  });

  it('answers the same for a malformed address', async () => {
    const res = await srv.call('POST', '/api/auth/forgot-password', { email: 'not-an-email' });
    expect([200, 400]).toContain(res.status);
  });
});

describe('reset and verification tokens do not reveal account state', () => {
  it('an unknown reset token is refused without describing why', async () => {
    const res = await srv.call('POST', '/api/auth/reset-password', { token: 'made-up', password: 'GoodPass123!' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body || {})).not.toMatch(/@/);
  });

  it('an unknown verification token is refused without describing why', async () => {
    const res = await srv.call('POST', '/api/auth/verify-email', { token: 'made-up' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body || {})).not.toMatch(/@/);
  });

  it('resend-verification requires a session, so it cannot be probed anonymously', async () => {
    const res = await srv.call('POST', '/api/auth/resend-verification', {});
    expect(res.status).toBe(401);
  });
});

describe('the availability checks are narrow and bounded', () => {
  it('check-email answers only about a syntactically valid address', async () => {
    const res = await srv.call('GET', '/api/auth/check-email?email=x');
    expect(res.body.valid).toBe(false);
    // A format complaint, not a statement about the database.
    expect(res.body).not.toHaveProperty('available', true);
  });

  it('check-username answers only about a syntactically valid candidate', async () => {
    const res = await srv.call('GET', '/api/auth/check-username?username=a');
    expect(res.body.valid).toBe(false);
  });

  it('does not return anything about the account beyond availability', async () => {
    const res = await srv.call('GET', `/api/auth/check-email?email=${encodeURIComponent(REAL)}`);
    expect(Object.keys(res.body).sort()).toEqual(['available', 'valid']);
    expect(res.body.available).toBe(false);
  });
});

describe('login: the deliberate oracle, pinned so it cannot drift unnoticed', () => {
  it('is documented as a deliberate trade-off with a named reversal switch', async () => {
    const { readFileSync } = await import('fs');
    const path = await import('path');
    const src = readFileSync(path.join(process.cwd(), 'server', 'routes', 'authRoutes.js'), 'utf8');
    expect(src).toMatch(/GENERIC_LOGIN_ERRORS/);
    expect(src).toMatch(/enumeration/i);
  });

  it('distinguishes unknown account from wrong password (current, intended behaviour)', async () => {
    const unknown = await srv.call('POST', '/api/auth/login', { email: FAKE, password: 'whatever123' });
    const wrong = await srv.call('POST', '/api/auth/login', { email: REAL, password: 'WrongPass123!' });
    expect(unknown.body.code).toBe('no_such_account');
    expect(wrong.body.code).toBe('wrong_password');
  });

  it('never returns a password hash or token in any login response', async () => {
    for (const body of [
      { email: FAKE, password: 'x' },
      { email: REAL, password: 'WrongPass123!' },
      { email: REAL, password: 'password123' }
    ]) {
      const res = await srv.call('POST', '/api/auth/login', body);
      const text = JSON.stringify(res.body || {});
      expect(text).not.toMatch(/\$2[aby]\$/);      // bcrypt hash
      expect(text).not.toMatch(/password_hash/);
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // a JWT in the body
    }
  });

  it('throttles per account, which is what bounds bulk harvesting', async () => {
    const { __resetLoginThrottle } = await import('./routes/authRoutes.js');
    __resetLoginThrottle();
    const target = 'priya.patel@example.com';
    let throttled = false;
    for (let i = 0; i < 14; i++) {
      const res = await srv.call('POST', '/api/auth/login', { email: target, password: `no${i}` });
      if (res.status === 429) { throttled = true; break; }
    }
    expect(throttled, 'repeated probing of one account must eventually be refused').toBe(true);
    __resetLoginThrottle();
  });
});

describe('signup reports a taken identity, which it must to be usable', () => {
  it('says the email is taken rather than failing opaquely', async () => {
    const res = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      name: 'Dup', grade: '11', role: 'student', school: 'SB',
      email: REAL, username: 'dupuser1', password: 'GoodPass123!'
    });
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('email');
  });

  it('does not disclose anything about the existing account', async () => {
    const res = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      name: 'Dup', grade: '11', role: 'student', school: 'SB',
      email: REAL, username: 'dupuser2', password: 'GoodPass123!'
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Leo|Chen/);   // no name of the existing holder
    expect(text).not.toMatch(/\$2[aby]\$/);
  });
});
