/**
 * The shared security counters.
 *
 * ── The property this file exists to protect ──
 *
 * These counters bound password guessing, mail flooding and appeal spam. The
 * change that introduced them moved that state off a process-local `Map` and
 * onto a third party, and the danger of doing so is not subtle: if Redis being
 * unreachable resets a counter, then an attacker who can make Redis unreachable
 * — or who simply arrives during an outage — gets an unlimited budget.
 *
 * So the load-bearing case here is `an outage is a continuation, not a reset`.
 * The in-process mirror is incremented on every call whether or not Redis
 * answers, which is what makes a fallback resume today's behaviour instead of
 * starting from zero. Several tests below assert exactly that, and they are the
 * ones to read first if this file ever needs changing.
 *
 * The mirror image also matters: nothing here may fail CLOSED. A school locked
 * out of sign-in because Upstash had a bad minute is a worse outcome than the
 * attack the limiter exists to stop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetRedisConfig } from './redis/redisConfig.js';
import { __resetRedisUsage, redisUsage } from './redis/redisClient.js';
import {
  createRedisLimitStore, createSharedCounter, __resetLocalCounters,
} from './redis/limitStore.js';

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

/**
 * A Redis good enough to test against: it actually holds keys, runs the two
 * scripts this module sends, and honours TTLs against a controllable clock.
 *
 * A stub that returned canned numbers would pass while the scripts were wrong.
 */
function fakeRedis() {
  const store = new Map();       // key -> { value, expiresAt }
  const state = { calls: 0, fail: false, lastBody: null };

  function live(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) { store.delete(key); return null; }
    return entry;
  }

  function run(cmd) {
    const [name, ...args] = cmd;
    switch (name) {
      case 'GET': {
        const e = live(args[0]);
        return e ? String(e.value) : null;
      }
      case 'DEL': {
        const had = live(args[0]) ? 1 : 0;
        store.delete(args[0]);
        return had;
      }
      case 'PTTL': {
        const e = live(args[0]);
        if (!e) return -2;
        return e.expiresAt === null ? -1 : e.expiresAt - Date.now();
      }
      case 'EVAL': {
        const script = args[0];
        const keyCount = Number(args[1]);
        const keys = args.slice(2, 2 + keyCount);
        const argv = args.slice(2 + keyCount);
        return runScript(script, keys, argv);
      }
      default:
        throw new Error(`fakeRedis: unsupported ${name}`);
    }
  }

  function runScript(script, keys, argv) {
    const key = keys[0];
    if (script.startsWith("local c = redis.call('INCR'")) {
      const existing = live(key);
      const next = (existing ? Number(existing.value) : 0) + 1;
      const expiresAt = existing
        ? existing.expiresAt
        : Date.now() + Number(argv[0]);
      store.set(key, { value: next, expiresAt });
      /* Both increment scripts share a prefix; only the TTL-returning one ends
         with a PTTL call, and that is the difference the fake reproduces. */
      if (script.includes('PTTL')) {
        return [next, expiresAt === null ? -1 : expiresAt - Date.now()];
      }
      return next;
    }
    if (script.startsWith("if redis.call('EXISTS'")) {
      const existing = live(key);
      if (!existing) return 0;
      const next = Number(existing.value) - 1;
      store.set(key, { value: next, expiresAt: existing.expiresAt });
      return next;
    }
    throw new Error(`fakeRedis: unknown script ${script.slice(0, 40)}`);
  }

  globalThis.fetch = vi.fn(async (url, init) => {
    state.calls += 1;
    if (state.fail) throw new TypeError('fetch failed');
    const body = JSON.parse(init.body);
    state.lastBody = body;

    if (String(url).endsWith('/pipeline')) {
      return new Response(JSON.stringify(body.map(cmd => {
        try { return { result: run(cmd) }; } catch (err) { return { error: err.message }; }
      })), { status: 200 });
    }
    try {
      return new Response(JSON.stringify({ result: run(body) }), { status: 200 });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 200 });
    }
  });

  return { store, state, keys: () => [...store.keys()] };
}

beforeEach(() => {
  __resetLocalCounters();
  __resetRedisUsage();
  enableRedis();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  disableRedis();
  __resetLocalCounters();
  vi.useRealTimers();
});

/* ── The express-rate-limit store ──────────────────────────────────────────── */

