/**
 * Whether this process may talk to Pinecone, where, and under what budget.
 *
 * ── The free tier is the architecture, not a footnote ──
 *
 * Every number below was read from Pinecone's own documentation on 2026-08-26
 * (via the Pinecone MCP documentation search) for the **Starter** plan, which is
 * the plan this integration is designed to live inside permanently:
 *
 *   serverless indexes per project      5
 *   index storage per org               2 GB
 *   namespaces per serverless index     100
 *   read units per month per org        1,000,000
 *   write units per month per org       2,000,000
 *   embedding tokens per month/model    5,000,000
 *   rerank requests per month/model     500   ← the binding constraint
 *   inference requests                  100/s, 2000/min
 *   filterable metadata per record      40 KB
 *   record id length                    512 characters
 *   upsert batch with text              96 records
 *   region                              Starter indexes MUST be us-east-1
 *
 * Two of those shaped the design more than the rest:
 *
 * **500 reranks per month** is about sixteen a day. A reranker in the default
 * search path would exhaust the month in an afternoon of ordinary use by one
 * class, and then fail — so reranking here is off by default, budgeted, and
 * counted (see `RERANK_MONTHLY_BUDGET`).
 *
 * **2 GB and 5 indexes** are generous for this shape of data. A district with
 * 50,000 events is roughly 50,000 records; at llama-text-embed-v2's 1024
 * dimensions that is well inside the storage limit, and it is why a single
 * index with per-environment namespaces was chosen over an index per
 * environment.
 *
 * If Pinecone changes these, this file is the one place to change, and
 * `docs/operations/pinecone.md` records the date they were read.
 */

/**
 * The API version this integration is written against.
 *
 * Pinecone versions its API by date and serves several at once. Pinning is
 * deliberate: an unpinned client silently follows breaking changes, and the
 * failure would appear as Discover quietly losing its semantic half.
 */
export const PINECONE_API_VERSION = '2026-04';

/** Control plane. Index creation and description live here, not on the index host. */
export const PINECONE_CONTROL_HOST = 'https://api.pinecone.io';

/**
 * The embedding model, and why this one.
 *
 * `llama-text-embed-v2` is Pinecone's dense retrieval model for longer passages
 * and structured documents, which is exactly what an event is: a title, a
 * category, a handful of tags and one or two paragraphs an organizer wrote.
 *
 * The alternative considered was `multilingual-e5-large`, which is the better
 * choice for messy multilingual corpora. It was not chosen because WeVolunteer
 * has no internationalisation layer — every string in `src/` is English, and
 * organizer-written event copy is English in the pilot district. **If that
 * changes, changing this constant is not enough**: a different model means
 * different vectors, so it means a new index version. See `INDEX_VERSION`.
 */
export const EMBED_MODEL = 'llama-text-embed-v2';

/**
 * The reranker, used rarely and on purpose.
 *
 * `cohere-rerank-3.5` is not available on Starter at all. Of the two that are,
 * `bge-reranker-v2-m3` is the multilingual one and `pinecone-rerank-v0` is
 * Pinecone's own; both are capped at 500 requests per month. `bge-reranker-v2-m3`
 * is chosen because its 1-2 paragraph passage profile matches an event
 * description, and because it is the one model whose allowance survives a plan
 * upgrade to Builder — `pinecone-rerank-v0` is *not available* on Builder, so
 * choosing it would make the paid plan a downgrade for this feature.
 */
export const RERANK_MODEL = 'bge-reranker-v2-m3';

/**
 * How many reranks this deployment will spend in a calendar month.
 *
 * Set below the plan's 500 so that hitting our ceiling is a log line rather than
 * a Pinecone 429 in front of a student. The counter that enforces it is
 * persisted, because an in-memory count resets on every deploy and a budget that
 * resets is not a budget.
 */
export const RERANK_MONTHLY_BUDGET = Number(process.env.PINECONE_RERANK_BUDGET ?? 400);

