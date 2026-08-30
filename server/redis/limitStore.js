/**
 * Shared, restart-surviving counters for the security throttles.
 *
 * ── The gap this closes ──
 *
 * Every rate limiter in this application counts in process memory, and
 * `instanceLock.js` says so in terms: "every throttle is in-process memory —
 * the `express-rate-limit` default store plus the `loginFailures` map in
 * authRoutes." That is correct for exactly one process, and it has one property
 * nobody chose: **a restart clears it.** A deploy in the middle of a password
 * spray hands the attempt a fresh budget, and the account lockout that was two
 * failures from engaging goes back to ten.
 *
 * It is also the first item in this project's own sequencing for a second
 * instance (`docs/plans/supabase-vercel-migration-plan.md` §4.4: "shared-store
 * rate limiting → object storage → schema baseline → the async port"), because
 * with two instances every limit here is silently doubled.
 *
 * ── Which limiters use this, and why not all of them ──
 *
 * Upstash's free plan allows 500,000 commands a month and a limiter check costs
 * two to three of them. `apiLimiter` alone — 600 requests per fifteen minutes
 * per device — would spend the month in an afternoon. So this is used ONLY by
 * throttles that tick on failure or on abuse, which are rare by construction:
 * a wrong password, a mail send, an appeal, a certificate check. The volume
 * limiters stay in memory, where they are correct and free. Each call site says
 * which it is and why.
 *
 * ── Fail-open, but never blindly ──
 *
 * When Redis is unavailable this falls back to an in-process counter that has
 * been incremented in lockstep all along — so the fallback is not a reset, it
 * is today's behaviour resuming. A locked-out school on an Upstash outage is a
 * worse outcome than the attack the limiter exists to stop, so nothing here
 * ever fails closed; and because the local counter never stopped counting,
 * nothing here fails silently open either.
 *
 * ── Fixed windows, deliberately ──
 *
 * The window is part of the key (`…:{bucket}`), so the reset time is arithmetic
 * rather than a `PTTL` round trip, and an expired window is a key that ages out
 * on its own. It also matches `express-rate-limit`'s own `MemoryStore`, so
 * moving a limiter onto this store does not quietly change its semantics — a
 * sliding window would have been more accurate and a different control.
 */
import { redisEval, redisCommand } from './redisClient.js';
import { redisEnabled, keyPrefix, hashSegment } from './redisConfig.js';

/**
 * Increment, and set the expiry only on the increment that created the key.
 *
 * One script rather than `INCR` then `PEXPIRE` as a pipeline, because a
 * pipeline is not atomic: interrupted between the two, it leaves a counter with
 * no expiry. On a 256 MB plan a key that never expires is not a leak, it is the
 * budget. Costs EVAL + INCR (+ PEXPIRE once per window).
 */
const INCR_SCRIPT = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return c";

/**
 * Decrement, but never resurrect a window that has already expired.
 *
 * `express-rate-limit` calls this on every successful request when
 * `skipSuccessfulRequests` is set, and a bare `DECR` on a missing key CREATES
 * it at -1 with no TTL — one immortal key per successful sign-in. The
 * existence check is the whole point of the script.
 */
const DECR_SCRIPT = "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('DECR', KEYS[1]) end return 0";

/** Charged per call, the way Upstash bills: the EVAL plus each `redis.call`. */
const INCR_COST = 3;
const DECR_COST = 3;

/**
 * The in-process mirror.
 *
 * Shared by every store and counter in this module so one sweep bounds all of
 * them. An attacker cannot grow it without bound by rotating identifiers: the
 * sweep below is the same shape `loginFailures` and the message limiter already
 * use, for the same reason.
 */
const localCounts = new Map();
const LOCAL_MAX = 20_000;

function sweepLocal(now) {
  if (localCounts.size <= LOCAL_MAX) return;
  for (const [k, v] of localCounts) if (v.expiresAt <= now) localCounts.delete(k);
  /* Still oversized means the entries are live — an attack in progress. Evict
     oldest-first rather than let the process run out of memory; a limiter that
     forgets is better than a server that dies. */
  if (localCounts.size > LOCAL_MAX) {
    for (const k of localCounts.keys()) {
      localCounts.delete(k);
      if (localCounts.size <= LOCAL_MAX * 0.8) break;
    }
  }
}

