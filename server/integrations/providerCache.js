/**
 * A short-lived cache in front of every third-party read, with three properties
 * the Owner Center depends on.
 *
 * ── 1. A page render is not a burst of vendor requests ──
 *
 * Without this, every open of `/owner`, every refresh, and every duplicate tab
 * spends the provider's quota. Amplitude's Dashboard API is priced in a "cost
 * per hour" budget and Upstash's free plan is priced in commands per month, so
 * "how often does the page ask" is a real number in somebody's bill rather than
 * a performance detail. A minute of cache turns an owner watching a deploy from
 * a page-refresh loop into one request per provider per minute.
 *
 * ── 2. Two simultaneous readers make one request ──
 *
 * Deduplication is not an optimisation here. The refresh button and an
 * automatic revalidation can land in the same tick, and two in-flight requests
 * to the same endpoint is the shape that turns a rate limit into an outage.
 *
 * ── 3. A failure does not erase the last good answer ──
 *
 * If the provider fails and a previous success is still remembered, the
 * previous success is returned with `stale: true` and the reason it is stale.
 * The Owner Center labels it. A dashboard that empties itself the moment a
 * vendor hiccups tells the reader less than one that says "this is what it said
 * ninety seconds ago, and it has not answered since" — and it is the difference
 * between a card and a whole page going blank.
 *
 * Stale entries are kept well past their TTL for exactly that reason, and are
 * only ever SERVED stale when a fresh attempt has already failed.
 *
 * Process-local by design. There is one application process (see
 * `server/instanceLock.js`), the values are seconds old, and putting operator
 * dashboard reads through Redis would spend the command budget this cache
 * exists to protect.
 */

/** @typedef {{ value: any, fetchedAt: number, hardExpiresAt: number }} Entry */

/** @type {Map<string, Entry>} */
const entries = new Map();
/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();

/**
 * How long a remembered failure-free value may still be served after its TTL,
 * when a fresh attempt fails.
 *
 * Fifteen minutes rather than forever: past that the figure stops being
 * "slightly old" and starts being a claim about a service nobody has heard from
 * since, which is the state the reader most needs told plainly.
 */
export const STALE_CEILING_MS = 15 * 60 * 1000;

/**
 * Runs `producer` at most once per `ttlMs` per `key`.
 *
 * `producer` must resolve to a provider result (see providerResult.js) and must
 * not throw; a rejection is treated as an `unavailable` state rather than
 * propagated, because the caller is a route handler rendering a status page and
 * an exception there is a 500 on the page that exists to say what is broken.
 *
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<{state: string}>} producer
 * @param {{ fresh?: boolean }} [options] `fresh` skips a cache HIT (the refresh
 *   button) but still deduplicates and still falls back to stale on failure.
 * @returns {Promise<{state: string, fetchedAt: number, stale?: boolean}>}
 */
export async function cached(key, ttlMs, producer, { fresh = false } = {}) {
  const now = Date.now();
  const entry = entries.get(key);

  if (!fresh && entry && now - entry.fetchedAt < ttlMs) {
    return { ...entry.value, fetchedAt: entry.fetchedAt };
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const work = (async () => {
    let result;
    try {
      result = await producer();
    } catch {
      /* A producer that throws is a bug in a provider module, not a vendor
         outage — but the reader cannot act on the difference and the page must
         still render, so it is reported as the vendor being unreachable. The
         throw is not swallowed silently: it is what makes the card say so. */
      result = { state: 'unavailable' };
    }

    const at = Date.now();

    if (result.state === 'ok') {
      entries.set(key, { value: result, fetchedAt: at, hardExpiresAt: at + STALE_CEILING_MS });
      return { ...result, fetchedAt: at };
    }

    /**
     * `not_configured` never falls back.
     *
     * It is not a failure to read something; it is the answer that nothing is
     * set up. Serving a remembered success over it would mean an operator who
     * has just REMOVED a credential still sees live-looking figures, which is
     * the one direction a status page must never be wrong in.
     */
    const previous = entries.get(key);
    if (result.state !== 'not_configured' && previous && at < previous.hardExpiresAt) {
      return { ...previous.value, fetchedAt: previous.fetchedAt, stale: true, staleReason: result.state };
    }

    if (result.state === 'not_configured') entries.delete(key);
    return { ...result, fetchedAt: at };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, work);
  return work;
}

/** Test seam, and what a deployment-time credential change would want. */
export function __resetProviderCache() {
  entries.clear();
  inFlight.clear();
}
