/**
 * Volume limiting that is correct across instances without being priced like it.
 *
 * ── The gap this closes, and why the obvious fix is wrong ──
 *
 * `limitStore.js` shares five SECURITY limiters through Redis, and deliberately
 * leaves the VOLUME limiters — `apiLimiter` above all — in process memory. With
 * one instance that is exactly correct. With N instances each enforces its own
 * copy and the effective ceiling becomes N x limit.
 *
 * The obvious fix is to give the volume limiters the same Redis store the
 * security ones use. That fails on arithmetic, not on taste:
 *
 *   `apiLimiter` allows 600 requests per fifteen minutes and sits on EVERY
 *   `/api` call. At the traffic modelled in `docs/operations/upstash.md` §7.3 —
 *   roughly 2,200 API requests per user per month — metering each one costs
 *   3 commands, so 6,600 commands per user per month. The whole free plan is
 *   500,000 a month, which at 1,000 users is 500 per user. **The naive design
 *   is off by more than thirteen times.** No amount of pipelining fixes a
 *   factor of thirteen; the request volume itself is the problem.
 *
 * So exact per-request coordination is not available at this price. What IS
 * available is the observation that a volume limiter spends almost all of its
 * life nowhere near its limit. A student browsing makes a hundred requests in a
 * quarter hour against a ceiling of six hundred. Coordination only has anything
 * to say once somebody approaches the ceiling — and that is a small enough
 * population to meter properly.
 *
 * ── The design: local-first, escalate on approach ──
 *
 *   1. Every instance keeps an EXACT local count. This alone is the whole
 *      limiter on one instance, which is what the deployment runs today, so
 *      today's behaviour is unchanged and costs nothing.
 *   2. Below `escalateAt`, nothing is shared and no command is spent.
 *   3. On crossing `escalateAt` the instance reports everything it has served
 *      so far in ONE atomic operation, and learns the global total.
 *   4. Above it, each request reports in batches of `batch`, taking
 *      `max(local, shared)` — which can only tighten a limit, never loosen it.
 *   5. Once the count is at or over the limit, refusal is decided LOCALLY. A
 *      caller being refused costs no commands, so an attacker cannot spend the
 *      allowance by continuing to knock.
 *
 * ── What this guarantees, stated honestly ──
 *
 * It is not exact across instances, and pretending otherwise would be the kind
 * of claim this codebase exists not to make. Each instance may serve up to
 * `escalateAt - 1` requests it has not reported, so with N instances the global
 * ceiling is bounded by:
 *
 *     limit + N x (escalateAt - 1)
 *
 * against today's N x limit. At the shipped defaults — 600 limit, escalate at
 * 150 — two instances are bounded by 898 rather than 1,200, and three by 1,047
 * rather than 1,800. The error is bounded, it is configurable, and it shrinks
 * as `escalateAt` falls; the cost moves the other way, which is the trade being
 * made rather than hidden.
 *
 * For a VOLUME brake that is the right trade. It is emphatically not the right
 * trade for a credential control, which is why `loginFailures` and the mail
 * limiters do not use this and are metered exactly, on every attempt.
 *
 * ── Cost, at the defaults ──
 *
 * A user who never passes 150 requests in a window costs ZERO commands, which
 * is almost everybody almost always. A user who runs the full 600 costs one
 * report at the threshold plus (600 - 150) / 25 batches, so 19 operations and
 * about 57 commands — for a window in which they made six hundred requests.
 */
import { redisEval, redisCommand } from './redisClient.js';
import { redisEnabled, keyPrefix, hashSegment } from './redisConfig.js';

/**
 * Add `n` to a counter, create its expiry exactly once, and return the total.
 *
 * The expiry is set only when the key is created (`c == n` means this call made
 * it), so a long-running window is never extended by later reports — the window
 * must end when it was going to end, or a busy caller could hold a key open for
 * ever. Costs EVAL + INCRBY, plus PEXPIRE on the creating call.
 */
const ADD_SCRIPT =
  "local c = redis.call('INCRBY', KEYS[1], ARGV[1]) "
  + "if c == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end "
  + 'return c';

const ADD_COST = 3;

/** Epoch-aligned windows, so a reset time is arithmetic rather than a command. */
function windowFor(windowMs, now = Date.now()) {
  const bucket = Math.floor(now / windowMs);
  return { bucket, resetAt: (bucket + 1) * windowMs };
}

