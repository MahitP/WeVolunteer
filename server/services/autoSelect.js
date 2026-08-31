/**
 * Auto Select — the draw, and applying it.
 *
 * ── Why this module exists ──
 *
 * This logic lived inline in two route handlers: `POST /api/events/:id/auto-select/run`
 * computed a draw and stored it as a draft, and
 * `POST /api/events/:id/auto-select/confirm` applied the latest draft. The scheduler
 * needs exactly that behaviour without an HTTP request.
 *
 * It is extracted rather than reimplemented, and that is the whole point. The
 * alternative — a second copy of the weighting, the seed formula and the capacity
 * arithmetic — is the mistake that produced audit finding F-1, where a
 * hand-maintained parallel list drifted from the schema until it destroyed the
 * database. A fairness algorithm with two implementations is the same failure
 * waiting to happen, except the divergence would be invisible: both copies would
 * produce plausible-looking winners.
 *
 * Everything here is a verbatim move of the route code — same SQL, same
 * `createRandom(seed)` with the same `${eventId}:${slotId}:run-${runNumber}` seed,
 * same `performWeightedSelection`, same capacity arithmetic, same notification
 * dispatches, same summary shape. The routes now delegate here, so the existing
 * route tests cover the extraction.
 *
 * The functions take `db` as their first argument, matching hoursLedger.js and
 * instanceLock.js, so nothing here depends on module-load order.
 */
import { createRandom, performWeightedSelection } from '../weighting.js';
import { attendanceRecordsFor } from '../volunteerStats.js';
import { eventApplicationEligibility } from '../eventEligibility.js';
import { usersWithClashingAcceptance, shiftsOverlap } from '../shiftOverlap.js';
import { notificationService } from './notificationService.js';
import '../utils.js';
import { runInTransaction } from '../db/connectionContext.js';
import { verifyRunStillApplies, staleRunMessage } from './autoSelectStaleness.js';
import { withSpan } from '../observability/spans.js';

/**
 * Computes a draw without writing anything.
 *
 * Pure with respect to the database: it reads pending applications and capacity and
 * returns which application ids would be accepted and which waitlisted. Separated
 * from `recordRun` so a caller can compute a result, and from `applyRun` so a
 * computed result can be reviewed before it takes effect — which is the manual
 * two-step flow the organizer sees.
 */
