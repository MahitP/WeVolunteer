/**
 * The transport, and the one rule it exists to keep: **nothing here throws.**
 *
 * Every caller of this module sits on a request path that has a correct answer
 * without Redis — a cache miss, an in-memory counter, an upstream call. So an
 * Upstash failure of any kind must arrive as a falsy return, never as an
 * exception in the middle of a handler. Most of this file is that one property,
 * asserted against every failure shape the wire can produce.
 *
 * The second property is the breaker. Without it an outage costs one 800 ms
 * timeout on EVERY request that would have used Redis, which turns a degraded
 * dependency into a degraded sign-in page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetRedisConfig } from './redis/redisConfig.js';
import {
  redisCommand, redisPipeline, redisEval, redisPing, redisUsage, redisHealth, __resetRedisUsage,
} from './redis/redisClient.js';

const realFetch = globalThis.fetch;

function configure() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  __resetRedisConfig();
}

/** A fetch that answers with one Upstash-shaped body. */
function respond(body, { status = 200 } = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  __resetRedisUsage();
  configure();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRedisConfig();
  __resetRedisUsage();
});

describe('when Upstash is not configured', () => {
  it('reports why, and makes no network call at all', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRedisConfig();
    globalThis.fetch = vi.fn();

    const res = await redisCommand(['GET', 'k']);
    expect(res).toEqual({ ok: false, reason: 'unconfigured' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('a successful command', () => {
  it('returns the result and charges one command', async () => {
    globalThis.fetch = respond({ result: 'hello' });
    const res = await redisCommand(['GET', 'k']);
    expect(res).toEqual({ ok: true, result: 'hello' });
    expect(redisUsage().commands).toBe(1);
    expect(redisUsage().requests).toBe(1);
  });

  it('sends the command in the BODY, never in the URL', async () => {
    /* Deliberate: a path-form command puts its arguments in a URL, where a
       proxy or an access log captures them, and these arguments are
       rate-limiter keys. */
    const fetchMock = respond({ result: 'OK' });
    globalThis.fetch = fetchMock;
    await redisCommand(['SET', 'secret-key', 'secret-value']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://fake.upstash.io');
    expect(url).not.toContain('secret-key');
    expect(JSON.parse(init.body)).toEqual(['SET', 'secret-key', 'secret-value']);
  });

  it('authenticates with a bearer token and nothing else', async () => {
    const fetchMock = respond({ result: 'PONG' });
    globalThis.fetch = fetchMock;
    await redisPing();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
  });
});

describe('failures, none of which throw', () => {
  it('an HTTP error becomes a reason carrying the status', async () => {
    globalThis.fetch = respond({}, { status: 401 });
    await expect(redisCommand(['GET', 'k'])).resolves.toEqual({ ok: false, reason: 'http_401' });
  });

  it('a network error becomes a reason', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(redisCommand(['GET', 'k'])).resolves.toEqual({ ok: false, reason: 'network_error' });
    expect(redisUsage().failures).toBe(1);
  });

  it('a timeout is counted separately from a failure, because it means something different', async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    });
    await expect(redisCommand(['GET', 'k'])).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(redisUsage().timeouts).toBe(1);
    expect(redisUsage().failures).toBe(0);
  });

  it('an unparseable body is a failure, not a crash', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>gateway</html>', { status: 200 }));
    await expect(redisCommand(['GET', 'k'])).resolves.toEqual({ ok: false, reason: 'malformed_response' });
  });

  it('a command Redis refused does NOT trip the breaker', async () => {
    /* The connection is fine; retrying will fail identically. Treating a wrong
       argument as an outage would take the cache down over a bug. */
    globalThis.fetch = respond({ error: 'WRONGTYPE Operation against a key' });
    const res = await redisCommand(['INCR', 'a-list']);
    expect(res).toEqual({ ok: false, reason: 'command_error' });
    expect(redisHealth().breakerOpen).toBe(false);
  });

  it('charges the command even when the response is unusable, because Upstash did', async () => {
    globalThis.fetch = respond({}, { status: 500 });
    await redisCommand(['GET', 'k']);
    expect(redisUsage().commands).toBe(1);
  });
});

describe('the circuit breaker', () => {
  it('opens on the first transport failure and then answers without waiting', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    globalThis.fetch = fetchMock;

    await redisCommand(['GET', 'a']);
    expect(redisHealth().breakerOpen).toBe(true);

    const second = await redisCommand(['GET', 'b']);
    expect(second).toEqual({ ok: false, reason: 'circuit_open' });
    /* The whole point: the second call cost no round trip and no latency. */
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redisUsage().breakerSkips).toBe(1);
  });

  it('charges no commands for calls it skips', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await redisCommand(['GET', 'a']);
    const after = redisUsage().commands;
    await redisCommand(['GET', 'b']);
    await redisCommand(['GET', 'c']);
    expect(redisUsage().commands).toBe(after);
  });

  it('closes again once the window passes', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
      await redisCommand(['GET', 'a']);
      expect(redisHealth().breakerOpen).toBe(true);

      vi.advanceTimersByTime(31_000);
      expect(redisHealth().breakerOpen).toBe(false);

      globalThis.fetch = respond({ result: 'ok' });
      await expect(redisCommand(['GET', 'a'])).resolves.toEqual({ ok: true, result: 'ok' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pipelines and scripts', () => {
  it('a pipeline charges one command per command, not one per round trip', async () => {
    globalThis.fetch = respond([{ result: 1 }, { result: 2 }, { result: 3 }]);
    const res = await redisPipeline([['INCR', 'a'], ['INCR', 'b'], ['INCR', 'c']]);
    expect(res).toEqual({ ok: true, results: [1, 2, 3] });
    expect(redisUsage().commands).toBe(3);
    expect(redisUsage().requests).toBe(1);
  });

  it('reports a per-entry error as a null rather than failing the whole batch', async () => {
    globalThis.fetch = respond([{ result: 'a' }, { error: 'ERR nope' }]);
    const res = await redisPipeline([['GET', 'a'], ['INCR', 'a']]);
    expect(res.ok).toBe(true);
    expect(res.results).toEqual(['a', null]);
  });

  it('an empty pipeline costs nothing and makes no request', async () => {
    globalThis.fetch = vi.fn();
    await expect(redisPipeline([])).resolves.toEqual({ ok: true, results: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('a script is charged what the caller says it costs, not one', async () => {
    /* Upstash bills every `redis.call` inside a script, so a script that makes
       three of them is three commands even though it is one round trip. A
       caller that charged 1 would under-report the quota it is spending. */
    globalThis.fetch = respond({ result: 4 });
    await redisEval('return 1', ['k'], ['1'], 3);
    expect(redisUsage().commands).toBe(3);
    expect(redisUsage().requests).toBe(1);
  });

  it('sends EVAL with the key count Redis expects', async () => {
    const fetchMock = respond({ result: 1 });
    globalThis.fetch = fetchMock;
    await redisEval('return 1', ['k1', 'k2'], ['a'], 1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body))
      .toEqual(['EVAL', 'return 1', '2', 'k1', 'k2', 'a']);
  });
});

describe('usage accounting', () => {
  it('tracks latency so an operator can tell a slow region from a broken one', async () => {
    globalThis.fetch = respond({ result: 'PONG' });
    await redisPing();
    const usage = redisUsage();
    expect(usage.requests).toBe(1);
    expect(usage.maxLatencyMs).toBeGreaterThanOrEqual(0);
    expect(usage.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