/**
 * The index name carries its schema version.
 *
 * ── Why the version is in the NAME ──
 *
 * Three things invalidate every vector in an index: changing the embedding
 * model, changing the text that gets embedded, and changing dimensionality.
 * None of them can be applied in place — the old vectors stay, they are simply
 * wrong, and the failure mode is silent: search still returns results, they are
 * just subtly worse for the half of the corpus that was never re-embedded.
 *
 * A version in the name makes that impossible to do by accident. Bumping it
 * points the application at an index that does not exist yet, which fails loudly
 * at setup time and is fixed by running the backfill — while the old index keeps
 * serving until the new one is ready, and can then be deleted to reclaim its
 * share of the 5-index allowance.
 */
export const INDEX_VERSION = 'v1';

/**
 * The version stamped on every stored record, and compared on read.
 *
 * Separate from `INDEX_VERSION` because they answer different questions. The
 * index version says "these vectors were built by a different model and cannot
 * be compared". The document version says "these vectors are comparable, but the
 * text we chose to embed has changed, so they should be refreshed" — a change
 * that can be rolled out gradually through the ordinary sync rather than by
 * standing up a second index.
 */
export const DOCUMENT_VERSION = 1;

/**
 * Timeouts. Short, because Discover must answer with or without Pinecone.
 *
 * The search budget is the one a student feels. `GET /api/events` was measured
 * at 11ms for 1,000 events and 113ms for 10,000 (see the events endpoint's own
 * notes), so a 1.2s ceiling on the semantic half means the worst case is roughly
 * "the page took a second longer", never "the page did not load". The fallback
 * below that timeout is the existing SQL search, which is a complete answer on
 * its own rather than a degraded one.
 */
export const SEARCH_TIMEOUT_MS = Number(process.env.PINECONE_SEARCH_TIMEOUT_MS ?? 1200);

/** Indexing runs off the request path, so it can afford to wait longer. */
export const INDEX_TIMEOUT_MS = Number(process.env.PINECONE_INDEX_TIMEOUT_MS ?? 10000);

/**
 * Records per upsert request.
 *
 * Pinecone's documented ceiling for an upsert carrying TEXT (rather than
 * pre-computed vectors) is 96 records, because the server embeds each one. 90
 * leaves headroom rather than sitting on the limit.
 */
export const UPSERT_BATCH_SIZE = 90;

/**
 * How many candidates the semantic half proposes.
 *
 * Larger is not better here. Every candidate is an id that the authoritative SQL
 * query then has to hydrate and re-check, and read units are charged by the
 * amount of data scanned. 60 is roughly three screens of results, which is more
 * than enough for fusion to have something to work with after the database has
 * removed the candidates the caller may not see.
 */
export const SEARCH_TOP_K = Number(process.env.PINECONE_TOP_K ?? 60);

/**
 * The similarity a candidate must reach before it is considered a match at all.
 *
 * ── The defect this exists for ──
 *
 * A vector index always returns the K NEAREST records. It has no concept of
 * "nothing matched" — ask it about gibberish and it hands back the least
 * dissimilar events it has, with low scores it does not otherwise complain
 * about. Because the read path is
 *
 *     (title/description/... LIKE @q  OR  e.id IN (candidates))
 *
 * those low-scoring candidates satisfied the predicate on their own, so a search
 * for something the corpus does not contain returned the ENTIRE corpus. That is
 * worse than an empty result: it reads as a search that ignored the question.
 *
 * The stub could not reveal it — a stub returns exactly the hits the test names.
 * It showed up on the first live query against the real service.
 *
 * ── Why 0.15 ──
 *
 * Measured against the live index (llama-text-embed-v2, cosine, 16 events,
 * 2026-08-28), top-1 scores were:
 *
 *     relevant queries    0.2585 – 0.5057   (worst: "families who cannot
 *                                            afford groceries")
 *     nonsense / off-topic 0.0124 – 0.1058  (best:  "zzzqqxnonexistenttopicxyz")
 *
 * 0.15 sits in that gap with roughly 40% headroom below and 70% above. It also
 * trims the tail of genuinely relevant queries, whose tenth hit scores around
 * 0.01 — those were never matches, and dropping them makes the result better
 * rather than smaller.
 *
 * Configurable because it is a measurement, not a law: a different corpus or a
 * different embedding model moves it, and an operator who changes either should
 * re-measure rather than inherit this number on faith.
 */
