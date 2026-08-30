/**
 * What an operator may know about the Redis layer, and what nobody may.
 *
 * ── Why this is its own module ──
 *
 * The counters live in four places — the transport, two caches, and the
 * limiter store — and an operator panel that reached into each of them would be
 * the fourth place that decides what is safe to expose. One module owns that
 * decision, the same way `telemetry.js` owns the telemetry allowlist and for
 * the same reason: an allowlist assembled at the call site is one that leaks
 * the first time somebody adds a field.
 *
 * ── The rule ──
 *
 * **Counts and configuration only.** No key names, no key contents, no
 * identifiers, no coordinates, no addresses, and never the token. The endpoint
 * URL IS included — it names the database and its region, which is what an
 * operator is checking, and it is not a credential.
 *
 * ── Why this is on the ADMIN surface and not on /health ──
 *
 * `/health` is unauthenticated, and `app.js` already refuses to let it become
 * an oracle about the filesystem. "Is Redis configured, and is its breaker
 * open" is exactly the kind of thing an unauthenticated caller should not be
 * able to poll — knowing the shared rate-limit store is down is knowing the
 * limits have fallen back to per-process.
 */
import { redisConfig, keyPrefix, FREE_TIER, LIMITS_READ_ON, REQUEST_TIMEOUT_MS } from './redisConfig.js';
import { redisUsage, redisHealth } from './redisClient.js';

/**
 * @param {object} [caches] named `stats()` results from the lookup caches.
 *   Passed in rather than imported, so this module does not have to know which
 *   routes exist — and so a route that has not been loaded (the weather route
 *   is only mounted in some configurations) does not become an import cycle.
 */
export function redisStatus(caches = {}) {
  const cfg = redisConfig();
  const usage = redisUsage();
  const health = redisHealth();

  return {
    configured: cfg.enabled,
    /* The reason, not a bare false. "incomplete" and "unconfigured" send an
       operator to two different places. */
    reason: cfg.reason,
    endpoint: cfg.enabled ? cfg.url : null,
    keyPrefix: keyPrefix(),
    timeoutMs: REQUEST_TIMEOUT_MS,

    /**
     * Degraded means "configured, but currently answering from the fallback".
     * That is the state worth alerting on: nothing is broken for users, and
     * every shared limit has quietly become per-process.
     */
    degraded: cfg.enabled && health.breakerOpen,
    breakerClearsInMs: health.breakerClearsInMs,

    /**
     * What THIS PROCESS has spent since boot.
     *
     * Deliberately not presented as the monthly total: the allowance is per
     * account and per month, and a restart resets this counter. It is here so
     * an operator can spot a runaway caller between console visits, and the
     * plan figures beside it are what makes the number mean something.
     */
    usage: {
      requests: usage.requests,
      commands: usage.commands,
      failures: usage.failures,
      timeouts: usage.timeouts,
      breakerTrips: usage.breakerTrips,
      avgLatencyMs: usage.avgLatencyMs,
      maxLatencyMs: usage.maxLatencyMs,
    },

    plan: {
      commandsPerMonth: FREE_TIER.commandsPerMonth,
      storageMB: FREE_TIER.storageBytes / (1024 * 1024),
      databases: FREE_TIER.databases,
      idleArchiveDays: FREE_TIER.idleArchiveDays,
      documentedOn: LIMITS_READ_ON,
    },

    /* Hit rates and counts per cache domain. `lookupCache.stats()` returns
       nothing but numbers and the domain name. */
    caches,
  };
}
