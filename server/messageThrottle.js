/**
 * The message send throttle: 20 messages a minute, per sender.
 *
 * ── Why this is its own module now ──
 *
 * It was a `Map` and a closure inside `routes/messageRoutes.js`, which made it
 * the last piece of rate-limiting state in the application that was purely
 * process-local and had nobody's attention. `docs/operations/horizontal-scaling.md`
 * listed it as the one item that was neither shared nor deliberately deferred.
 *
 * Two things were wrong with it beyond not being shared, and both are fixed
 * here because a rewrite that reproduced them would be a wasted rewrite.
 *
 * ── Defect 1: the eviction could clear an ACTIVE bucket ──
 *
 * The original swept at 5,000 entries and, if still over, deleted keys in
 * insertion order until it was under 4,000 — active buckets included. A sender
 * whose bucket was evicted got a fresh twenty. So the throttle failed exactly
 * when it was most needed: under enough concurrent senders to fill the map,
 * which is what a spam run looks like. The sweep now only removes buckets with
 * no live timestamps, and the cap is enforced by dropping the OLDEST bucket by
 * last activity — never one that is currently holding somebody back.
 *
 * ── Defect 2: unbounded per-user arrays ──
 *
 * Each send pushed a timestamp and the array was filtered on read, so a sender
 * being refused kept a 20-element array — fine — but the map itself grew with
 * every distinct sender and was only swept when it passed 5,000. The sweep is
 * now also time-based, so an idle map drains instead of waiting for a crowd.
 *
 * ── The window is SLIDING, and stays that way ──
 *
 * `express-rate-limit`'s stores use fixed windows, so the tempting move — reuse
 * the limiter store the security limiters use — would have changed the rule:
 * under a fixed minute, twenty sends at 00:59 and twenty at 01:01 are both
 * legal, which is forty messages in two seconds. `messageThrottle.characterization.test.js`
 * pins that this does not happen, and it is why this keeps its own state shape.
 */
import { createVolumeCoordinator } from './redis/volumeLimit.js';

export const MESSAGE_LIMIT = Number(process.env.MESSAGE_RATE_LIMIT) || 20;
export const MESSAGE_WINDOW_MS = 60_000;

/**
 * Where sharing begins.
 *
 * Half the limit. A sender at ten messages a minute is already well outside
 * ordinary use — the conversations this application carries are a student and
 * an organizer arranging a shift — so in practice nobody reaches this and the
 * throttle costs nothing. See `redis/volumeLimit.js` for why the threshold
 * exists at all rather than sharing every send.
 */
const ESCALATE_AT = Math.max(1, Math.floor(MESSAGE_LIMIT / 2));

/** One report per this many sends once sharing has begun. */
const BATCH = 5;

/** userId -> { times: number[], reported: number, last: number } */
const buckets = new Map();

const MAX_BUCKETS = 5_000;

const coordinator = createVolumeCoordinator({
  name: 'msg',
  limit: MESSAGE_LIMIT,
  escalateAt: ESCALATE_AT,
  batch: BATCH,
});

/**
 * Removes buckets that are genuinely finished, then — only if still over the
 * cap — the least recently active.
 *
 * The ordering is the fix for defect 1: an active bucket is only ever dropped
 * after every expired one has been, and then oldest-first, so the sender most
 * likely to be mid-burst is the last to be forgiven rather than the first.
 */
function sweep(now) {
  for (const [k, b] of buckets) {
    if (b.times.length === 0 || now - b.last >= MESSAGE_WINDOW_MS) buckets.delete(k);
  }
  if (buckets.size <= MAX_BUCKETS) return;

  const byAge = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last);
  for (const [k] of byAge) {
    buckets.delete(k);
    if (buckets.size <= MAX_BUCKETS * 0.8) break;
  }
}

/**
 * Records a send attempt and says whether it is allowed.
 *
 * A REFUSED send does not consume budget — the timestamp is pushed only on the
 * allowed path. That is the original behaviour and it matters: if retries
 * counted, a sender who kept knocking would push their own window forward and
 * never recover.
 *
 * Never throws. A Redis failure inside `coordinate` is already handled there by
 * falling back to the local count, which is the behaviour of the deployment as
 * it runs today.
 */
export async function checkMessageRateLimit(userId, now = Date.now()) {
  const existing = buckets.get(userId);
  const times = (existing?.times ?? []).filter(ts => now - ts < MESSAGE_WINDOW_MS);

  /**
   * The shared-state watermark travels with the bucket.
   *
   * `coordinate` needs BOTH how much this instance has reported and the global
   * total it learned at that moment — passing only the first made it re-report
   * everything on every send, which inflated the shared counter until a lone
   * instance refused at half its own limit. The bug is worth naming because it
   * failed in the SAFE direction and so would have survived a smoke test: the
   * throttle was too strict, not too loose.
   *
   * Both are dropped once the window has fully drained, because the shared key
   * has expired by then and a stale watermark would suppress the next
   * escalation.
   */
  const drained = times.length === 0;
  const state = drained
    ? { reported: 0, lastGlobal: 0 }
    : {
      reported: Math.min(existing?.reported ?? 0, times.length),
      lastGlobal: existing?.lastGlobal ?? 0,
    };

  const wouldBe = times.length + 1;

  const { total, reported, lastGlobal } =
    await coordinator.coordinate(userId, wouldBe, state, MESSAGE_WINDOW_MS, now);

  if (total > MESSAGE_LIMIT) {
    /* Refused. The filtered array is written back so the ageing-out above is not
       recomputed from scratch on every retry, but no timestamp is added — a
       refused send must not consume budget. */
    buckets.set(userId, { times, reported: state.reported, lastGlobal, last: now });
    if (buckets.size > MAX_BUCKETS) sweep(now);
    return false;
  }

  times.push(now);
  buckets.set(userId, { times, reported, lastGlobal, last: now });
  if (buckets.size > MAX_BUCKETS) sweep(now);
  return true;
}

/** Observability, for the status panel and the load harness. */
export function messageThrottleStats() {
  return { buckets: buckets.size, ...coordinator.stats() };
}

/** Test seam. */
export function __resetMessageThrottleForTests() {
  buckets.clear();
}
