/**
 * The blanket API limiter must not let one person spend another's budget.
 *
 * `apiLimiter` covers every /api request. With no key generator it keyed on
 * `req.ip`, which in the pilot's own topology — one school building, one NAT
 * address, a few hundred students — is a single 600-request bucket for
 * everybody. A few dozen students browsing at lunchtime exhausted it and the
 * next person got a 429 on a request that was neither abusive nor theirs.
 *
 * These cases pin the three properties the fix rests on, because getting any
 * one of them wrong turns a lockout into something worse:
 *
 *   1. two signed-in accounts on ONE address get separate buckets  (the fix)
 *   2. the token is VERIFIED, so a forged or unsigned cookie cannot mint an
 *      unlimited number of buckets                                 (the trap)
 *   3. a preauth token is not a session                            (the gate)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';

let COOKIE_NAME, JWT_SECRET, keyFor, appSource;

beforeAll(async () => {
  const cfg = await import('./config.js');
  COOKIE_NAME = cfg.COOKIE_NAME;
  JWT_SECRET = cfg.JWT_SECRET;
  /* The function is exported and called directly. express-rate-limit v8 does
     not expose the resolved options on the middleware, and reaching into its
     internals would test the library rather than this key. The wiring — that
     this function is the limiter's generator at all — is asserted separately
     below, because a correct key that nothing uses is the false green this
     suite exists to avoid. */
  ({ apiLimiterKey: keyFor } = await import('./app.js'));
  appSource = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
});

/** A request carrying whatever cookie the case is about. */
const reqWith = (cookieValue, ip = '203.0.113.10') => ({
  ip,
  cookies: cookieValue === undefined ? {} : { [COOKIE_NAME]: cookieValue },
  headers: {},
});

const sessionFor = (id) => jwt.sign({ id }, JWT_SECRET);

/* ipKeyGenerator takes (req, res); it does not read res, but passing one keeps
   the call shape identical to the middleware's. */
const RES = {};

describe('the key is actually wired to the limiter', () => {
  it('apiLimiter uses apiLimiterKey as its key generator', () => {
    expect(appSource).toMatch(/keyGenerator:\s*apiLimiterKey/);
  });
});

describe('two accounts behind one address', () => {
  it('do not share a bucket — the lockout this fixes', () => {
    const a = keyFor(reqWith(sessionFor('user-a')), RES);
    const b = keyFor(reqWith(sessionFor('user-b')), RES);
    expect(a).not.toBe(b);
  });

  it('keep the same bucket across requests, so the limit still applies per account', () => {
    const first = keyFor(reqWith(sessionFor('user-a')), RES);
    const second = keyFor(reqWith(sessionFor('user-a'), '198.51.100.7'), RES);
    expect(second).toBe(first);
  });
});

describe('anonymous callers', () => {
  it('are still keyed by address, at the same rate as before', () => {
    const k = keyFor(reqWith(undefined, '203.0.113.10'), RES);
    expect(k).toMatch(/^api:ip:/);
  });

  it('on different addresses get different buckets', () => {
    expect(keyFor(reqWith(undefined, '203.0.113.10'), RES))
      .not.toBe(keyFor(reqWith(undefined, '203.0.113.11'), RES));
  });
});

describe('the token is verified, not merely read', () => {
  /**
   * The trap this avoids. If the cookie were trusted without checking the
   * signature, an attacker could send a different fabricated id on every
   * request and never collide with their own bucket — an unlimited budget,
   * which is strictly worse than the shared-bucket defect being fixed.
   */
  it('falls back to the address for a forged token', () => {
    const forged = jwt.sign({ id: 'attacker' }, 'not-the-real-secret');
    expect(keyFor(reqWith(forged), RES)).toMatch(/^api:ip:/);
  });

  it('falls back to the address for a structurally invalid cookie', () => {
    expect(keyFor(reqWith('not-a-jwt-at-all'), RES)).toMatch(/^api:ip:/);
  });

  it('gives two forged tokens the SAME bucket, so forging buys nothing', () => {
    const one = jwt.sign({ id: 'a' }, 'wrong-secret');
    const two = jwt.sign({ id: 'b' }, 'wrong-secret');
    expect(keyFor(reqWith(one), RES)).toBe(keyFor(reqWith(two), RES));
  });

  it('falls back to the address for an expired token', () => {
    const expired = jwt.sign({ id: 'user-a' }, JWT_SECRET, { expiresIn: -60 });
    expect(keyFor(reqWith(expired), RES)).toMatch(/^api:ip:/);
  });
});

describe('a preauth token is not a session', () => {
  /**
   * Issued mid-sign-in, before the second factor. `authenticateToken` refuses
   * it as a full session, so letting it name a bucket here would hand the
   * half-authenticated state an identity the rest of the application withholds.
   */
  it('is keyed by address, not by subject', () => {
    const preauth = jwt.sign({ id: 'user-a', preauth: true }, JWT_SECRET);
    expect(keyFor(reqWith(preauth), RES)).toMatch(/^api:ip:/);
  });
});

describe('the key does not disclose who is using the application', () => {
  it('hashes the subject rather than carrying it', () => {
    const key = keyFor(reqWith(sessionFor('leo.chen@example.com')), RES);
    expect(key).not.toMatch(/leo\.chen/);
    expect(key).toMatch(/^api:u:[0-9a-f]{32}$/);
  });
});
