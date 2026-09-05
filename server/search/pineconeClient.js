/**
 * The wire to Pinecone. Bounded, never throws, and never a reason a request
 * fails.
 *
 * ── Why this is a fetch client and not `@pinecone-database/pinecone` ──
 *
 * The same argument `telemetrySink.js` makes, and it lands the same way here.
 * The official SDK is a large dependency whose value is ergonomics — typed
 * builders over six HTTP endpoints — and ENGINEERING_GUIDE §3.2 treats an
 * unexplained lockfile diff as a supply-chain risk on an application holding
 * minors' data. What this integration actually needs from the transport is the
 * part an SDK does not give: a hard timeout, a failure that is *counted rather
 * than thrown*, and a guarantee that no Pinecone outage can turn into a 500 on
 * Discover. Wrapping a client to obtain those is more code than the six calls.
 *
 * What is NOT reimplemented: the endpoints, the request shapes, the API version
 * and the auth header are Pinecone's, used as documented. Every path below was
 * read from Pinecone's own API reference on 2026-08-26 rather than recalled:
 *
 *   POST {control}/indexes/create-for-model          provision
 *   GET  {control}/indexes/{name}                    describe → data-plane host
 *   POST {host}/records/namespaces/{ns}/upsert       upsert, ndjson, text embedded server-side
 *   POST {host}/records/namespaces/{ns}/search       query, text embedded server-side
 *   POST {host}/vectors/delete                       delete by id
 *   POST {host}/describe_index_stats                 record counts
 *   POST {control}/rerank                            standalone rerank
 *
 * ── The one rule ──
 *
 * Every function here returns `{ ok: true, ... }` or `{ ok: false, reason }`.
 * None of them throw, and none of them reject. A caller that forgets to check
 * `ok` gets a falsy result and an empty list, never an exception in the middle
 * of a request handler.
 */
import {
  PINECONE_API_VERSION, PINECONE_CONTROL_HOST, EMBED_MODEL, RERANK_MODEL,
  SEARCH_TIMEOUT_MS, INDEX_TIMEOUT_MS, pineconeConfig,
} from './pineconeConfig.js';

/**
 * Usage, accumulated for the life of the process.
 *
 * Pinecone reports `read_units`, `embed_total_tokens` and `rerank_units` on the
 * responses that consume them, which is the only honest way to answer "how much
 * of the free tier have we spent". Counting requests instead would be a guess:
 * a read unit is a measure of data scanned, not of calls made.
 */
const usage = {
  readUnits: 0,
  embedTokens: 0,
  rerankUnits: 0,
  searches: 0,
  upserts: 0,
  records: 0,
  deletes: 0,
  failures: 0,
  timeouts: 0,
};

export function pineconeUsage() {
  return { ...usage };
}

export function __resetPineconeUsage() {
  for (const key of Object.keys(usage)) usage[key] = 0;
}

/** Adds whatever Pinecone reported it charged us for. */
function accrue(body) {
  const u = body?.usage;
  if (!u) return;
  if (Number.isFinite(u.read_units)) usage.readUnits += u.read_units;
  if (Number.isFinite(u.embed_total_tokens)) usage.embedTokens += u.embed_total_tokens;
  if (Number.isFinite(u.rerank_units)) usage.rerankUnits += u.rerank_units;
}

/**
 * One HTTP request, with a deadline and no way to throw.
 *
 * Named `pineconeFetch` rather than `call`. `server/asyncShapes.test.js` builds
 * a regex from every async function name in the codebase to catch an un-awaited
 * async predicate inside `.filter()` — so an async function called `call` makes
 * every `Object.prototype.hasOwnProperty.call(` in the repository look like the
 * bug that guard exists to find. A generic name on an async function is a
 * hazard to everybody else's code, which the guard noticed immediately.
 *
 * `Api-Key` and `X-Pinecone-Api-Version` are Pinecone's header names. The key is
 * never logged: the error path below records the STATUS and the failure kind,
 * never the request, because a request carries the header that carries the key.
 */