describe('createRedisLimitStore, with Redis available', () => {
  it('counts up and reports a reset time', async () => {
    fakeRedis();
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 15 * 60 * 1000 });

    expect((await store.increment('ip-a')).totalHits).toBe(1);
    expect((await store.increment('ip-a')).totalHits).toBe(2);

    const third = await store.increment('ip-a');
    expect(third.totalHits).toBe(3);
    expect(third.resetTime).toBeInstanceOf(Date);
    expect(third.resetTime.getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps different clients, and different limiters, in different buckets', async () => {
    fakeRedis();
    const login = createRedisLimitStore({ name: 'login' });
    const mail = createRedisLimitStore({ name: 'mail' });
    login.init({ windowMs: 60_000 });
    mail.init({ windowMs: 60_000 });

    await login.increment('same-key');
    await login.increment('same-key');
    expect((await mail.increment('same-key')).totalHits).toBe(1);
    expect((await login.increment('other-key')).totalHits).toBe(1);
  });

  it('decrements without resurrecting an expired window', async () => {
    /* A bare DECR on a missing key creates it at -1 with NO TTL — one immortal
       key per successful sign-in, on a 256 MB plan. */
    const redis = fakeRedis();
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 60_000 });

    await store.decrement('never-seen');
    expect(redis.keys().filter(k => k.includes('never-seen'))).toEqual([]);
  });

  it('decrement undoes an increment, which is what skipSuccessfulRequests needs', async () => {
    fakeRedis();
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 60_000 });

    await store.increment('ip-a');
    await store.increment('ip-a');
    await store.decrement('ip-a');
    expect((await store.get('ip-a')).totalHits).toBe(1);
  });

  it('resetKey clears both tiers', async () => {
    fakeRedis();
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 60_000 });

    await store.increment('ip-a');
    await store.resetKey('ip-a');
    expect((await store.get('ip-a')).totalHits).toBe(0);
  });

  it('writes a TTL on every counter it creates', async () => {
    /* An unbounded key is not a leak on this plan, it is the whole budget. */
    const redis = fakeRedis();
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 60_000 });
    await store.increment('ip-a');

    for (const [, entry] of redis.store) {
      expect(entry.expiresAt).not.toBeNull();
      expect(entry.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it('never puts a raw client key on the wire', async () => {
    const redis = fakeRedis();
    const store = createRedisLimitStore({ name: 'mail' });
    store.init({ windowMs: 60_000 });
    await store.increment('mail:ava@school.example.org');

    for (const key of redis.keys()) {
      expect(key).not.toContain('ava');
      expect(key).not.toContain('@');
      expect(key).toContain('wev:');
    }
  });

  it('declares itself a shared store, so double-count detection works', () => {
    const store = createRedisLimitStore({ name: 'login' });
    expect(store.localKeys).toBe(false);
    expect(store.prefix).toContain('rl:login:');
  });
});

describe('createRedisLimitStore, when Redis fails', () => {
  it('an outage is a continuation, not a reset', async () => {
    /* The property this whole design rests on. */
    const redis = fakeRedis();
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 60_000 });

    await store.increment('ip-a');
    await store.increment('ip-a');
    await store.increment('ip-a');

    redis.state.fail = true;
    const during = await store.increment('ip-a');
    expect(during.totalHits).toBe(4);
    expect(during.resetTime).toBeInstanceOf(Date);
  });

  it('never rejects, because express-rate-limit turns a rejection into a 500 on /login', async () => {
    const redis = fakeRedis();
    redis.state.fail = true;
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 60_000 });

    await expect(store.increment('ip-a')).resolves.toBeDefined();
    await expect(store.decrement('ip-a')).resolves.toBeUndefined();
    await expect(store.get('ip-a')).resolves.toBeDefined();
    await expect(store.resetKey('ip-a')).resolves.toBeUndefined();
  });

  it('with Redis unconfigured, behaves exactly like the in-memory limiter it replaced', async () => {
    disableRedis();
    globalThis.fetch = vi.fn();
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 60_000 });

    expect((await store.increment('ip-a')).totalHits).toBe(1);
    expect((await store.increment('ip-a')).totalHits).toBe(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('takes the shared count when it is higher, so a second instance cannot loosen a limit', async () => {
    const redis = fakeRedis();
    const store = createRedisLimitStore({ name: 'login' });
    store.init({ windowMs: 60_000 });

    /* Another instance got there first: the shared counter is already at 7
       while this process has seen nothing. */
    const sharedKey = redis.keys();
    expect(sharedKey).toEqual([]);
    await store.increment('ip-a');
    const key = redis.keys()[0];
    redis.store.set(key, { value: 7, expiresAt: Date.now() + 60_000 });

    expect((await store.increment('ip-a')).totalHits).toBe(8);
  });
});

/* ── The hand-rolled counter ───────────────────────────────────────────────── */

