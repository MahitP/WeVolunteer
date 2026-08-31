/**
 * An application-wide reservation against a third party's usage policy.
 *
 * ── The obligation this serves ──
 *
 * Nominatim's usage policy caps this APPLICATION at one request per second in
 * total — not one per client, not one per process. `routes/geocodeRoutes.js`
 * implements that with a module-level timestamp, which is exactly right for one
 * process and quietly wrong twice: it resets on restart, so a deploy releases a
 * burst, and it is per-process, so a second instance would double the rate
 * against a limit that is not per-process.
 *
 * The consequence of getting it wrong is not a 500. It is OSM blocking this
 * application's User-Agent, which removes address lookup for every school at
 * once and is slow to reverse. That asymmetry is why this exists and why every
 * decision below errs toward waiting rather than proceeding.
 *
 * ── Why a reservation and not a lock ──
 *
 * The same reasoning `geocodeRoutes.js` records for its local version. A lock
 * queues without bound: the two-hundredth caller waits two hundred seconds for
 * a browser tab that closed three minutes ago. A reservation lets the caller
 * ask "how long would I wait?" and refuse before waiting, which is a shape the
 * route already returns a 429 for.
 *
 * ── Why this composes with the local reservation rather than replacing it ──
 *
 * Without Redis there must still be a throttle, and the local one is it. So the
 * route takes both and waits the longer. Replacing the local one would make an
 * Upstash outage into an unthrottled path to somebody else's server, which is
 * the one failure mode this must not have.
 */
import { redisEval } from './redisClient.js';
import { redisEnabled, keyPrefix } from './redisConfig.js';

/**
 * Read the current reservation, move it forward, and report the wait — in one
 * atomic step.
 *
 * A pipeline of GET-then-SET cannot do this: two callers arriving together both
 * read the same timestamp and both believe they may go now, which is precisely
 * the double-rate this exists to prevent. The whole value of the shared
 * reservation is the atomicity, so it is a script.
 *
 * Returns the milliseconds to wait, or -1 to mean "the queue is already deeper
 * than a caller should be asked to sit through". A refusal reserves nothing, so
 * refusing does not push the queue out further for everybody behind it.
 *
 * The key carries a TTL of one interval beyond the slot it hands out, so a
 * throttle that stops being used cannot leave a key behind — the 256 MB plan
 * has no room for keys that only ever accumulate.
 *
 * Costs EVAL + GET + SET (three commands), and only on a cache MISS, which
 * after the two cache tiers in front of it is rare.
 */
const RESERVE_SCRIPT = [
  "local now = tonumber(ARGV[1])",
  "local interval = tonumber(ARGV[2])",
  "local maxWait = tonumber(ARGV[3])",
  "local nextAt = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "local slot = now",
  "if nextAt > now then slot = nextAt end",
  "if slot - now > maxWait then return -1 end",
  "redis.call('SET', KEYS[1], slot + interval, 'PX', interval * 2 + 1000)",
  "return slot - now",
].join(' ');

const RESERVE_COST = 3;

/**
 * Claims the next shared slot for one upstream.
 *
 * @param {object} opts
 * @param {string} opts.name the upstream, e.g. 'nominatim'
 * @param {number} opts.intervalMs minimum spacing the policy requires
 * @param {number} opts.maxWaitMs longest a caller should be asked to wait
 * @returns {Promise<number|null>} milliseconds to wait, or `null` to refuse
 *
 * ── What happens when Redis is unavailable ──
 *
 * Returns 0, meaning "the shared reservation adds nothing". That is fail-OPEN,
 * and it is safe only because the caller is also holding a local reservation
 * that has already granted: the guarantee degrades from
 * application-wide-across-instances back to per-process, which is precisely the
 * guarantee that exists today. Returning `null` instead would take address
 * lookup down for everybody whenever Upstash had a bad minute, which is a worse
 * trade than a briefly per-process rate on a single-instance deployment.
 */
export async function reserveSharedUpstreamSlot({ name, intervalMs, maxWaitMs }) {
  if (!redisEnabled()) return 0;

  const res = await redisEval(
    RESERVE_SCRIPT,
    [`${keyPrefix()}throttle:${name}`],
    [String(Date.now()), String(intervalMs), String(maxWaitMs)],
    RESERVE_COST
  );

  if (!res.ok || typeof res.result !== 'number') return 0;
  if (res.result < 0) return null;

  /* Bounded defensively. A clock skew between this host and Redis could in
     principle produce a wait longer than the caller agreed to sit through, and
     the caller's contract is that it never waits more than maxWaitMs. */
  return Math.min(res.result, maxWaitMs);
}
