/**
 * The semantic half of Discover: turning "something outdoors with animals" into
 * a list of event ids, and never into a decision about what anybody may see.
 *
 * ── Where this sits, and the one rule ──
 *
 *   the query           →  Pinecone  →  candidate event ids
 *   the candidate ids   →  the EXISTING SQL query, unchanged
 *   the SQL query       →  rows, filters, pagination, serialisation
 *
 * Pinecone proposes; the database disposes. Every candidate id is fed back into
 * `buildEventWhere` alongside every filter the caller asked for, so an event
 * that has been cancelled, filled, re-dated or deleted since it was indexed is
 * removed by the same predicates that have always removed it. **No fact from
 * Pinecone is ever displayed.** The metadata in the index exists to make the
 * top-K worth having, not to answer questions — a status in a vector database is
 * a memory of a status.
 *
 * That is also why this module returns ids and ranks rather than events. It has
 * no way to know whether an id should be shown to the person asking, and it is
 * deliberately not given one: the moment this file starts reasoning about
 * audiences or bans, the permission model has two implementations.
 *
 * ── Failure is a normal outcome ──
 *
 * Every function resolves, and an outage returns `{ ok: false, ids: [] }`. The
 * caller then runs exactly the query it ran before this integration existed —
 * which is a complete answer, not a degraded one. Discover with no Pinecone is
 * WeVolunteer as it shipped for a year.
 */
import { searchRecords, rerank } from './pineconeClient.js';
import {
  pineconeEnabled, pineconeConfig, SEARCH_TOP_K, RERANK_MONTHLY_BUDGET,
} from './pineconeConfig.js';
import { eventIdFromVectorId, TEXT_FIELD } from './eventDocument.js';
import { logEvent } from './../telemetry.js';
import { withSpan } from '../observability/spans.js';

/**
 * Below this, a query is a prefix rather than a meaning.
 *
 * "ch" is somebody two keystrokes into "chess", and a semantic search for it
 * returns confident nonsense — the model will happily find the events most like
 * the concept "ch". The existing substring search handles prefixes correctly and
 * cheaply, so short queries simply stay on it.
 */
const MIN_SEMANTIC_LENGTH = 3;

/**
 * Above this, it is not a search box entry, and the 200-character cap in
 * `parseEventFilters` has already truncated it anyway.
 */
const MAX_SEMANTIC_LENGTH = 200;

/**
 * Is this query worth spending a Pinecone read on?
 *
 * ── Why some queries deliberately skip the vendor ──
 *
 * Not every search benefits, and every search costs. Read units are metered
 * monthly, so a query that semantic search cannot improve should not be sent:
 *
 *   · **Nothing typed.** Browsing is a filter, not a question. This is the most
 *     common state of the page and it must cost nothing.
 *   · **A `@handle` or `#tag`.** BrowseEvents routes these to the directory and
 *     to the tag facet respectively — they are exact lookups with an exact
 *     answer, and the opportunity query is skipped entirely for `@`.
 *   · **Too short.** See `MIN_SEMANTIC_LENGTH`.
 *   · **Quoted.** `"Chess Club"` is a user asking for those words in that order.
 *     Honouring the quotes means staying lexical.
 */
export function shouldUseSemantic(query, { sigil = null } = {}) {
  if (!pineconeEnabled()) return false;
  const q = String(query ?? '').trim();
  if (q.length < MIN_SEMANTIC_LENGTH || q.length > MAX_SEMANTIC_LENGTH) return false;
  if (sigil === 'handle' || sigil === 'tag') return false;
  if (q.startsWith('@') || q.startsWith('#')) return false;
  if (/^".*"$/.test(q)) return false;
  return true;
}

/**
 * The metadata filter, derived from the filters the caller already sent.
 *
 * ── This is an optimisation and NOT a security control ──
 *
 * Its only job is to stop the top-K being spent on records the SQL query is
 * certain to discard. A district's corpus is mostly history: after two years,
 * most events are `completed`, so an unfiltered top-60 for "food pantry" can be
 * sixty events from 2024 and the semantic half contributes nothing.
 *
 * Only filters that are STABLE in the index are applied. `openOnly` is not among
 * them — it depends on remaining spots, which the index deliberately does not
 * store (see `eventDocument.js`), so it is left entirely to SQL. Applying a
 * stale version of it here would remove events that do have space.
 */
