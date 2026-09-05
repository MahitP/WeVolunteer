/**
 * `events.first_slot_start`, and the index the default browse sort needs.
 *
 * ── What was slow ──
 *
 * The browse list sorts by "soonest", which is MIN(start_datetime) over an
 * event's slots. A sort key computed per row has to be computed for EVERY
 * candidate before the top sixty can be chosen, so the default page was linear
 * in event count and no index could help — the value did not exist anywhere to
 * index. Measured on a throwaway PostgreSQL: 63 ms at 10,000 events, 370 ms at
 * 50,000, on a page of sixty.
 *
 * Storing the value turns that sort into an index range scan. The reasoning for
 * storing a derived value at all, and why it does not breach the derive-don't-
 * store rule that governs the hours ledger, is in `server/eventSummary.js`.
 *
 * ── Ordering and the backfill ──
 *
 * Additive and order-independent beyond needing `events` and `slots` to exist.
 * The backfill runs in the same migration, so no deployment ever serves a page
 * ordered by a column that is NULL everywhere — which would put every event in
 * the tie-break order and look like the list had been shuffled.
 *
 * ── NULL is a real value here ──
 *
 * An event with no slots stores NULL, and `eventQuery.js` sorts NULLs last on
 * both engines. `events` created before this column existed and never touched
 * since are backfilled below; ones created afterwards are maintained by
 * `refreshEventSummary` at every slot mutation.
 */

/**
 * Is the relation there? Asked in SQL that both engines speak.
 *
 * `SELECT 1 FROM <table> LIMIT 0` needs no dialect: it is valid everywhere,
 * plans nothing, returns nothing, and raises on a missing relation — which is
 * the whole question. Migration 061 established this idiom for exactly this
 * reason, and the reason is worth repeating: `sqliteDialect.test.js` counts
 * SQLite-only constructs across the tree and fails when the total rises, so
 * reaching for `sqlite_master` or `PRAGMA table_info` here would spend the
 * PostgreSQL port's budget rather than pay into it. This costs the ratchet zero
 * and works on both engines rather than one.
 *
 * The guard is needed rather than defensive decoration:
 * `migrations.postgres.test.js` provisions a database from a PARTIAL baseline
 * to prove that post-baseline migrations apply in isolation, and there `slots`
 * genuinely does not exist. Without this the backfill fails with
 * `relation "slots" does not exist` and takes every later migration with it —
 * which is exactly what it did.
 */
function hasRelation(db, table) {
  try { db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all(); return true; } catch { return false; }
}

/**
 * The PostgreSQL half asks a DIFFERENT question, and must.
 *
 * The `SELECT 1 … LIMIT 0` probe above works on SQLite because a failed
 * statement there is just a failed statement. On PostgreSQL a failed statement
 * ABORTS THE TRANSACTION — every command after it answers "current transaction
 * is aborted, commands ignored until end of transaction block", including the
 * `INSERT INTO schema_migrations` that records this migration as applied.
 *
 * So the probe swallowed its own error and poisoned the transaction anyway, and
 * eleven migration tests failed on a statement they never ran. `to_regclass`
 * asks the same question without failing: it returns NULL for a relation that
 * is not there.
 *
 * This is why migration 061 has two spellings of one guard, and it is worth
 * having been caught by a test rather than in production.
 */
async function missingRelationsPg(db) {
  const [present] = await db.prepare(`
    SELECT to_regclass('events') IS NOT NULL AS events,
           to_regclass('slots')  IS NOT NULL AS slots
  `).all();
  return !present?.events || !present?.slots;
}

/**
 * Is the COLUMN there? Same idiom, same reason.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so re-running this migration on a
 * database that already has the column would otherwise raise "duplicate column
 * name" — and a migration must be safe to re-run. `PRAGMA table_info` answers
 * this too and is SQLite-only; selecting the column answers it in SQL both
 * engines speak.
 */
function hasColumn(db, table, column) {
  try { db.prepare(`SELECT ${column} FROM ${table} LIMIT 0`).all(); return true; } catch { return false; }
}

