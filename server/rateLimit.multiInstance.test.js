import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetRedisConfig } from './redis/redisConfig.js';
import { __resetRedisUsage, redisUsage } from './redis/redisClient.js';
import { createVolumeLimitStore, createTokenBucket, rateLimitMode } from './redis/volumeLimit.js';

/**
 * Two backend instances, one Redis, one budget.
 *
 * ── What this exists to prove ──
 *
 * `docs/operations/horizontal-scaling.md` listed the volume limiters as the
 * remaining multi-instance blocker: N instances each enforce their own copy, so
 * the effective ceiling is N x limit. A design that claims to fix that has to be
 * shown two instances sharing one budget, not argued about.
 *
 * The two stores below ARE two instances. Each `createVolumeLimitStore` holds
 * its own local counter — that is the whole of an instance's rate-limit state —
 * and both speak to one fake Redis that genuinely executes the Lua script the
 * real client sends. A stub returning canned numbers would pass while the
 * script was wrong, so this one keeps keys, honours TTLs, and runs INCRBY.
 *
 * ── The honest claim ──
 *
 * This design is APPROXIMATE across instances and the tests below assert the
 * bound rather than pretending it is exact. Each instance may serve up to
 * `escalateAt - 1` requests it has not yet reported, so the global ceiling is
 * `limit + N x (escalateAt - 1)` — against `N x limit` before. The arithmetic
 * for why exactness is not affordable here is in `redis/volumeLimit.js`.
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

/** A Redis that really runs the INCRBY script, shared by both instances. */
function fakeRedis() {
  const store = new Map();
  const state = { calls: 0, fail: false };

  const live = (k) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) { store.delete(k); return null; }
    return e;
  };

  function runScript(script, keys, argv) {
    const key = keys[0];
    if (script.startsWith("local c = redis.call('INCRBY'")) {
      const existing = live(key);
      const by = Number(argv[0]);
      const next = (existing ? Number(existing.value) : 0) + by;
      const expiresAt = existing ? existing.expiresAt : Date.now() + Number(argv[1]);
      store.set(key, { value: next, expiresAt });
      return next;
    }
    if (script.startsWith("local b = redis.call('HMGET'")) {
      /* The token bucket, reproduced faithfully — a stub that returned a canned
         "allowed" would pass while the refill arithmetic was wrong. */
      const e = live(key);
      const h = e ? e.value : {};
      const cap = Number(argv[0]);
      const rate = Number(argv[1]);
      const now = Number(argv[2]);
      let tokens = h.t === undefined ? cap : Number(h.t);
      const at = h.a === undefined ? now : Number(h.a);
      const elapsed = Math.max(0, now - at);
      tokens = Math.min(cap, tokens + elapsed * rate);
      let ok = 0;
      if (tokens >= 1) { tokens -= 1; ok = 1; }
      store.set(key, { value: { t: String(tokens), a: String(now) }, expiresAt: Date.now() + Number(argv[3]) });
      return [ok, String(tokens)];
    }
    throw new Error(`fakeRedis: unknown script ${script.slice(0, 40)}`);
  }

  function run(cmd) {
    const [name, ...args] = cmd;
    if (name === 'GET') { const e = live(args[0]); return e ? String(e.value) : null; }
    if (name === 'EVAL') {
      const n = Number(args[1]);
      return runScript(args[0], args.slice(2, 2 + n), args.slice(2 + n));
    }
    throw new Error(`fakeRedis: unsupported ${name}`);
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

const LIMIT = 100;
const ESCALATE = 25;

/** One backend instance's limiter state. */
function instance() {
  const s = createVolumeLimitStore({
    name: 'api', limit: LIMIT, escalateAt: ESCALATE, batch: 10,
  });
  s.init({ windowMs: 15 * 60 * 1000 });
  return s;
}

/** Drives `n` requests through an instance, returning how many were ALLOWED. */
async function drive(store, key, n) {
  let allowed = 0;
  for (let i = 0; i < n; i++) {
    const { totalHits } = await store.increment(key);
    if (totalHits <= LIMIT) allowed++;
  }
  return allowed;
}

let redis;
beforeEach(() => { __resetRedisUsage(); redis = fakeRedis(); enableRedis(); });
afterEach(() => {
  globalThis.fetch = realFetch; disableRedis(); vi.restoreAllMocks();
  delete process.env.RATE_LIMIT_MODE;
});

describe('one instance — unchanged, and free', () => {
  it('enforces the limit exactly', async () => {
    const a = instance();
    expect(await drive(a, 'u1', LIMIT + 50)).toBe(LIMIT);
  });

  it('spends NO Redis commands below the escalation threshold', async () => {
    /**
     * The property the whole design exists for. A caller who stays under the
     * threshold — which is almost every caller, almost always — must not cost
     * a command, or the free plan cannot carry this limiter at all.
     */
    const a = instance();
    await drive(a, 'quiet', ESCALATE - 1);
    expect(redis.state.calls, 'a quiet caller spent Redis commands').toBe(0);
    expect(redisUsage().commands).toBe(0);
  });

  it('stops spending commands once the caller is over the limit', async () => {
    /* An attacker who keeps knocking after being refused must not be able to
       drain the command allowance by doing so. */
    const a = instance();
    await drive(a, 'noisy', LIMIT + 5);
    const afterLimit = redis.state.calls;
    await drive(a, 'noisy', 200);
    expect(redis.state.calls, 'refusals cost Redis commands').toBe(afterLimit);
  });
});

describe('two instances — one shared budget', () => {
  it('instance B sees the budget instance A consumed', async () => {
    const a = instance();
    const b = instance();

    /* A runs the whole limit on its own. */
    expect(await drive(a, 'shared', LIMIT)).toBe(LIMIT);

    /* B has never seen this caller. Without sharing it would grant a fresh 100;
       it must instead discover the budget is spent once it escalates. */
    const allowedOnB = await drive(b, 'shared', LIMIT);
    expect(allowedOnB, 'instance B granted a whole second budget').toBeLessThan(LIMIT);
    expect(allowedOnB).toBeLessThanOrEqual(ESCALATE);
  });

  it('the combined total stays inside the documented bound', async () => {
    const a = instance();
    const b = instance();
    const total = (await drive(a, 'k', LIMIT * 2)) + (await drive(b, 'k', LIMIT * 2));

    /* The bound the design claims: limit + N x (escalateAt - 1). */
    const bound = LIMIT + 2 * (ESCALATE - 1);
    expect(total, `combined ${total} exceeded the bound ${bound}`).toBeLessThanOrEqual(bound);

    /* And it must be a real improvement, not merely "bounded by something". */
    expect(total, 'no better than two independent limiters').toBeLessThan(2 * LIMIT);
  });

  it('holds when the two instances interleave request by request', async () => {
    /**
     * The sequential case above could pass on an implementation that only
     * reconciles at a boundary. Alternating exercises the case where both
     * instances are mid-window and each other's reports land between their own.
     */
    const a = instance();
    const b = instance();
    let total = 0;
    for (let i = 0; i < LIMIT * 2; i++) {
      const store = i % 2 === 0 ? a : b;
      const { totalHits } = await store.increment('inter');
      if (totalHits <= LIMIT) total++;
    }
    expect(total).toBeLessThanOrEqual(LIMIT + 2 * (ESCALATE - 1));
    expect(total).toBeLessThan(2 * LIMIT);
  });

  it('does not let one caller spend another caller\'s budget', async () => {
    const a = instance();
    const b = instance();
    await drive(a, 'victim', LIMIT);
    expect(await drive(b, 'someone-else', ESCALATE), 'buckets leaked across keys')
      .toBe(ESCALATE);
  });

  it('keys the shared counter by a HASH, never the caller identity', async () => {
    const a = instance();
    await drive(a, 'session-identifier-abc', ESCALATE + 5);
    const keys = redis.keys();
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k, `a Redis key contains the raw identity: ${k}`)
        .not.toContain('session-identifier-abc');
    }
  });
});

