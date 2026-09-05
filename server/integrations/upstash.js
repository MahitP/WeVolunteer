/**
 * Upstash Redis, for the Owner Center.
 *
 * ── Almost nothing new is written here, deliberately ──
 *
 * `server/redis/status.js` already owns the decision about what an operator may
 * know about the Redis layer, and its header says why that decision lives in
 * one module: "an allowlist assembled at the call site is one that leaks the
 * first time somebody adds a field". This module does not re-derive any of it.
 * It calls `redisStatus()` and adds exactly one thing that panel could not
 * have: a live round trip.
 *
 * ── Why a PING at all, when `redisStatus` already reports health ──
 *
 * Because those counters are about requests this process has already made. On a
 * quiet morning they are all zero, and zero failures out of zero requests looks
 * identical to a healthy connection and to a database that was archived for
 * inactivity thirty days ago. One PING is the difference between "nothing has
 * gone wrong" and "it answers, in 42 ms".
 *
 * ── What it costs, and why that is affordable ──
 *
 * One command. Upstash's free plan allows 500,000 commands a month (see
 * `redisConfig.js`, which sizes the whole integration against that figure), and
 * this is cached for a minute — so an owner leaving the page open all day
 * spends about 1,440 commands, under 0.3% of the monthly allowance. Uncached it
 * would be one command per render, which is the shape that turns a status page
 * into a load generator.
 *
 * ── What is deliberately absent ──
 *
 * Every write. No FLUSHDB, no key deletion, no key browsing, no TTL editing.
 * The Owner Center is a place to find out that something is wrong, not a Redis
 * console — and the one destructive control anybody would actually want here
 * ("clear the rate limits, I locked myself out") would also clear every
 * credential-stuffing counter on a service used by children. The console link
 * is the right answer for that, and it is what the card offers.
 */
import { redisStatus } from '../redis/status.js';
import { redisPing } from '../redis/redisClient.js';
import { notConfigured, ok } from './providerResult.js';

/** The console. Project-specific URLs need an account id we do not hold. */
export const UPSTASH_CONSOLE_URL = 'https://console.upstash.com/redis';

/**
 * The variables that switch Redis on, named HERE and never in `src/`.
 *
 * `redis.privacy.test.js` fails the build on any file under `src/` that so much
 * as contains `UPSTASH_REDIS_REST`, because a `VITE_`-prefixed one would compile
 * a write credential into the browser bundle. Keeping the string on this side of
 * the wire means the Owner Center can still tell its reader what to set without
 * client source ever naming it.
 */
export const UPSTASH_CONFIGURE_WITH = 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN';

export async function fetchRedis(caches = {}) {
  const status = redisStatus(caches);

  /**
   * Not configured is a supported, unalarming state — the pilot runs without
   * Upstash, and every caller has an in-process fallback. It is its own state
   * rather than a failure, so the card renders grey rather than red.
   *
   * `incomplete` is separated from `unconfigured` because they send an operator
   * to two different places: one means nothing was set, the other means one of
   * the pair was, which is a typo rather than a decision.
   */
  if (!status.configured) {
    return notConfigured(
      UPSTASH_CONFIGURE_WITH,
      status.reason === 'incomplete'
        ? 'Only one of the two Upstash variables is set, so Redis stays off.'
        : undefined,
    );
  }

  const ping = await redisPing();
  if (!ping.ok) {
    /**
     * A refused PING is reported WITH the status block rather than instead of
     * it. The counters and the breaker state are what explain the refusal —
     * "breaker open, clears in 22s" is a different morning from "configured,
     * breaker closed, and it still will not answer" — and they are local, so
     * they are available exactly when the round trip is not.
     */
    return ok({
      reachable: false,
      status,
      /* The reason as `redisClient` classified it. It is one of this
         repository's own words (`disabled`, `timeout`, `breaker_open`, an HTTP
         status), never Upstash's response body. */
      reason: typeof ping.reason === 'string' ? ping.reason : 'unavailable',
    });
  }

  return ok({
    reachable: true,
    latencyMs: ping.latencyMs,
    status,
  });
}

/** Exported for a test that wants the unconfigured branch without a network. */
export function upstashConfigured(caches = {}) {
  return redisStatus(caches).configured === true;
}
