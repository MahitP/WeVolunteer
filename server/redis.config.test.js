/**
 * The configuration gate, which is the only thing standing between "Upstash is
 * not set up" and every caller in the application deciding that for itself.
 *
 * Two properties matter more than the rest and both are asserted here:
 *
 *   - **Unconfigured is a supported state, not an error.** The pilot runs
 *     without Upstash today and must keep running without it.
 *   - **The prefix separates environments.** The free plan allows ONE database,
 *     so a developer's suite and production share a keyspace, and the prefix is
 *     the only thing keeping a test's login counter out of production's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  redisConfig, redisEnabled, keyPrefix, hashSegment, __resetRedisConfig, FREE_TIER, LIMITS_READ_ON,
} from './redis/redisConfig.js';

const SAVED = {};
const VARS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_KEY_PREFIX', 'NODE_ENV'];

beforeEach(() => {
  for (const v of VARS) SAVED[v] = process.env[v];
  for (const v of VARS) delete process.env[v];
  __resetRedisConfig();
});

afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v];
  }
  __resetRedisConfig();
});

describe('enablement', () => {
  it('is off, and not an error, when nothing is configured', () => {
    expect(redisEnabled()).toBe(false);
    expect(redisConfig().reason).toBe('unconfigured');
  });

  it('is off when only half of the credential pair is present', () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    __resetRedisConfig();
    expect(redisEnabled()).toBe(false);
    /* Distinguished from `unconfigured` on purpose: a 401 on every call looks
       exactly like a revoked token and sends an operator to the wrong place. */
    expect(redisConfig().reason).toBe('incomplete');
  });

  it('refuses a plaintext URL rather than upgrading it', () => {
    process.env.UPSTASH_REDIS_REST_URL = 'http://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    __resetRedisConfig();
    expect(redisEnabled()).toBe(false);
    expect(redisConfig().reason).toBe('insecure_url');
  });

  it('is on with both halves over https, and strips a trailing slash', () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io/';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    __resetRedisConfig();
    expect(redisEnabled()).toBe(true);
    expect(redisConfig().url).toBe('https://example.upstash.io');
  });
});

describe('key prefix', () => {
  it('separates environments by NODE_ENV, without being asked to', () => {
    process.env.NODE_ENV = 'production';
    __resetRedisConfig();
    expect(keyPrefix()).toBe('wev:production:');

    process.env.NODE_ENV = 'test';
    __resetRedisConfig();
    expect(keyPrefix()).toBe('wev:test:');
  });

  it('lets an explicit prefix win, for two deployments sharing a NODE_ENV', () => {
    process.env.NODE_ENV = 'production';
    process.env.UPSTASH_KEY_PREFIX = 'pilot';
    __resetRedisConfig();
    expect(keyPrefix()).toBe('wev:pilot:');
  });

  it('strips anything that could change the command being sent', () => {
    process.env.UPSTASH_KEY_PREFIX = 'ev il/../*?';
    __resetRedisConfig();
    expect(keyPrefix()).toBe('wev:evil:');
  });

  it('always ends in a separator, so no call site can concatenate wrongly', () => {
    for (const env of ['development', 'test', 'production']) {
      process.env.NODE_ENV = env;
      __resetRedisConfig();
      expect(keyPrefix().endsWith(':')).toBe(true);
    }
  });
});

describe('hashSegment', () => {
  it('is stable, so a counter survives a restart', () => {
    expect(hashSegment('leo@example.org')).toBe(hashSegment('leo@example.org'));
  });

  it('never reproduces its input, which is the point', () => {
    const email = 'priya.patel@example.org';
    expect(hashSegment(email)).not.toContain('priya');
    expect(hashSegment(email)).not.toContain('@');
  });

  it('contains only characters that are safe in a Redis key and a URL', () => {
    for (const input of ['a/b', 'a?b=c', 'a b', '../../etc/passwd', '\n\r', '💥']) {
      expect(hashSegment(input)).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('distinguishes inputs that differ only in case, because callers normalise first', () => {
    expect(hashSegment('A')).not.toBe(hashSegment('a'));
  });
});

describe('the recorded free-tier numbers', () => {
  /* These drive real decisions elsewhere — which limiters may be shared, what
     the CLI reports. A silent edit should be visible in a diff of this file. */
  it('are the Free plan as documented on the date recorded beside them', () => {
    expect(LIMITS_READ_ON).toBe('2026-08-28');
    expect(FREE_TIER.commandsPerMonth).toBe(500_000);
    expect(FREE_TIER.databases).toBe(1);
    expect(FREE_TIER.idleArchiveDays).toBe(30);
  });
});
