import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ipKeyGenerator } from 'express-rate-limit';
import { __resetRedisConfig } from './redis/redisConfig.js';
import { __resetRedisUsage } from './redis/redisClient.js';
import { createSharedCounter, __resetLocalCounters } from './redis/limitStore.js';

/**
 * The authentication abuse architecture, as a layered system rather than as
 * four unrelated limiters.
 *
 * ── The question this file answers ──
 *
 * "If I run 2, 5, 20 or 100 backend instances, does authentication abuse
 * protection remain secure and predictable?"
 *
 * The answer is yes, and the reason is a domination property that was true but
 * nowhere asserted. There are four controls on the sign-in path:
 *
 *   authLimiter          10 failures / 15 min per IP        in-process
 *   loginLimiter         ~5 failures / 15 min per IP+account in-process
 *   loginFailures        10 failures / 15 min per ACCOUNT   SHARED
 *   IP-failure ceiling  200 failures / 15 min per IP block  SHARED
 *
 * The two in-process ones are strictly TIGHTER than shared controls covering
 * the same dimension. With N instances each local limiter degrades to N x its
 * budget — but the global bound is `min(N x local, shared)`, and the shared cap
 * never moves. So:
 *
 *   per account   min(N x 5, 10)   <= 10, whatever N is
 *   per IP block  min(N x 10, 200) <= 200, whatever N is
 *
 * That is why the in-process limiters do not need distributing: they are a
 * free, fast rejection path in front of an authoritative shared cap, and
 * distributing them would spend Redis commands on `skipSuccessfulRequests`
 * traffic — an increment on every request and a decrement on every success —
 * to buy a bound that already holds.
 *
 * This file asserts the shared halves, because those are what the property
 * rests on. If either shared cap were removed or keyed differently, the local
 * limiters alone would multiply with N and the whole argument would collapse.
 */
const realFetch = globalThis.fetch;

function enableRedis() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  __resetRedisConfig();
}
function disableRedis() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRedisConfig();
}

/** A Redis that really runs the counter script, shared by every "instance". */
function fakeRedis() {
  const store = new Map();
  const state = { calls: 0, fail: false };
  const live = (k) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) { store.delete(k); return null; }
    return e;
  };
  function run(cmd) {
    const [name, ...a] = cmd;
    if (name === 'GET') { const e = live(a[0]); return e ? String(e.value) : null; }
    if (name === 'DEL') { const had = live(a[0]) ? 1 : 0; store.delete(a[0]); return had; }
    if (name === 'PTTL') {
      const e = live(a[0]);
      if (!e) return -2;
      return e.expiresAt === null ? -1 : e.expiresAt - Date.now();
    }
    if (name === 'EVAL') {
      const n = Number(a[1]);
      const keys = a.slice(2, 2 + n);
      const argv = a.slice(2 + n);
      const key = keys[0];
      const e = live(key);
      const next = (e ? Number(e.value) : 0) + 1;
      const expiresAt = e ? e.expiresAt : Date.now() + Number(argv[0]);
      store.set(key, { value: next, expiresAt });
      return a[0].includes('PTTL')
        ? [next, expiresAt === null ? -1 : expiresAt - Date.now()]
        : next;
    }
    throw new Error(`unsupported ${name}`);
  }
  globalThis.fetch = vi.fn(async (url, init) => {
    state.calls += 1;
    if (state.fail) throw new TypeError('fetch failed');
    try {
      return new Response(JSON.stringify({ result: run(JSON.parse(init.body)) }), { status: 200 });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 200 });
    }
  });
  return { store, state, keys: () => [...store.keys()] };
}

const WINDOW = 15 * 60 * 1000;
const ACCOUNT_LIMIT = 10;
const IP_LIMIT = 200;

/** One backend instance's view of a shared counter. */
const account = () => createSharedCounter({ name: 'login-failure', windowMs: WINDOW });
const ipBlock = () => createSharedCounter({ name: 'login-ip-failure', windowMs: WINDOW });

let redis;
beforeEach(() => { __resetRedisUsage(); __resetLocalCounters(); redis = fakeRedis(); enableRedis(); });
afterEach(() => { globalThis.fetch = realFetch; disableRedis(); vi.restoreAllMocks(); });

