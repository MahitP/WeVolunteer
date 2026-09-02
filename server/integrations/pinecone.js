/**
 * Pinecone, for the Owner Center.
 *
 * ── Why it appears at all ──
 *
 * The brief says to include Pinecone only if it is genuinely part of the
 * production architecture. It is: `server/search/discoverSearch.js` puts
 * semantic results into Discover, which is the page students arrive on. When it
 * is down the product does not break — the read path is one `OR e.id IN (…)` on
 * the text predicate and it degrades to keyword search — but it degrades
 * SILENTLY, and a search that has quietly stopped understanding what somebody
 * typed is exactly the kind of failure nobody reports and nobody notices.
 *
 * ── One card, not a section ──
 *
 * Index reachability, the record count, and how much of the free tier this
 * process has spent. That is the whole of it. There is no vector browser, no
 * query console, no reindex button: reindexing is `npm run pinecone:reindex`,
 * an operator command with a terminal to print progress into, and putting it
 * behind a web button would make an expensive, long-running job one misclick
 * away.
 *
 * ── Free tier ──
 *
 * `describe_index_stats` is a control-plane read: it is not billed in read
 * units and does not touch the 500-reranks-a-month ceiling that is the binding
 * constraint on this account (see `pineconeConfig.js`). The usage figures below
 * are this process's own counters, accumulated from what Pinecone reported it
 * charged for — not a second guess at the bill.
 */
import { pineconeConfig, pineconeStatus } from '../search/pineconeConfig.js';
import { indexStats, pineconeUsage } from '../search/pineconeClient.js';
import { RERANK_MONTHLY_BUDGET } from '../search/pineconeConfig.js';
import { notConfigured, ok } from './providerResult.js';

/** The console. A project-specific URL needs a project id we do not hold. */
export const PINECONE_CONSOLE_URL = 'https://app.pinecone.io/';

/** The variable that switches semantic search on. Named here, never in `src/`. */
export const PINECONE_CONFIGURE_WITH = 'PINECONE_API_KEY';

/**
 * Pinecone's free "Starter" plan, as documented, so the usage figures beside it
 * mean something. Read on 2026-08-26 and recorded in
 * `docs/operations/pinecone.md`; if Pinecone changes them, that file and this
 * constant are the two places to change.
 */
export const PINECONE_FREE_TIER = Object.freeze({
  rerankUnitsPerMonth: 500,
  embedTokensPerMonth: 5_000_000,
  indexes: 5,
  namespaces: 100,
});

export async function fetchVectorSearch() {
  const status = pineconeStatus();
  if (!status.enabled) return notConfigured(PINECONE_CONFIGURE_WITH);

  const cfg = pineconeConfig();
  const stats = await indexStats();

  /**
   * A refused stats call is reported as unreachable rather than as a provider
   * failure, and the configuration is reported beside it.
   *
   * The distinction matters on this integration more than the others: Pinecone
   * being unreachable does not break Discover, so the reader's question is
   * never "is the site down" — it is "has search quietly lost its semantic
   * half", and the index name and namespace are what let them go and check.
   */
  if (!stats.ok) {
    return ok({
      reachable: false,
      /* One of this repository's own words from `pineconeClient` — `disabled`,
         `no_host`, `timeout`, an HTTP status — never Pinecone's body. */
      reason: typeof stats.reason === 'string' ? stats.reason : 'unavailable',
      index: status.index,
      namespace: status.namespace,
      model: status.model,
      usage: pineconeUsage(),
      budget: budget(),
    });
  }

  /**
   * The record count for OUR namespace, and the index total beside it.
   *
   * Both, because they answer different questions and a single number hides the
   * one that goes wrong: environments here separate by namespace rather than by
   * index (the plan allows 5 indexes and 100 namespaces), so an index holding
   * 40,000 records while this deployment's namespace holds zero is a
   * misconfigured `PINECONE_NAMESPACE`, not an empty index — and it is
   * invisible if only one figure is shown.
   */
  const namespaces = stats.body?.namespaces && typeof stats.body.namespaces === 'object'
    ? stats.body.namespaces
    : {};
  const mine = namespaces[cfg.namespace]?.recordCount ?? namespaces[cfg.namespace]?.vectorCount ?? null;

  return ok({
    reachable: true,
    index: status.index,
    namespace: status.namespace,
    model: status.model,
    records: Number.isFinite(Number(mine)) ? Number(mine) : null,
    totalRecords: Number.isFinite(Number(stats.body?.totalRecordCount))
      ? Number(stats.body.totalRecordCount)
      : (Number.isFinite(Number(stats.body?.totalVectorCount)) ? Number(stats.body.totalVectorCount) : null),
    usage: pineconeUsage(),
    budget: budget(),
  });
}

/**
 * What the reranking budget is and how much of it this process has spent.
 *
 * `RERANK_MONTHLY_BUDGET` is the application's own self-imposed ceiling, set
 * below Pinecone's 500-a-month free allowance so that hitting ours is a
 * recoverable event rather than a bill. Both are reported: a spend approaching
 * the local budget is the one worth acting on, and the plan figure is what
 * makes the local one legible.
 */
function budget() {
  return {
    rerankBudget: RERANK_MONTHLY_BUDGET,
    plan: PINECONE_FREE_TIER,
  };
}
