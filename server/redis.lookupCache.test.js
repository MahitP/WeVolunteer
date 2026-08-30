/**
 * The two-tier cache for third-party lookups.
 *
 * ── What is actually being asserted ──
 *
 * Not "the cache works". The properties that matter are the ones that keep a
 * cache from becoming a liability:
 *
 *   - **A Redis failure is a miss, never an error.** The caller's fallback is
 *     to do the work it would have done without a cache at all.
 *   - **Nothing is written without a TTL.** On a 256 MB shared plan a key that
 *     never expires is the entire budget.
 *   - **The in-process tier answers first**, so the common case costs no round
 *     trip and no quota — Redis is there for what L1 cannot do, which is
 *     survive a deploy.
 *   - **The caller's key never reaches the wire.** For geocoding that key is an
 *     address somebody typed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetRedisConfig } from './redis/redisConfig.js';
import { __resetRedisUsage } from './redis/redisClient.js';
import { createLookupCache } from './redis/lookupCache.js';

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

/** A Redis that holds strings with expiries, and can be told to misbehave. */
function fakeRedis() {
  const store = new Map();
  const state = { fail: false, raw: null, calls: 0 };

  globalThis.fetch = vi.fn(async (url, init) => {
    state.calls += 1;
    if (state.fail) throw new TypeError('fetch failed');
    const [name, key, value, , px] = JSON.parse(init.body);

    if (name === 'GET') {
      if (state.raw !== null) return new Response(JSON.stringify({ result: state.raw }), { status: 200 });
      const entry = store.get(key);
      const live = entry && (entry.expiresAt === null || entry.expiresAt > Date.now());
      return new Response(JSON.stringify({ result: live ? entry.value : null }), { status: 200 });
    }
    if (name === 'SET') {
      store.set(key, { value, expiresAt: px === undefined ? null : Date.now() + Number(px) });
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `unsupported ${name}` }), { status: 200 });
  });

  return { store, state, keys: () => [...store.keys()] };
}

beforeEach(() => {
  __resetRedisUsage();
  enableRedis();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  disableRedis();
  vi.useRealTimers();
});

describe('the two tiers', () => {
  it('serves a repeat read from memory, costing no round trip', async () => {
    const redis = fakeRedis();
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });

    await cache.set('k', { temp: 61 });
    const callsAfterWrite = redis.state.calls;

    expect(await cache.get('k')).toEqual({ temp: 61 });
    expect(await cache.get('k')).toEqual({ temp: 61 });
    expect(redis.state.calls).toBe(callsAfterWrite);
    expect(cache.stats().l1Hits).toBe(2);
  });

  it('finds an entry another process wrote, which is the whole reason Redis is here', async () => {
    const redis = fakeRedis();
    const writer = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    await writer.set('k', { temp: 61 });

    /* A fresh cache is what this process looks like after a deploy: L1 empty,
       the shared tier still warm. */
    const afterDeploy = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    expect(await afterDeploy.get('k')).toEqual({ temp: 61 });
    expect(afterDeploy.stats().l2Hits).toBe(1);
    expect(redis.keys()).toHaveLength(1);
  });

  it('promotes a shared hit into memory so the next reader pays nothing', async () => {
    const redis = fakeRedis();
    const writer = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    await writer.set('k', { temp: 61 });

    const reader = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    await reader.get('k');
    const calls = redis.state.calls;
    await reader.get('k');
    expect(redis.state.calls).toBe(calls);
  });

  it('reports a miss as null rather than as an absent-value sentinel', async () => {
    fakeRedis();
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    expect(await cache.get('nothing-here')).toBeNull();
    expect(cache.stats().misses).toBe(1);
  });
});

