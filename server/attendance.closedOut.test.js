/**
 * Credited hours become permanent when the organizer closes them out.
 *
 * ── The rule, and the window it leaves open ──
 *
 *   any time before close-out      an existing credited record may be corrected,
 *                                  with a reason, exactly as before — INCLUDING
 *                                  once the event is `completed`
 *   after `POST /…/hours/close-out` it may not be corrected at all, by anyone
 *
 * ── Why the lock is not `status = 'completed'` ──
 *
 * Because `completed` is not a decision. It is written by
 * `computeEventCompletion` the instant every accepted volunteer has a record — a
 * side effect of ticking the last checkbox. Locking on it would mean that on a
 * single-volunteer event the FIRST save both credits the student and freezes the
 * number, with no moment in between in which to notice a mistyped 40; the case
 * below named "a single-volunteer event" is exactly that scenario, and it is the
 * one this design exists to keep correctable.
 *
 * It would also contradict a promise the API already makes out loud:
 * `PUT /api/events/:id` refuses a completed event with "…its details can no
 * longer be changed. Attendance can still be corrected."
 *
 * ── What was there before ──
 *
 * Nothing. `finalizeAttendance` refused a cancelled event and refused a shift
 * that had not ended, and had no opinion about an event finished last spring. An
 * organizer could reopen Closeout on any past event and move a graduating
 * student's hours with a one-line reason, and the transcript, the certificate
 * and the Silver Award progress bar would all follow silently.
 *
 * ── Why these tests go through the HTTP route ──
 *
 * The rule spans two endpoints and a column, and the parts only misbehave
 * together: the close-out route's preconditions, the `UPDATE events SET
 * status = 'completed'` that finalisation performs, and the refusal
 * `finalizeAttendance` raises afterwards. The status code matters too — 409, not
 * 400: resending different values cannot fix any of this.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('hours are final once the organizer closes them out', () => {
  let srv, db;
  let organizer, admin, studentId, otherStudentId, organizerId;

  /**
   * An event whose shifts are all over, with `count` accepted volunteers on
   * separate slots.
   *
   * Separate slots on purpose: `computeEventCompletion` needs every accepted
   * volunteer accounted for before it will complete the event, so a two-slot
   * event is what lets a test finalise ONE person and leave the event open.
   */
  async function finishedEvent({ hours = 4, applicants = 1 } = {}) {
    const start = new Date(Date.now() - 3 * 86400000);
    const end = new Date(start.getTime() + hours * 3600000);
    const tag = Math.random().toString(36).slice(2);
    const eventId = `event-${tag}`;
    const now = new Date().toISOString();
    const users = [studentId, otherStudentId];

    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, created_at, credits_hours)
      VALUES (?, 'Closed out', 'd', 'Other', 'Somewhere', ?, ?, 'open', ?, 1)
    `).run(eventId, start.toISOString(), organizerId, now);

    const apps = [];
    for (let i = 0; i < applicants; i++) {
      const slotId = `slot-${tag}-${i}`;
      const appId = `app-${tag}-${i}`;
      await db.prepare(`
        INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
        VALUES (?, ?, ?, 'd', ?, ?, 5)
      `).run(slotId, eventId, `Shift ${i + 1}`, start.toISOString(), end.toISOString());
      await db.prepare(`
        INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
        VALUES (?, ?, ?, ?, 'accepted', ?)
      `).run(appId, users[i], eventId, slotId, now);
      apps.push({ appId, slotId, userId: users[i] });
    }
    return { eventId, apps };
  }

  const statusOf = async (eventId) =>
    (await db.prepare('SELECT status FROM events WHERE id = ?').get(eventId)).status;

  const creditedTo = async (slotId, userId) => await db.prepare(
    'SELECT present, hours_awarded FROM attendance WHERE slot_id = ? AND user_id = ?'
  ).get(slotId, userId);

  const ledgerRows = async (slotId) => await db.prepare(
    'SELECT * FROM hours_ledger WHERE slot_id = ?'
  ).all(slotId);

  const finalise = (eventId, body, who) =>
    srv.call('POST', `/api/events/${eventId}/attendance`, body, who);

  const closeOut = (eventId, who) =>
    srv.call('POST', `/api/events/${eventId}/hours/close-out`, {}, who);

  const closedOutAt = async (eventId) => (await db.prepare(
    'SELECT hours_closed_out_at AS at, hours_closed_out_by AS by_who FROM events WHERE id = ?'
  ).get(eventId));

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login('jordan.whitfield@example.org');
    admin = await srv.login('admin@example.gov');
    ({ db } = await import('./db.js'));
    studentId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('leo.chen@example.com')).id;
    otherStudentId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('priya.patel@example.com')).id;
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('jordan.whitfield@example.org')).id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /* ── Before close-out: corrections still work exactly as they did ───────── */

  describe('while the event is still open', () => {
    it('lets an organizer correct a record they have already finalised', async () => {
      const { eventId, apps } = await finishedEvent({ hours: 4, applicants: 2 });
      const [first] = apps;

      await finalise(eventId, { attendanceMap: { [first.appId]: true } }, organizer);
      expect(await statusOf(eventId)).toBe('open');   // the second volunteer is unaccounted for

      const res = await finalise(eventId, {
        attendanceMap: { [first.appId]: true },
        hoursMap: { [first.appId]: 2.5 },
        reason: 'Left after the first half.',
      }, organizer);

      expect(res.status).toBe(200);
      expect(await creditedTo(first.slotId, first.userId))
        .toMatchObject({ present: 1, hours_awarded: 2.5 });
    });

    it('still refuses a correction that carries no reason', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      const [first] = apps;
      await finalise(eventId, { attendanceMap: { [first.appId]: true } }, organizer);

      const res = await finalise(eventId, {
        attendanceMap: { [first.appId]: false },
      }, organizer);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('reason_required');
    });
  });

  /* ── The moment it closes ───────────────────────────────────────────────── */

  describe('the request that accounts for the last volunteer', () => {
    it('completes the event and says so', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      const res = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);

      expect(res.status).toBe(200);
      expect(res.body.eventCompleted).toBe(true);
      expect(await statusOf(eventId)).toBe('completed');
    });

    /**
     * THE property that separates this design from freezing on `completed`.
     * Completion is a side effect of ticking the last box; it must not also be
     * the moment a student's record stops being fixable.
     */
    it('does NOT freeze the hours', async () => {
      const { eventId, apps } = await finishedEvent({ hours: 4, applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);

      expect((await closedOutAt(eventId)).at).toBeFalsy();

      const res = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 2.5 },
        reason: 'Checked the sign-out sheet.',
      }, organizer);

      expect(res.status).toBe(200);
      expect((await creditedTo(apps[0].slotId, apps[0].userId)).hours_awarded).toBe(2.5);
    });

    /**
     * The single-volunteer event, which is the case that has no correction
     * window at all if completion is the lock: one shift, one person, and the
     * first save accounts for the whole roster.
     */
    it('leaves a single-volunteer event correctable after its very first save', async () => {
      const { eventId, apps } = await finishedEvent({ hours: 4, applicants: 1 });
      const first = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
      }, organizer);

      expect(first.body.eventCompleted).toBe(true);
      expect(await statusOf(eventId)).toBe('completed');

      const fix = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 1.25 },
        reason: 'Typed 4 by mistake.',
      }, organizer);

      expect(fix.status).toBe(200);
      expect((await creditedTo(apps[0].slotId, apps[0].userId)).hours_awarded).toBe(1.25);
    });
  });

  /* ── Closing out: the deliberate act ─────────────────────────────────────── */

  describe('the close-out endpoint', () => {
    it('refuses while the event is not complete', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      await finalise(eventId, { attendanceMap: { [apps[0].appId]: true } }, organizer);

      const res = await closeOut(eventId, organizer);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('event_not_complete');
      expect((await closedOutAt(eventId)).at).toBeFalsy();
    });

    it('records who closed the hours out, and when', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);

      const res = await closeOut(eventId, organizer);

      expect(res.status).toBe(200);
      const row = await closedOutAt(eventId);
      expect(row.at).toBeTruthy();
      expect(row.by_who).toBe(organizerId);
    });

    it('writes an audit row, because nothing else records the decision', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);
      await closeOut(eventId, organizer);

      const row = await db.prepare(
        "SELECT action, details FROM admin_audit_logs WHERE action = 'EVENT_HOURS_CLOSED_OUT' AND details LIKE ?"
      ).get(`%${eventId}%`);
      expect(row).toBeTruthy();
    });

    /** One-way. A second press is a double-click or a second organizer. */
    it('refuses a second close-out rather than overwriting the attribution', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);
      const first = await closeOut(eventId, organizer);
      const before = await closedOutAt(eventId);

      const second = await closeOut(eventId, organizer);

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('already_closed_out');
      expect((await closedOutAt(eventId)).at).toBe(before.at);
    });

    it('refuses somebody who does not host the event', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);

      const outsider = await srv.signupConfirmed({
        name: 'Other Organizer', username: 'closeoutother',
        email: 'closeout.other@example.net', grade: 'Adult',
        role: 'organizer', password: 'TestPass123!',
      });
      const res = await closeOut(eventId, outsider);

      expect(res.status).toBe(403);
      expect((await closedOutAt(eventId)).at).toBeFalsy();
    });

    it('refuses a signed-out caller', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);

      const res = await closeOut(eventId, null);

      expect(res.status).toBe(401);
      expect((await closedOutAt(eventId)).at).toBeFalsy();
    });

    it('answers 404 for an event that does not exist', async () => {
      expect((await closeOut('event-nope', organizer)).status).toBe(404);
    });

    /** There is no reopen route; this asserts the absence rather than assuming it. */
    it('offers no way back', async () => {
      const { eventId, apps } = await finishedEvent({ applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);
      await closeOut(eventId, organizer);

      const del = await srv.call('DELETE', `/api/events/${eventId}/hours/close-out`, {}, organizer);
      expect([404, 405]).toContain(del.status);
      expect((await closedOutAt(eventId)).at).toBeTruthy();
    });
  });

  /* ── After close-out: no takebacksies ───────────────────────────────────── */

  describe('once the hours have been closed out', () => {
    /** A completed event, credited, and then deliberately frozen. */
    async function closedOut({ hours = 4 } = {}) {
      const { eventId, apps } = await finishedEvent({ hours, applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);
      expect(await statusOf(eventId)).toBe('completed');
      const res = await closeOut(eventId, organizer);
      expect(res.status).toBe(200);
      return { eventId, apps };
    }

    it('refuses to change the hours on a credited record', async () => {
      const { eventId, apps } = await closedOut({ hours: 4 });

      const res = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 12 },
        reason: 'Actually they were here all day.',
      }, organizer);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('hours_locked');
      expect((await creditedTo(apps[0].slotId, apps[0].userId)).hours_awarded).toBe(4);
    });

    it('refuses to flip a present volunteer to absent', async () => {
      const { eventId, apps } = await closedOut();

      const res = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: false },
        reason: 'Changed my mind.',
      }, organizer);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('hours_locked');
      expect((await creditedTo(apps[0].slotId, apps[0].userId)).present).toBe(1);
    });

    it('names the records that would have changed, so the refusal is readable', async () => {
      const { eventId, apps } = await closedOut({ hours: 4 });

      const res = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 1 },
        reason: 'r',
      }, organizer);

      expect(res.body.locked).toHaveLength(1);
      expect(res.body.locked[0]).toMatchObject({
        applicationId: apps[0].appId, hoursFrom: 4, hoursTo: 1,
      });
      expect(res.body.locked[0].name).toBeTruthy();
    });

    /**
     * The whole submission is refused, not the offending rows. A partial save
     * would leave the organizer with no way to know which half landed — the same
     * all-or-nothing rule `invalid_hours` and `shift_not_ended` already follow.
     */
    it('refuses the whole submission, leaving every other record untouched', async () => {
      const { eventId, apps } = await closedOut({ hours: 4 });

      const res = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: false, [apps[1].appId]: false },
        reason: 'Both wrong.',
      }, organizer);

      expect(res.status).toBe(409);
      expect((await creditedTo(apps[0].slotId, apps[0].userId)).present).toBe(1);
      expect((await creditedTo(apps[1].slotId, apps[1].userId)).present).toBe(1);
    });

    it('writes nothing to the hours ledger when it refuses', async () => {
      const { eventId, apps } = await closedOut({ hours: 4 });
      const before = (await ledgerRows(apps[0].slotId)).length;

      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 9 },
        reason: 'r',
      }, organizer);

      expect((await ledgerRows(apps[0].slotId)).length).toBe(before);
    });

    /**
     * Re-submitting the screen unchanged is not an edit and must not be refused.
     * The Closeout tab seeds its checkboxes from the existing records, so every
     * row arrives in the payload every time it is opened — a lock that fired on
     * "a row was submitted" rather than "a row would change" would make the
     * screen unopenable on every completed event on the platform.
     */
    it('accepts a submission that changes nothing', async () => {
      const { eventId, apps } = await closedOut({ hours: 4 });

      const res = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);

      expect(res.status).toBe(200);
      expect(res.body.credited).toEqual([]);
    });

    /**
     * A volunteer accepted AFTER close-out has never been finalised, so there is
     * no finalised record of theirs to protect. Refusing them would not preserve
     * anything — it would mean a student who worked the shift can never be
     * credited by anybody, which is a different loss wearing the same word.
     */
    it('still lets a volunteer with no record at all be credited', async () => {
      const { eventId, apps } = await closedOut({ hours: 4 });
      const now = new Date().toISOString();
      const lateAppId = `app-late-${Math.random().toString(36).slice(2)}`;
      await db.prepare(`
        INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
        VALUES (?, ?, ?, ?, 'accepted', ?)
      `).run(lateAppId, otherStudentId, eventId, apps[0].slotId, now);

      const res = await finalise(eventId, {
        attendanceMap: { [lateAppId]: true },
      }, organizer);

      expect(res.status).toBe(200);
      expect(await creditedTo(apps[0].slotId, otherStudentId))
        .toMatchObject({ present: 1, hours_awarded: 4 });
    });

    /**
     * The lock is a property of the RECORD, not of who is asking. An
     * administrator holds `attendance.mark` on every event on the platform, and
     * that is what makes this worth asserting: the one account that can reach
     * every closed-out event is the one an unbounded correction path would be
     * most damaging through.
     */
    it('refuses an administrator too', async () => {
      const { eventId, apps } = await closedOut({ hours: 4 });

      const res = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 8 },
        reason: 'Administrative correction.',
      }, admin);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('hours_locked');
      expect((await creditedTo(apps[0].slotId, apps[0].userId)).hours_awarded).toBe(4);
    });

    /**
     * ── The stale snapshot, exercised directly ──
     *
     * THE regression test for the race, and it is a unit-level one on purpose.
     *
     * The route reads the event, then opens a transaction, then finalises. A
     * close-out committing anywhere in that window used to be invisible: the
     * correction was judged against the snapshot taken before it and landed on
     * hours that had just been made permanent.
     *
     * Two parallel HTTP requests do NOT reproduce it — the window is narrower
     * than the close-out's own auth and host check, so the ordering never lands
     * inside it. Verified: the parallel case below passes with the fix reverted.
     * So the condition is constructed instead, by handing `finalizeAttendance`
     * exactly what the route would have handed it — an event object that still
     * says the hours are open — while the row says otherwise.
     *
     * This one DOES fail without the fix.
     */
    it('refuses a correction judged against a pre-close-out snapshot', async () => {
      const { finalizeAttendance } = await import('./attendance.js');
      const { runInTransaction } = await import('./db/connectionContext.js');

      const { eventId, apps } = await finishedEvent({ hours: 4, applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);

      /* The snapshot the route would have taken BEFORE the close-out. */
      const stale = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
      expect(stale.hours_closed_out_at, 'the snapshot must predate the close-out').toBeFalsy();

      expect((await closeOut(eventId, organizer)).status).toBe(200);

      const outcome = await runInTransaction(db, async (tx) => finalizeAttendance(tx, {
        event: stale,
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 2.5 },
        reason: 'Judged against a stale snapshot.',
        actor: { id: organizerId, role: 'organizer' },
        now: new Date().toISOString(),
      }));

      expect(outcome.ok, 'a stale snapshot let a correction through').toBe(false);
      expect(outcome.error).toBe('hours_locked');
      expect((await creditedTo(apps[0].slotId, apps[0].userId)).hours_awarded).toBe(4);
    });

    /**
     * The same thing through the real API, fired in parallel.
     *
     * This does NOT reproduce the race — see above — so it is an INVARIANT
     * check rather than a regression test: whatever order the two land in, the
     * status the correction reports and the hours actually stored must agree,
     * and the hours must be final afterwards. Kept because that agreement is
     * the property a reader cares about, and because a future change to the
     * request path could widen the window this asserts against.
     */
    it('refuses a correction that was in flight when the close-out landed', async () => {
      const { eventId, apps } = await finishedEvent({ hours: 4, applicants: 2 });
      await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true, [apps[1].appId]: true },
      }, organizer);

      /* Both requests issued without awaiting the first, so the close-out lands
         while the correction is between its own event read and its write. */
      /* 2.5 on a four-hour shift: inside the override ceiling, so the ONLY
         thing that can refuse it is the lock. An out-of-range value would be
         rejected as `invalid_hours` and the case would prove nothing. */
      const correction = finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 2.5 },
        reason: 'Racing the close-out.',
      }, organizer);
      const closing = closeOut(eventId, organizer);

      const [corrected, closed] = await Promise.all([correction, closing]);

      expect(closed.status).toBe(200);
      /* Either the correction got in first (200, hours 12) or it lost the race
         (409, hours 4) — but it must never be 200 with the hours changed AFTER
         the close-out committed. The invariant is that the two agree. */
      const stored = (await creditedTo(apps[0].slotId, apps[0].userId)).hours_awarded;
      if (corrected.status === 200) {
        expect(stored, 'a 200 must mean the change actually landed').toBe(2.5);
      } else {
        expect(corrected.status).toBe(409);
        expect(corrected.body.code).toBe('hours_locked');
        expect(stored, 'a refusal must leave the hours untouched').toBe(4);
      }

      /* And afterwards the hours are final either way. */
      const after = await finalise(eventId, {
        attendanceMap: { [apps[0].appId]: true },
        hoursMap: { [apps[0].appId]: 1 },
        reason: 'After the dust settles.',
      }, organizer);
      expect(after.status).toBe(409);
      expect(after.body.code).toBe('hours_locked');
    });

    /**
     * The other half of one-way-ness. The lock is worthless if its precondition
     * can be unwound: reopen the event, and `completed` — the state that made
     * closing out available — would no longer hold. The refusal lives in
     * `PATCH /api/events/:id/status` and predates this change; this is the test
     * that ties the two together.
     */
    it('cannot be reopened to get around the lock', async () => {
      const { eventId } = await closedOut();

      const res = await srv.call('PATCH', `/api/events/${eventId}/status`, { status: 'open' }, organizer);

      expect(res.status).toBe(409);
      expect(await statusOf(eventId)).toBe('completed');
      expect((await closedOutAt(eventId)).at).toBeTruthy();
    });

    /**
     * The API is the boundary that matters: the UI hides these controls, and a
     * hidden control is not a rule. This is the same request the screen would
     * have sent, made directly.
     */
    it('refuses a hand-made request that never touched the UI', async () => {
      const { eventId, apps } = await closedOut({ hours: 4 });

      const res = await finalise(eventId, {
        attendanceMap: { [apps[1].appId]: true },
        hoursMap: { [apps[1].appId]: 0 },
        reason: 'Bypassing the screen.',
      }, organizer);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('hours_locked');
      expect((await creditedTo(apps[1].slotId, apps[1].userId)).hours_awarded).toBe(4);
    });

    /** The event's own details were already frozen by `completed`; unchanged. */
    it('still reports the event as complete', async () => {
      const { eventId } = await closedOut();
      expect(await statusOf(eventId)).toBe('completed');
    });
  });
});