describe('Redis failure', () => {
  it('falls back to the local count rather than to no limit', async () => {
    /**
     * The direction that matters. A limiter whose shared store is unreachable
     * must not become unlimited — it must become what it was before sharing,
     * which is a correct per-instance limiter.
     */
    const a = instance();
    redis.state.fail = true;
    expect(await drive(a, 'outage', LIMIT + 50)).toBe(LIMIT);
  });

  it('does not RESET a count that was already accumulating', async () => {
    const a = instance();
    await drive(a, 'mid', ESCALATE + 10);
    redis.state.fail = true;
    /* The remaining budget is what is left locally, not a fresh window. */
    const more = await drive(a, 'mid', LIMIT);
    expect(more).toBe(LIMIT - (ESCALATE + 10));
  });

  it('the breaker suppresses calls during an outage, and recovery waits for it', async () => {
    /**
     * Recovery is NOT instantaneous, and the first version of this test assumed
     * it was. `redisClient.js` opens a circuit breaker on failure so that an
     * outage costs one timeout per window rather than one per request — so for
     * `BREAKER_OPEN_MS` after a failure, nothing is sent even if Redis is
     * healthy again. That is the design working, and a test that expected
     * instant recovery was testing a system nobody built.
     *
     * Both halves are asserted here: that the breaker really does hold calls
     * off, and that sharing resumes once it closes.
     */
    const a = instance();
    const b = instance();

    redis.state.fail = true;
    await drive(a, 'recover', ESCALATE + 5);
    const callsDuringOutage = redis.state.calls;

    /* Healthy again — but the breaker is still open, so nothing is sent and the
       limiter carries on with its exact local count. */
    redis.state.fail = false;
    await drive(a, 'recover', 5);
    expect(redis.state.calls, 'the breaker did not suppress calls during its window')
      .toBe(callsDuringOutage);

    /* The breaker's window elapsing. `__resetRedisUsage` clears
       `breakerOpenUntil`, which is the seam this module exposes for exactly
       this — see redisClient.js. */
    __resetRedisUsage();

    /* A now reports everything it served while Redis was unreachable, in one
       piece, because `reported` was never advanced during the outage. */
    await drive(a, 'recover', 1);
    expect(redis.state.calls, 'nothing was reported after the breaker closed')
      .toBeGreaterThan(callsDuringOutage);

    const onB = await drive(b, 'recover', LIMIT);
    expect(onB, 'B behaved as though nothing had been consumed').toBeLessThan(LIMIT);
  });
});

