/**
 * Keeping Pinecone in step with `events`, without ever making a request wait for
 * it and without paying to embed the same words twice.
 *
 * ── The shape, and why ──
 *
 *   a write to `events`  →  mark the row dirty  (same database, same request)
 *                        →  respond to the caller
 *                        →  drain the queue      (after the response, or by CLI)
 *
 * The marking is a single-row upsert in the database the write already touched,
 * so it costs nothing measurable and cannot fail independently of the write it
 * belongs to. Everything that can fail — the network, the vendor, the embedding
 * — happens after the response, against a row that is already committed. A crash
 * in between loses nothing: the row is still `pending` when the process comes
 * back.
 *
 * The alternative, calling Pinecone inside the handler, was rejected on the
 * obvious failure: creating an event would then fail when a search vendor was
 * down. Discover is a convenience; posting an opportunity is the product.
 *
 * ── Why every function takes a database handle ──
 *
 * `server/db.accessSurface.test.js` holds a ratchet: a new module RECEIVES a
 * handle rather than importing the global one, because a parameter can be given
 * a pooled client during a transaction and an import cannot. It matters more
 * here than usual — `markEventDirty` is called from inside the transaction that
 * writes the event, and it must join that transaction rather than race it. A
 * mark that committed independently of a rolled-back edit would queue an index
 * update for a change that never happened.
 *
 * ── Nothing here throws ──
 *
 * Every export resolves. `markEventDirty` is called from write paths that must
 * not acquire a new failure mode, and the sync functions are called from a
 * background drain and from a CLI, neither of which has anyone to report to.
 */
import { logEvent } from './../telemetry.js';
import {
  buildRecord, contentHash, shouldIndex, vectorIdFor, eventIdFromVectorId,
} from './eventDocument.js';
import { upsertRecords, deleteRecords, indexStats } from './pineconeClient.js';
import { pineconeEnabled, UPSERT_BATCH_SIZE, DOCUMENT_VERSION } from './pineconeConfig.js';

/**
 * One event, with everything `eventDocument` needs, in one query.
 *
 * The tag list and the organization name are joins rather than extra round
 * trips: a backfill over 50,000 events that issued three queries each would take
 * three times as long and hold the connection three times as often, for data the
 * planner can assemble in one pass.
 *
 * `min_start` is the first shift's start, which is the date a card shows and the
 * date every filter in `eventQuery.js` compares against — an aggregate, so it
 * cannot come from the `events` row alone.
 */
const EVENT_SELECT = `
  SELECT e.id, e.title, e.description, e.category, e.location, e.status,
         e.audience, e.organization_id, e.application_deadline,
         org.name AS organization_name,
         (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) AS min_start,
         (SELECT GROUP_CONCAT(et.tag) FROM event_tags et WHERE et.event_id = e.id) AS tag_list
    FROM events e
    LEFT JOIN organizations org ON org.id = e.organization_id
`;