describe('per-account guessing is bounded however many instances exist', () => {
  it('twenty instances attacking one account still stop at the shared cap', async () => {
    /**
     * The scenario the local `loginLimiter` cannot answer on its own: an
     * attacker whose requests are spread across every instance by the load
     * balancer. Each instance's local budget is untouched; the shared account
     * counter is not.
     */
    const instances = Array.from({ length: 20 }, account);
    let allowed = 0;
    for (let i = 0; i < 400; i++) {
      const inst = instances[i % instances.length];
      const { count } = await inst.peek('id:victim');
      if (count >= ACCOUNT_LIMIT) continue;
      await inst.hit('id:victim');
      allowed += 1;
    }
    expect(allowed, 'the shared account cap did not hold across instances').toBe(ACCOUNT_LIMIT);
  });

  it('a successful sign-in clears only that account', async () => {
    const a = account();
    for (let i = 0; i < 5; i++) await a.hit('id:alice');
    for (let i = 0; i < 5; i++) await a.hit('id:bob');

    await a.clear('id:alice');

    expect((await a.peek('id:alice')).count).toBe(0);
    expect((await a.peek('id:bob')).count, "clearing alice cleared bob's counter").toBe(5);
  });

  it('one attacker cannot lock a DIFFERENT account out', async () => {
    /* The failure mode of naive account-keyed limiting. The counter is per
       account, so hammering alice must leave bob able to sign in. */
    const a = account();
    for (let i = 0; i < ACCOUNT_LIMIT * 3; i++) await a.hit('id:alice');
    expect((await a.peek('id:bob')).count).toBe(0);
  });
});

describe('credential stuffing is bounded by the IP block, not by the account', () => {
  it('one address working through many accounts is stopped', async () => {
    /**
     * The attack the per-account cap CANNOT see: one failure each against two
     * thousand accounts never trips a per-account counter. The IP ceiling is
     * the control that does, and it is shared — so spreading the attempts
     * across instances does not refresh it either.
     */
    const instances = Array.from({ length: 5 }, ipBlock);
    let allowed = 0;
    for (let i = 0; i < 2000; i++) {
      const inst = instances[i % instances.length];
      const { count } = await inst.peek('203.0.113.9');
      if (count >= IP_LIMIT) continue;
      await inst.hit('203.0.113.9');
      allowed += 1;
    }
    expect(allowed, 'the shared IP ceiling did not hold across instances').toBe(IP_LIMIT);
  });

  it('a legitimate school behind one address is NOT locked out by the ceiling', async () => {
    /* 200 is chosen to clear a campus. Forty students each fumbling twice is
       eighty failures — well inside it — and the per-account cap is what
       actually stops guessing at any one of them. */
    const ip = ipBlock();
    for (let i = 0; i < 80; i++) await ip.hit('198.51.100.7');
    expect((await ip.peek('198.51.100.7')).count).toBeLessThan(IP_LIMIT);
  });
});