describe('createSharedCounter', () => {
  it('counts, and reports when the window ends', async () => {
    fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 15 * 60 * 1000 });

    expect((await counter.hit('id:u1')).count).toBe(1);
    const second = await counter.hit('id:u1');
    expect(second.count).toBe(2);
    expect(second.resetAt).toBeGreaterThan(Date.now());
  });

  it('measures the window from the FIRST occurrence, not from a clock boundary', async () => {
    /* An epoch-aligned window would let ten failures at 14:59 unlock at 15:00.
       That is a real weakening of a control that bounds password guessing, and
       it is why the increment script pays for an extra PTTL. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T14:59:00.000Z'));
    fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 15 * 60 * 1000 });

    const first = await counter.hit('id:u1');
    const expected = new Date('2026-08-28T15:14:00.000Z').getTime();
    expect(Math.abs(first.resetAt - expected)).toBeLessThan(2000);

    vi.setSystemTime(new Date('2026-08-28T15:00:30.000Z'));
    const later = await counter.hit('id:u1');
    expect(later.count).toBe(2);
    expect(Math.abs(later.resetAt - expected)).toBeLessThan(2000);
  });

  it('a later occurrence does not extend the window', async () => {
    /* Matches the Map this replaced: `until` was set once, on the failure that
       created the entry, and subsequent failures only incremented the count. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 15 * 60 * 1000 });

    const first = await counter.hit('id:u1');
    vi.setSystemTime(new Date('2026-08-28T10:10:00.000Z'));
    const second = await counter.hit('id:u1');
    expect(Math.abs(second.resetAt - first.resetAt)).toBeLessThan(2000);
  });

  it('forgets the count once the window has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 15 * 60 * 1000 });

    await counter.hit('id:u1');
    await counter.hit('id:u1');
    vi.setSystemTime(new Date('2026-08-28T10:16:00.000Z'));
    expect((await counter.peek('id:u1')).count).toBe(0);
  });

  it('peek records nothing', async () => {
    fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 60_000 });
    await counter.hit('id:u1');
    await counter.peek('id:u1');
    await counter.peek('id:u1');
    expect((await counter.peek('id:u1')).count).toBe(1);
  });

  it('clear releases a lockout, which is how a remembered password works', async () => {
    fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 60_000 });
    await counter.hit('id:u1');
    await counter.hit('id:u1');
    await counter.clear('id:u1');
    expect((await counter.peek('id:u1')).count).toBe(0);
  });

  it('an outage mid-window continues the count rather than clearing it', async () => {
    const redis = fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 60_000 });

    await counter.hit('id:u1');
    await counter.hit('id:u1');
    redis.state.fail = true;

    expect((await counter.hit('id:u1')).count).toBe(3);
    expect((await counter.peek('id:u1')).count).toBe(3);
  });

  it('never rejects on any Redis failure', async () => {
    const redis = fakeRedis();
    redis.state.fail = true;
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 60_000 });
    await expect(counter.hit('id:u1')).resolves.toBeDefined();
    await expect(counter.peek('id:u1')).resolves.toBeDefined();
    await expect(counter.clear('id:u1')).resolves.toBeUndefined();
  });

  it('peek costs ONE command in the common case', async () => {
    /* This runs on every sign-in attempt, successful ones included, which makes
       it the most frequent Redis call in the application. The obvious
       GET + PTTL pipeline is one round trip and two billed commands; at the
       traffic modelled in docs/operations/upstash.md §7.3 that difference is
       about a fifth of the whole integration's monthly spend. */
    fakeRedis();
    __resetRedisUsage();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 60_000 });

    await counter.peek('id:never-seen');
    expect(redisUsage().commands).toBe(1);

    const before = redisUsage().commands;
    await counter.hit('id:u1');
    const afterHit = redisUsage().commands;
    await counter.peek('id:u1');
    /* Still one: this process already knows when the window ends, because it
       recorded the hit itself. */
    expect(redisUsage().commands - afterHit).toBe(1);
    expect(afterHit).toBeGreaterThan(before);
  });

  it('pays for the exact reset time only when it has none and there is a lockout to report', async () => {
    /* After a restart the local mirror is empty. Reporting `now + windowMs`
       would OVERSTATE the wait to somebody who is locked out, which is the
       wrong direction for a message a person reads, so the second command is
       worth paying in exactly that case. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    const redis = fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 60_000 });
    await counter.hit('id:u1');
    await counter.hit('id:u1');

    /* Twenty seconds into the window, then a fresh process: the shared counter
       is warm and this one knows nothing about it. */
    vi.setSystemTime(new Date('2026-08-28T10:00:20.000Z'));
    __resetLocalCounters();
    __resetRedisUsage();

    const seen = await counter.peek('id:u1');
    expect(seen.count).toBe(2);
    expect(redisUsage().commands).toBe(2);

    /* Forty seconds left, read from Redis — not the sixty a local guess would
       have reported, which would have told a locked-out student to wait a third
       longer than they actually must. */
    expect(seen.resetAt - Date.now()).toBe(40_000);
    expect(redis.keys()).toHaveLength(1);
  });

  it('hashes the identifier, so the keyspace is not a list of who was attacked', async () => {
    const redis = fakeRedis();
    const counter = createSharedCounter({ name: 'login-failure', windowMs: 60_000 });
    await counter.hit('anon:leo.chen@school.example.org');

    for (const key of redis.keys()) {
      expect(key).not.toContain('leo');
      expect(key).not.toContain('@');
      expect(key).toMatch(/^wev:[a-z]+:cnt:login-failure:[0-9a-f]{32}$/);
    }
  });
});