export async function computeDraw(db, eventId, { runNumber }) {
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) throw new Error(`Event not found: ${eventId}`);

  /**
   * Slots in a DEFINED order, which they were not in before.
   *
   * The bare `SELECT * FROM slots WHERE event_id = ?` returned rows in whatever
   * order the engine felt like — b-tree order on SQLite, physical order on
   * PostgreSQL, and neither is promised. That was tolerable while each slot's
   * draw was independent. It stops being tolerable now that a selection on one
   * slot can exclude the same volunteer from an overlapping one: WHICH slot they
   * keep would have been decided by storage layout, and the same event could
   * resolve differently on the two engines.
   *
   * Chronological, then by id. "The earlier shift is the one they keep" is a
   * rule that can be said out loud to the volunteer who asks, and `id` breaks
   * the tie between two shifts starting at the same moment so the order is total
   * rather than merely mostly-defined.
   *
   * This does not change who is drawn on any single slot. The seed is
   * `${eventId}:${slotId}:run-${runNumber}` — per slot, not per position — so
   * every slot's own lottery is exactly what it was.
   */
  const slots = await db.prepare(
    'SELECT * FROM slots WHERE event_id = ? ORDER BY start_datetime ASC, id ASC'
  ).all(eventId);
  const selectedIds = [];
  const waitlistIds = [];

  /**
   * Who this execution has already seated, and when.
   *
   * ── The gap this closes ──
   *
   * `usersWithClashingAcceptance` reads ACCEPTED rows, and a draw writes
   * nothing — `computeDraw` is pure with respect to the database by design, so a
   * result can be reviewed before it takes effect. So the committed-acceptance
   * check cannot see a selection made two slots ago in this same loop, and a
   * volunteer pending on two overlapping shifts of one event was selected for
   * both. One execution, one double-booking, no human involved: the same defect
   * the cross-event check was written for, reached by the one path that check
   * structurally cannot see.
   *
   * ── Why in memory and not another query ──
   *
   * The facts are already here. Re-reading them would mean writing selections
   * down mid-draw, which would make the draw no longer pure and would need a
   * transaction around a computation that deliberately has none. An array of
   * `{userId, start, end}` bounded by the places on one event answers the same
   * question with no query at all.
   *
   * The PREDICATE is the shared one. `shiftsOverlap` is the JavaScript form of
   * `OVERLAPS_SHIFT_SQL`, asserted equal to it over every arrangement two
   * intervals can be in, so a shift that touches at the boundary is not a clash
   * here for exactly the reason it is not a clash anywhere else.
   */
  const seatedHere = [];

  for (const slot of slots) {
    /**
     * `totalHours`, not `total_hours`.
     *
     * The alias here used to be snake_case while `performWeightedSelection`
     * reads `a.totalHours`, so every applicant arrived at the curve with
     * `undefined` hours, `Number(undefined) || 0` made that 0, and every
     * applicant was handed the identical maximum weight of 10.0. The draw was a
     * uniform lottery for as long as that mismatch stood — the hours weighting
     * the organizer UI describes, and that
     * docs/legal/policies/07-volunteer-record-policy.md publishes as policy, was
     * not happening at all.
     *
     * Nothing failed, because the one determinism test builds its applicants by
     * hand in camelCase and no test asserted that a lower-hours volunteer
     * actually wins more often. `weighting.test.js` now makes that assertion
     * directly, over the real curve, so the two names cannot drift apart again
     * without the build going red.
     */
    /**
     * Credited hours, by the same definition `creditedHoursFor` uses.
     *
     * ── Why the events join matters ──
     *
     * Without it this sums every attendance row, including ones belonging to
     * CANCELLED events — which the student's own profile excludes. Two numbers,
     * both called credited hours, disagreeing. And because the weight curve
     * rewards FEWER hours, the phantom ones made somebody less likely to be
     * drawn because an organizer cancelled an event they had turned up to.
     *
     * ── Why a subquery and not a join ──
     *
     * The first attempt added `LEFT JOIN events … AND status <> 'cancelled'`
     * plus a WHERE predicate, and `capacity.baseline.test.js` caught what that
     * does: filtering in WHERE after a LEFT JOIN turns it into an inner join for
     * any applicant whose every attendance row is excluded, so a student with
     * only cancelled-event hours DISAPPEARED from the pool instead of being
     * weighed at zero. The 200-run lottery assertion went to 200/200 and said
     * so.
     *
     * A correlated subquery cannot drop an applicant, and it is the same shape
     * as `creditedHoursFor`, which is the thing it has to agree with.
     */
    const allPending = await db.prepare(`
      SELECT a.id, a.user_id,
             (SELECT COALESCE(SUM(att.hours_awarded), 0)
                FROM attendance att
                JOIN events e_att ON e_att.id = att.event_id
               WHERE att.user_id = a.user_id
                 AND att.present = 1
                 AND e_att.status <> 'cancelled') as totalHours
      FROM applications a
      WHERE a.slot_id = ? AND a.status = 'pending'
      ORDER BY a.id
    `).all(slot.id);

    /**
     * Anybody the organization has since refused is out of the draw.
     *
     * A pending application is a request, not a place. The draw is where the
     * place is actually given, and it can run weeks after the applications
     * arrived — long enough for a ban to be issued or for the event to be
     * narrowed to members only. Selecting them anyway would have the platform
     * seat somebody the organization had just refused, with no human deciding
     * anything and no record of a decision.
     *
     * They are WAITLISTED rather than dropped, and that detail is the whole of
     * whether this is humane. Dropping them left a row `pending` on an event
     * the confirmation then closes, with no further run possible and no
     * notification of any kind — a person who applied, was never told anything,
     * and stayed that way. Waitlisted is a state the screen can render, it is
     * the honest description of where they stand, and `promoteFromWaitlist`
     * re-asks eligibility every time a place frees: if the ban is lifted or
     * they join the organization, they come off it by themselves.
     *
     * Not `rejected`, because the organizer did not reject them.
     */
    /**
     * And so is anybody who is already accepted to a shift at this time.
     *
     * ── Why this belongs in the same place ──
     *
     * The reasoning above transfers word for word. A pending application is a
     * request; the draw is where the place is given and can run weeks later;
     * seating somebody who cannot come would happen with no human deciding
     * anything. The only difference is what makes them unable to come.
     *
     * Without this the draw would select them, because it reads `pending` rows
     * on one slot and never looked at what else the applicant holds. Two draws
     * on two overlapping events would both select the same student, and nothing
     * afterwards detected it — the organizer plans staffing around a volunteer
     * who cannot come and finds out when they do not arrive. A HAND-PICKING
     * organizer is already covered: the applicant list carries `hasConflict` and
     * `ApplicantReview` renders a red Conflict tag, so a human sees the clash
     * and decides. A manual acceptance is deliberately still not blocked; taking
     * the decision away from somebody who has the fact in front of them would be
     * worse than the problem. The draw is the path with no human in it.
     *
     * Waitlisted rather than rejected is what makes it self-healing, and that is
     * the point: `promoteFromWaitlist` re-asks the same question on every freed
     * place and skips without dropping, so if the clashing acceptance is
     * withdrawn the student returns at the position they held. Rejecting would
     * let an automated draw permanently destroy an application over a clash the
     * student might resolve five minutes later.
     *
     * ── Fairness, since excluding a candidate changes the odds ──
     *
     * It changes them in the direction the draw exists to serve. The excluded
     * student already holds that time, so the spot is one they could not have
     * used; passing it to the next applicant is strictly better for everyone
     * else and neutral for them. They end with exactly one of the two shifts,
     * which is the right outcome — two is a double-booking, zero would punish
     * them for applying. Which one they keep depends on which event's draw ran
     * first: arbitrary, but unbiased, and they chose it by overriding a warning
     * that named the clash.
     *
     * ── What this deliberately does NOT do ──
     *
     * It reads committed acceptances, so it cannot see selections made earlier
     * in THIS draw. A student pending on two overlapping slots of the same event
     * can still be selected for both. Resolving that means deciding which slot
     * wins, which is a change to how the draw picks people rather than to who is
     * eligible for it, and it is not this rule's job.
     */
    const clashing = await usersWithClashingAcceptance(
      db, allPending.map(a => a.user_id), slot,
    );

    /* A loop rather than `.filter`, because the predicate is async now.
       `Array.filter` does not await, so it would have compared a promise: the
       truthiness of `.ok` on a pending promise is `undefined`, and every
       applicant would have been waitlisted instead of selected. */
    const pendingApps = [];
    for (const a of allPending) {
      if (clashing.has(a.user_id)) continue;
      /* And anybody this same execution has already seated at this time. Same
         treatment, same reason, same predicate — see `seatedHere` above. */
      if (seatedHere.some(s => s.userId === a.user_id
        && shiftsOverlap(s.start, s.end, slot.start_datetime, slot.end_datetime))) continue;
      if ((await eventApplicationEligibility(event, a.user_id)).ok) pendingApps.push(a);
    }
    for (const refused of allPending) {
      if (!pendingApps.includes(refused)) waitlistIds.push(refused.id);
    }

    if (pendingApps.length === 0) continue;

    /**
     * Attendance reliability for the whole pool in one query, then attached.
     *
     * One aggregate for the slot rather than one per applicant: a popular shift
     * draws forty applications, and the draw already runs once per slot inside
     * a transaction. A miss in this Map means "no recorded history", which
     * `reliabilityMultiplier` treats as neutral — deliberately not as zero
     * attendance.
     */
    const records = await attendanceRecordsFor(db, pendingApps.map(a => a.user_id));
    for (const app of pendingApps) app.attendance = records.get(app.user_id) ?? null;

    // Capacity already consumed by hand-accepted volunteers. This is what keeps a
    // draw from ever exceeding a slot's spots, and from reconsidering anyone who is
    // already accepted — the query above only looks at `pending`.
    const acceptedSlotCount = (await db.prepare(`
      SELECT COUNT(*) as count FROM applications WHERE slot_id = ? AND status = 'accepted'
    `).get(slot.id)).count;

    const remainingSpots = Math.max(0, slot.max_spots - acceptedSlotCount);

    if (remainingSpots <= 0) {
      // All waitlisted
      pendingApps.forEach(app => {
        waitlistIds.push(app.id);
      });
    } else {
      // Seed incorporating the run number, so a re-draw differs from the first draw
      // but any given run is reproducible.
      const seed = `${event.id}:${slot.id}:run-${runNumber}`;
      const randomFn = createRandom(seed);
      const draw = performWeightedSelection(pendingApps, remainingSpots, randomFn);
      selectedIds.push(...draw.selectedIds);
      waitlistIds.push(...draw.waitlistIds);

      /* Recorded AFTER the draw and only for who it actually chose, so a later
         overlapping slot sees this one's outcome. Looked up by application id
         against the pool the draw was given, which is the only place the
         user behind an id is known here. */
      const byId = new Map(pendingApps.map(a => [a.id, a]));
      for (const id of draw.selectedIds) {
        const chosen = byId.get(id);
        if (!chosen) continue;
        seatedHere.push({
          userId: chosen.user_id,
          start: slot.start_datetime,
          end: slot.end_datetime,
        });
      }
    }
  }

  return { selectedIds, waitlistIds };
}

