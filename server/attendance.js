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
 */

import { recordHoursChange } from './hoursLedger.js';

export function createCheckinTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_checkin (
      event_id   TEXT NOT NULL,
      slot_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      present    INTEGER CHECK(present IN (0,1)) NOT NULL,
      marked_by  TEXT,
      marked_at  TEXT NOT NULL,
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

export const slotHasEnded = (slot, now) => new Date(slot.end_datetime) <= new Date(now);

/** Volunteers whose hours would be destroyed by removing these slots. */
export function attendanceOnSlots(db, slotIds) {
  if (!slotIds.length) return [];
  const placeholders = slotIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT a.slot_id, a.user_id, a.present, a.hours_awarded,
           u.name AS user_name, s.name AS slot_name
    FROM attendance a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN slots s ON s.id = a.slot_id
    WHERE a.slot_id IN (${placeholders})
  `).all(...slotIds);
}

export function eventAttendanceCount(db, eventId) {
  return db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE event_id = ?').get(eventId).c;
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
export function computeEventCompletion(db, eventId, now) {
  const slots = db.prepare('SELECT id, end_datetime FROM slots WHERE event_id = ?').all(eventId);
  if (slots.length === 0) return { complete: false, reason: 'no_slots' };

  const unfinished = slots.filter(s => !slotHasEnded(s, now));
  if (unfinished.length > 0) {
    return { complete: false, reason: 'shifts_remaining', remaining: unfinished.length };
  }

  const outstanding = db.prepare(`
    SELECT COUNT(*) AS c
    FROM applications ap
    WHERE ap.event_id = ? AND ap.status = 'accepted'
      AND NOT EXISTS (
        SELECT 1 FROM attendance at
        WHERE at.slot_id = ap.slot_id AND at.user_id = ap.user_id
      )
  `).get(eventId).c;

  if (outstanding > 0) {
    return { complete: false, reason: 'attendance_outstanding', outstanding };
  }

  const total = db.prepare(
    "SELECT COUNT(*) AS c FROM applications WHERE event_id = ? AND status = 'accepted'"
  ).get(eventId).c;
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
export function checkinWindowState(db, event, now) {
  const earliest = db.prepare(
    'SELECT MIN(start_datetime) AS start FROM slots WHERE event_id = ?'
  ).get(event.id)?.start;

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
export function recordCheckins(db, { event, checkinMap, actor, now }) {
  const upsert = db.prepare(`
    INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_by, marked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_id, user_id) DO UPDATE SET
      present = excluded.present, marked_by = excluded.marked_by, marked_at = excluded.marked_at
  `);

  let marked = 0;
  const skipped = [];

  for (const [applicationId, present] of Object.entries(checkinMap || {})) {
    const app = db.prepare(
      'SELECT id, event_id, slot_id, user_id, status FROM applications WHERE id = ?'
    ).get(applicationId);

    if (!app || app.event_id !== event.id || app.status !== 'accepted') {
      skipped.push(applicationId);
      continue;
    }

    upsert.run(event.id, app.slot_id, app.user_id, present ? 1 : 0, actor.id, now);
    marked++;
  }

  return { marked, skipped };
}

export function getCheckins(db, eventId) {
  return db.prepare('SELECT * FROM attendance_checkin WHERE event_id = ?').all(eventId);
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
export function finalizeAttendance(db, { event, attendanceMap, hoursMap, reason, actor, now }) {
  const entries = Object.entries(attendanceMap || {});
  const planned = [];
  const skipped = [];
  const notEnded = [];
  const invalidHours = [];
  /* Slots whose stored times cannot produce a duration — see the refusal below. */
  const unpriceable = [];

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

    const app = db.prepare(`
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

    const prior = db.prepare(
      'SELECT present, hours_awarded FROM attendance WHERE slot_id = ? AND user_id = ?'
    ).get(app.slot_id, app.user_id);

    // Attendance is historical participation, so an existing record stays
    // correctable however the application status has moved since. But a
    // volunteer who was never accepted and has no record cannot acquire one.
    if (app.status !== 'accepted' && !prior) {
      skipped.push({ applicationId, why: 'not_accepted' });
      continue;
    }

    if (!slotHasEnded(app, now)) {
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
    if (!prior && awardsHours && scheduled === null) {
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
        + 'from them. Correct the shift times on the event, then finalise again.',
      unpriceable
    };
  }

  // A shift that has not finished cannot be credited. Check-in is the tool for
  // marking people during an event.
  if (notEnded.length > 0) {
    return {
      ok: false,
      error: 'shift_not_ended',
      message: `Hours can only be finalised after a shift has ended. ${notEnded.length} of the shifts you submitted are still to come — use check-in for those.`,
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

  const upsert = db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slot_id, user_id) DO UPDATE SET
      present = excluded.present, hours_awarded = excluded.hours_awarded
  `);

  const credited = [];
  const revoked = [];

  for (const p of planned) {
    upsert.run(event.id, p.app.slot_id, p.app.user_id, p.present, p.hours);

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

    recordHoursChange(db, {
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
