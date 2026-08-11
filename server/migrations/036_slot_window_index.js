/**
 * A covering index for the event list's slot aggregate.
 *
 * ── What was slow ──
 *
 * `GET /api/events` derives four values per event from that event's slots —
 * earliest start, latest end, total capacity, total hours — because none of them
 * are stored. The WHERE clause and the ORDER BY both reference them, so the
 * aggregate cannot be deferred until after the page is chosen: to return the
 * twenty soonest events you have to know every event's earliest shift.
 *
 * That aggregate is the endpoint's floor, and at pilot-plus scale (10,000 events
 * over ~20,000 slots) it was reading four columns out of the `slots` TABLE for
 * every row, having found them through `idx_slots_event(event_id)`. An index on
 * the event id alone locates the rows; it does not carry the values, so each hit
 * cost a second read into the table heap.
 *
 * ── What this changes ──
 *
 * `(event_id, start_datetime, end_datetime, max_spots)` carries every column the
 * aggregate touches, in the order it groups by, so the whole thing becomes an
 * index-only scan. The query plan changes from
 *
 *     SEARCH s USING INDEX idx_slots_event (event_id=?)
 * to
 *     SEARCH s USING COVERING INDEX idx_slots_event_window (event_id=?)
 *
 * Measured on a 10,000-event / 19,928-slot / 59,784-application database, this
 * index alone accounts for roughly 10ms of the endpoint's remaining cost — the
 * rest of the improvement in this release comes from the query shape (see
 * eventQuery.js and eventRoutes.js). Small on its own, kept because it is the
 * part that keeps paying as the slot table grows.
 *
 * ── Write cost, measured rather than assumed ──
 *
 * 2,000 slot inserts: 6ms without this index, 10ms with it. Slots are written
 * when an organizer creates or edits an event — a handful of rows, a few times a
 * day — so 2µs per row is not a trade-off worth declining. It is NOT redundant
 * with `idx_slots_event`: that one is still the right index for the many places
 * that only need to find an event's slots, and dropping it would make those read
 * a wider index for no reason.
 *
 * ── Reversal ──
 *
 *     DROP INDEX idx_slots_event_window;
 *
 * Nothing depends on it for correctness; the endpoint answers identically
 * without it, only slower.
 */
function up(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_slots_event_window
      ON slots(event_id, start_datetime, end_datetime, max_spots)
  `);

  /* The planner needs statistics to prefer a wider covering index over the
     narrow one it has been using. Without this the index exists and goes
     unused, which is the worst of both — the write cost with none of the read
     benefit. Cheap on a table this size and re-run by later migrations anyway. */
  db.exec('ANALYZE');
}

export default {
  version: 36,
  name: 'slot_window_index',
  up,
  fileUrl: import.meta.url,
};
