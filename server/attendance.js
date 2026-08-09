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

export function slotDuration(slot) {
  const ms = new Date(slot.end_datetime) - new Date(slot.start_datetime);
  return Math.max(0.1, Number((ms / 3600000).toFixed(2)));
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
    let hours = prior ? prior.hours_awarded : slotDuration(app);
    let hoursOverridden = false;

    if (awardsHours && hoursMap && Object.hasOwn(hoursMap, applicationId)) {
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
      if (!Number.isFinite(raw) || raw < 0 || raw > MAX_CREDITABLE_HOURS) {
        invalidHours.push({
          applicationId, name: app.user_name, slotName: app.slot_name, value: supplied,
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
      message: `Hours must be a number between 0 and ${MAX_CREDITABLE_HOURS}.`,
      invalidHours
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
      wasCredited
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