/** Stores a computed draw as an unconfirmed draft and returns the row id. */
export async function recordRun(db, eventId, { selectedIds, waitlistIds }, { runNumber, reason }) {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const nowStr = new Date().toISOString();

  await db.prepare(`
    INSERT INTO auto_select_runs (id, event_id, run_number, created_at, selected_ids, waitlist_ids, is_confirmed, reason)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(runId, eventId, runNumber, nowStr, JSON.stringify(selectedIds), JSON.stringify(waitlistIds), reason ?? null);

  return { runId, createdAt: nowStr };
}

/**
 * Applies a stored draft: accepts, waitlists, notifies, writes the summary.
 *
 * Everything happens in one transaction so a promotion can never be visible without
 * the run that authorised it. Notifications are dispatched inside the transaction
 * exactly as the original route did — changing that ordering is out of scope for an
 * extraction, and `notificationService.dispatch` performs its own writes which the
 * same transaction covers.
 *
 * `executedBy` is recorded in the summary so a district can tell an automatic
 * selection from an organizer's. That is the only addition to the original
 * behaviour, and it is additive: the field is new, nothing existing changed shape.
 */
/**
 * The current status of every application the run selected.
 *
 * A missing row yields `status: null` rather than being dropped, because "this
 * application no longer exists" is a distinct staleness reason from "it was
 * withdrawn", and silently omitting it would let the run apply as though the id
 * had never been selected.
 */
async function readSelectionState(db, selectedIds) {
  if (selectedIds.length === 0) return [];
  const placeholders = selectedIds.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT id, slot_id, status FROM applications WHERE id IN (${placeholders})`
  ).all(...selectedIds);

  const byId = new Map(rows.map(r => [r.id, r]));
  return selectedIds.map(id => {
    const row = byId.get(id);
    return { id, slotId: row?.slot_id ?? null, status: row?.status ?? null };
  });
}

