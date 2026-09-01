/**
 * `events.first_slot_start` — the one derived value this codebase stores.
 *
 * ── Why it exists, against the rule that says derive rather than store ──
 *
 * The browse list's default sort is "soonest", which means MIN(start_datetime)
 * over an event's slots. Sorting by a value computed per row means computing it
 * for EVERY candidate before the top sixty can be chosen, so the default browse
 * was O(n) in event count no matter how the query was shaped: 63 ms at 10,000
 * events, 370 ms at 50,000, and no index could help because the value did not
 * exist anywhere to be indexed.
 *
 * Storing it makes the sort an index range scan — O(log n + page) — and that is
 * the whole reason for the exception. It is deliberately the ONLY aggregate
 * stored: `total_spots`, `total_hours` and the accepted count stay derived,
 * because nothing sorts or filters the default page by them, so they are only
 * ever computed for the sixty rows actually returned.
 *
 * ── Why the hours ledger's rule is not being broken ──
 *
 * INV-001 says credited hours are derived from attendance and never stored, and
 * that rule is about a value somebody is ACCOUNTABLE for — a student's hours are
 * a claim about the world, and a stored copy can disagree with the evidence.
 * `first_slot_start` is not a claim about anything; it is a cache of a MIN over
 * rows in the same database, reconstructible exactly and at any time by
 * `recomputeEventSummary`. The distinction is between a derived FACT and a
 * derived INDEX, and this is the second.
 *
 * ── Why maintenance is in application code and not a trigger ──
 *
 * `bin/generate-postgres-schema.mjs` translates exactly one trigger shape — the
 * append-only `RAISE(ABORT)` guard — and refuses anything else with
 * "Untranslatable trigger". A maintenance trigger would mean teaching that
 * generator to translate procedural bodies between two dialects, which is a far
 * larger surface to get wrong than six call sites that are all already inside a
 * transaction.
 *
 * The risk that buys is a write path that forgets to call this. It is answered
 * three ways rather than by hoping: every slot mutation happens in
 * `eventRoutes.js` inside `runInTransaction`, `verifyEventSummaries` recomputes
 * every row and reports drift, and `eventSummary.invariant.test.js` runs that
 * check after exercising every mutation the API offers.
 */

/**
 * Recomputes and stores one event's slot summary.
 *
 * MUST be called inside the same transaction as the slot mutation that made it
 * necessary. Outside one, a concurrent reader can see slots and summary
 * disagreeing, and the ordering of the browse list is exactly what that
 * disagreement corrupts.
 *
 * Written as a single correlated UPDATE rather than SELECT-then-UPDATE: two
 * statements would leave a window in which another transaction's slot write
 * lands between the read and the write, and the later of the two would store a
 * value computed from a set that no longer exists. One statement cannot.
 *
 * A NULL result — an event whose slots have all gone — is correct and is stored
 * as NULL rather than skipped. `eventQuery.js` sorts NULLs last on both engines,
 * which is where an unscheduled event belongs.
 */
export async function refreshEventSummary(tx, eventId) {
  await tx.prepare(`
    UPDATE events
       SET first_slot_start = (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = events.id)
     WHERE id = ?
  `).run(eventId);
}

/**
 * Refreshes several events in one statement.
 *
 * Used by the backfill and the repair path. `IN (…)` rather than a loop for the
 * reason every other batch in this codebase gives: on PostgreSQL each statement
 * is a network round trip, and a repair over a district's events should not be
 * one round trip per event.
 */
export async function refreshEventSummaries(tx, eventIds) {
  if (!eventIds.length) return 0;
  const marks = eventIds.map(() => '?').join(',');
  await tx.prepare(`
    UPDATE events
       SET first_slot_start = (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = events.id)
     WHERE id IN (${marks})
  `).run(...eventIds);
  return eventIds.length;
}

/** Every event, for a backfill or a rebuild. One statement, whatever the size. */
export async function refreshAllEventSummaries(tx) {
  await tx.prepare(`
    UPDATE events
       SET first_slot_start = (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = events.id)
  `).run();
}

/**
 * Finds every event whose stored summary disagrees with its slots.
 *
 * This is the guard that makes storing a derived value defensible: the stored
 * column is only ever an optimisation of something still computable, so drift
 * is always detectable and always repairable. Returns the rows that disagree,
 * with both values, so a report can say what it found rather than only that
 * something was wrong.
 *
 * `IS DISTINCT FROM` is not available on SQLite, so the NULL cases are spelled
 * out. Getting this wrong in the other direction — using `<>`, which is NULL
 * for a NULL operand and therefore never true — would produce a checker that
 * reports success on exactly the drift it exists to find.
 */
export async function verifyEventSummaries(db, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT e.id,
           e.first_slot_start AS stored,
           (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) AS computed
      FROM events e
     WHERE (e.first_slot_start IS NULL) <> ((SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) IS NULL)
        OR e.first_slot_start <> (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id)
     LIMIT ?
  `).all(limit);
}