export default {
  version: 66,
  name: 'event_slot_summary',
  /* Hashed from the FILE, not from `up.toString()` — without this the checksum
     covers only the SQLite half and a change to the PostgreSQL one would go
     unnoticed by the registry. `migrations.registry.test.js` enforces it. */
  fileUrl: import.meta.url,

  up(db) {
    if (!hasRelation(db, 'events') || !hasRelation(db, 'slots')) return;

    if (!hasColumn(db, 'events', 'first_slot_start')) {
      db.exec('ALTER TABLE events ADD COLUMN first_slot_start TEXT');
    }

    /**
     * The composite carries `status` first because every browse query filters
     * on it (`scope=listable` is `status IN ('open','closed')`) before it
     * orders, so a leading `status` lets the seek narrow first and then walk
     * the range in sort order. `id` is included because it is the tie-break
     * `buildEventOrder` appends unconditionally — with it the index answers the
     * whole ORDER BY and the sort disappears rather than being merely narrowed.
     */
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_first_slot_start
        ON events(status, first_slot_start, id)
    `);

    /**
     * A SECOND index, ordered the other way round, and both are used.
     *
     * `EXPLAIN (ANALYZE, BUFFERS)` at 50,000 events settled this rather than
     * taste. `status IN ('open','closed')` splits a status-leading index into
     * two ranges, and the concatenation of two ordered ranges is not ordered —
     * so the planner scanned all 33,334 matching rows and top-N sorted them,
     * even though the ORDER BY was on the very next column.
     *
     * With `first_slot_start` leading, the scan walks in sort order and stops
     * after sixty: **12.7 ms -> 0.105 ms**, zero heap fetches, 90 index entries
     * read for a page of 60.
     *
     * The status-leading index stays because the exact COUNT still wants it —
     * that one seeks straight to the 33,334 matching entries instead of
     * filtering 50,000. Two indexes on a table written by organizers a few
     * times a day, each with a measured plan behind it, which is the standard
     * `docs/operations/postgres-scale-measurements.md` sets for adding one.
     *
     * `status` is INCLUDEd rather than a key column: it is only ever a filter
     * here, never a range or an ordering, so it needs to be present for the
     * scan to stay index-only and does not need to be sorted on.
     */
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_browse_order
        ON events(first_slot_start, id, status)
    `);

    db.exec(`
      UPDATE events
         SET first_slot_start = (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = events.id)
    `);
  },

  postgres: {
    async up(db) {
      if (await missingRelationsPg(db)) return;

      /* `IF NOT EXISTS` on both, so a database that has already been through
         `applyPostgresSchema` — which supplies every column the generated
         schema knows about — is not an error. */
      await db.prepare('ALTER TABLE events ADD COLUMN IF NOT EXISTS first_slot_start TEXT').run();
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_events_first_slot_start
          ON events(status, first_slot_start, id)
      `).run();
      /**
       * The order-leading twin — see the SQLite half for the query plans.
       *
       * ── Why `status` is a trailing KEY column and not an `INCLUDE` ──
       *
       * This was `(first_slot_start, id) INCLUDE (status)`, which is the
       * marginally better PostgreSQL spelling: `status` is only ever a filter
       * here, so storing it as a payload keeps it out of the b-tree key while
       * still allowing an index-only scan.
       *
       * It made the two provisioning paths disagree. A FRESH database gets its
       * indexes from the generated DDL, which is translated from SQLite — and
       * SQLite has no `INCLUDE`, so it writes the three-key form. An UPGRADED
       * database ran this migration and got the `INCLUDE` form. Same name, two
       * different indexes, decided by how the database happened to be created.
       *
       * `migrations.convergence.test.js` compares the two paths by index
       * DEFINITION and fails on exactly this. Converging on the three-key form
       * costs a slightly wider b-tree and nothing else: for this query
       * `status` is a filter either way and the scan stays index-only either
       * way. One schema is worth more than one index page.
       */
      await db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_events_browse_order
          ON events(first_slot_start, id, status)
      `).run();
      await db.prepare(`
        UPDATE events
           SET first_slot_start = (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = events.id)
      `).run();
    },
  },
};