/**
 * The message send throttle across two instances.
 *
 * `messageThrottle.js` keeps its state in module scope, so "two instances" here
 * means two module instances: `vi.resetModules()` between imports gives each
 * its own `buckets` map, which is exactly what two processes have. They share
 * the one fake Redis, as two processes would share the one database.
 */
describe('message throttle — two instances, one sender', () => {
  let A, B, LIMIT_M;

  beforeEach(async () => {
    vi.resetModules();
    const a = await import('./messageThrottle.js');
    a.__resetMessageThrottleForTests();
    vi.resetModules();
    const b = await import('./messageThrottle.js');
    b.__resetMessageThrottleForTests();
    A = a.checkMessageRateLimit;
    B = b.checkMessageRateLimit;
    LIMIT_M = a.MESSAGE_LIMIT;
  });

  /** Sends `n` times through one instance, returning how many were allowed. */
  async function sendVia(fn, user, n, now) {
    let ok = 0;
    for (let i = 0; i < n; i++) if (await fn(user, now)) ok++;
    return ok;
  }

  it('one instance alone still allows exactly the limit', async () => {
    const now = Date.now();
    expect(await sendVia(A, 'u', LIMIT_M + 10, now)).toBe(LIMIT_M);
  });

  it('a spammer cannot get a fresh budget by landing on the other instance', async () => {
    const now = Date.now();
    await sendVia(A, 'spammer', LIMIT_M, now);
    const onB = await sendVia(B, 'spammer', LIMIT_M, now);
    expect(onB, 'instance B handed out a second full budget').toBeLessThan(LIMIT_M);
  });

  it('the combined total stays inside the documented bound', async () => {
    const now = Date.now();
    const total = (await sendVia(A, 'k', LIMIT_M * 2, now))
      + (await sendVia(B, 'k', LIMIT_M * 2, now));
    /* limit + N x (escalateAt - 1), with escalateAt = limit / 2. */
    const bound = LIMIT_M + 2 * (Math.floor(LIMIT_M / 2) - 1);
    expect(total, `combined ${total} exceeded ${bound}`).toBeLessThanOrEqual(bound);
    expect(total, 'no better than two independent throttles').toBeLessThan(2 * LIMIT_M);
  });

  it('interleaved sends respect the shared bucket', async () => {
    const now = Date.now();
    let total = 0;
    for (let i = 0; i < LIMIT_M * 2; i++) {
      if (await (i % 2 === 0 ? A : B)('inter', now)) total++;
    }
    expect(total).toBeLessThan(2 * LIMIT_M);
  });

  it('keeps senders independent', async () => {
    const now = Date.now();
    await sendVia(A, 'noisy', LIMIT_M, now);
    expect(await sendVia(B, 'quiet', 3, now), 'senders shared a bucket').toBe(3);
  });

  it('falls back to a correct per-instance throttle when Redis is down', async () => {
    const now = Date.now();
    redis.state.fail = true;
    expect(await sendVia(A, 'outage', LIMIT_M + 10, now)).toBe(LIMIT_M);
  });

  it('never writes a raw user id into a Redis key', async () => {
    const now = Date.now();
    await sendVia(A, 'user-student-12345', LIMIT_M, now);
    for (const k of redis.keys()) {
      expect(k, `raw sender id in a Redis key: ${k}`).not.toContain('user-student-12345');
    }
  });
});