describe('address keying resists rotation', () => {
  /**
   * ── The bypass this pins ──
   *
   * The shared IP counter originally keyed on `req.ip`. For IPv4 that is
   * correct; for IPv6 it is not a control at all. A single residential
   * allocation is a /64 — eighteen quintillion addresses — so an attacker
   * rotating inside their own prefix would draw a fresh 200-failure ceiling
   * every time.
   *
   * `ipKeyGenerator` collapses IPv6 to a 56-bit prefix, which is what every
   * other IP-keyed limiter here already used. These assert the grouping
   * directly, because the difference is invisible in any IPv4 test.
   */
  it('groups IPv6 addresses in the same allocation into one bucket', () => {
    const a = ipKeyGenerator('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = ipKeyGenerator('2001:db8:1234:5678:1111:2222:3333:4444');
    const c = ipKeyGenerator('2001:db8:1234:56ff:9999:9999:9999:9999');
    expect(a, 'two addresses in one /64 landed in different buckets').toBe(b);
    expect(c, 'the whole /56 must share a bucket').toBe(a);
  });

  it('keeps genuinely different IPv6 allocations apart', () => {
    const mine = ipKeyGenerator('2001:db8:1234:5678::1');
    const theirs = ipKeyGenerator('2001:db8:9999:0000::1');
    expect(mine).not.toBe(theirs);
  });

  it('leaves IPv4 addresses alone', () => {
    expect(ipKeyGenerator('203.0.113.9')).toBe('203.0.113.9');
    expect(ipKeyGenerator('203.0.113.9')).not.toBe(ipKeyGenerator('203.0.113.10'));
  });

  it('an attacker rotating within one IPv6 prefix exhausts ONE ceiling', async () => {
    const ip = ipBlock();
    let allowed = 0;
    for (let i = 0; i < 400; i++) {
      const addr = ipKeyGenerator(`2001:db8:1234:5678:0:0:0:${i.toString(16)}`);
      const { count } = await ip.peek(addr);
      if (count >= IP_LIMIT) continue;
      await ip.hit(addr);
      allowed += 1;
    }
    expect(allowed, 'rotating inside one allocation bought more than one ceiling')
      .toBe(IP_LIMIT);
  });
});

describe('privacy of the shared state', () => {
  it('never stores an account id or an address in clear', async () => {
    const a = account();
    const ip = ipBlock();
    await a.hit('id:user-student-4471');
    await ip.hit('203.0.113.9');
    for (const k of redis.keys()) {
      expect(k, `a Redis key carries an identity: ${k}`).not.toContain('user-student-4471');
      expect(k, `a Redis key carries an address: ${k}`).not.toContain('203.0.113.9');
    }
  });
});

describe('failure behaviour is closed, not open', () => {
  it('a Redis outage does not reset a count that was accumulating', async () => {
    /**
     * The direction that matters for a SECURITY counter. `createSharedCounter`
     * mirrors every hit locally, so an outage continues from what this instance
     * has been tracking rather than handing the attacker a fresh budget —
     * which is precisely what the in-process `Map` it replaced did on every
     * deploy.
     */
    const a = account();
    for (let i = 0; i < 7; i++) await a.hit('id:midway');
    redis.state.fail = true;
    expect((await a.peek('id:midway')).count, 'an outage cleared the counter')
      .toBeGreaterThanOrEqual(7);
  });

  it('still refuses past the limit while Redis is down', async () => {
    const a = account();
    redis.state.fail = true;
    let allowed = 0;
    for (let i = 0; i < 50; i++) {
      const { count } = await a.peek('id:offline');
      if (count >= ACCOUNT_LIMIT) continue;
      await a.hit('id:offline');
      allowed += 1;
    }
    expect(allowed, 'the limiter failed OPEN during an outage').toBe(ACCOUNT_LIMIT);
  });
});

/**
 * The address key AS THIS MODULE COMPUTES IT, not as the library computes it.
 *
 * The distinction is the whole point of this block. `authRoutes.js` once
 * referenced `ipKeyGenerator` without importing it: every call threw, the catch
 * turned the failure into a single shared bucket, and every test above still
 * passed — because a ceiling that is far too TIGHT still refuses attackers.
 * Only lint noticed.
 *
 * These call the module's own function, so a missing import, a renamed helper
 * or a swallowed error fails here.
 */
describe('authRoutes computes the address key correctly', () => {
  let addressKey;
  beforeEach(async () => {
    ({ __addressKeyForTests: addressKey } = await import('./routes/authRoutes.js'));
  });

  it('groups an IPv6 allocation and separates distinct ones', () => {
    const a = addressKey({ ip: '2001:db8:1234:5678:aaaa::1' });
    const b = addressKey({ ip: '2001:db8:1234:5678:ffff::9' });
    const other = addressKey({ ip: '2001:db8:9999:0000::1' });

    expect(a, 'two addresses in one allocation got separate ceilings').toBe(b);
    expect(other, 'unrelated allocations were merged').not.toBe(a);
  });

  it('keeps distinct IPv4 addresses distinct', () => {
    const a = addressKey({ ip: '203.0.113.9' });
    const b = addressKey({ ip: '203.0.113.10' });
    expect(a).not.toBe(b);
    expect(a, 'IPv4 fell into the catch-all bucket').not.toBe('unparseable');
    expect(a, 'IPv4 fell into the no-address bucket').not.toBe('unknown');
  });

  it('does not collapse everything into one bucket', () => {
    /* The exact shape of the bug: a thrown error caught into a constant. */
    const keys = new Set([
      addressKey({ ip: '203.0.113.9' }),
      addressKey({ ip: '198.51.100.4' }),
      addressKey({ ip: '2001:db8:1::1' }),
    ]);
    expect(keys.size, 'distinct clients shared one failure ceiling').toBe(3);
  });

  it('falls back to the socket address when req.ip is absent', () => {
    expect(addressKey({ socket: { remoteAddress: '203.0.113.42' } })).toBe('203.0.113.42');
  });

  it('a request with no address at all still lands in a bucket', () => {
    /* Conservative: it cannot let anybody PAST the ceiling. */
    expect(addressKey({})).toBe('unknown');
  });
});