export function buildPineconeFilter(filters = {}) {
  const filter = {};

  if (filters.scope === 'listable') filter.status = { $in: ['open', 'closed'] };
  else if (filters.scope === 'open') filter.status = { $eq: 'open' };
  else filter.status = { $ne: 'cancelled' };

  if (filters.category) filter.category = { $eq: String(filters.category) };
  if (filters.tags?.length) filter.tags = { $in: filters.tags.map(String) };

  /* Date bounds map onto the indexed first-shift start. Both are epoch seconds
     because Pinecone has no date type — see `buildMetadata`. */
  const from = filters.from ? Date.parse(`${filters.from}T00:00:00.000Z`) : null;
  const to = filters.to ? Date.parse(`${filters.to}T23:59:59.999Z`) : null;
  if (Number.isFinite(from) || Number.isFinite(to)) {
    filter.startsAt = {};
    if (Number.isFinite(from)) filter.startsAt.$gte = Math.floor(from / 1000);
    if (Number.isFinite(to)) filter.startsAt.$lte = Math.floor(to / 1000);
  }

  return filter;
}

/**
 * Asks Pinecone for candidates. Returns ids in relevance order.
 *
 * @returns {Promise<{ok: boolean, ids: string[], reason?: string, durationMs: number}>}
 */
export async function semanticCandidates(query, filters = {}, { topK = SEARCH_TOP_K } = {}) {
  /**
   * Given a span because it leaves the machine.
   *
   * This is a network call to Pinecone on the path of a user-visible search, so
   * it is the operation most likely to be the reason Discover feels slow, and
   * the one an operator cannot diagnose from this application's own logs — "the
   * search took 900ms" and "Pinecone took 880ms of it" are different findings
   * with different fixes.
   *
   * The QUERY TEXT is not an attribute and must never become one. The comment
   * further down says why for the log record and the same reasoning binds here:
   * a search box on a school platform is free text typed by a minor, and the
   * allowlist in `spanAttributes.js` has no key that would carry it.
   */
  return withSpan('search.discover', { component: 'discover' }, () =>
    semanticCandidatesInner(query, filters, { topK }));
}

async function semanticCandidatesInner(query, filters, { topK }) {
  const started = Date.now();
  if (!pineconeEnabled()) {
    return { ok: false, ids: [], reason: 'disabled', durationMs: 0 };
  }

  const res = await searchRecords({
    text: String(query).trim(),
    topK,
    filter: buildPineconeFilter(filters),
    /* Ids only. The record's text comes back only when a rerank is going to
       need it, because every field returned is response size we pay for and
       then discard — the row is read from the database regardless. */
    fields: ['_id'],
  });

  const durationMs = Date.now() - started;

  /* One telemetry record per search, through the existing façade. No query text:
     a search box on a school platform is free text typed by a minor, and
     ENGINEERING_GUIDE §6.10's bar for what may leave this application does not
     make an exception for it being interesting. Only the shape of what
     happened. */
  logEvent(res.ok ? 'info' : 'warn', 'pinecone.search', {
    operation: 'discover',
    durationMs,
    count: res.hits?.length ?? 0,
    outcome: res.ok ? 'ok' : 'failed',
    reason: res.ok ? undefined : res.reason,
  });

  if (!res.ok) return { ok: false, ids: [], reason: res.reason, durationMs };

  const ids = res.hits.map((h) => eventIdFromVectorId(h.id)).filter(Boolean);
  return { ok: true, ids, durationMs };
}

/**
 * Reciprocal Rank Fusion.
 *
 * ── Why RRF and not a weighted score blend ──
 *
 * The two halves of this search produce numbers that are not comparable: a
 * cosine similarity from an embedding model and a SQL substring match are on
 * different scales, and one of them is not really a score at all. Any blend of
 * them needs a weight that has to be tuned against data nobody has, and that
 * silently becomes wrong when the corpus grows.
 *
 * RRF throws the scores away and keeps only the ORDER, which is the part both
 * halves genuinely agree on the meaning of. An item ranked first by either list
 * scores highly; an item ranked well by both wins. There is one constant, `k`,
 * and it is a damping term rather than a tuned weight: 60 is the value from the
 * original paper and the one every implementation uses.
 */
