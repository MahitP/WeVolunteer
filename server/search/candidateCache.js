/**
 * A short-lived, in-process memo of "which event ids did the vector index
 * propose for this question", and the single-flight that stops two identical
 * questions being asked twice at once.
 *
 * ── Why this is worth having ──
 *
 * A Discover search costs one HTTPS round trip to Pinecone before the database
 * is touched at all, and the same round trip is spent again for:
 *
 *   · **page 2.** Pagination re-runs the whole request, and the candidate list
 *     for a query does not change between its pages.
 *   · **the same search from a second student.** A class told to "look for the
 *     food pantry shifts" produces thirty identical queries in a minute.
 *   · **a client that fires twice.** A double-submit, a StrictMode double
 *     effect, a retry after a slow response.
 *
 * None of those are pathological; they are the normal shape of a search box.
 * Sixty seconds of memory turns them into one vendor call.
 *
 * ── Why in-process only, with no Redis tier ──
 *
 * `redis/lookupCache.js` exists for exactly this shape and is deliberately not
 * used here. Its L2 is worth having when the upstream costs hundreds of
 * milliseconds and Redis costs tens — the weather and geocode case. Pinecone is
 * not that upstream: a warm Upstash round trip was measured at 222 ms
 * (`docs/operations/upstash.md`) and a Pinecone search at roughly the same, so
 * an L2 lookup would spend a command to save nothing and would be on the
 * critical path of every search either way.
 *
 * The consequence is honest and small: a restart empties this, and a second
 * instance would keep its own. Both cost a vendor call, never a wrong answer.
 *
 * ── Why caching CANDIDATE IDS is safe when caching results would not be ──
 *
 * What is stored is the answer to "what does the corpus contain that is like
 * these words" — a function of the query and the metadata filter alone. It is
 * not a result set, not scoped to a viewer, and not an authorization decision.
 * Every id returned from here goes back through `buildEventWhere` with the
 * caller's own filters and the caller's own identity, exactly as an uncached id
 * does, so two students sharing a cache entry cannot see each other's rows.
 *
 * Caching the RESULTS would be the opposite of that and is not done anywhere:
 * the rows a search returns depend on who is asking, and an invalidation rule
 * that has to track capability grants, organization membership, bans and event
 * visibility is a permission model with a second implementation.
 *
 * ── Staleness has one direction ──
 *
 * An entry can only be missing an event that was indexed in the last minute. It
 * cannot show a cancelled, filled, deleted or hidden event, because none of
 * those facts come from here — the database applies all of them afterwards. The
 * lexical half of the search is never cached at all, so a brand-new event whose
 * title matches what was typed is found immediately regardless.
 *
 * ── The key never holds the query ──
 *
 * A search box on a school platform is free text typed by a minor. The key is a
 * SHA-256 of the question, so the entries this process holds are not a readable
 * list of what the district searched for, and a heap dump is not a transcript.
 */
import { createHash } from 'node:crypto';

/**
 * How long a candidate list stays good.
 *
 * Zero — or anything below it — turns the memo off entirely. The single-flight
 * below stays on regardless: coalescing two identical requests that are in the
 * air at the same moment is not caching, it is not asking the same question
 * twice, and there is no staleness in it to switch off.
 */
const TTL_MS = Number(process.env.PINECONE_CANDIDATE_TTL_MS ?? 60_000);
const MEMO_ENABLED = Number.isFinite(TTL_MS) && TTL_MS > 0;

/**
 * The entry ceiling.
 *
 * Five hundred distinct searches inside one TTL window is far past what a
 * district produces, and the entries are small — a few dozen ids each — so the
 * bound is about never growing without limit rather than about this being
 * large. Eviction is insertion-ordered, like `lookupCache`'s L1 and for the
 * same reason: a read that refreshed recency would make the common case a
 * write.
 */
const MAX_ENTRIES = Number(process.env.PINECONE_CANDIDATE_MAX ?? 500);

const entries = new Map();
const inFlight = new Map();
const stats = { hits: 0, misses: 0, coalesced: 0, stored: 0, evicted: 0 };

/** The cache key: everything that changes the answer, and nothing readable. */
export function candidateKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function read(key) {
  if (!MEMO_ENABLED) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) { entries.delete(key); return null; }
  return entry.value;
}

/**
 * Stored and returned as COPIES of the id list.
 *
 * The caller puts this list on `filters.semanticIds`, from where it reaches a
 * sort builder, a parameter binder and a fusion function. None of them mutates
 * it today. Handing out the cache's own array would make that a property this
 * module depends on and cannot see — the kind of coupling that survives every
 * test until somebody adds a `.sort()` and two unrelated searches start
 * answering each other's questions.
 */
const copied = (value) => (Array.isArray(value?.ids) ? { ...value, ids: [...value.ids] } : value);

function write(key, value) {
  if (!MEMO_ENABLED) return;
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    entries.delete(oldest);
    stats.evicted += 1;
  }
  entries.set(key, { value: copied(value), at: Date.now() });
  stats.stored += 1;
}

/**
 * The cached candidate list, or the loader's answer — computed at most once per
 * key at a time.
 *
 * ── What is and is not stored ──
 *
 * Only a successful answer. A failure is the vendor being unavailable, and
 * remembering that for a minute would turn one bad second into a bad minute;
 * the breaker in `pineconeClient.js` is what keeps an outage from costing every
 * search its timeout, and it can distinguish "down" from "this one call went
 * wrong" in a way a cache cannot. An empty-but-successful answer IS stored: "the
 * corpus has nothing like this" is a real answer and a common one.
 *
 * ── Single-flight ──
 *
 * Thirty students searching the same words in the same second produce thirty
 * cache misses before any of them produces an entry, so the cache alone would
 * not stop the burst it exists to stop. Callers that arrive while a key is in
 * flight await the same promise. The map entry is removed in `finally`, so a
 * rejected loader cannot wedge a key permanently — though the loaders here do
 * not reject, by their own contract.
 *
 * @param {string} key from `candidateKey`
 * @param {() => Promise<{ok: boolean}>} loader
 */
export async function withCandidateCache(key, loader) {
  const hit = read(key);
  if (hit) { stats.hits += 1; return { ...copied(hit), cached: true }; }

  const pending = inFlight.get(key);
  if (pending) { stats.coalesced += 1; return { ...copied(await pending), coalesced: true }; }

  stats.misses += 1;
  const promise = (async () => {
    const result = await loader();
    if (result?.ok) write(key, result);
    return result;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** Counters for the operator status panel. No keys, no ids, no query text. */
export function candidateCacheStats() {
  const total = stats.hits + stats.misses + stats.coalesced;
  return {
    ...stats,
    size: entries.size,
    inFlight: inFlight.size,
    ttlMs: MEMO_ENABLED ? TTL_MS : 0,
    memo: MEMO_ENABLED,
    hitRate: total ? Math.round(((stats.hits + stats.coalesced) / total) * 100) : 0,
  };
}

/** Test seam. */
export function __resetCandidateCache() {
  entries.clear();
  inFlight.clear();
  for (const key of Object.keys(stats)) stats[key] = 0;
}