describe('expiry and bounds', () => {
  it('writes every value with a TTL', async () => {
    const redis = fakeRedis();
    const cache = createLookupCache({ domain: 'geocode', ttlMs: 60_000, maxLocal: 10 });
    await cache.set('k', ['a place']);

    for (const [, entry] of redis.store) {
      expect(entry.expiresAt).not.toBeNull();
      expect(entry.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it('lets the in-process entry go stale on its own clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    fakeRedis();
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    await cache.set('k', { temp: 61 });

    vi.setSystemTime(new Date('2026-08-28T10:02:00.000Z'));
    /* Both tiers have expired, so this is a genuine miss rather than a stale
       answer served with confidence. */
    expect(await cache.get('k')).toBeNull();
  });

  it('evicts the oldest entry rather than growing without bound', async () => {
    fakeRedis();
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 3 });
    for (const k of ['a', 'b', 'c', 'd']) await cache.set(k, { k });
    expect(cache.stats().localSize).toBeLessThanOrEqual(3);
  });

  it('refuses to store an implausibly large value', async () => {
    /* Not about Upstash's 100 MB record ceiling — about an upstream that starts
       returning something unexpected filling a shared 256 MB budget. */
    const redis = fakeRedis();
    const cache = createLookupCache({ domain: 'geocode', ttlMs: 60_000, maxLocal: 10 });
    await cache.set('huge', { blob: 'x'.repeat(70_000) });

    expect(redis.keys()).toEqual([]);
    expect(cache.stats().skippedTooLarge).toBe(1);
    /* Still cached in process, where the ceiling is this process's own memory. */
    expect(await cache.get('huge')).not.toBeNull();
  });
});

describe('failure behaviour', () => {
  it('a Redis outage is a miss, and never an exception', async () => {
    const redis = fakeRedis();
    redis.state.fail = true;
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });

    await expect(cache.get('k')).resolves.toBeNull();
    await expect(cache.set('k', { temp: 61 })).resolves.toBeUndefined();
    /* The write still landed in memory: an outage costs the entry's durability,
       not the entry. */
    await expect(cache.get('k')).resolves.toEqual({ temp: 61 });
  });

  it('a value that will not parse is treated as absent, not as a 500', async () => {
    const redis = fakeRedis();
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    redis.state.raw = 'not json — written by an older release';
    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('a value that cannot be serialised is dropped rather than thrown', async () => {
    fakeRedis();
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    const cyclic = {};
    cyclic.self = cyclic;
    await expect(cache.set('k', cyclic)).resolves.toBeUndefined();
  });

  it('with Redis unconfigured it is exactly the in-memory cache it replaced', async () => {
    disableRedis();
    globalThis.fetch = vi.fn();
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });

    await cache.set('k', { temp: 61 });
    expect(await cache.get('k')).toEqual({ temp: 61 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('what reaches the wire', () => {
  it('hashes the caller key, so a console listing is not a list of searches', async () => {
    const redis = fakeRedis();
    const cache = createLookupCache({ domain: 'geocode', ttlMs: 60_000, maxLocal: 10 });
    await cache.set('1600 pennsylvania ave, springfield', [{ name: 'somewhere' }]);

    for (const key of redis.keys()) {
      expect(key).not.toContain('pennsylvania');
      expect(key).not.toContain('springfield');
      expect(key).toMatch(/^wev:[a-z]+:cache:geocode:[0-9a-f]{32}$/);
    }
  });

  it('separates domains, so a weather key can never answer a geocode read', async () => {
    fakeRedis();
    const weather = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    const geocode = createLookupCache({ domain: 'geocode', ttlMs: 60_000, maxLocal: 10 });

    await weather.set('same', { temp: 61 });
    expect(await geocode.get('same')).toBeNull();
  });

  it('reports a hit rate without reporting anything that was cached', async () => {
    fakeRedis();
    const cache = createLookupCache({ domain: 'weather', ttlMs: 60_000, maxLocal: 10 });
    await cache.set('k', { temp: 61 });
    await cache.get('k');
    await cache.get('other');

    const stats = cache.stats();
    expect(stats.hitRate).toBe(50);
    expect(JSON.stringify(stats)).not.toContain('61');
  });
});