export function rrfFuse(lists, { k = 60 } = {}) {
  const scores = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    list.forEach((id, index) => {
      if (!id) return;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([id]) => id);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reranking — rationed, because the plan rations it
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The month's rerank spend, kept in memory and reset by the calendar.
 *
 * ── Why this is not persisted, and what that costs ──
 *
 * A restart resets the counter, so a deployment that restarts daily could spend
 * more than the budget over a month. That is accepted deliberately: the
 * alternative is a database write on the read path of a search, and the failure
 * this guards against is "an expensive feature runs away", not "an attacker
 * exhausts the quota". The real ceiling is Pinecone's own 500, which returns 429
 * — and a 429 here degrades to the unreranked order rather than failing the
 * search.
 *
 * `PINECONE_RERANK=1` is required on top of this. Off by default is the
 * protection; the counter is the second one.
 */
let rerankMonth = null;
let rerankSpent = 0;

function rerankBudgetRemaining() {
  const month = new Date().toISOString().slice(0, 7);
  if (rerankMonth !== month) {
    rerankMonth = month;
    rerankSpent = 0;
  }
  return RERANK_MONTHLY_BUDGET - rerankSpent;
}

export function rerankBudgetState() {
  return { month: rerankMonth, spent: rerankSpent, remaining: rerankBudgetRemaining() };
}

export function __resetRerankBudget() {
  rerankMonth = null;
  rerankSpent = 0;
}

/**
 * Should this particular search spend one of the month's reranks?
 *
 * Starter allows 500 a month — about sixteen a day — so this is not a decision
 * about quality, it is a decision about which sixteen searches a day are worth
 * it. The ones that are: long, natural-language queries with a lot of
 * candidates, where the embedding's ordering is most likely to be improvable and
 * where the user has expressed enough intent for the improvement to matter.
 * A two-word query with four results has nothing to reorder.
 */
export function shouldRerank(query, candidateCount) {
  const cfg = pineconeConfig();
  if (!cfg.enabled || !cfg.rerankEnabled) return false;
  if (rerankBudgetRemaining() <= 0) return false;
  if (candidateCount < 10) return false;
  const words = String(query ?? '').trim().split(/\s+/).filter(Boolean).length;
  return words >= 4;
}

/**
 * Reorders candidates by relevance, if the budget allows. Never throws, and
 * returns the input order unchanged whenever it declines or fails.
 *
 * @param {string} query
 * @param {Array<{id: string, text: string}>} candidates
 */
export async function maybeRerank(query, candidates, { topN = 20 } = {}) {
  if (!Array.isArray(candidates) || !shouldRerank(query, candidates.length)) {
    return { reranked: false, ids: candidates.map((c) => c.id) };
  }

  rerankSpent++;
  const res = await rerank({
    query,
    documents: candidates.map((c) => ({ [TEXT_FIELD]: String(c.text ?? '') })),
    topN: Math.min(topN, candidates.length),
    rankField: TEXT_FIELD,
  });

  logEvent(res.ok ? 'info' : 'warn', 'pinecone.rerank', {
    operation: 'rerank',
    count: candidates.length,
    outcome: res.ok ? 'ok' : 'failed',
    reason: res.ok ? undefined : res.reason,
  });

  if (!res.ok) return { reranked: false, ids: candidates.map((c) => c.id) };

  const ordered = res.results
    .map((r) => candidates[r.index])
    .filter(Boolean)
    .map((c) => c.id);

  /* Anything the reranker did not return keeps its original position behind the
     reordered head, so a topN smaller than the candidate list truncates the
     ranking rather than the result set. */
  const seen = new Set(ordered);
  for (const c of candidates) if (!seen.has(c.id)) ordered.push(c.id);

  return { reranked: true, ids: ordered };
}