function localBump(key, expiresAt, delta) {
  const now = Date.now();
  const entry = localCounts.get(key);
  if (!entry || entry.expiresAt <= now) {
    const fresh = { count: Math.max(0, delta), expiresAt };
    localCounts.set(key, fresh);
    sweepLocal(now);
    return fresh.count;
  }
  entry.count = Math.max(0, entry.count + delta);
  return entry.count;
}

function localPeek(key) {
  const entry = localCounts.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return 0;
  return entry.count;
}

/** Test seam — and the only supported way to clear shared state between suites. */
export function __resetLocalCounters() {
  localCounts.clear();
}

/* ── Windowing ────────────────────────────────────────────────────────────── */

/**
 * The window this instant falls in, and when it ends.
 *
 * Anchored to the epoch rather than to first contact, so two application
 * instances agree on the boundary without coordinating — which is the only
 * reason a shared counter is worth anything.
 */
function windowFor(windowMs, now = Date.now()) {
  const bucket = Math.floor(now / windowMs);
  return { bucket, resetAt: (bucket + 1) * windowMs };
}

/**
 * The Redis key for one client in one window.
 *
 * `name` distinguishes limiters so `mail` and `login` cannot share a budget.
 * The client's key is hashed: it is an address, an email or a session digest,
 * and none of those belong in a third party's keyspace listing. The window
 * bucket is last so a console listing sorts by client, not by minute.
 */
function redisKeyFor(name, key, bucket) {
  return `${keyPrefix()}rl:${name}:${hashSegment(key)}:${bucket}`;
}

/**
 * The TTL written on a counter.
 *
 * One window plus a small grace, so a counter created a millisecond before a
 * boundary is not read as expired by a clock a few hundred milliseconds ahead
 * of ours. Bounded either way — nothing here can outlive two windows.
 */
function ttlFor(windowMs) {
  return windowMs + 5_000;
}

/* ── The express-rate-limit store ─────────────────────────────────────────── */

/**
 * A `Store` for `express-rate-limit` v8, backed by Redis with a memory
 * fallback.
 *
 * ── Why every method resolves, and none rejects ──
 *
 * `express-rate-limit` passes a rejected store promise to `next(err)`, which on
 * `/api/auth/login` is a 500 where a sign-in should have been. Since the client
 * beneath this never throws, the only rejection this could produce would be a
 * bug in this file — so the methods are written so there is nothing to throw.
 *
 * @param {object} opts
 * @param {string} opts.name short, stable limiter name; appears in the key
 */