/**
 * Capacity for every slot the selection touches, read under a row lock where the
 * engine has one.
 *
 * ── The lock, and why it is conditional rather than universal ──
 *
 * On PostgreSQL, `FOR UPDATE` on the slot row is what makes "read the accepted
 * count, then accept" atomic against a concurrent confirmation: the second
 * transaction blocks until the first commits, then counts a total that already
 * includes it. Proved in `capacity.postgresConcurrency.test.js`, including that
 * the lock survives an `await` between the read and the write.
 *
 * SQLite has no `FOR UPDATE`, and needs none — one connection inside one
 * transaction cannot interleave, which is the guarantee this migration is
 * carefully replacing rather than discarding. Emitting the clause there would be
 * a syntax error, so the dialect decides.
 */
async function readSlotCapacity(db, selectedIds) {
  const slots = new Map();
  if (selectedIds.length === 0) return slots;

  const placeholders = selectedIds.map(() => '?').join(',');
  const slotIds = (await db.prepare(
    `SELECT DISTINCT slot_id FROM applications WHERE id IN (${placeholders})`
  ).all(...selectedIds)).map(r => r.slot_id).filter(Boolean);

  if (slotIds.length === 0) return slots;

  const lock = db.dialect === 'postgres' ? ' FOR UPDATE' : '';
  const slotPlaceholders = slotIds.map(() => '?').join(',');

  /* The lock is taken on `slots` — the row whose capacity is the scarce thing.
     Locking the applications would not serialise two confirmations looking at
     different applications of the same slot. */
  const rows = await db.prepare(
    `SELECT id, max_spots FROM slots WHERE id IN (${slotPlaceholders})${lock}`
  ).all(...slotIds);

  for (const row of rows) {
    const acceptedNow = (await db.prepare(
      "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
    ).get(row.id)).c;
    slots.set(row.id, { maxSpots: row.max_spots, acceptedNow });
  }
  return slots;
}