/** Splits the aggregated tag column back into keys. */
function rowExtras(row) {
  return {
    tags: String(row?.tag_list ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    organizationName: row?.organization_name ?? null,
    startsAt: row?.min_start ?? null,
  };
}

/**
 * Records that an event's searchable content may have changed.
 *
 * Deliberately cheap and deliberately imprecise: it does NOT compute the hash or
 * compare anything, it just says "look at this one". Computing the hash here
 * would mean loading the tags and the organization on the request path to
 * discover, most of the time, that nothing relevant changed — spending the
 * request's latency to save the background drain a comparison it is going to
 * make anyway.
 *
 * Safe to call for an event that does not exist, an unchanged event, or twice in
 * one request. Never throws.
 */
export async function markEventDirty(db, eventId, { reason = 'write' } = {}) {
  if (!eventId) return;
  try {
    const now = new Date().toISOString();
    /* An upsert, because the row may not exist yet (a new event) and must not be
       duplicated if it does. The state moves back to 'pending' whatever it was:
       an event edited while its last sync was failing is still pending. */
    await db.prepare(`
      INSERT INTO event_search_index (event_id, state, updated_at)
      VALUES (?, 'pending', ?)
      ON CONFLICT(event_id) DO UPDATE SET state = 'pending', updated_at = ?
    `).run(eventId, now, now);
  } catch {
    /* A search index that misses an update is a stale search result. It is not a
       reason to fail the write that produced it, and `reconcile` finds it. */
    void reason;
  }
}

/**
 * Marks every event dirty. Used by the CLI when the document schema changes.
 *
 * Cheap in the database and expensive in Pinecone, which is why it is a
 * deliberate command rather than something that happens on a version mismatch.
 */
export async function markAllDirty(db) {
  const now = new Date().toISOString();
  /**
   * `WHERE true` is load-bearing, not decoration.
   *
   * In an `INSERT … SELECT … ON CONFLICT`, SQLite cannot tell whether `ON`
   * begins a conflict clause or a join condition, and resolves the ambiguity by
   * refusing to parse: `near "DO": syntax error`. A terminated WHERE clause
   * settles it. PostgreSQL accepts the same statement either way, so one
   * spelling serves both engines.
   *
   * Found by the test that re-indexes an unchanged corpus — without it this
   * threw on every run of `npm run pinecone:reindex`, which is the command the
   * documentation tells an operator to use after a document-schema change.
   */
  await db.prepare(`
    INSERT INTO event_search_index (event_id, state, updated_at)
    SELECT e.id, 'pending', ? FROM events e
    WHERE true
    ON CONFLICT(event_id) DO UPDATE SET state = 'pending', updated_at = ?
  `).run(now, now);
}

/**
 * The events waiting to be sent, oldest first.
 *
 * Includes events that have NEVER been seen (no bookkeeping row at all), which
 * is what makes a first backfill work without a separate seeding step: the
 * LEFT JOIN treats "no row" and "pending" as the same thing.
 */
async function pendingBatch(db, limit) {
  return db.prepare(`
    ${EVENT_SELECT}
    LEFT JOIN event_search_index si ON si.event_id = e.id
    WHERE si.event_id IS NULL
       OR si.state IN ('pending', 'failed')
       OR si.doc_version <> @docVersion
    ORDER BY COALESCE(si.updated_at, e.created_at) ASC
    LIMIT @limit
  `).all({ limit, docVersion: DOCUMENT_VERSION });
}

/** The stored hash for a set of events, as a map. */
async function hashesFor(db, eventIds) {
  if (!eventIds.length) return new Map();
  const names = eventIds.map((_, i) => `@id${i}`);
  const params = {};
  eventIds.forEach((id, i) => { params[`id${i}`] = id; });
  const rows = await db.prepare(
    `SELECT event_id, content_hash, doc_version FROM event_search_index
      WHERE event_id IN (${names.join(', ')})`,
  ).all(params);
  return new Map(rows.map((r) => [r.event_id, r]));
}

async function markIndexed(db, eventId, hash) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO event_search_index
      (event_id, content_hash, doc_version, state, last_error, attempts, indexed_at, updated_at)
    VALUES (?, ?, ?, 'indexed', NULL, 0, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      doc_version  = excluded.doc_version,
      state        = 'indexed',
      last_error   = NULL,
      attempts     = 0,
      indexed_at   = excluded.indexed_at,
      updated_at   = excluded.updated_at
  `).run(eventId, hash, DOCUMENT_VERSION, now, now);
}

async function markRemoved(db, eventId) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO event_search_index
      (event_id, content_hash, doc_version, state, attempts, updated_at)
    VALUES (?, NULL, ?, 'removed', 0, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      content_hash = NULL, state = 'removed', attempts = 0, updated_at = excluded.updated_at
  `).run(eventId, DOCUMENT_VERSION, now);
}

/**
 * Records a failure without losing the queue position.
 *
 * `attempts` is incremented rather than the row being dropped, so a permanently
 * malformed event is visible in `stats` as something that has failed eleven
 * times rather than as an event that silently never appears in search.
 */