export function createRedisLimitStore({ name }) {
  let windowMs = 60_000;

  const stats = { increments: 0, redisOk: 0, fallbacks: 0, decrements: 0, resets: 0 };

  async function bump(key, delta) {
    const { bucket, resetAt } = windowFor(windowMs);
    const localKey = `${name}:${key}:${bucket}`;

    /* The local mirror is updated on EVERY call, whether or not Redis answers.
       That is what makes an outage a continuation rather than a reset. */
    const localCount = localBump(localKey, resetAt, delta);

    if (!redisEnabled()) {
      return { totalHits: localCount, resetTime: new Date(resetAt) };
    }

    const redisKey = redisKeyFor(name, key, bucket);
    const res = delta > 0
      ? await redisEval(INCR_SCRIPT, [redisKey], [String(ttlFor(windowMs))], INCR_COST)
      : await redisEval(DECR_SCRIPT, [redisKey], [], DECR_COST);

    if (!res.ok || typeof res.result !== 'number') {
      stats.fallbacks += 1;
      return { totalHits: localCount, resetTime: new Date(resetAt) };
    }

    stats.redisOk += 1;
    /* The shared count is authoritative when it is available. It can only be
       greater than or equal to this instance's own view, so taking it never
       loosens a limit. */
    return { totalHits: Math.max(0, res.result), resetTime: new Date(resetAt) };
  }

  return {
    init(options) {
      if (Number.isFinite(options?.windowMs) && options.windowMs > 0) windowMs = options.windowMs;
    },

    async increment(key) {
      stats.increments += 1;
      return bump(key, 1);
    },

    async decrement(key) {
      stats.decrements += 1;
      await bump(key, -1);
    },

    async get(key) {
      const { bucket, resetAt } = windowFor(windowMs);
      const localKey = `${name}:${key}:${bucket}`;
      const local = localPeek(localKey);
      if (!redisEnabled()) return { totalHits: local, resetTime: new Date(resetAt) };

      const res = await redisCommand(['GET', redisKeyFor(name, key, bucket)]);
      const shared = res.ok && res.result !== null ? Number(res.result) : NaN;
      return {
        totalHits: Number.isFinite(shared) ? Math.max(shared, local) : local,
        resetTime: new Date(resetAt),
      };
    },

    async resetKey(key) {
      stats.resets += 1;
      const { bucket } = windowFor(windowMs);
      localCounts.delete(`${name}:${key}:${bucket}`);
      if (redisEnabled()) await redisCommand(['DEL', redisKeyFor(name, key, bucket)]);
    },

    /**
     * Deliberately absent behaviour, stated rather than left to inference.
     *
     * `resetAll` would have to enumerate keys, and enumeration means `SCAN` —
     * which the read-only REST token cannot run at all and which, on a shared
     * single-database plan, is a walk over every environment's keys. Nothing in
     * this application calls it; windows expire on their own.
     */
    async resetAll() {
      localCounts.clear();
    },

    /**
     * False, because keys are shared once Redis is configured.
     *
     * `express-rate-limit` uses this only to warn about double-counting when a
     * request passes through two limiters sharing a store. It stays false even
     * though the fallback path is process-local: the flag describes the design,
     * and flipping it during an outage would produce a spurious warning about a
     * misconfiguration that does not exist.
     */
    localKeys: false,

    prefix: `${keyPrefix()}rl:${name}:`,

    stats() {
      return { name, ...stats };
    },
  };
}

/* ── The hand-rolled counter ──────────────────────────────────────────────── */

/**
 * Increment, set the expiry once, and report how long is left — atomically.
 *
 * ── Why this one returns a TTL when the limiter store does not ──
 *
 * The store above uses epoch-aligned windows so the reset time is arithmetic
 * and costs no command. That is the right trade there, and it matches what
 * `express-rate-limit`'s own MemoryStore does — it expires every key on a
 * single shared timer rather than per key.
 *
 * `loginFailures` is different, and copying the store's scheme would have
 * WEAKENED it. Its window starts at the FIRST failure and runs fifteen minutes
 * from there; under an epoch-aligned window, ten failures at 14:59 would unlock
 * at 15:00. That is a real reduction in a control that bounds password guessing
 * against one account, so the extra `PTTL` is bought deliberately.
 *
 * Costs EVAL + INCR + PTTL, plus PEXPIRE on the call that creates the key.
 */
const HIT_SCRIPT = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return {c, redis.call('PTTL', KEYS[1])}";

const HIT_COST = 4;

/** The key for a hand-rolled counter. No window bucket — the TTL carries it. */
function counterKeyFor(name, key) {
  return `${keyPrefix()}cnt:${name}:${hashSegment(key)}`;
}

/**
 * Reads a `{count, pttl}` pair the way both paths below want it.
 *
 * Redis answers a Lua table as an array. A negative PTTL means "no expiry set"
 * (-1) or "no such key" (-2); neither should become a reset time in the past,
 * so both fall back to a full window — the conservative direction for a lockout.
 */
function readPair(result, windowMs) {
  if (!Array.isArray(result) || result.length < 2) return null;
  const count = Number(result[0]);
  const pttl = Number(result[1]);
  if (!Number.isFinite(count)) return null;
  return { count, remainingMs: Number.isFinite(pttl) && pttl > 0 ? pttl : windowMs };
}