export async function applyRun(db, eventId, run, { executedBy = 'organizer' } = {}) {
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) throw new Error(`Event not found: ${eventId}`);

  const selectedIds = JSON.parse(run.selected_ids);
  const waitlistIds = JSON.parse(run.waitlist_ids);

  /* `runInTransaction`, not `inTransaction`: this body awaits, and the
     synchronous helper commits when its callback RETURNS — which for an async
     callback is before any of the work has run. On PostgreSQL the transaction
     owns a pinned pooled client; on SQLite it owns its own connection. Either
     way every statement below lands inside it, including across the awaits.

     Deliberately not `return runInTransaction(...)`: the callback returns
     nothing, and this function's contract is `{ selectedIds, waitlistIds }`. A
     refusal propagates by throwing and needs no return value. */
  await runInTransaction(db, async (tx) => {
    /**
     * 0. Refuse the run if it can no longer be honoured exactly.
     *
     * ── Why this is here at all ──
     *
     * A draw reads capacity; confirmation happens later, after the organizer has
     * looked at the list. In between, somebody can be accepted by hand or
     * withdraw. Until this check existed, confirmation applied the recorded ids
     * regardless — reachable without any concurrency at all (draw, approve,
     * confirm) and demonstrated in `capacity.baseline.test.js`.
     *
     * ── Why refuse rather than truncate ──
     *
     * Owner decision, 2026-08-16. The organizer confirmed a specific reviewed
     * list. Accepting a subset silently gives them something they did not choose;
     * accepting all of it breaks capacity. Refusing preserves both, and a re-draw
     * is cheap because a draw is a pure read.
     *
     * ── Why it is inside the transaction ──
     *
     * The check and the writes it authorises must be one atomic step, or the
     * state it validated can change before the acceptance lands. On PostgreSQL
     * the slot rows are additionally locked (see `readSlotCapacity`) so a
     * concurrent confirmation waits rather than racing. On SQLite the single
     * connection inside this transaction already serialises.
     *
     * Nothing is written before this point, so a refusal leaves the run
     * `is_confirmed = 0` and every application untouched — which is precisely
     * what "stale, not applied" means in the existing run lifecycle.
     */
    const verdict = verifyRunStillApplies({
      selections: await readSelectionState(tx, selectedIds),
      slots: await readSlotCapacity(tx, selectedIds),
    });

    if (!verdict.ok) {
      const err = new Error(staleRunMessage(verdict));
      err.code = verdict.code;
      err.reason = verdict.reason;
      err.detail = verdict.detail;
      /* Thrown rather than returned: `inTransaction` rolls back on a throw, and
         the UPDATE below must not have happened. Every caller already handles a
         throw from here. */
      throw err;
    }

    // 1. Confirm this run
    await tx.prepare('UPDATE auto_select_runs SET is_confirmed = 1 WHERE id = ?').run(run.id);

    // 2. Set statuses for selected applicants
    const acceptStmt = await tx.prepare("UPDATE applications SET status = 'accepted', waitlist_order = NULL WHERE id = ?");
    for (const id of selectedIds) {
      await acceptStmt.run(id);

      const appRow = await tx.prepare(`
        SELECT a.user_id, s.name as slot_name
        FROM applications a
        JOIN slots s ON a.slot_id = s.id
        WHERE a.id = ?
      `).get(id);

      if (appRow) {
        await notificationService.dispatch('APPLICATION_ACCEPTED', { eventId: event.id, eventTitle: event.title }, appRow.user_id);
      }
    }

    // 3. Set statuses and ranks for waitlisted applicants
    const waitlistApps = waitlistIds.length > 0
      ? await tx.prepare(`
          SELECT id, slot_id, user_id FROM applications
          WHERE id IN (${waitlistIds.map(() => '?').join(',')})
        `).all(...waitlistIds)
      : [];

    const waitlistStmt = await tx.prepare("UPDATE applications SET status = 'waitlisted', waitlist_order = ? WHERE id = ?");

    // Slot-specific waitlist counters
    const slotWaitlistIndex = {};

    for (const id of waitlistIds) {
      const app = waitlistApps.find(a => a.id === id);
      if (!app) continue;

      slotWaitlistIndex[app.slot_id] = (slotWaitlistIndex[app.slot_id] || 0) + 1;
      const rank = slotWaitlistIndex[app.slot_id];

      await waitlistStmt.run(rank, id);

      await notificationService.dispatch('APPLICATION_WAITLISTED', { eventId: event.id, eventTitle: event.title, waitlistRank: rank }, app.user_id);
    }

    // 4. Compute selection summary
    const totalApplicants = selectedIds.length + waitlistIds.length;
    let acceptedHoursSum = 0;
    let waitlistedHoursSum = 0;

    if (selectedIds.length > 0) {
      /* Credited hours, as a subquery for the reason given on the draw's own
         query above: a join plus a WHERE predicate drops an applicant whose
         only hours came from a cancelled event, rather than counting them as
         zero. */
      const rows = await tx.prepare(`
        SELECT (SELECT COALESCE(SUM(att.hours_awarded), 0)
                  FROM attendance att
                  JOIN events e_att ON e_att.id = att.event_id
                 WHERE att.user_id = a.user_id
                   AND att.present = 1
                   AND e_att.status <> 'cancelled') as total_hours
        FROM applications a
        WHERE a.id IN (${selectedIds.map(() => '?').join(',')})
      `).all(...selectedIds);
      acceptedHoursSum = rows.reduce((sum, r) => sum + r.total_hours, 0);
    }

    if (waitlistIds.length > 0) {
      /* Credited hours, as a subquery for the reason given on the draw's own
         query above: a join plus a WHERE predicate drops an applicant whose
         only hours came from a cancelled event, rather than counting them as
         zero. */
      const rows = await tx.prepare(`
        SELECT (SELECT COALESCE(SUM(att.hours_awarded), 0)
                  FROM attendance att
                  JOIN events e_att ON e_att.id = att.event_id
                 WHERE att.user_id = a.user_id
                   AND att.present = 1
                   AND e_att.status <> 'cancelled') as total_hours
        FROM applications a
        WHERE a.id IN (${waitlistIds.map(() => '?').join(',')})
      `).all(...waitlistIds);
      waitlistedHoursSum = rows.reduce((sum, r) => sum + r.total_hours, 0);
    }

    const avgAcceptedHours = selectedIds.length > 0 ? Number((acceptedHoursSum / selectedIds.length).toFixed(1)) : 0;
    const avgWaitlistedHours = waitlistIds.length > 0 ? Number((waitlistedHoursSum / waitlistIds.length).toFixed(1)) : 0;

    // Surface the draw history so the published summary reflects that
    // re-draws happened, and why — not just the final, cleaned-up outcome.
    const runCount = (await tx.prepare('SELECT COUNT(*) as count FROM auto_select_runs WHERE event_id = ?').get(eventId)).count;
    const redrawReasons = (await tx.prepare(`
      SELECT reason FROM auto_select_runs
      WHERE event_id = ? AND reason IS NOT NULL
      ORDER BY run_number ASC
    `).all(eventId)).map(r => r.reason);

    const summary = {
      totalApplicants,
      acceptedVolunteers: selectedIds.length,
      waitlistedVolunteers: waitlistIds.length,
      avgAcceptedHours,
      avgWaitlistedHours,
      runCount,
      redrawReasons,
      executedBy,
      timestamp: new Date().toISOString()
    };

    await tx.prepare(`
      UPDATE events
      SET selection_summary = ?, status = 'closed'
      WHERE id = ?
    `).run(JSON.stringify(summary), eventId);
  });

  return { selectedIds, waitlistIds };
}