/**
 * `RATE_LIMIT_MODE=exact` — the escape hatch that makes the approximation a
 * setting rather than a property of the code.
 *
 * The default is approximate for one reason only: Upstash bills per command and
 * `apiLimiter` sits on every request. That is the PROVIDER's pricing model, not
 * a fact about Redis — several managed Redis and Valkey offerings meter
 * connections instead. On one of those, exact enforcement is free.
 *
 * These tests are what make "upgrade the provider later" true rather than
 * hopeful: they prove the exact path works today, so the change is one
 * environment variable and not a rewrite somebody has to design under pressure.
 */
describe('exact mode — globally exact for any number of instances', () => {
  beforeEach(() => { process.env.RATE_LIMIT_MODE = 'exact'; });

  it('two instances together allow exactly the limit, not the bound', async () => {
    const a = instance();
    const b = instance();
    const total = (await drive(a, 'k', LIMIT)) + (await drive(b, 'k', LIMIT));
    /* Not `<= limit + N x (escalateAt - 1)`. Exactly the limit. */
    expect(total, 'exact mode allowed more than the limit').toBe(LIMIT);
  });

  it('three instances together allow exactly the limit', async () => {
    const [a, b, c] = [instance(), instance(), instance()];
    const total = (await drive(a, 'k3', LIMIT))
      + (await drive(b, 'k3', LIMIT))
      + (await drive(c, 'k3', LIMIT));
    expect(total).toBe(LIMIT);
  });

  it('holds when the instances interleave request by request', async () => {
    const insts = [instance(), instance(), instance(), instance()];
    let allowed = 0;
    for (let i = 0; i < LIMIT * 3; i++) {
      const { totalHits } = await insts[i % insts.length].increment('inter-exact');
      if (totalHits <= LIMIT) allowed++;
    }
    expect(allowed).toBe(LIMIT);
  });

  it('costs a command per request — which is the trade being made', async () => {
    const a = instance();
    await drive(a, 'cost', 20);
    expect(redis.state.calls, 'exact mode did not meter every request').toBe(20);
  });

  it('still falls back to a correct per-instance limiter when Redis is down', async () => {
    const a = instance();
    redis.state.fail = true;
    expect(await drive(a, 'exact-outage', LIMIT + 50)).toBe(LIMIT);
  });
});

describe('the mode is validated, not guessed', () => {
  it('refuses a mode it does not know rather than defaulting', () => {
    /* A typo here would silently change how strictly every volume limit is
       enforced, which is the kind of thing nobody notices until it matters. */
    expect(() => rateLimitMode({ RATE_LIMIT_MODE: 'exactly' })).toThrow(/not a known mode/);
  });

  it('defaults to coordinated when unset', () => {
    expect(rateLimitMode({})).toBe('coordinated');
  });

  it('local takes a limiter off Redis without a deploy', async () => {
    process.env.RATE_LIMIT_MODE = 'local';
    const a = instance();
    await drive(a, 'off', LIMIT);
    expect(redis.state.calls, 'local mode still spoke to Redis').toBe(0);
  });
});

/**
 * The distributed token bucket, which is a different problem from a window.
 *
 * Refilling is read-compute-write, so two instances doing it with GET/SET
 * interleave: both read the same tokens, both refill from the same timestamp,
 * both write — and the bucket issues two tokens for one while the second write
 * restores the first's spent token. A sustained two-instance attack would
 * refill FASTER than the configured rate. One Lua script cannot interleave.
 */
