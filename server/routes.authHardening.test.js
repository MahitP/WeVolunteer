import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * A file-wide budget, measured rather than guessed.
 *
 * Every test here drives the login throttle by making real sign-in attempts, so each
 * one performs a handful of bcrypt comparisons — the cost is the point, because the
 * throttle is what the file exists to prove. `clears the bucket on a successful
 * sign-in` alone does twelve.
 *
 * Isolated they run ~1.3s against vitest's 5000ms default. Under the parallel load of
 * the full suite that one was measured at 5083ms and timed out. Nothing was hung: the
 * work did not fit, which makes it a flake rather than a defect in the code under
 * test — and flakiness is a defect in its own right on the gate every other gate
 * depends on.
 *
 * Set once for the file rather than per test, because every test in it has the same
 * shape and the same exposure. The global default stays 5000ms so a genuinely hung
 * test elsewhere still fails fast.
 */
vi.setConfig({ testTimeout: 20000 });

/**
 * Stage 2 hardening findings: S1, S2, S3 and U1.
 *
 * Each test states the concrete failure it is pinning, because every one of
 * these behaviours was reachable while the suite was fully green.
 *
 * Imports are dynamic and inside beforeAll: config.js reads JWT_SECRET at module
 * load and throws without it, and startTestServer is what sets it.
 */

let srv;
let __resetLoginThrottle;

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ __resetLoginThrottle } = await import('./routes/authRoutes.js'));
});
afterAll(async () => { await srv?.close?.(); });
beforeEach(() => { __resetLoginThrottle(); });