async function markFailed(db, eventId, reason) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO event_search_index (event_id, state, last_error, attempts, updated_at)
    VALUES (?, 'failed', ?, 1, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      state = 'failed',
      last_error = excluded.last_error,
      attempts = event_search_index.attempts + 1,
      updated_at = excluded.updated_at
  `).run(eventId, String(reason ?? 'unknown').slice(0, 120), now);
}

/**
 * Sends one batch of pending events, and returns what happened.
 *
 * ── The hash comparison is the whole free-tier story ──
 *
 * An event whose stored hash equals its computed hash is marked indexed and
 * NOT sent. That is what makes `backfill` idempotent, makes a re-run cost
 * nothing, and means an organizer fixing a typo in a title re-embeds one event
 * rather than the district's corpus.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] how many events to consider
 * @param {boolean} [opts.dryRun] compute and compare, send nothing
 */
export async function syncPending(db, { limit = UPSERT_BATCH_SIZE, dryRun = false } = {}) {
  const result = {
    considered: 0, upserted: 0, deleted: 0, unchanged: 0, failed: 0, skipped: false,
  };

  if (!pineconeEnabled() && !dryRun) {
    result.skipped = true;
    result.reason = 'disabled';
    return result;
  }

  let rows;
  try {
    rows = await pendingBatch(db, limit);
  } catch (err) {
    result.failed = 1;
    result.reason = `query_${err?.name || 'error'}`;
    return result;
  }
  result.considered = rows.length;
  if (!rows.length) return result;

  const stored = await hashesFor(db, rows.map((r) => r.id));

  /* Three piles: send it, remove it, or leave it alone. */
  const toUpsert = [];
  const toDelete = [];
  const unchanged = [];

  for (const row of rows) {
    const extras = rowExtras(row);
    if (!shouldIndex(row)) {
      toDelete.push(row.id);
      continue;
    }
    const hash = contentHash(row, extras);
    const prior = stored.get(row.id);
    if (prior && prior.content_hash === hash && prior.doc_version === DOCUMENT_VERSION) {
      unchanged.push(row.id);
      continue;
    }
    toUpsert.push({ id: row.id, hash, record: buildRecord(row, extras) });
  }

  result.unchanged = unchanged.length;
  if (dryRun) {
    result.upserted = toUpsert.length;
    result.deleted = toDelete.length;
    return result;
  }

  /* Already correct in Pinecone — the bookkeeping just had not caught up. */
  for (const id of unchanged) await markIndexed(db, id, stored.get(id).content_hash);

  if (toUpsert.length) {
    const res = await upsertRecords(toUpsert.map((u) => u.record));
    if (res.ok) {
      for (const u of toUpsert) await markIndexed(db, u.id, u.hash);
      result.upserted = toUpsert.length;
    } else {
      for (const u of toUpsert) await markFailed(db, u.id, res.reason);
      result.failed += toUpsert.length;
    }
  }

  if (toDelete.length) {
    const res = await deleteRecords(toDelete.map(vectorIdFor));
    if (res.ok) {
      for (const id of toDelete) await markRemoved(db, id);
      result.deleted = toDelete.length;
    } else {
      for (const id of toDelete) await markFailed(db, id, res.reason);
      result.failed += toDelete.length;
    }
  }

  logEvent(result.failed ? 'warn' : 'info', 'pinecone.upsert', {
    operation: 'sync',
    count: result.upserted + result.deleted,
    outcome: result.failed ? 'partial' : 'ok',
  });

  return result;
}

/**
 * Removes one event from the index immediately.
 *
 * Deletion is the one operation that cannot wait for a drain: an event deleted
 * from the database has no bookkeeping row left to find it by — the foreign key
 * cascades it away — so the record would stay in Pinecone for ever, and would be
 * returned as a candidate that the hydration step silently drops. That is a
 * result the user never sees but always pays for.
 *
 * Called BEFORE the row is deleted, so the caller still has the id.
 */
export async function removeEventFromIndex(eventId) {
  if (!eventId) return { ok: true, skipped: true };
  if (!pineconeEnabled()) return { ok: true, skipped: true };
  try {
    const res = await deleteRecords([vectorIdFor(eventId)]);
    logEvent(res.ok ? 'info' : 'warn', 'pinecone.delete', {
      operation: 'remove', count: 1, outcome: res.ok ? 'ok' : 'failed', reason: res.reason,
    });
    return res;
  } catch {
    return { ok: false, reason: 'threw' };
  }
}

/**
 * Indexes everything, a batch at a time, resumably.
 *
 * Resumable because progress lives in the database rather than in this function:
 * every successful batch marks its rows indexed, so an interrupted backfill
 * restarted an hour later picks up exactly where it stopped. There is no cursor
 * to lose and no way to double-send — a record that was already sent has a
 * matching hash and is skipped.
 *
 * @param {object} [opts]
 * @param {number} [opts.batchSize]
 * @param {number} [opts.maxBatches] a bound, so a backfill cannot run away
 * @param {boolean} [opts.dryRun]
 * @param {(progress: object) => void} [opts.onProgress]
 */
export async function backfill(db, {
  batchSize = UPSERT_BATCH_SIZE, maxBatches = 10000, dryRun = false, onProgress = null,
} = {}) {
  const totals = { batches: 0, considered: 0, upserted: 0, deleted: 0, unchanged: 0, failed: 0 };

  for (let i = 0; i < maxBatches; i++) {
    const res = await syncPending(db, { limit: batchSize, dryRun });
    if (res.skipped) return { ...totals, skipped: true, reason: res.reason };

    totals.batches++;
    totals.considered += res.considered;
    totals.upserted += res.upserted;
    totals.deleted += res.deleted;
    totals.unchanged += res.unchanged;
    totals.failed += res.failed;

    /* Only a pass that did something is worth reporting. A final empty pass is
       how the loop discovers it is finished, and printing "batch 7" for it makes
       the summary look like it did more work than it did. */
    if (onProgress && res.considered > 0) onProgress({ ...totals });

    /* Nothing left, or a batch that could only fail again — a dry run marks
       nothing, so it would otherwise re-consider the same rows for ever. */
    if (res.considered === 0) break;
    if (dryRun) break;
    if (res.failed === res.considered) break;
  }

  return totals;
}

/**
 * Where the database and the index disagree.
 *
 * Two directions, and they fail differently:
 *
 *   **missing**  the database has a searchable event the index does not. The
 *                event is simply unfindable by semantic search — invisible, with
 *                no error anywhere.
 *   **orphaned** the index has a record the database does not. Its id is
 *                returned as a candidate, the hydration step finds nothing, and
 *                the result is a search that quietly returns fewer results than
 *                it should while charging read units for the privilege.
 *
 * Only the first is repaired automatically here, because it is repaired by the
 * ordinary sync. Orphans are REPORTED rather than deleted: deleting is
 * destructive, and a namespace that looks full of orphans is much more likely to
 * mean "pointed at the wrong namespace" than "50,000 stale records". The CLI
 * takes an explicit flag to remove them.
 */
export async function reconcile(db, { removeOrphans = false } = {}) {
  const report = { missing: 0, orphaned: 0, removed: 0, indexedRecords: null, dbEvents: 0 };

  const missing = await db.prepare(`
    SELECT COUNT(*) AS c
      FROM events e
      LEFT JOIN event_search_index si ON si.event_id = e.id
     WHERE e.status <> 'cancelled'
       AND (si.event_id IS NULL OR si.state <> 'indexed' OR si.doc_version <> @docVersion)
  `).get({ docVersion: DOCUMENT_VERSION });
  report.missing = Number(missing?.c ?? 0);

  const total = await db.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE status <> 'cancelled'`,
  ).get();
  report.dbEvents = Number(total?.c ?? 0);

  if (!pineconeEnabled()) return { ...report, skipped: true, reason: 'disabled' };

  /* Pinecone reports a record COUNT per namespace, not a list of ids, so the
     orphan check is arithmetic rather than a set difference: any excess over the
     rows we believe are indexed is unaccounted for. Listing every id to be exact
     would page the whole namespace and charge for it. */
  const stats = await indexStats();
  if (stats.ok) {
    const ns = stats.body?.namespaces ?? {};
    const { namespace } = (await import('./pineconeConfig.js')).pineconeConfig();
    report.indexedRecords = Number(ns?.[namespace]?.vectorCount ?? ns?.[namespace]?.record_count ?? 0);

    const believed = await db.prepare(
      `SELECT COUNT(*) AS c FROM event_search_index WHERE state = 'indexed'`,
    ).get();
    report.orphaned = Math.max(0, report.indexedRecords - Number(believed?.c ?? 0));
  }

  if (removeOrphans && report.orphaned > 0) {
    /* Deleting by id requires knowing the ids, and we deliberately do not page
       the namespace. What we CAN do precisely is remove records for events this
       database says should not be there — a cancelled or deleted event whose
       bookkeeping row still exists. */
    const stale = await db.prepare(`
      SELECT si.event_id
        FROM event_search_index si
        LEFT JOIN events e ON e.id = si.event_id
       WHERE si.state = 'indexed' AND (e.id IS NULL OR e.status = 'cancelled')
       LIMIT 1000
    `).all();
    if (stale.length) {
      const res = await deleteRecords(stale.map((r) => vectorIdFor(r.event_id)));
      if (res.ok) {
        for (const r of stale) await markRemoved(db, r.event_id);
        report.removed = stale.length;
      }
    }
  }

  logEvent('info', 'pinecone.reconcile', {
    operation: 'reconcile', count: report.missing, outcome: report.missing ? 'drift' : 'ok',
  });

  return report;
}