describe('distributed token bucket', () => {
  const CAPACITY = 10;
  const REFILL_PER_MIN = 60; // one token per second

  function bucketPair() {
    return [
      createTokenBucket({ name: 'scan', capacity: CAPACITY, refillPerMinute: REFILL_PER_MIN }),
      createTokenBucket({ name: 'scan', capacity: CAPACITY, refillPerMinute: REFILL_PER_MIN }),
    ];
  }

  it('two instances share ONE burst, not one each', async () => {
    const [a, b] = bucketPair();
    const now = Date.now();
    let allowed = 0;
    for (let i = 0; i < CAPACITY * 2; i++) {
      const r = await (i % 2 === 0 ? a : b).take('door', now);
      if (r?.allowed) allowed++;
    }
    expect(allowed, 'the burst was issued twice').toBe(CAPACITY);
  });

  it('refills at the configured rate, once, across instances', async () => {
    const [a, b] = bucketPair();
    const t0 = Date.now();
    for (let i = 0; i < CAPACITY; i++) await a.take('refill', t0);
    expect((await a.take('refill', t0))?.allowed, 'the burst did not run out').toBe(false);

    /* Five seconds at one token a second: five tokens, shared — not five each. */
    const t1 = t0 + 5_000;
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const r = await (i % 2 === 0 ? a : b).take('refill', t1);
      if (r?.allowed) allowed++;
    }
    expect(allowed, 'the refill was applied per instance').toBe(5);
  });

  it('never exceeds capacity however long it idles', async () => {
    const [a] = bucketPair();
    const t0 = Date.now();
    await a.take('idle', t0);
    /* A year later the bucket must hold `capacity`, not a year of tokens. */
    const t1 = t0 + 365 * 24 * 3600 * 1000;
    let allowed = 0;
    for (let i = 0; i < CAPACITY * 3; i++) if ((await a.take('idle', t1))?.allowed) allowed++;
    expect(allowed).toBe(CAPACITY);
  });

  it('a clock that steps backwards does not remove tokens', async () => {
    /* Clamped in the script deliberately: negative elapsed would DRAIN the
       bucket, refusing a legitimate scan for a reason nobody could diagnose. */
    const [a] = bucketPair();
    const t0 = Date.now();
    await a.take('clock', t0);
    const back = await a.take('clock', t0 - 60_000);
    expect(back?.allowed).toBe(true);
    expect(back.tokens).toBeLessThanOrEqual(CAPACITY);
  });

  it('returns null rather than throwing when Redis is unavailable', async () => {
    const [a] = bucketPair();
    redis.state.fail = true;
    expect(await a.take('down')).toBeNull();
  });

  it('keys are hashed — a door scanner id never reaches Redis in clear', async () => {
    const [a] = bucketPair();
    await a.take('organizer-device-9911', Date.now());
    for (const k of redis.keys()) expect(k).not.toContain('organizer-device-9911');
  });
});

/**
 * Abuse economics: an attacker must not be able to spend our Redis allowance.
 *
 * ── The vector being closed ──
 *
 * A limiter that meters every request turns "send more requests" into "cost the
 * operator more money". On a plan billed per command that is a denial-of-wallet
 * vector, and it is the reason this design coordinates on approach rather than
 * on every call. These tests assert the bound rather than trusting the
 * intention, because the intention is one refactor away from being wrong.
 */
describe('abuse cannot buy Redis commands', () => {
  it('a caller who is already refused costs NOTHING to refuse again', async () => {
    /* The single most important property here. Once local knows the ceiling is
       spent, refusing needs no agreement from anybody. */
    const a = instance();
    await drive(a, 'attacker', LIMIT + 10);
    const spent = redis.state.calls;

    await drive(a, 'attacker', 5_000);
    expect(redis.state.calls, 'knocking after a refusal spent commands').toBe(spent);
  });

  it('the commands one key can ever cost in a window are bounded', async () => {
    /**
     * The ceiling is `(limit - escalateAt) / batch + 1` reports. Everything
     * below the threshold is free, everything above the limit is free, and the
     * middle is batched — so no amount of traffic against ONE key exceeds it.
     */
    const a = instance();
    await drive(a, 'bounded', LIMIT * 50);

    const worstCase = Math.ceil((LIMIT - ESCALATE) / 10) + 1;
    expect(
      redis.state.calls,
      `one key cost ${redis.state.calls} commands against a bound of ${worstCase}`,
    ).toBeLessThanOrEqual(worstCase);
  });

  it('spend scales with DISTINCT keys, not with request volume', async () => {
    /**
     * The honest statement of the residual: an attacker who can mint distinct
     * keys pays per key. `apiLimiterKey` keys on the VERIFIED session, so
     * minting one means holding a signed token; an anonymous caller keys on the
     * address, so minting one means holding another address. Neither is free,
     * and that is what bounds this.
     */
    const a = instance();

    for (let i = 0; i < 5; i++) await drive(a, `k${i}`, ESCALATE - 1);
    expect(redis.state.calls, 'quiet keys cost commands').toBe(0);

    for (let i = 0; i < 5; i++) await drive(a, `loud${i}`, LIMIT * 2);
    const perKey = redis.state.calls / 5;
    expect(perKey).toBeLessThanOrEqual(Math.ceil((LIMIT - ESCALATE) / 10) + 1);
  });

  it('a Redis outage does not turn into a retry storm against Redis', async () => {
    /* The breaker means an outage costs one timeout per window rather than one
       per request — so an attack DURING an outage cannot amplify either. */
    const a = instance();
    redis.state.fail = true;
    await drive(a, 'outage-attack', LIMIT * 5);
    expect(redis.state.calls, 'the breaker did not stop the retries').toBeLessThanOrEqual(2);
  });
});