async function pineconeFetch(url, { method = 'POST', body, contentType = 'application/json', timeoutMs }) {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Api-Key': cfg.apiKey,
        'X-Pinecone-Api-Version': PINECONE_API_VERSION,
        ...(body === undefined ? {} : { 'Content-Type': contentType }),
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* ndjson or empty */ }

    if (!res.ok) {
      usage.failures++;
      /* Status and Pinecone's own message field only. A response body from a
         vendor is not something to copy wholesale into this application's logs
         — and on a 4xx it can echo the request that produced it. */
      return {
        ok: false,
        reason: `http_${res.status}`,
        status: res.status,
        message: typeof parsed?.error?.message === 'string'
          ? parsed.error.message.slice(0, 200)
          : typeof parsed?.message === 'string' ? parsed.message.slice(0, 200) : null,
      };
    }

    accrue(parsed);
    return { ok: true, body: parsed };
  } catch (err) {
    usage.failures++;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    if (timedOut) usage.timeouts++;
    /* The error's NAME, never the error. A fetch failure can carry the request
       object, and the request carries the API key. */
    return { ok: false, reason: timedOut ? 'timeout' : `network_${err?.name || 'error'}` };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The read-path breaker
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Stops an outage from costing every search its full timeout.
 *
 * ── The problem ──
 *
 * `SEARCH_TIMEOUT_MS` is 1200 ms, and a search that cannot reach Pinecone waits
 * all of it before falling back to the lexical query — which is a complete
 * answer that was available immediately. So the failure mode of "the vendor is
 * unreachable" is not a broken Discover; it is a Discover that works and feels
 * broken, on every request, for as long as the outage lasts. Under load it is
 * worse than slow: a thousand requests each holding a socket for 1.2 seconds is
 * a thousand sockets.
 *
 * One timeout per cooldown window rather than one per request. The same shape
 * `redis/redisClient.js` uses, and for the same reason.
 *
 * ── What counts as a failure ──
 *
 * Only the answers that mean "this vendor is not answering right now":
 * timeouts, network errors, 5xx and 429. A 400 does not count — that is a
 * malformed filter or a bad query, it is this application's fault, and opening
 * the breaker on it would suppress every OTHER search because one of them was
 * wrong.
 *
 * ── Half-open, so recovery needs no timer ──
 *
 * After the cooldown the next call is allowed through as a probe. Success
 * closes the breaker; failure re-opens it for another cooldown. Nothing polls,
 * nothing schedules, and a process that is not searching does not discover the
 * recovery it does not need.
 *
 * ── Indexing is deliberately NOT guarded ──
 *
 * `upsertRecords` and `deleteRecords` are called by the drain worker, which
 * runs every fifteen seconds, keeps its queue in the database and retries with
 * a capped attempt count. Nobody is waiting on them. Short-circuiting them
 * would only delay the recovery they are already arranged to survive.
 */
const BREAKER_FAILURES = Number(process.env.PINECONE_BREAKER_FAILURES ?? 3);
const BREAKER_COOLDOWN_MS = Number(process.env.PINECONE_BREAKER_COOLDOWN_MS ?? 30_000);

const breaker = { failures: 0, openedAt: 0, probing: false, opens: 0, shortCircuited: 0 };

/** Is this failure the vendor being unavailable, rather than us being wrong? */
function isOutage(reason, status) {
  if (reason === 'timeout') return true;
  if (typeof reason === 'string' && reason.startsWith('network_')) return true;
  return Number(status) === 429 || Number(status) >= 500;
}

/** `null` when the call may proceed, or the refusal to return instead. */
function breakerVerdict() {
  if (!breaker.openedAt) return null;
  const elapsed = Date.now() - breaker.openedAt;
  if (elapsed < BREAKER_COOLDOWN_MS) {
    breaker.shortCircuited += 1;
    return { ok: false, reason: 'circuit_open' };
  }
  /* Half-open: one probe at a time, so a burst arriving exactly at the end of
     the cooldown does not become the thundering herd the breaker prevented. */
  if (breaker.probing) {
    breaker.shortCircuited += 1;
    return { ok: false, reason: 'circuit_open' };
  }
  breaker.probing = true;
  return null;
}

function breakerRecord(res) {
  if (res?.ok) {
    breaker.failures = 0;
    breaker.openedAt = 0;
    breaker.probing = false;
    return;
  }
  if (!isOutage(res?.reason, res?.status)) {
    /* Not the vendor's fault. A probe that fails this way neither closes nor
       re-opens the breaker; it simply releases the probe slot. */
    breaker.probing = false;
    return;
  }
  breaker.failures += 1;
  breaker.probing = false;
  if (breaker.failures >= BREAKER_FAILURES && !breaker.openedAt) {
    breaker.openedAt = Date.now();
    breaker.opens += 1;
  } else if (breaker.openedAt) {
    breaker.openedAt = Date.now();
  }
}

/** Runs a read-path call under the breaker. */
async function guarded(fn) {
  const refusal = breakerVerdict();
  if (refusal) return refusal;
  const res = await fn();
  breakerRecord(res);
  return res;
}

/** Breaker state for the operator status panel. */
export function pineconeBreakerState() {
  return {
    open: Boolean(breaker.openedAt) && Date.now() - breaker.openedAt < BREAKER_COOLDOWN_MS,
    failures: breaker.failures,
    opens: breaker.opens,
    shortCircuited: breaker.shortCircuited,
    cooldownMs: BREAKER_COOLDOWN_MS,
  };
}

export function __resetPineconeBreaker() {
  breaker.failures = 0;
  breaker.openedAt = 0;
  breaker.probing = false;
  breaker.opens = 0;
  breaker.shortCircuited = 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Control plane
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The data-plane host for the configured index, resolved once.
 *
 * Pinecone gives each index its own host and the control plane is the only
 * place that knows it. Resolving it lazily (rather than requiring it in the
 * environment) means a correct `.env` is one variable, not two — but the
 * variable is still honoured, because one fewer control-plane call at boot is
 * worth having.
 */
let resolvedHost = null;

/**
 * Normalises a host into a base URL.
 *
 * Pinecone reports a bare hostname (`idx-abc123.svc.aped-1.pinecone.io`), which
 * is always https. A CONFIGURED host may carry its own scheme, and `http://` is
 * honoured outside production so that a test can point the client at a loopback
 * stub and exercise the real request path rather than a mocked `fetch`.
 *
 * Plain HTTP is refused in production for the reason `telemetrySink.js` refuses
 * it: the request carries an API key in a header, and sending that in clear over
 * the public internet would undo the point of keeping it out of the bundle.
 */
function toBaseUrl(host) {
  const raw = String(host ?? '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//.test(raw)) return `https://${raw}`;
  if (raw.startsWith('http://') && process.env.NODE_ENV === 'production') return null;
  return raw.replace(/\/+$/, '');
}

/** The data-plane base URL, resolved once. */
export async function indexHost() {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return null;
  if (cfg.host) return toBaseUrl(cfg.host);
  if (resolvedHost) return resolvedHost;

  const res = await pineconeFetch(`${PINECONE_CONTROL_HOST}/indexes/${encodeURIComponent(cfg.indexName)}`, {
    method: 'GET',
    timeoutMs: INDEX_TIMEOUT_MS,
  });
  if (!res.ok || !res.body?.host) return null;

  resolvedHost = toBaseUrl(res.body.host);
  return resolvedHost;
}

/** Describes the index — used by the CLI to report readiness and dimensions. */
export async function describeIndex() {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  return pineconeFetch(`${PINECONE_CONTROL_HOST}/indexes/${encodeURIComponent(cfg.indexName)}`, {
    method: 'GET',
    timeoutMs: INDEX_TIMEOUT_MS,
  });
}

/**
 * Creates the index, with Pinecone doing the embedding.
 *
 * ── Why integrated inference rather than embedding here ──
 *
 * `create-for-model` binds an embedding model to the index, so records are
 * upserted as TEXT and Pinecone embeds them — including the asymmetry between a
 * stored passage and a search query, which the model was trained with and which
 * is easy to get subtly wrong by hand. It also means this application never
 * holds a vector, never has to version a vector encoder, and cannot drift
 * between what it embedded at write time and what it embeds at read time.
 *
 * Provisioning is NOT done at boot. It is an explicit CLI action
 * (`bin/pinecone-index.mjs setup`), because an application that creates
 * infrastructure on startup creates it from every environment that happens to
 * hold a key — including a developer laptop pointed at production.
 */
export async function createIndexForModel({ fieldMapText = 'text' } = {}) {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };

  return pineconeFetch(`${PINECONE_CONTROL_HOST}/indexes/create-for-model`, {
    body: JSON.stringify({
      name: cfg.indexName,
      cloud: cfg.cloud,
      region: cfg.region,
      embed: {
        model: EMBED_MODEL,
        metric: 'cosine',
        field_map: { text: fieldMapText },
      },
    }),
    timeoutMs: 60000,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Data plane
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Upserts records as newline-delimited JSON.
 *
 * The integrated upsert endpoint takes ndjson, one record per line, each with an
 * `_id` and the text field named in the index's `field_map`. The caller is
 * responsible for batching to the documented ceiling — see `UPSERT_BATCH_SIZE`,
 * which exists because an upsert carrying text is capped far lower than one
 * carrying vectors.
 */
export async function upsertRecords(records) {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!Array.isArray(records) || records.length === 0) return { ok: true, count: 0 };

  const base = await indexHost();
  if (!base) return { ok: false, reason: 'no_host' };

  const ndjson = records.map((r) => JSON.stringify(r)).join('\n');
  const res = await pineconeFetch(
    `${base}/records/namespaces/${encodeURIComponent(cfg.namespace)}/upsert`,
    { body: ndjson, contentType: 'application/x-ndjson', timeoutMs: INDEX_TIMEOUT_MS },
  );

  if (res.ok) {
    usage.upserts++;
    usage.records += records.length;
  }
  return res.ok ? { ok: true, count: records.length } : res;
}

/**
 * Semantic search. Returns hits, or an empty list and a reason.
 *
 * `filter` is Pinecone's metadata filter and is an OPTIMISATION here, never a
 * security control — it narrows the candidates so the top-K is not spent on
 * events nobody can act on. Everything that decides what a person may SEE is
 * applied afterwards by the database. See `discoverSearch.js`.
 */
export async function searchRecords({ text, topK, filter = null, fields = ['_id'] }) {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled', hits: [] };

  const base = await indexHost();
  if (!base) return { ok: false, reason: 'no_host', hits: [] };

  const query = { inputs: { text }, top_k: topK };
  if (filter && Object.keys(filter).length) query.filter = filter;

  const res = await guarded(() => pineconeFetch(
    `${base}/records/namespaces/${encodeURIComponent(cfg.namespace)}/search`,
    { body: JSON.stringify({ query, fields }), timeoutMs: SEARCH_TIMEOUT_MS },
  ));
  if (!res.ok) return { ...res, hits: [] };

  usage.searches++;
  const hits = Array.isArray(res.body?.result?.hits) ? res.body.result.hits : [];
  return {
    ok: true,
    hits: hits.map((h) => ({
      id: String(h?._id ?? ''),
      score: Number(h?._score ?? 0),
      fields: h?.fields ?? {},
    })).filter((h) => h.id),
  };
}

/**
 * Searches using a record ALREADY IN THE INDEX as the query.
 *
 * ── Why this is the one Pinecone feature worth adding ──
 *
 * The stored vector is reused as the query, so this costs **no embedding
 * tokens at all** — the expensive half of a semantic search was already paid
 * for when the event was indexed. It is the only capability found in the
 * exploration that makes the corpus more useful without making it more
 * expensive: no second index, no new namespace, no per-user vectors, no extra
 * metadata, and nothing new sent to the vendor beyond an event id this
 * application already owns.
 *
 * Documented on the integrated-embedding search endpoint as `query.id`
 * (Pinecone API 2026-04, read 2026-08-28). It is supported only for indexes
 * with integrated embedding, which is what `create-index-for-model` built.
 *
 * Charged in read units like any query. It runs on demand — a student opening
 * one event — never on a timer and never during a browse.
 */
export async function searchByRecordId({ recordId, topK, filter = null, fields = ['_id'] }) {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled', hits: [] };
  if (!recordId) return { ok: false, reason: 'no_record_id', hits: [] };

  const base = await indexHost();
  if (!base) return { ok: false, reason: 'no_host', hits: [] };

  const query = { id: recordId, top_k: topK };
  if (filter && Object.keys(filter).length) query.filter = filter;

  const res = await guarded(() => pineconeFetch(
    `${base}/records/namespaces/${encodeURIComponent(cfg.namespace)}/search`,
    { body: JSON.stringify({ query, fields }), timeoutMs: SEARCH_TIMEOUT_MS },
  ));
  if (!res.ok) return { ...res, hits: [] };

  usage.searches++;
  const hits = Array.isArray(res.body?.result?.hits) ? res.body.result.hits : [];
  return {
    ok: true,
    hits: hits.map((h) => ({
      id: String(h?._id ?? ''),
      score: Number(h?._score ?? 0),
    })).filter((h) => h.id),
  };
}

/** Removes records by id. Used when an event stops being searchable. */
export async function deleteRecords(ids) {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, count: 0 };

  const base = await indexHost();
  if (!base) return { ok: false, reason: 'no_host' };

  const res = await pineconeFetch(`${base}/vectors/delete`, {
    body: JSON.stringify({ ids, namespace: cfg.namespace }),
    timeoutMs: INDEX_TIMEOUT_MS,
  });
  if (res.ok) usage.deletes += ids.length;
  return res.ok ? { ok: true, count: ids.length } : res;
}

/** Record counts per namespace — the CLI's `stats`, and the reconciler's total. */
export async function indexStats() {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };

  const base = await indexHost();
  if (!base) return { ok: false, reason: 'no_host' };

  return pineconeFetch(`${base}/describe_index_stats`, {
    body: JSON.stringify({}),
    timeoutMs: INDEX_TIMEOUT_MS,
  });
}

/**
 * Reranks documents against a query. Expensive in the only currency that
 * matters here — see `RERANK_MONTHLY_BUDGET`. The budget is enforced by the
 * caller, not here, so that this stays a transport.
 */
export async function rerank({ query, documents, topN, rankField = 'text' }) {
  const cfg = pineconeConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!Array.isArray(documents) || documents.length === 0) return { ok: true, results: [] };

  const res = await guarded(() => pineconeFetch(`${PINECONE_CONTROL_HOST}/rerank`, {
    body: JSON.stringify({
      model: RERANK_MODEL,
      query,
      documents,
      top_n: Math.min(topN, documents.length),
      rank_fields: [rankField],
      return_documents: false,
    }),
    timeoutMs: SEARCH_TIMEOUT_MS,
  }));
  if (!res.ok) return res;

  const data = Array.isArray(res.body?.data) ? res.body.data : [];
  return {
    ok: true,
    results: data
      .map((d) => ({ index: Number(d?.index), score: Number(d?.score ?? 0) }))
      .filter((d) => Number.isInteger(d.index)),
  };
}

/** Test seam: the resolved host must not leak between cases. */
export function __resetPineconeClient() {
  resolvedHost = null;
  __resetPineconeUsage();
}