/**
 * Keys carry a HASH of the caller-supplied part, never the part itself.
 *
 * `redis.privacy.test.js` enforces this at every construction site, and the
 * reason is in its header: a limiter key is a list of who was using the
 * application, and this one would be keyed on session identifiers.
 */
function keyFor(name, key, bucket) {
  return `${keyPrefix()}vol:${name}:${bucket}:${hashSegment(key)}`;
}

/**
 * A volume limiter's shared half.
 *
 * @param {object} opts
 * @param {string} opts.name          appears in the key
 * @param {number} opts.limit         the ceiling being enforced
 * @param {number} opts.escalateAt    local count at which sharing begins
 * @param {number} opts.batch         requests per report once sharing
 */
export function createVolumeCoordinator({ name, limit, escalateAt, batch }) {
  const stats = { escalations: 0, reports: 0, redisOk: 0, fallbacks: 0, skipped: 0 };

  return {
    name,
    stats: () => ({ name, ...stats }),

    /**
     * Decides what total this limiter should judge against.
     *
     * `localCount` is this instance's exact count INCLUDING the request being
     * decided. `state` is what this instance remembers from its last report:
     * `reported` (how much it has told Redis about) and `lastGlobal` (the total
     * Redis returned at that moment).
     *
     * ── Why `lastGlobal` has to be remembered ──
     *
     * The first version of this did not keep it, and two instances then leaked
     * almost a whole extra budget: an instance would report, learn the global
     * total was 150, and on the very next request go back to judging against
     * its own local count of 30. Everything learned was discarded between
     * batches. Between reports the honest estimate is the last global plus what
     * this instance has served since — which is what is computed here.
     *
     * Returns `{ total, reported, lastGlobal }`.
     */
    async coordinate(key, localCount, state, windowMs, now = Date.now()) {
      const reported = state?.reported ?? 0;
      const lastGlobal = state?.lastGlobal ?? 0;

      /* Below the threshold, and when Redis is not configured at all, this is a
         purely local limiter — the deployed single-instance case, and the one
         that must cost nothing. */
      if (!redisEnabled() || localCount < escalateAt) {
        stats.skipped += 1;
        return { total: localCount, reported, lastGlobal };
      }

      const unreported = localCount - reported;
      /* What this instance believes the global total to be right now: everything
         Redis knew at the last report, plus everything served since. Never below
         the local count, which is a floor by construction. */
      const estimate = Math.max(localCount, lastGlobal + unreported);

      /* Already at the ceiling by this instance's own estimate. Refusing needs
         no agreement from anybody, and costs no command — which is what stops a
         caller who is being refused from draining the allowance by knocking. */
      if (estimate > limit) {
        stats.skipped += 1;
        return { total: estimate, reported, lastGlobal };
      }

      /* Report in batches. The FIRST report carries everything served so far,
         so the requests made below the threshold are not lost from the global
         count. */
      if (reported > 0 && unreported < batch) {
        return { total: estimate, reported, lastGlobal };
      }

      if (reported === 0) stats.escalations += 1;
      stats.reports += 1;

      const { bucket, resetAt } = windowFor(windowMs, now);
      const ttl = Math.max(1, resetAt - now);
      const res = await redisEval(
        ADD_SCRIPT, [keyFor(name, key, bucket)], [String(unreported), String(ttl)], ADD_COST
      );

      if (!res.ok || typeof res.result !== 'number') {
        /* Redis is unreachable. The local view stands, which is exactly the
           behaviour of the deployment as it runs today — a continuation, not a
           reset, and never an unlimited budget. `reported` is deliberately NOT
           advanced, so whatever was served during the outage is reported in one
           piece when Redis comes back. */
        stats.fallbacks += 1;
        return { total: estimate, reported, lastGlobal };
      }

      stats.redisOk += 1;
      /* The shared total is authoritative and can only be >= this instance's
         own view, so taking it never loosens the limit. */
      const global = Math.max(localCount, res.result);
      return { total: global, reported: localCount, lastGlobal: global };
    },

    /** Test seam: reads the shared counter without changing it. */
    async peek(key, windowMs, now = Date.now()) {
      if (!redisEnabled()) return null;
      const { bucket } = windowFor(windowMs, now);
      const res = await redisCommand(['GET', keyFor(name, key, bucket)]);
      if (!res.ok || res.result === null) return null;
      const n = Number(res.result);
      return Number.isFinite(n) ? n : null;
    },
  };
}

