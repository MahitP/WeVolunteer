/**
 * The bookkeeping that keeps Pinecone in step with the database — and, more
 * importantly, keeps it from being asked to do the same work twice.
 *
 * ── Why this table exists at all ──
 *
 * A search index derived from a table needs three questions answered, and none
 * of them can be answered from `events` itself:
 *
 *   1. **Has this event's searchable content changed since we last sent it?**
 *      Without an answer, every sync re-embeds the whole corpus. Pinecone's
 *      Starter plan allows 5,000,000 embedding tokens a month; a district's
 *      50,000 events is a meaningful fraction of that, and spending it to
 *      produce vectors identical to the ones already stored is the single
 *      easiest way to exhaust the free tier by accident. `content_hash` is the
 *      answer, and it is why re-running the backfill is free.
 *
 *   2. **Which events are not in the index?** `events LEFT JOIN
 *      event_search_index` names them in one query. Asking Pinecone instead
 *      would mean paging the entire vector namespace on every reconciliation.
 *
 *   3. **What failed, and how often?** A vendor that is down must not lose
 *      writes silently. `state` and `last_error` turn an outage into a queue
 *      that drains when it ends, rather than a set of events that are quietly
 *      unfindable for ever.
 *
 * ── Why an outbox rather than writing to Pinecone in the request ──
 *
 * `POST /api/events` must not wait on a third party, and must not fail because
 * one is unreachable. So the write path does one thing — mark the row dirty, in
 * the same database, in the same transaction as the event itself — and the
 * synchronisation happens after the response. That ordering is the reason a
 * Pinecone outage cannot make event creation fail, and the reason a crash
 * between the two cannot lose the update: the dirty row is already committed.
 *
 * ── Why `events` was not simply given two more columns ──
 *
 * Considered, and rejected on blast radius. `events` is read by roughly every
 * route in the application and is the table migration 057 rebuilds; adding
 * derived, frequently-rewritten search bookkeeping to it means every sync writes
 * to the hottest row in the schema and takes its row locks. A separate table
 * with a foreign key gets the same information, cascades its own deletes, and
 * can be truncated wholesale when the index is rebuilt — which is exactly what
 * an index-version bump needs to do, and what would be unthinkable against
 * `events`.
 *
 * ── Additive on both engines ──
 *
 * One new table. No change to any existing one, so no rebuild and no guard set.
 */

/** @param {import('node:sqlite').DatabaseSync} db */
function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_search_index (
      event_id     TEXT PRIMARY KEY,
      /* sha256 of the embedded text plus the filterable metadata. NULL until
         the event has been sent successfully even once. */
      content_hash TEXT,
      /* Which document schema produced that hash. A bump invalidates every row
         without anybody having to remember to clear the table. */
      doc_version  INTEGER NOT NULL DEFAULT 1,
      /* 'pending'  the content changed and Pinecone has not been told
         'indexed'  Pinecone holds this exact content
         'failed'   the last attempt failed; last_error says how
         'removed'  deliberately absent from the index (a cancelled event) */
      state        TEXT NOT NULL DEFAULT 'pending'
                   CHECK(state IN ('pending', 'indexed', 'failed', 'removed')),
      /* A short reason code, never a vendor response body. */
      last_error   TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      indexed_at   TEXT,
      updated_at   TEXT NOT NULL,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);

  /* The sync worker's only query is "what is not indexed", so that is the index
     it gets. Without it, every pass is a full scan of a table that grows with
     the event corpus. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_search_index_state
      ON event_search_index(state)
  `);
}

/**
 * The same table on PostgreSQL.
 *
 * `CREATE TABLE IF NOT EXISTS` rather than a catalogue probe, for the reason
 * migration 058 gives for `ADD COLUMN IF NOT EXISTS`: the clause exists, it is
 * atomic, and it makes re-running the migration the database's problem rather
 * than a read-then-write race in application code.
 */
async function postgresUp(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS event_search_index (
      event_id     text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      content_hash text,
      doc_version  integer NOT NULL DEFAULT 1,
      state        text NOT NULL DEFAULT 'pending'
                   CHECK(state IN ('pending', 'indexed', 'failed', 'removed')),
      last_error   text,
      attempts     integer NOT NULL DEFAULT 0,
      indexed_at   text,
      updated_at   text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_search_index_state
      ON event_search_index(state);
  `);
}

export default {
  version: 59,
  name: 'event_search_index',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