const post = (path, body, headers = {}) => fetch(`${srv.base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const login = (email, password) => post('/api/auth/login', { email, password });

/** The seeded student, reachable by either identifier. */
const EMAIL = 'leo.chen@example.com';
const PASSWORD = 'password123';

async function usernameOf(email) {
  const res = await login(email, PASSWORD);
  const body = await res.json();
  return body.user.username;
}

/** Burns `n` wrong-password attempts against `identifier`. */
async function fail(identifier, n) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const res = await login(identifier, 'definitely-not-the-password');
    codes.push(res.status);
  }
  return codes;
}

describe('S1 — the login throttle is per account, not per spelling', () => {
  /**
   * The counter used to key on the identifier string, so an account reachable as
   * both an email address and a username had two independent buckets and twice
   * the allowance. Alternating spellings doubled the attempts available against
   * one account, which is the exact shape the throttle exists to stop.
   */
  it('counts email and username attempts against the same bucket', async () => {
    const username = await usernameOf(EMAIL);
    __resetLoginThrottle();

    // Ten failures is the limit, spent half under each spelling.
    await fail(EMAIL, 5);
    await fail(username, 5);

    // The eleventh must be refused whichever spelling it arrives under.
    const viaUsername = await login(username, 'still-wrong');
    expect(viaUsername.status).toBe(429);
    expect((await viaUsername.json()).code).toBe('account_throttled');

    const viaEmail = await login(EMAIL, 'still-wrong');
    expect(viaEmail.status).toBe(429);
  }, 15000);

  it('does not let one account lock out another', async () => {
    await fail(EMAIL, 11);

    const other = await login('priya.patel@example.com', PASSWORD);
    expect(other.status).toBe(200);
  }, 15000);

  it('clears the bucket on a successful sign-in', async () => {
    await fail(EMAIL, 5);
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);

    // Five more must not tip it over: the earlier five are gone.
    await fail(EMAIL, 5);
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
  });
});

describe('S2 — the lock is checked before the account-shape branches', () => {
  /**
   * The lock used to sit below the no_such_account / suspended / oauth_only
   * replies, so a caller who was already locked out could still read all three
   * of those oracles at will. A lock that only guards the password comparison
   * is not a lock on the endpoint.
   */
  /**
   * The `!userRow` reply sat above the lock check, so probes against an
   * identifier matching no account were never gated by it at all — the counter
   * recorded them and nothing ever read the count back. This passing proves the
   * check now runs before that branch.
   */
  it('throttles probes against identifiers that match no account', async () => {
    const codes = await fail('does-not-exist@nowhere.test', 11);
    // The first ten are answered normally; the eleventh is refused.
    expect(codes.slice(0, 10).every(c => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);

    const res = await login('does-not-exist@nowhere.test', 'x');
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('account_throttled');
  }, 15000);

  it('stops answering wrong_password for a locked real account', async () => {
    await fail(EMAIL, 10);

    const res = await login(EMAIL, 'still-wrong');
    expect(res.status).toBe(429);
    // Not 401/wrong_password: the lock is now the first thing consulted.
    expect((await res.json()).code).toBe('account_throttled');
  }, 15000);

  it('refuses even the correct password while locked', async () => {
    await fail(EMAIL, 10);

    // Locking must not be bypassable by finally guessing right — that would
    // make the throttle decorative against an online attack.
    const res = await login(EMAIL, PASSWORD);
    expect(res.status).toBe(429);
  }, 15000);
});

describe('S3 — PATCH /profile uses the same rules as signup', () => {
  let cookie;
  beforeEach(async () => {
    const res = await login(EMAIL, PASSWORD);
    cookie = res.headers.get('set-cookie').split(';')[0];
  });

  const patch = (body) => fetch(`${srv.base}/api/auth/profile`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body)
  });

  /** `name.trim()` on a non-string threw, so this answered 500. */
  it('rejects a non-string name with 400, not 500', async () => {
    const res = await patch({ name: 12345 });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('name');
  });

  it('rejects a whitespace-only name instead of storing an empty one', async () => {
    const res = await patch({ name: '   ' });
    expect(res.status).toBe(400);

    const me = await fetch(`${srv.base}/api/auth/me`, { headers: { Cookie: cookie } });
    expect((await me.json()).name.trim()).not.toBe('');
  });

  it('enforces the same length limits signup does', async () => {
    expect((await patch({ name: 'a'.repeat(101) })).status).toBe(400);
    expect((await patch({ bio: 'b'.repeat(501) })).status).toBe(400);
    expect((await patch({ school: 's'.repeat(201) })).status).toBe(400);
    // An avatar is one emoji from a fixed palette, never a smuggled payload.
    expect((await patch({ avatar: '<img src=x onerror=alert(1)>' })).status).toBe(400);
  });

  it('still accepts a legitimate edit', async () => {
    const res = await patch({ name: 'Leo Chen', bio: 'I help at the food pantry.' });
    expect(res.status).toBe(200);
    expect((await res.json()).user.bio).toBe('I help at the food pantry.');
  });
});

describe('U1 — forgot-password accepts a username', () => {
  /**
   * The sign-in field takes either identifier and the "Forgot?" link carries it
   * straight over, so a student who signs in with their username got "a reset
   * link is on its way" and no mail was ever sent.
   */
  it('answers identically for an email, a username, and neither', async () => {
    const username = await usernameOf(EMAIL);

    const byEmail = await post('/api/auth/forgot-password', { email: EMAIL });
    const byUsername = await post('/api/auth/forgot-password', { email: username });
    const byNothing = await post('/api/auth/forgot-password', { email: 'nobody@nowhere.test' });

    expect(byEmail.status).toBe(200);
    expect(byUsername.status).toBe(200);
    expect(byNothing.status).toBe(200);

    const bodies = await Promise.all([byEmail.json(), byUsername.json(), byNothing.json()]);
    // Byte-identical, so widening the lookup leaks nothing new.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('issues a usable token when given a username', async () => {
    const username = await usernameOf(EMAIL);
    const res = await post('/api/auth/forgot-password', { email: username });
    expect(res.status).toBe(200);

    // The proof it did something: a live reset row now exists for that account.
    //
    // The row is all this case needs, and the row is all migration 048 leaves
    // readable — the token itself is a SHA-256 digest in the table now, so a
    // column that still exists is selected instead of the one that does not.
    const { db } = await import('./db.js');
    const user = await db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(EMAIL);
    const token = await db.prepare('SELECT user_id FROM password_reset_tokens WHERE user_id = ?').get(user.id);
    expect(token).toBeTruthy();
  });

  it('does not reveal the address behind a username', async () => {
    const username = await usernameOf(EMAIL);
    const res = await post('/api/auth/forgot-password', { email: username });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(EMAIL);
  });
});
