/**
 * A two-tier cache for THIRD-PARTY LOOKUP RESPONSES, and for nothing else.
 *
 * ── What this is for, and the measurement that draws the line ──
 *
 * `docs/operations/postgres-scale-measurements.md` records the application's hot
 * queries at 50× pilot scale: unread notification count 0.3 ms, my applications
 * 0.5 ms, event roster 0.4 ms. An Upstash round trip is an HTTPS request to
 * another host. Putting any of those behind Redis makes them slower and spends
 * quota to do it, so **no database query is cached here and none should be.**
 *
 * What this caches is the other shape: a call to somebody else's server that
 * takes hundreds of milliseconds, is bounded by their published usage policy,
 * and returns the same answer to everybody. Two routes qualify — the weather
 * forecast and address geocoding. For those the comparison is not 0.4 ms
 * against 40 ms; it is 40 ms against 800 ms, plus an obligation to a third party
 * that this application is not entitled to spend freely.
 *
 * ── Why two tiers rather than one ──
 *
 * L1 is the in-process `Map` those routes already had, and it stays the primary
 * cache: it answers in zero milliseconds and costs no quota, which is right for
 * the common case of many students opening the same event.
 *
 * L2 is Redis, and it exists for exactly one thing L1 cannot do: **survive a
 * restart.** A deploy empties L1, and re-warming a few hundred geocode entries
 * is minutes of pressure against the one-request-per-second Nominatim policy
 * (see `routes/geocodeRoutes.js`). L2 turns that into a handful of Redis reads.
 * It also happens to be the tier a second application instance would share, but
 * that is a consequence, not the reason.
 *
 * ── What must never be cached here ──
 *
 * Anything personal, and anything authorization depends on. Concretely:
 *
 *   - **Travel-time origins are excluded.** `routes/travelRoutes.js` states the
 *     invariant in terms — "Never persisted. No column, no row, nowhere" —
 *     because the origin is a minor's location. A hashed key does not make that
 *     acceptable: the point is that the coordinates do not leave this process.
 *     That route keeps its process-local cache and is not a caller here.
 *   - **No per-user responses.** Every value stored here is a function of the
 *     lookup arguments alone, so two users with different permissions cannot
 *     receive each other's answer. The routes still run their own
 *     `authenticateToken` and `requireCap` checks before consulting the cache;
 *     the cache never carries an authorization decision.
 */
import { redisCommand, noteCacheOutcome } from './redisClient.js';
import { redisEnabled, keyPrefix, hashSegment } from './redisConfig.js';

/**
 * The largest value worth storing.
 *
 * A forecast is a few hundred bytes and a geocode result a few kilobytes. The
 * plan's ceiling is 100 MB per record and 256 MB in total, so the guard is not
 * about Upstash's limits — it is about an upstream that starts returning
 * something unexpected filling a shared 256 MB budget one response at a time.
 * Oversized values are simply not written; the caller still gets its answer.
 */
const MAX_VALUE_BYTES = 64 * 1024;

/**
 * A cache over one domain of third-party lookups.
 *
 * @param {object} opts
 * @param {string} opts.domain short, stable, appears in the key: 'weather', 'geocode'
 * @param {number} opts.ttlMs how long an answer stays good, in BOTH tiers
 * @param {number} opts.maxLocal L1 entry ceiling, matching what the route had
 */
export function createLookupCache({ domain, ttlMs, maxLocal }) {
  /** L1. Same structure and same eviction the routes already used. */
  const local = new Map();

  const stats = { l1Hits: 0, l2Hits: 0, misses: 0, writes: 0, errors: 0, skippedTooLarge: 0 };

  function localGet(key) {
    const entry = local.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > ttlMs) { local.delete(key); return null; }
    return entry.data;
  }

  function localSet(key, data) {
    /* Insertion-ordered eviction, as before: the oldest key is the first one
       `keys()` yields. Not a true LRU, and deliberately not — a read that
       refreshed recency would make the common case a write. */
    if (local.size >= maxLocal) {
      const oldest = local.keys().next().value;
      local.delete(oldest);
    }
    local.set(key, { data, ts: Date.now() });
  }

  /**
   * The Redis key.
   *
   * The caller's key is hashed rather than embedded. For geocoding that key is
   * an address somebody typed, and a keyspace listing on a third party's
   * console should not be a list of the places this district searched for.
   * Hashing also removes every character that could change the command being
   * sent — see `hashSegment`.
   */
  function redisKey(key) {
    return `${keyPrefix()}cache:${domain}:${hashSegment(key)}`;
  }

  return {
    /**
     * The cached answer, or `null`.
     *
     * Never throws and never rejects. A Redis failure is a miss, which is the
     * only correct interpretation: the caller's fallback is to do the work,
     * which is exactly what it would have done without a cache at all.
     */
    async get(key) {
      const hit = localGet(key);
      if (hit !== null) { stats.l1Hits += 1; return hit; }

      if (!redisEnabled()) { stats.misses += 1; return null; }

      const res = await redisCommand(['GET', redisKey(key)]);
      if (!res.ok) { stats.errors += 1; stats.misses += 1; noteCacheOutcome(false); return null; }
      if (res.result === null || res.result === undefined) {
        stats.misses += 1; noteCacheOutcome(false); return null;
      }

      /* A value written by an older release, or truncated in transit, must not
         become a 500 on a route that had a perfectly good upstream available.
         Unparseable is treated as absent. */
      let parsed;
      try { parsed = JSON.parse(res.result); } catch { stats.errors += 1; stats.misses += 1; return null; }

      /* Promote into L1 so the next reader pays nothing. */
      localSet(key, parsed);
      stats.l2Hits += 1;
      noteCacheOutcome(true);
      return parsed;
    },

    /**
     * Stores an answer in both tiers.
     *
     * L1 is written first and unconditionally, so a Redis outage costs the
     * durability of the entry and not the entry. `PX` carries the TTL, so
     * nothing here can create a key without an expiry — the one way a bounded
     * plan turns into an unbounded one.
     *
     * Deliberately NOT awaited by every caller: see the routes, which await it
     * because they are already async and the write is a single command. There
     * is no fire-and-forget path, because an unawaited promise that rejects is
     * an unhandled rejection, and this module's contract is that nothing here
     * ever rejects.
     */
    async set(key, value) {
      localSet(key, value);
      if (!redisEnabled()) return;

      let payload;
      try { payload = JSON.stringify(value); } catch { stats.errors += 1; return; }
      if (payload.length > MAX_VALUE_BYTES) { stats.skippedTooLarge += 1; return; }

      const res = await redisCommand(['SET', redisKey(key), payload, 'PX', String(ttlMs)]);
      if (res.ok) stats.writes += 1; else stats.errors += 1;
    },

    /** Counters for the operator status panel. No keys, no values, no identifiers. */
    stats() {
      const total = stats.l1Hits + stats.l2Hits + stats.misses;
      return {
        domain,
        ...stats,
        localSize: local.size,
        hitRate: total ? Math.round(((stats.l1Hits + stats.l2Hits) / total) * 100) : 0,
      };
    },

    /** Test seam. Clears L1 only — Redis entries expire on their own TTL. */
    __clearLocal() {
      local.clear();
      for (const k of Object.keys(stats)) stats[k] = 0;
    },
  };
}