export const __volumeInternals = { windowFor, keyFor, ADD_SCRIPT, ADD_COST };

/* ── The `express-rate-limit` store ───────────────────────────────────────── */

/**
 * Local state for one limiter: an exact count per (key, window).
 *
 * Kept per store rather than in one shared map so two limiters using this
 * cannot collide on a key, and so a store can be reset in a test without
 * disturbing another.
 */
function makeLocalState() {
  const counts = new Map();

  return {
    counts,
    bump(localKey, resetAt, delta) {
      const entry = counts.get(localKey);
      if (!entry || entry.resetAt !== resetAt) {
        const fresh = { count: Math.max(0, delta), reported: 0, lastGlobal: 0, resetAt };
        counts.set(localKey, fresh);
        return fresh;
      }
      entry.count = Math.max(0, entry.count + delta);
      return entry;
    },
    peek(localKey, resetAt) {
      const entry = counts.get(localKey);
      return entry && entry.resetAt === resetAt ? entry : null;
    },
    /** Drops finished windows. Cheap, and bounded by the number of live keys. */
    sweep(now) {
      for (const [k, v] of counts) if (v.resetAt <= now) counts.delete(k);
    },
  };
}

/**
 * A store for a HIGH-VOLUME limiter — exact locally, coordinated on approach.
 *
 * Drop-in for `express-rate-limit`'s `store` option, and deliberately NOT the
 * same thing as `createRedisLimitStore`: that one meters every increment
 * exactly, which is right for a limiter that ticks on a failure and ruinous for
 * one that ticks on every request. See this file's header for the arithmetic.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {number} opts.limit      the ceiling this limiter enforces
 * @param {number} [opts.escalateAt] defaults to a quarter of the limit
 * @param {number} [opts.batch]      defaults to 25
 */
export function createVolumeLimitStore({ name, limit, escalateAt, batch = 25 }) {
  let windowMs = 15 * 60 * 1000;
  const local = makeLocalState();
  const threshold = escalateAt ?? Math.max(1, Math.floor(limit / 4));
  const coordinator = createVolumeCoordinator({ name, limit, escalateAt: threshold, batch });

  let sweptAt = 0;

  return {
    init(options) {
      if (Number.isFinite(options?.windowMs) && options.windowMs > 0) windowMs = options.windowMs;
    },

    async increment(key) {
      const now = Date.now();
      const { resetAt } = windowFor(windowMs, now);
      const localKey = `${key}:${resetAt}`;

      /* Swept at most once a window, and only over live keys. Without this the
         map grows with distinct callers for as long as the process runs. */
      if (now - sweptAt > windowMs) { local.sweep(now); sweptAt = now; }

      const entry = local.bump(localKey, resetAt, 1);
      const { total, reported, lastGlobal } =
        await coordinator.coordinate(key, entry.count, entry, windowMs, now);
      entry.reported = reported;
      entry.lastGlobal = lastGlobal;

      return { totalHits: total, resetTime: new Date(resetAt) };
    },

    async decrement(key) {
      const now = Date.now();
      const { resetAt } = windowFor(windowMs, now);
      /* Local only, deliberately. A decrement is `skipSuccessfulRequests`
         giving budget back; giving it back in Redis would need a second
         operation on the hot path to undo one this design mostly never made.
         No limiter using this store sets that option — asserted in
         `rateLimit.volume.test.js`. */
      local.bump(`${key}:${resetAt}`, resetAt, -1);
    },

    async get(key) {
      const { resetAt } = windowFor(windowMs);
      const entry = local.peek(`${key}:${resetAt}`, resetAt);
      return { totalHits: entry?.count ?? 0, resetTime: new Date(resetAt) };
    },

    async resetKey(key) {
      const { resetAt } = windowFor(windowMs);
      local.counts.delete(`${key}:${resetAt}`);
    },

    async resetAll() { local.counts.clear(); },

    /**
     * True, because the count this store reports is this process's own except
     * on the escalation path. `express-rate-limit` uses the flag only to warn
     * about double-counting across limiters sharing a store, and no two
     * limiters share one of these.
     */
    localKeys: true,

    stats: () => ({ ...coordinator.stats(), tracked: local.counts.size, escalateAt: threshold }),

    /** Test seams. */
    __local: local,
    __coordinator: coordinator,
  };
}