/**
 * Counts by state, for the CLI and for a health line.
 *
 * Returns `{ available: false }` rather than throwing when the bookkeeping table
 * is not there. That is not a hypothetical: an operator pointing this at a
 * database that has not run migration 059 is the FIRST thing that happens on a
 * machine with an old development database lying around, and "Error" is a
 * useless answer to it. The reason is named so the CLI can say which of the two
 * problems the operator actually has.
 */
export async function indexingStats(db) {
  let rows;
  try {
    rows = await db.prepare(
      'SELECT state, COUNT(*) AS c FROM event_search_index GROUP BY state',
    ).all();
  } catch (err) {
    return { available: false, reason: 'no_table', detail: err?.message?.slice(0, 120) ?? null };
  }
  const byState = Object.fromEntries(rows.map((r) => [r.state, Number(r.c)]));
  const events = await db.prepare('SELECT COUNT(*) AS c FROM events').get();
  return {
    available: true,
    events: Number(events?.c ?? 0),
    indexed: byState.indexed ?? 0,
    pending: byState.pending ?? 0,
    failed: byState.failed ?? 0,
    removed: byState.removed ?? 0,
    documentVersion: DOCUMENT_VERSION,
  };
}

/** Exposed for the reconciler's tests, which need to name a record's event. */
export { eventIdFromVectorId };