/** The latest run for an event, confirmed or not. */
export async function latestRun(db, eventId) {
  return await db.prepare(`
    SELECT * FROM auto_select_runs
    WHERE event_id = ?
    ORDER BY run_number DESC LIMIT 1
  `).get(eventId);
}

/** Whether a confirmed run exists — the terminal state for an event's selection. */
export async function hasConfirmedRun(db, eventId) {
  return (await db.prepare(
    'SELECT COUNT(*) as count FROM auto_select_runs WHERE event_id = ? AND is_confirmed = 1'
  ).get(eventId)).count > 0;
}

/**
 * Draw and apply in one step, for the scheduler.
 *
 * If the organizer already produced a draft and never confirmed it, THAT draft is
 * applied rather than a fresh draw. It is the result they generated and may already
 * have reviewed; replacing it would be the scheduler overruling a human decision
 * with one nobody has seen.
 *
 * Refuses if a confirmed run already exists, which is the idempotency guard the
 * manual route already enforces and the reason this is safe to call repeatedly.
 */
export async function runAndConfirm(db, eventId, { source = 'scheduler' } = {}) {
  /**
   * One of the four operations in this codebase given a span by hand.
   *
   * It earns one on the criteria in `spans.js`: it is not a layer, so automatic
   * instrumentation cannot name it; it does real work — a draw, a weighting
   * pass, a write and an apply, each of which touches the database; and it is
   * the operation an organizer complains about when a selection "did not
   * happen", where the useful answer is which of those four stages was slow or
   * which one refused.
   *
   * `eventId` is deliberately NOT an attribute. It is an identifier, the
   * allowlist in `spanAttributes.js` has no key for it, and a span attribute is
   * not the place to start carrying one — the `wev.request_id` on the enclosing
   * HTTP span already joins this trace to the log record that names what was
   * being selected for.
   */
  return withSpan('autoselect.run', { component: 'autoselect', reason: source }, async () => {
    return runAndConfirmInner(db, eventId, { source });
  });
}

async function runAndConfirmInner(db, eventId, { source }) {
  if (await hasConfirmedRun(db, eventId)) {
    return { executed: false, reason: 'already_confirmed' };
  }

  const existing = await latestRun(db, eventId);

  if (existing) {
    await applyRun(db, eventId, existing, { executedBy: source });
    return { executed: true, reusedDraft: true, runNumber: existing.run_number };
  }

  const runNumber = 1;
  const draw = await computeDraw(db, eventId, { runNumber });
  const { runId } = await recordRun(db, eventId, draw, { runNumber, reason: null });
  const stored = await db.prepare('SELECT * FROM auto_select_runs WHERE id = ?').get(runId);
  await applyRun(db, eventId, stored, { executedBy: source });

  return { executed: true, reusedDraft: false, runNumber, ...draw };
}