export const MIN_SEMANTIC_SCORE = Number(process.env.PINECONE_MIN_SCORE ?? 0.15);

/**
 * Whether the integration is switched on at all.
 *
 * Off unless a key AND an index name are present, and off in tests unless a test
 * asks for it by name — the same gate `telemetrySink.js` uses, for the same
 * reason: a suite that talks to a real vendor spends somebody's quota silently
 * and, here, would write fixture events into a production index.
 */
export function resolvePineconeConfig(env = process.env) {
  if (env.VITEST && env.WEV_PINECONE_TEST_SINK !== '1') {
    return { enabled: false, reason: 'test_environment' };
  }

  const apiKey = String(env.PINECONE_API_KEY || '').trim();
  if (!apiKey) return { enabled: false, reason: 'not_configured' };

  /**
   * The namespace separates deployments inside ONE index.
   *
   * Starter allows 5 indexes and 100 namespaces per index, so namespaces are the
   * abundant resource and indexes are the scarce one. Keying the namespace on
   * the environment means development, staging and production share an index
   * without ever seeing each other's records, and the index allowance stays free
   * for the version bumps described above.
   *
   * It defaults to `NODE_ENV`, so a developer who sets only `PINECONE_API_KEY`
   * cannot accidentally write test events into the production namespace.
   */
  const namespace = String(
    env.PINECONE_NAMESPACE || env.NODE_ENV || 'development',
  ).trim().slice(0, 64);

  const indexName = String(
    env.PINECONE_INDEX || `wevolunteer-discover-${INDEX_VERSION}`,
  ).trim();

  /**
   * The index host, if it is already known.
   *
   * Pinecone's data plane lives on a per-index host that the control plane
   * reports. Caching it in the environment removes one control-plane round trip
   * per process start; leaving it out is also fine — the client resolves it once
   * and remembers it.
   */
  const host = String(env.PINECONE_INDEX_HOST || '').trim() || null;

  return {
    enabled: true,
    apiKey,
    indexName,
    namespace,
    host,
    /* Starter indexes must be us-east-1; overriding this on Starter fails at
       creation time with a plan error rather than silently working. */
    cloud: String(env.PINECONE_CLOUD || 'aws').trim(),
    region: String(env.PINECONE_REGION || 'us-east-1').trim(),
    /**
     * Reranking is OPT-IN even when Pinecone is configured.
     *
     * 500 requests a month is not a feature you leave on. It is enabled
     * deliberately, for a deployment that has measured its search volume and
     * decided the budget is worth spending.
     */
    rerankEnabled: env.PINECONE_RERANK === '1' || env.PINECONE_RERANK === 'true',
  };
}

let cached = null;

/** Resolved once per process, unless a test resets it. */
export function pineconeConfig() {
  if (cached === null) cached = resolvePineconeConfig();
  return cached;
}

export function pineconeEnabled() {
  return pineconeConfig().enabled === true;
}

/** Why it is off, for the boot line an operator reads. */
export function pineconeStatus() {
  const c = pineconeConfig();
  return c.enabled
    ? { enabled: true, index: c.indexName, namespace: c.namespace, model: EMBED_MODEL }
    : { enabled: false, reason: c.reason };
}

/** Test seam. */
export function __resetPineconeConfig() {
  cached = null;
}
