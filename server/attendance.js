/**
 * Attendance — check-in and hours finalisation.
 *
 * ── Two stages, deliberately separate ────────────────────────────────────────
 *
 *   check-in     `attendance_checkin`   a working note taken during the event
 *   finalisation `attendance`           the permanent, credited record
 *
 * An organizer standing at a park needs to tick people off as they arrive. That
 * is not the same act as awarding service hours, and conflating the two is how
 * hours get credited for shifts that have not happened yet. Check-in marks are
 * freely editable and credit nothing. Finalisation is only possible once a
 * shift has ended, writes to `attendance`, and always writes a ledger entry.
 *
 * `attendance` therefore keeps exactly the meaning it has always had — which is
 * why none of the 24 existing hours queries need to change, and why no existing
 * volunteer total can move.
 *
 * ── Invariants enforced here ─────────────────────────────────────────────────
 *
 *  · A row is only ever written when named explicitly in a request. Anything
 *    unnamed is left alone, so a partial or stale request cannot mark people
 *    absent.
 *  · Hours are a snapshot. An existing credit keeps its stored `hours_awarded`
 *    for ever; only new credits are priced from the slot's current duration.
 *  · Attendance is independent of application status. A volunteer who attended
 *    keeps their hours no matter what happens to their application afterwards.
 *  · Changing an existing record requires a reason and is attributed to an actor.
 *  · Once the organizer has CLOSED THE HOURS OUT (`events.hours_closed_out_at`),
 *    an existing record can no longer be changed at all — by anyone, including
 *    an administrator. Corrections belong to the window between finalising and
 *    closing out; after it the record is the school's, not the organizer's. See
 *    the refusal in `finalizeAttendance`, and the route that sets the column for
 *    why the lock is a deliberate act rather than a consequence of `completed`.
 */

import { recordHoursChange } from './hoursLedger.js';
import { MAX_SLOT_HOURS } from './validation.js';
import { withSpan } from './observability/spans.js';
import { forUpdate } from './db/dialectSql.js';

/**
 * The check-in table, as a database created from scratch gets it.
 *
 * `method` is declared here AND added by migration 037, so that a fresh
 * database and a migrated one arrive at the same schema. This function runs
 * before `runMigrations`, so on a new database the column already exists when
 * 037 looks and its existence check skips the ALTER; on an existing database
 * the ALTER is what adds it. Neither path can produce a table the other would
 * not recognise.
 *
 * No CHECK constraint on `method`: SQLite cannot add one by ALTER TABLE, so
 * declaring one here would make the two paths genuinely differ. `recordCheckins`
 * enforces the enum instead.
 */
