/**
 * Closing out an event's hours — the deliberate act that makes them permanent.
 *
 * ── The decision this records, and why it is not `status` ──
 *
 * Credited hours had no end state at all: `finalizeAttendance` refused a
 * cancelled event and an un-ended shift, and had no opinion about an event that
 * finished last spring. So an organizer could reopen the Closeout tab on any
 * past event and move a graduating student's hours, with a one-line reason, and
 * every downstream figure would follow it silently.
 *
 * The obvious fix is to lock on `events.status = 'completed'`, and it is wrong
 * for two reasons that only show up when you look at what `completed` IS:
 *
 *   1. **Nobody decides it.** It is written by `computeEventCompletion` the
 *      instant every accepted volunteer has a record — a side effect of ticking
 *      the last checkbox. On a single-volunteer event the FIRST save both
 *      credits the student and freezes the number, so a mistyped 40 is
 *      permanent before anyone has looked at it. The reason-required field and
 *      the hours ledger exist precisely because corrections are expected.
 *   2. **The product already promises the opposite.** `PUT /api/events/:id`
 *      refuses a completed event with "This event is complete and its details
 *      can no longer be changed. *Attendance can still be corrected.*" That
 *      carve-out is deliberate and documented; locking on `completed` makes the
 *      sentence a lie.
 *
 * ── Why not a fifth `status` value ──
 *
 * Considered and rejected. `events.status` is read in about twenty places, and
 * several of them are `NOT IN ('completed', 'cancelled')` — account deletion
 * eligibility, the organizer's active-events count, badge evaluation. A new
 * terminal value means auditing every one of them, and each site that is missed
 * is a silent authorization or retention bug rather than a visible failure.
 * `status` answers "what is happening with this event"; it should not also have
 * to answer "is the service record final".
 *
 * ── What these two columns buy beyond the lock ──
 *
 * Attribution. Nothing in the schema recorded who froze a student's service
 * record or when — the ledger records every CHANGE to hours and nothing records
 * the decision to allow no more. `hours_closed_out_by` is the organizer who
 * pressed it, so the trail answers that question the way it answers every other.
 *
 * ── Additive on both engines ──
 *
 * Two nullable columns, no default, no backfill. NULL means "still correctable",
 * which is what every existing event is and what every event should be until
 * somebody says otherwise. No table rebuild is needed on either engine, so
 * unlike migration 057 this one carries no guard set — there is nothing
 * destructive to guard.
 *
 * Deliberately NOT added to `db.js`'s `CREATE TABLE`. Migration 057 rebuilds
 * `events` from an explicit column list and refuses any column it does not know
 * about; the bootstrap runs BEFORE the registry, so a column declared there
 * would exist by the time 057 looked and would fail that guard on every fresh
 * database. Adding it here instead keeps 057's list true at the moment 057
 * runs. A fresh PostgreSQL database still gets the columns, because its schema
 * is generated from a fully-migrated SQLite one.
 */

/** Adds a column only if it is absent, so a re-run is a no-op. */
function addColumnIfMissing(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function up(db) {
  const exists = db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'events'"
  ).get();
  if (!exists) return; // fresh database; db.js has not run yet

  addColumnIfMissing(db, 'events', 'hours_closed_out_at', 'TEXT');
  addColumnIfMissing(db, 'events', 'hours_closed_out_by', 'TEXT');
}

/**
 * The same two columns on PostgreSQL.
 *
 * `ADD COLUMN IF NOT EXISTS` rather than a catalogue probe: PostgreSQL has the
 * clause, it is atomic, and it makes the re-run case the database's problem
 * rather than a read-then-write race in application code.
 *
 * No foreign key on `hours_closed_out_by`, matching `attendance_checkin.marked_by`
 * and the hours ledger's `actor_id`. Attribution outlives the account: a
 * deleted organizer must not take with them the record of who froze a student's
 * hours, and a `REFERENCES users(id) ON DELETE SET NULL` would erase exactly
 * that at exactly the moment it matters most.
 */
async function postgresUp(db) {
  await db.exec(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS hours_closed_out_at text;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS hours_closed_out_by text;
  `);
}

export default {
  version: 58,
  name: 'hours_close_out',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