/**
 * A shared counter for throttles that are not `express-rate-limit` middleware.
 *
 * `loginFailures` in authRoutes.js is the caller this exists for: it counts
 * only FAILED sign-ins, keyed on the resolved account rather than on what was
 * typed, and it is the control that actually bounds brute force against one
 * account across every device. It has always been a `Map`; this gives it the
 * same shared, restart-surviving storage as the middleware limiters without
 * changing what it counts, when it counts it, or how long a lockout lasts.
 *
 * @param {object} opts
 * @param {string} opts.name appears in the key
 * @param {number} opts.windowMs measured from the first occurrence, not from a
 *   clock boundary — see `HIT_SCRIPT`
 */
export function createSharedCounter({ name, windowMs }) {
  const localKey = (key) => `cnt:${name}:${key}`;

  return {
    /**
     * Records one occurrence. Returns the count including this one, and when
     * the window ends.
     */
    async hit(key) {
      const now = Date.now();
      const lk = localKey(key);

      /* The local mirror is written on EVERY call, so an outage mid-window
         resumes today's behaviour instead of clearing the count. `localBump`
         only takes `expiresAt` when it creates the entry, which is exactly the
         "window starts at the first failure" rule. */
      const local = localBump(lk, now + windowMs, 1);
      const localEntry = localCounts.get(lk);
      const localResetAt = localEntry ? localEntry.expiresAt : now + windowMs;

      if (!redisEnabled()) return { count: local, resetAt: localResetAt };

      const res = await redisEval(
        HIT_SCRIPT, [counterKeyFor(name, key)], [String(windowMs)], HIT_COST
      );
      const pair = res.ok ? readPair(res.result, windowMs) : null;
      if (!pair) return { count: local, resetAt: localResetAt };

      return {
        count: Math.max(pair.count, local),
        resetAt: Date.now() + pair.remainingMs,
      };
    },

    /**
     * Reads the count without recording anything.
     *
     * ── Why this is one command and not two ──
     *
     * This runs on EVERY sign-in attempt, including every successful one, which
     * makes it the most frequent Redis call in the application. The obvious
     * implementation pipelines `GET` and `PTTL` so the reset time is always
     * exact — one round trip, but two commands billed, and Upstash's free plan
     * meters commands rather than round trips.
     *
     * The `PTTL` is only ever USED when the count has reached the limit, which
     * is the rare case: it feeds the "try again in about N minutes" message and
     * nothing else. So it is fetched only when the count is non-zero and this
     * process has no local record of when the window ends — which is to say,
     * after a restart, for an account that is mid-lockout. Every other attempt
     * costs a single `GET`.
     *
     * Halving this call is worth more than it looks: at the traffic modelled in
     * docs/operations/upstash.md §7.3 it is about a fifth of the integration's
     * entire monthly spend.
     */
    async peek(key) {
      const now = Date.now();
      const lk = localKey(key);
      const local = localPeek(lk);
      const localEntry = localCounts.get(lk);
      const knownResetAt = localEntry && localEntry.expiresAt > now ? localEntry.expiresAt : null;
      const localResetAt = knownResetAt ?? now + windowMs;

      if (!redisEnabled()) return { count: local, resetAt: localResetAt };

      const redisKey = counterKeyFor(name, key);
      const res = await redisCommand(['GET', redisKey]);
      if (!res.ok || res.result === null) return { count: local, resetAt: localResetAt };

      const shared = Number(res.result);
      if (!Number.isFinite(shared)) return { count: local, resetAt: localResetAt };

      const count = Math.max(shared, local);

      /* The exact reset time matters only when there is something to report,
         and this process usually already knows it. `now + windowMs` would
         OVERSTATE the wait, which is the wrong direction for a message shown to
         somebody locked out, so the second command is worth paying here. */
      if (count > 0 && knownResetAt === null) {
        const ttl = await redisCommand(['PTTL', redisKey]);
        const pttl = ttl.ok ? Number(ttl.result) : NaN;
        if (Number.isFinite(pttl) && pttl > 0) return { count, resetAt: now + pttl };
      }

      return { count, resetAt: localResetAt };
    },

    /**
     * Clears a key's count.
     *
     * Called when somebody signs in successfully, so remembering a password on
     * the sixth try never costs the lockout.
     */
    async clear(key) {
      localCounts.delete(localKey(key));
      if (redisEnabled()) await redisCommand(['DEL', counterKeyFor(name, key)]);
    },
  };
}