export function createCheckinTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_checkin (
      event_id   TEXT NOT NULL,
      slot_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      present    INTEGER CHECK(present IN (0,1)) NOT NULL,
      marked_by  TEXT,
      marked_at  TEXT NOT NULL,
      method     TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY(slot_id, user_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_checkin_event ON attendance_checkin(event_id)');
}

/** Hours a slot is worth, from its current duration. Only ever used for new credits. */
/**
 * The ceiling on hours an organizer may credit for one shift.
 *
 * A single shift cannot be longer than a day, so a number above this is a typo
 * or an attempt — and either way it is better refused at the screen than
 * discovered in a service record months later. There is no lower bound beyond
 * zero: crediting 0 for a shift somebody attended but did not complete is a
 * legitimate, if unkind, organizer decision, and `present` still records that
 * they turned up.
 */
export const MAX_CREDITABLE_HOURS = 24;

/**
 * The two constants are the same rule seen from two sides, so they are checked
 * rather than merely described as matching.
 *
 * `MAX_SLOT_HOURS` bounds how long a shift may BE; `MAX_CREDITABLE_HOURS`
 * bounds what may be credited FOR one. If they drift apart a slot becomes
 * creatable whose own default credit the cap would refuse — a shift somebody
 * can be rostered for and never paid for. The comment in validation.js claimed
 * this assertion existed; it did not, which is exactly the drift it was
 * describing. Thrown at module load, so it fails the boot and the suite rather
 * than one finalisation months later.
 */
if (MAX_SLOT_HOURS !== MAX_CREDITABLE_HOURS) {
  throw new Error(
    `MAX_SLOT_HOURS (${MAX_SLOT_HOURS}) and MAX_CREDITABLE_HOURS (${MAX_CREDITABLE_HOURS}) `
    + 'must agree: a shift cannot be longer than the hours it is allowed to credit.'
  );
}

/**
 * How far past a shift's scheduled length an organizer may still credit.
 *
 * Volunteers stay late, events overrun, and the scheduled duration is a plan
 * rather than a measurement — so an override has to be able to exceed it. Two
 * hours covers a genuine overrun on any shift this product models while still
 * refusing the numbers that indicate something is wrong rather than long.
 *
 * Absolute, not proportional: a multiplier would grant twelve hours of slack on
 * a long shift, where the schedule is most reliable, and almost none on a short
 * one, where running over is most likely.
 */
export const OVERRIDE_GRACE_HOURS = 2;

/**
 * The scheduled length of a shift, in hours, or `null` when the slot cannot say.
 *
 * ── Why `null` rather than a floor ──
 *
 * This returned `Math.max(0.1, …)`, and that floor was doing more than
 * rounding: it turned every unusable slot into a plausible-looking 0.1-hour
 * shift. `end < start` came back 0.1, indistinguishable from a six-minute
 * shift. `end == start` came back 0.1. A null `start_datetime` came back
 * ~490,000 — because `new Date(null)` is the epoch rather than an invalid date,
 * so the sign never went near a NaN anybody could have caught.
 *
 * A slot that cannot price itself must SAY so, so the caller can refuse the
 * credit and name the slot to the organizer. The alternative is what was there:
 * fabricating 0.1 hours onto a student's service record, or writing a NaN that
 * fails the NOT NULL constraint and surfaces as a 500 nobody can act on.
 *
 * Callers that only need a number for DISPLAY keep their own floor — see
 * `formatSlot` in eventRoutes.js. This one feeds `hours_awarded`, and a service
 * record is not a display.
 */
export function slotDuration(slot) {
  const startMs = Date.parse(slot?.start_datetime);
  const endMs = Date.parse(slot?.end_datetime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const hours = Number(((endMs - startMs) / 3600000).toFixed(2));
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return hours;
}

/**
 * Whether a shift is over.
 *
 * `null` — not `false` — when the end time cannot be read at all. The two are
 * different questions and were being answered the same way: `NaN <= x` is
 * false, so a slot with a missing or unparseable `end_datetime` reported "not
 * finished yet" and the organizer was told to come back later, for ever, about
 * a shift that has no end. That refusal is permanent and says nothing true.
 *
 * Callers distinguish the two, so an unreadable slot reaches the refusal that
 * names it instead of the one that asks for patience.
 */
export const slotHasEnded = (slot, now) => {
  const endMs = Date.parse(slot?.end_datetime);
  if (!Number.isFinite(endMs)) return null;
  return endMs <= new Date(now).getTime();
};

/**
 * Whether a shift has begun.
 *
 * Tri-state for exactly the reason `slotHasEnded` above is: `NaN <= x` is
 * false, so a slot whose `start_datetime` cannot be read would report "not
 * started yet" for ever, and a volunteer would be told to wait, permanently,
 * for a shift that has no beginning. Callers must test `!== true` and route
 * `null` to a refusal that names the broken slot.
 *
 * ── This is NOT used by manual check-in, and must not be ──
 *
 * `checkinWindowState` opens two hours EARLY and is per EVENT. This opens at
 * the start and is per SLOT, and it gates only one thing: whether a volunteer
 * may mint a QR code.
 *
 * The two differ because the instruments differ. A manual mark is an
 * organizer's judgement, attributed to them by name in `marked_by`, and setting
 * up ninety minutes early is the job. A QR code is a bearer credential, and a
 * bearer credential that is valid before the thing it attests to has begun is
 * one you can spend at home the night before.
 *
 * It is per slot rather than per event because check-in IS per slot —
 * `attendance_checkin`'s primary key is `(slot_id, user_id)`. On a two-day
 * festival, a per-event rule would let a Sunday volunteer's code work on
 * Saturday morning.
 *
 * Redemption deliberately does NOT re-check this. A code cannot exist before
 * its slot starts, so checking again at scan time would add a second time bound
 * without adding a guarantee — and check-in has an opening time and no closing
 * time on purpose (see `checkinWindowState`), so a volunteer arriving two hours
 * late is an ordinary case that must keep working.
 */
export const slotHasStarted = (slot, now) => {
  const startMs = Date.parse(slot?.start_datetime);
  if (!Number.isFinite(startMs)) return null;
  return startMs <= new Date(now).getTime();
};

/** Volunteers whose hours would be destroyed by removing these slots. */
export async function attendanceOnSlots(db, slotIds) {
  if (!slotIds.length) return [];
  const placeholders = slotIds.map(() => '?').join(',');
  return await db.prepare(`
    SELECT a.slot_id, a.user_id, a.present, a.hours_awarded,
           u.name AS user_name, s.name AS slot_name
    FROM attendance a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN slots s ON s.id = a.slot_id
    WHERE a.slot_id IN (${placeholders})
  `).all(...slotIds);
}

export async function eventAttendanceCount(db, eventId) {
  return (await db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE event_id = ?').get(eventId)).c;
}

/**
 * Whether an event has genuinely finished.
 *
 * Completion is what makes an event immutable, so getting it wrong is
 * expensive in both directions: too eager and a multi-day event freezes after
 * its first morning, with the remaining shifts uncreditable for ever; too lazy
 * and finished events stay editable.
 *
 * An event is complete when every slot has ended AND every accepted
 * application has an attendance record. An event with no slots, or no accepted
 * volunteers, is never auto-completed — there is nothing to have finished.
 */
export async function computeEventCompletion(db, eventId, now) {
  const slots = await db.prepare('SELECT id, end_datetime FROM slots WHERE event_id = ?').all(eventId);
  if (slots.length === 0) return { complete: false, reason: 'no_slots' };

  /* `!== true` rather than `!`: a slot whose end time cannot be read is not
     finished either, and treating `null` as "done" would let an event complete
     — and become immutable — on a shift nobody can evaluate. */
  const unfinished = slots.filter(s => slotHasEnded(s, now) !== true);
  if (unfinished.length > 0) {
    return { complete: false, reason: 'shifts_remaining', remaining: unfinished.length };
  }

  const outstanding = (await db.prepare(`
    SELECT COUNT(*) AS c
    FROM applications ap
    WHERE ap.event_id = ? AND ap.status = 'accepted'
      AND NOT EXISTS (
        SELECT 1 FROM attendance at
        WHERE at.slot_id = ap.slot_id AND at.user_id = ap.user_id
      )
  `).get(eventId)).c;

  if (outstanding > 0) {
    return { complete: false, reason: 'attendance_outstanding', outstanding };
  }

  const total = (await db.prepare(
    "SELECT COUNT(*) AS c FROM applications WHERE event_id = ? AND status = 'accepted'"
  ).get(eventId)).c;
  if (total === 0) return { complete: false, reason: 'no_volunteers' };

  return { complete: true };
}

/**
 * How long before a shift starts an organizer may begin marking arrivals.
 *
 * Two hours covers setting up early and a volunteer who turns up ahead of time,
 * and it is short enough that "present" keeps meaning somebody was actually
 * there. Marking a roster present days in advance is not check-in; it is a
 * prediction, and it is the shape of an attendance record that was filled in
 * rather than observed.
 */
export const CHECKIN_OPENS_BEFORE_MS = 2 * 60 * 60 * 1000;

/**
 * Whether check-in is open for this event, and when it opens if not.
 *
 * ── Why there is an opening time but no closing time ──
 *
 * The risk being closed off is marking people present for something that has
 * not happened. That risk is entirely in the past direction, so the guard is
 * too.
 *
 * A closing time would be a different thing wearing the same clothes:
 * organizers reconcile attendance after the fact — somebody arrives late, a
 * name is missed, a paper list gets typed up on Monday — and a deadline there
 * would destroy an organizer's ability to correct the record without
 * preventing a single dishonest mark. Under the decision rules that govern this
 * repository (prefer preserving data, prefer preventing silent loss), an upper
 * bound costs more than it protects. `finalizeAttendance` already refuses to
 * credit a slot that has not ended, which is where the real money is.
 *
 * An event with no slots at all reports open: there is no time to be early
 * relative to, and `recordCheckins` refuses every application anyway.
 */
export async function checkinWindowState(db, event, now) {
  const earliest = (await db.prepare(
    'SELECT MIN(start_datetime) AS start FROM slots WHERE event_id = ?'
  ).get(event.id))?.start;

  if (!earliest) return { open: true, opensAt: null };

  const opensAtMs = new Date(earliest).getTime() - CHECKIN_OPENS_BEFORE_MS;
  if (!Number.isFinite(opensAtMs)) return { open: true, opensAt: null };

  return {
    open: new Date(now).getTime() >= opensAtMs,
    opensAt: new Date(opensAtMs).toISOString(),
  };
}

/**
 * Records check-in marks. Never touches `attendance`, never credits anything,
 * never writes to the ledger — nothing here changes anyone's hours.
 */
export async function recordCheckins(db, { event, checkinMap, actor, now, method = 'manual' }) {
  /**
   * `method` records HOW the mark was taken, and defaults to 'manual' so the
   * existing route needs no change at all.
   *
   * SQLite cannot add a CHECK constraint to an existing table without
   * rebuilding it, and rebuilding `attendance_checkin` is out of scope, so the
   * enum is enforced here instead. A typo would otherwise write a value nothing
   * can interpret into a column an organizer is shown.
   */
  if (method !== 'manual' && method !== 'qr') {
    throw new Error(`recordCheckins: unknown method '${method}'`);
  }

  const upsert = await db.prepare(`
    INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_by, marked_at, method)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_id, user_id) DO UPDATE SET
      present = excluded.present, marked_by = excluded.marked_by,
      marked_at = excluded.marked_at, method = excluded.method
  `);

  let marked = 0;
  const skipped = [];

  for (const [applicationId, present] of Object.entries(checkinMap || {})) {
    const app = await db.prepare(
      'SELECT id, event_id, slot_id, user_id, status FROM applications WHERE id = ?'
    ).get(applicationId);

    if (!app || app.event_id !== event.id || app.status !== 'accepted') {
      skipped.push(applicationId);
      continue;
    }

    await upsert.run(event.id, app.slot_id, app.user_id, present ? 1 : 0, actor.id, now, method);
    marked++;
  }

  return { marked, skipped };
}

export async function getCheckins(db, eventId) {
  return await db.prepare('SELECT * FROM attendance_checkin WHERE event_id = ?').all(eventId);
}

/**
 * Finalises attendance into credited hours.
 *
 * Two passes on purpose. The first decides what would change and whether a
 * reason is required; only if it is satisfied does the second write anything.
 * Validating mid-write would leave a half-applied save behind.
 *
 * Caller is responsible for wrapping this in a transaction.
 */
export async function finalizeAttendance(db, { event, attendanceMap, hoursMap, reason, actor, now }) {
  /**
   * Given a span because this is where service hours become real.
   *
   * Everything downstream of it — a student's transcript, a certificate, the
   * hours ledger's parity check — is derived from what this function writes, so
   * "the hours are wrong" is always ultimately a question about one of these
   * calls. It is also the longest single database interaction in the
   * application: a transaction over every attendee on the event, with a ledger
   * write each.
   *
   * No attendee count, no event id, no actor. `wev.count` exists on the
   * allowlist and is deliberately not passed: the number of attendees on an
   * event at a named school at a named time is closer to identifying than it
   * looks, and the aggregate is already in `wev.business.operations`.
   */
  return withSpan('attendance.finalize', { component: 'attendance' }, () =>
    finalizeAttendanceInner(db, { event, attendanceMap, hoursMap, reason, actor, now }));
}

async function finalizeAttendanceInner(db, { event, attendanceMap, hoursMap, reason, actor, now }) {
  const entries = Object.entries(attendanceMap || {});
  const planned = [];
  const skipped = [];
  const notEnded = [];
  const invalidHours = [];
  /* Slots whose stored times cannot produce a duration — see the refusal below. */
  const unpriceable = [];
  /* Already-credited records this request would change on a closed-out event. */
  const locked = [];

  /**
   * Whether the hours for this event have been closed out.
   *
   * ── Why this is its own column and not `status = 'completed'` ──
   *
   * `completed` is not a decision anybody makes. It is written by
   * `computeEventCompletion` the instant every accepted volunteer has a record —
   * a side effect of ticking the last checkbox. Locking on it would mean that on
   * a single-volunteer event the very FIRST save both credits the student and
   * freezes the number, with no moment in between in which to notice a mistyped
   * 40. The reason field below and the hours ledger exist precisely because
   * corrections are expected.
   *
   * It would also contradict a promise the product already makes out loud:
   * `PUT /api/events/:id` refuses a completed event with "This event is complete
   * and its details can no longer be changed. Attendance can still be
   * corrected."
   *
   * So the lock is an act — `POST /api/events/:id/hours/close-out`, offered only
   * once the event IS complete, confirmed, attributed and one-way. Everything
   * before it stays correctable exactly as it was.
   *
   * A string holding WHEN rather than a boolean, so the trail can say when.
   *
   * ── Re-read INSIDE the transaction, not taken from `event` ──
   *
   * `event` was fetched by the route before the transaction opened, and between
   * that read and this write there is a whole request's worth of time —
   * authorization, the host check, several awaits. A close-out committing in
   * that window would be invisible to a correction judged against the stale
   * snapshot, and the correction would land on hours that had just been made
   * permanent. That is the one outcome this feature exists to prevent, so it is
   * not left to how quickly two organizers happen to click.
   *
   * Reading it here puts the check and the write in the same transaction. On
   * SQLite that closes the window outright, because the engine serialises the
   * writer.
   *
   * ── `FOR UPDATE`, because on PostgreSQL the re-read alone does not ──
   *
   * It was a plain SELECT, on the reasoning that READ COMMITTED returns the
   * value as of this statement rather than as of the route's. True, and not
   * sufficient: the statement's snapshot says nothing about what commits
   * AFTERWARDS. The close-out is a bare autocommit CAS
   * (`attendanceRoutes.js`), and this transaction holds no lock on `events` —
   * it writes `attendance` — so a close-out committing between this read and
   * the upsert below is not blocked by anything, and the correction commits on
   * top of it.
   *
   * Measured on real PostgreSQL with two connections, the statements this code
   * actually issues:
   *
   *   plain SELECT, close-out during the window
   *     → commit order: close-out → correction        INVARIANT VIOLATED
   *   FOR UPDATE, close-out during the window
   *     → commit order: correction → close-out        held: the correction
   *       landed while the hours were still open, which is legitimate, and the
   *       close-out blocked until this transaction committed
   *   FOR UPDATE, close-out already committed
   *     → this read returns the timestamp and the submission is refused
   *
   * So the row is locked for the life of this transaction, which makes the two
   * acts serialise instead of overlapping. `forUpdate` is empty on SQLite, so
   * nothing changes there.
   *
   * Falls back to the route's copy if the row cannot be read — a database that
   * cannot answer this is not a database this should be writing hours to
   * either, and the surrounding `try` turns any failure into a refusal rather
   * than an unguarded write.
   */
  let eventClosedOut = Boolean(event.hours_closed_out_at);
  try {
    const fresh = await db.prepare(
      `SELECT hours_closed_out_at FROM events WHERE id = ?${forUpdate(db)}`
    ).get(event.id);
    eventClosedOut = Boolean(fresh?.hours_closed_out_at);
  } catch { /* keep the route's answer; see above */ }

  /**
   * The event may not measure service in hours at all.
   *
   * A donation drive still has a roster and still records who turned up; it
   * just credits nothing. Attendance is written with `hours_awarded = 0` so
   * that every SUM and the ledger's parity check keep working untouched — the
   * meaning lives on `events.credits_hours`, which every display path reads
   * before it formats a number. An organizer-supplied hours correction on such
   * an event is ignored rather than refused, because there is nothing there to
   * correct.
   */
  const awardsHours = event.credits_hours !== 0;

  for (const [applicationId, rawPresent] of entries) {
    const present = rawPresent ? 1 : 0;

    const app = await db.prepare(`
      SELECT ap.id, ap.event_id, ap.slot_id, ap.user_id, ap.status,
             u.name AS user_name, s.name AS slot_name,
             s.start_datetime, s.end_datetime
      FROM applications ap
      LEFT JOIN users u ON u.id = ap.user_id
      LEFT JOIN slots s ON s.id = ap.slot_id
      WHERE ap.id = ?
    `).get(applicationId);

    if (!app || app.event_id !== event.id) {
      skipped.push({ applicationId, why: 'unknown_application' });
      continue;
    }

    const prior = await db.prepare(
      'SELECT present, hours_awarded FROM attendance WHERE slot_id = ? AND user_id = ?'
    ).get(app.slot_id, app.user_id);

    // Attendance is historical participation, so an existing record stays
    // correctable however the application status has moved since. But a
    // volunteer who was never accepted and has no record cannot acquire one.
    if (app.status !== 'accepted' && !prior) {
      skipped.push({ applicationId, why: 'not_accepted' });
      continue;
    }

    /**
     * ── A closed-out event's credited records are final ──
     *
     * Decided HERE, before the shift, pricing and range checks, because on such
     * a record the answer to all three is irrelevant: nothing can be written to
     * it whatever they say. Left until after them, an organizer typing 12 hours
     * onto a 4-hour shift whose hours were closed out last spring was told the
     * number was out of range — true, and not the reason, and it invites them
     * to try 5 instead. The reason is that the hours are closed.
     *
     * "Would change" rather than "was submitted": the Closeout screen seeds its
     * checkboxes from the existing records, so every row arrives in the payload
     * every time the tab is opened. A lock that fired on submission would make
     * the screen unopenable on every completed event on the platform.
     *
     * The three ways a submission asks for a change, and nothing else counts:
     *
     *   · the present flag differs from what is stored
     *   · an hours figure is supplied that differs from what is stored
     *   · an hours figure is supplied that is not a number at all — still an
     *     attempted write, and refused as one rather than as bad input
     *
     * Rows with NO stored record are untouched by this. See the note on
     * `locked` below the loop for why that is deliberate.
     */
    if (eventClosedOut && prior) {
      const supplied = hoursMap && Object.hasOwn(hoursMap, applicationId)
        ? hoursMap[applicationId] : undefined;
      const asksForHours = supplied !== undefined && supplied !== null && supplied !== '';
      const suppliedHours = asksForHours ? Number(supplied) : null;
      const changesHours = asksForHours
        && (!Number.isFinite(suppliedHours) || suppliedHours !== prior.hours_awarded);

      if (present !== prior.present || changesHours) {
        locked.push({
          applicationId,
          name: app.user_name,
          slotName: app.slot_name,
          from: prior.present === 1 ? 'present' : 'absent',
          to: present === 1 ? 'present' : 'absent',
          hoursFrom: prior.hours_awarded,
          hoursTo: asksForHours ? suppliedHours : prior.hours_awarded,
        });
      } else {
        skipped.push({ applicationId, why: 'unchanged' });
      }
      continue;
    }

    /* `false` means "not yet"; `null` means the end time cannot be read, which
       is a different problem with a different answer. Only the first is a
       reason to come back later — the second falls through to the unpriceable
       check below, which names the shift so somebody can fix it. */
    if (slotHasEnded(app, now) === false) {
      notEnded.push({ applicationId, slotName: app.slot_name, endsAt: app.end_datetime });
      continue;
    }

    /**
     * The actual hours the volunteer completed, when the organizer supplies
     * them.
     *
     * A volunteer scheduled for four hours who leaves after two and a half did
     * two and a half, and one who stays an extra hour did four. The scheduled
     * slot duration is a default, not a fact, and until now it was the only
     * thing that could ever be credited.
     *
     * The override is the SOURCE OF TRUTH, and the client's "left early"
     * checkbox is only a way of computing a number to put here. A boolean
     * cannot say how early, so a checkbox alone would either credit nothing or
     * guess — both worse than the scheduled duration it replaced.
     *
     * When no override is given the existing rule is untouched: an existing
     * credit keeps its original value permanently, and a new one is priced from
     * the slot. That invariant is what stops an edit to a slot's times
     * re-pricing service somebody already performed.
     */
    /**
     * The slot's own scheduled length, or `null` when it cannot say.
     *
     * Needed for two separate decisions below: pricing a NEW credit, and
     * bounding an override. Computed once so the two cannot disagree.
     */
    const scheduled = slotDuration(app);

    /**
     * A slot that cannot price itself does not get to price a service record.
     *
     * `slotDuration` used to floor at 0.1, which meant a slot with reversed,
     * equal or unparseable times produced a plausible-looking six-minute shift
     * and wrote it to a student's record — or produced a NaN that failed the
     * NOT NULL constraint and surfaced as a 500 with nothing an organizer could
     * act on. Neither is a decision anybody made.
     *
     * Only NEW credits are affected. An existing credit keeps its stored value
     * whatever the slot says now, which is the snapshot invariant, and is also
     * what stops this refusal reaching back through history: a record already
     * written stays written.
     */
    /**
     * ── Refused only when there is no other way to price it ──
     *
     * Three conditions were missing, and each one turned a guard into a trap:
     *
     *   `present === 1` — marking somebody ABSENT credits nothing and needs no
     *     duration, so a broken slot was blocking the recording of absences.
     *   `!hasOverride` — the organizer typing the hours IS the remedy. Refusing
     *     even then left no in-product way forward at all: the message says to
     *     correct the shift times, and `PUT /api/events/:id` refuses any event
     *     whose application deadline has passed — which is every event anybody
     *     is finalising attendance on. One mistyped slot would have blocked the
     *     entire roster permanently.
     *
     * With an override the number comes from a human who was there, which is
     * the opposite of the fabrication this guard exists to prevent — and it is
     * still bounded, at `MAX_CREDITABLE_HOURS`, because a slot that cannot price
     * itself cannot offer a tighter ceiling.
     *
     * The refusal is whole-request, so every one of these conditions protects
     * every other volunteer on the event as well as this one.
     */
    const hasOverride = hoursMap && Object.hasOwn(hoursMap, applicationId)
      && hoursMap[applicationId] !== null && hoursMap[applicationId] !== '';

    if (!prior && present === 1 && awardsHours && scheduled === null && !hasOverride) {
      unpriceable.push({
        applicationId, name: app.user_name, slotName: app.slot_name,
        startDatetime: app.start_datetime ?? null,
        endDatetime: app.end_datetime ?? null,
      });
      continue;
    }

    let hours = prior ? prior.hours_awarded : (scheduled ?? 0);
    let hoursOverridden = false;

    /**
     * An hours figure is only meaningful for somebody who was THERE.
     *
     * `present` was not part of this condition, so `{present: false, hours: 24}`
     * wrote `attendance(present = 0, hours_awarded = 24)`. That row is excluded
     * from every `WHERE present = 1` sum, so nothing looked wrong and the ledger
     * stayed in parity — but the number sat there as the record's stored value.
     * A later, entirely legitimate flip to present, carrying a reason and no
     * `hoursMap`, then inherited it through `prior.hours_awarded` above and
     * credited twenty-four hours for a two-hour slot, with no override appearing
     * in any request. Two individually innocuous calls, and the slot-pricing
     * rule bypassed between them.
     *
     * Ignored rather than refused: the client already declines to send hours for
     * an absent volunteer, so anything arriving here is a bug or a hand-made
     * request, and there is no organizer to show an error to. The stored value
     * for an absent row stays whatever the slot said, which is the same thing it
     * would have been had the field never been sent.
     */
    if (present === 1 && awardsHours && hoursMap && Object.hasOwn(hoursMap, applicationId)) {
      const supplied = hoursMap[applicationId];
      /**
       * `null` is refused rather than coerced.
       *
       * `Number(null)` is 0, and 0 is a legitimate value here — an organizer
       * may credit nothing for a shift somebody turned up to and did not
       * complete. So a null arriving from a client bug, or from a JSON
       * round-trip that turned a NaN into a null, would silently write a real
       * decision nobody made, onto a student's graduation record. A number, or
       * a string that is one, or nothing at all.
       */
      const raw = (supplied === null || supplied === '' || typeof supplied === 'boolean')
        ? NaN
        : Number(supplied);
      /**
       * ── An override is bounded by the SHIFT, not only by the absolute cap ──
       *
       * `MAX_CREDITABLE_HOURS` is 24, and it was the only ceiling. So a
       * six-minute slot accepted a 24-hour credit — 240 times what the shift was
       * worth — and a slot with an unparseable start date accepted one too,
       * because `NaN !== 4` marked it "overridden" and the fabricated value
       * became the record. That is the override rescuing data the pricing rule
       * had already refused to touch.
       *
       * The bound is the slot's own length plus a grace margin rather than the
       * length itself, because staying late is the case this feature exists for:
       * the module's own note says a volunteer rostered for four hours who works
       * five did five. What must be refused is 24 hours on a six-minute slot,
       * not four hours on a three-hour one.
       *
       * `OVERRIDE_GRACE_HOURS` is absolute rather than proportional on purpose.
       * A multiplier scales the wrong way — it grants 12 hours of slack on a
       * long shift, where the schedule is most reliable, and almost none on a
       * short one, where running over is most likely.
       */
      const ceiling = scheduled === null
        ? MAX_CREDITABLE_HOURS
        : Math.min(MAX_CREDITABLE_HOURS, scheduled + OVERRIDE_GRACE_HOURS);

      if (!Number.isFinite(raw) || raw < 0 || raw > ceiling) {
        invalidHours.push({
          applicationId, name: app.user_name, slotName: app.slot_name, value: supplied,
          scheduledHours: scheduled, maxHours: Number(ceiling.toFixed(2)),
        });
        continue;
      }
      const rounded = Number(raw.toFixed(2));
      if (rounded !== hours) { hours = rounded; hoursOverridden = true; }
    }

    if (!awardsHours) hours = 0;

    /* An unchanged record with an unchanged number is genuinely nothing to do.
       This check moved below the hours calculation so that correcting ONLY the
       hours — same present flag, different number — is no longer skipped as
       "unchanged", which is the single most likely reason to open this screen
       a second time. */
    if (prior && prior.present === present && !hoursOverridden) {
      skipped.push({ applicationId, why: 'unchanged' });
      continue;
    }

    planned.push({ app, prior: prior || null, present, hours, hoursOverridden });
  }

  /**
   * ── Once the event is closed out, a credited record is final ──
   *
   * `events.status = 'completed'` is not a label. It is written by exactly one
   * place — the finalise route, when `computeEventCompletion` reports that every
   * shift has ended and every accepted volunteer has been accounted for — and
   * once written it cannot be written back: `PATCH /api/events/:id/status`
   * refuses a completed event outright. It is the moment the organizer's
   * judgement about who served becomes the school's record of who served, which
   * is also the moment a student's certificate and their hours total start being
   * quoted to somebody outside this system.
   *
   * Up to that point corrections are not merely allowed, they are expected — a
   * volunteer marked absent who was there, a shift credited at four hours that
   * ran to two and a half. That is what the reason field below exists for, and
   * nothing here narrows it.
   *
   * After it, no. The screen carried no bound at all: an organizer could reopen
   * Closeout on an event finished last spring and move a graduating student's
   * hours, with a one-line reason, and every downstream figure — the transcript,
   * the certificate, the Silver Award progress bar, the Impact Dashboard — would
   * silently follow.
   *
   * ── What is locked, and what is not ──
   *
   * Only rows that ALREADY HAVE a credited record, and only when the submission
   * would actually change one — both decided in the loop above, where the row's
   * stored values are already in hand. An unchanged row is still reported as
   * `skipped: 'unchanged'`, so opening the screen on a completed event and
   * pressing save without editing anything is a no-op rather than a refusal.
   *
   * A volunteer with NO record is deliberately still creditable. Completion is
   * computed from the accepted roster at the moment it was reached, so somebody
   * accepted afterwards has never been finalised at all; refusing them would
   * mean a student who worked the shift can never be credited for it by anyone.
   * Awarding them nothing is not "no takebacksies", it is a different loss.
   *
   * ── Why this refusal is checked FIRST ──
   *
   * Ahead of `invalid_hours`, `slot_unpriceable` and `shift_not_ended`, because
   * on a locked record none of those questions has any bearing on the outcome.
   * Reporting "that is more hours than the shift can account for" to somebody
   * editing an event that closed last spring is true, unhelpful, and an
   * invitation to try a smaller number.
   *
   * ── Why here and not only in the route ──
   *
   * `finalizeAttendance` is the only writer to `attendance` in the codebase, and
   * a guard in the route is a guard on one caller. This is the floor.
   */
  if (locked.length > 0) {
    return {
      ok: false,
      error: 'hours_locked',
      /* Deliberately does not promise a way round it. There is no
         administrator override path today — `admin_correction` exists in the
         ledger's enum with no writer — and a refusal that names a remedy which
         does not exist sends an organizer to ask for something nobody can do. */
      message: 'The hours for this event have been closed out, so they are final. '
        + `${locked.length} record${locked.length === 1 ? '' : 's'} would change. `
        + 'Closing out is deliberate and cannot be undone.',
      locked,
    };
  }

  if (invalidHours.length > 0) {
    return {
      ok: false,
      error: 'invalid_hours',
      message: 'Those hours are more than the shift can account for. '
        + `An entry may be between 0 and the shift's scheduled length plus ${OVERRIDE_GRACE_HOURS} hours, `
        + `and never more than ${MAX_CREDITABLE_HOURS}.`,
      invalidHours
    };
  }

  /**
   * A slot whose times cannot produce a duration is a broken event, not a
   * broken request — so it is a 409 naming the shift, not a 400.
   *
   * Previously this path either fabricated 0.1 hours onto a service record or
   * wrote a NaN that failed the NOT NULL constraint and surfaced as a 500 with
   * nothing an organizer could act on. Naming the slot is what lets somebody go
   * and fix the event, which is the only real remedy.
   */
  if (unpriceable.length > 0) {
    return {
      ok: false,
      error: 'slot_unpriceable',
      message: `${unpriceable.length === 1 ? 'A shift has' : `${unpriceable.length} shifts have`} `
        + 'start and end times that do not describe a real span, so hours cannot be worked out '
        + 'from them. Correct the shift times on the event, then finalize again.',
      unpriceable
    };
  }

  // A shift that has not finished cannot be credited. Check-in is the tool for
  // marking people during an event.
  if (notEnded.length > 0) {
    return {
      ok: false,
      error: 'shift_not_ended',
      message: `Hours can only be finalized after a shift has ended. ${notEnded.length} of the shifts you submitted are still to come — use check-in for those.`,
      notEnded
    };
  }

  /* A correction is any change to a record that already existed — including an
     hours-only change. Re-pricing somebody's service record without saying why
     is exactly what the reason requirement exists to prevent. */
  const corrections = planned.filter(p => p.prior !== null);
  if (corrections.length > 0 && !String(reason || '').trim()) {
    return {
      ok: false,
      error: 'reason_required',
      message: `Changing an existing attendance record needs a reason. ${corrections.length} volunteer record(s) would change.`,
      corrections: corrections.map(c => ({
        name: c.app.user_name,
        slotName: c.app.slot_name,
        from: c.prior.present === 1 ? 'present' : 'absent',
        to: c.present === 1 ? 'present' : 'absent',
        hoursFrom: c.prior.hours_awarded,
        hoursTo: c.hours
      }))
    };
  }

  const upsert = await db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slot_id, user_id) DO UPDATE SET
      present = excluded.present, hours_awarded = excluded.hours_awarded
  `);

  const credited = [];
  const revoked = [];

  for (const p of planned) {
    await upsert.run(event.id, p.app.slot_id, p.app.user_id, p.present, p.hours);

    const wasCredited = p.prior ? p.prior.present === 1 : false;
    const isCredited = p.present === 1;
    /**
     * `adjusted` is a distinct ledger action from `credited`, and the
     * distinction matters to anybody reading the trail later. "Credited 2.5"
     * after "credited 4" reads as two separate awards; "adjusted 4 → 2.5" reads
     * as what actually happened. The enum has carried `adjusted` since the
     * ledger shipped with no production writer; this is it.
     */
    const action = wasCredited && !isCredited ? 'revoked'
      : (wasCredited && isCredited && p.hoursOverridden) ? 'adjusted'
        : 'credited';

    await recordHoursChange(db, {
      userId: p.app.user_id,
      eventId: event.id,
      slotId: p.app.slot_id,
      userName: p.app.user_name,
      eventTitle: event.title,
      slotName: p.app.slot_name,
      action,
      presentBefore: p.prior ? p.prior.present : null,
      hoursBefore: p.prior ? p.prior.hours_awarded : null,
      presentAfter: p.present,
      hoursAfter: p.hours,
      actorId: actor.id,
      actorRole: actor.role,
      source: 'attendance_screen',
      reason: p.prior ? String(reason).trim() : null,
      createdAt: now
    });

    (isCredited ? credited : revoked).push({
      userId: p.app.user_id,
      name: p.app.user_name,
      slotName: p.app.slot_name,
      hours: p.hours,
      wasCredited,
      /**
       * The ledger action, carried out to the caller.
       *
       * The route dispatches a notification per credited row and had only
       * `hours` to go on, so it said "Volunteer hours added — you earned 1
       * hours" to somebody whose four hours had just been CUT to one: an
       * `adjusted` row is in `credited`, because `credited` means "ends up with
       * a credit", not "gained one". The ledger learned this distinction in
       * v1.3 and the notification loop was never told.
       */
      action,
      /* Whether this event measures service in hours at all. A donation drive
         credits attendance and no hours, and "you earned 0 hours" is the wrong
         sentence for it — every other surface checks the flag first. */
      awardsHours,
      hoursBefore: p.prior ? p.prior.hours_awarded : null,
    });
  }

  return {
    ok: true,
    credited,
    revoked,
    unchanged: skipped.filter(s => s.why === 'unchanged').length,
    skipped: skipped.filter(s => s.why !== 'unchanged')
  };
}
