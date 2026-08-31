/**
 * The shared reservation in front of Nominatim.
 *
 * ── Why this is worth its own file ──
 *
 * The consequence of getting it wrong is not a 500. It is OSM blocking this
 * application's User-Agent, which removes address lookup for every school at
 * once and is slow to reverse. So the asymmetry runs one way throughout: when
 * in doubt, wait.
 *
 * The one case that must NOT fail closed is Redis being unavailable, and the
 * reason is specific: the caller is holding a process-local reservation that
 * has already granted, so falling back means the guarantee degrades from
 * application-wide to per-process — which is exactly the guarantee that exists
 * today, and has since the throttle was written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetRedisConfig } from './redis/redisConfig.js';
import { __resetRedisUsage } from './redis/redisClient.js';
import { reserveSharedUpstreamSlot } from './redis/upstreamThrottle.js';

const realFetch = globalThis.fetch;
const OPTS = { name: 'nominatim', intervalMs: 1000, maxWaitMs: 3000 };

function enableRedis() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  __resetRedisConfig();
}

/**
 * A Redis that runs the reservation script for real.
 *
 * The script IS the feature — a stub returning canned waits would pass while
 * two callers were both told they could go now, which is the exact failure this
 * exists to prevent.
 */
function fakeRedis() {
  const store = new Map();
  const state = { fail: false };

  function live(key) {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) { store.delete(key); return null; }
    return e;
  }

  globalThis.fetch = vi.fn(async (url, init) => {
    if (state.fail) throw new TypeError('fetch failed');
    const body = JSON.parse(init.body);
    const [name, , keyCount, key, nowArg, intervalArg, maxWaitArg] = body;
    if (name !== 'EVAL' || keyCount !== '1') {
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 200 });
    }

    const now = Number(nowArg);
    const interval = Number(intervalArg);
    const maxWait = Number(maxWaitArg);
    const existing = live(key);
    const nextAt = existing ? Number(existing.value) : 0;
    const slot = nextAt > now ? nextAt : now;
    if (slot - now > maxWait) {
      return new Response(JSON.stringify({ result: -1 }), { status: 200 });
    }
    store.set(key, { value: slot + interval, expiresAt: Date.now() + interval * 2 + 1000 });
    return new Response(JSON.stringify({ result: slot - now }), { status: 200 });
  });

  return { store, state, keys: () => [...store.keys()] };
}

beforeEach(() => { __resetRedisUsage(); enableRedis(); });

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRedisConfig();
  vi.useRealTimers();
});

describe('the reservation', () => {
  it('lets the first caller go immediately', async () => {
    fakeRedis();
    expect(await reserveSharedUpstreamSlot(OPTS)).toBe(0);
  });

  it('spaces callers by the interval the policy requires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    fakeRedis();

    expect(await reserveSharedUpstreamSlot(OPTS)).toBe(0);
    expect(await reserveSharedUpstreamSlot(OPTS)).toBe(1000);
    expect(await reserveSharedUpstreamSlot(OPTS)).toBe(2000);
  });

  it('refuses once the queue is deeper than a caller should sit through', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    fakeRedis();

    await reserveSharedUpstreamSlot(OPTS);   // 0
    await reserveSharedUpstreamSlot(OPTS);   // 1000
    await reserveSharedUpstreamSlot(OPTS);   // 2000
    await reserveSharedUpstreamSlot(OPTS);   // 3000
    expect(await reserveSharedUpstreamSlot(OPTS)).toBeNull();
  });

  it('a refusal reserves nothing, so it does not push the queue out further', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    const redis = fakeRedis();

    for (let i = 0; i < 4; i++) await reserveSharedUpstreamSlot(OPTS);
    const key = redis.keys()[0];
    const before = redis.store.get(key).value;

    await reserveSharedUpstreamSlot(OPTS);
    await reserveSharedUpstreamSlot(OPTS);
    expect(redis.store.get(key).value).toBe(before);
  });

  it('drains as time passes, rather than staying refused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    fakeRedis();

    for (let i = 0; i < 4; i++) await reserveSharedUpstreamSlot(OPTS);
    expect(await reserveSharedUpstreamSlot(OPTS)).toBeNull();

    vi.setSystemTime(new Date('2026-08-28T10:00:04.000Z'));
    expect(await reserveSharedUpstreamSlot(OPTS)).toBe(0);
  });

  it('two callers arriving together are not both told to go now', async () => {
    /* The reason this is a script and not a GET followed by a SET. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    fakeRedis();

    const waits = await Promise.all([
      reserveSharedUpstreamSlot(OPTS),
      reserveSharedUpstreamSlot(OPTS),
    ]);
    expect(waits.filter(w => w === 0)).toHaveLength(1);
    expect(waits).toContain(1000);
  });

  it('writes a TTL, so an unused throttle key does not accumulate', async () => {
    const redis = fakeRedis();
    await reserveSharedUpstreamSlot(OPTS);
    for (const [, entry] of redis.store) {
      expect(entry.expiresAt).toBeGreaterThan(Date.now());
    }
  });
});

describe('when Redis is unavailable', () => {
  it('adds nothing, rather than taking address lookup down', async () => {
    const redis = fakeRedis();
    redis.state.fail = true;
    /* Fail-open, and safe only because the caller also holds a process-local
       reservation that has already granted. */
    expect(await reserveSharedUpstreamSlot(OPTS)).toBe(0);
  });

  it('adds nothing when Upstash is not configured, and makes no call', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRedisConfig();
    globalThis.fetch = vi.fn();

    expect(await reserveSharedUpstreamSlot(OPTS)).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('never returns a wait longer than the caller agreed to', async () => {
    /* A clock skew between this host and Redis could otherwise hand back a wait
       the caller's own contract says it will not sit through. */
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ result: 99_999 }), { status: 200 }));
    expect(await reserveSharedUpstreamSlot(OPTS)).toBe(3000);
  });
});
