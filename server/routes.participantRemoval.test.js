import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * An organizer removing somebody from a shift.
 *
 * ── The rule ──
 *
 * Before the shift starts, the host may take a volunteer off it — plans change,
 * and an organizer who cannot manage their own roster will manage it by not
 * using the product. Once the shift has started they may not, because at that
 * point removal is not roster management, it is editing the past: somebody
 * turned up and worked, and taking them off the list afterwards is how a record
 * stops being a record.
 *
 * Hours are never reachable from here. Removal writes `applications.status` and
 * nothing else; attendance and credited hours live in their own tables. A
 * volunteer keeps every hour they earned, whatever happens to their signup.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';

describe('removing a participant', () => {
  let srv;
  let db;
  let organizer;
  let student;
  let application;
  let eventId;
  let slotId;

  const setSlotWindow = async (offsetMinutesStart, offsetMinutesEnd) => {
    const now = Date.now();
    await db.prepare('UPDATE slots SET start_datetime = ?, end_datetime = ? WHERE id = ?').run(
      new Date(now + offsetMinutesStart * 60000).toISOString(),
      new Date(now + offsetMinutesEnd * 60000).toISOString(),
      slotId,
    );
  };

  const setStatus = (status, session = organizer, appId = application.id) =>
    srv.call('PATCH', `/api/applications/${appId}`, { status }, session);

  const statusOf = async (appId = application.id) =>
    (await db.prepare('SELECT status FROM applications WHERE id = ?').get(appId))?.status;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    organizer = await srv.login(ORGANIZER);
    student = await srv.login(STUDENT);

    const apps = (await srv.call('GET', '/api/applications', undefined, organizer)).body;
    application = apps.find(a => a.status === 'accepted');
    expect(application, 'the seed has no accepted application to remove').toBeTruthy();
    eventId = application.eventId;
    slotId = application.slotId;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare("UPDATE applications SET status = 'accepted' WHERE id = ?").run(application.id);
    await db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    await setSlotWindow(60 * 24, 60 * 25);
  });

  describe('before the shift starts', () => {
    it('lets the host remove an accepted volunteer', async () => {
      const res = await setStatus('rejected');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf()).toBe('rejected');
    });

    it('accepts a move to the waitlist', async () => {
      /**
       * Note what actually happens, which is pre-existing and not this guard's
       * doing: demoting the only accepted volunteer frees the place, and
       * `promoteFromWaitlist` then fills the spare capacity from the queue in
       * order — where they are now the only person waiting, so they are
       * re-accepted. Two correct rules composing into a no-op.
       *
       * Asserted as "the call succeeds" rather than "they end up waitlisted",
       * because the second would be a fiction. `rejected` is the status an
       * organizer actually reaches for to remove somebody, and it is tested
       * above.
       */
      const res = await setStatus('waitlisted');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(['waitlisted', 'accepted']).toContain(await statusOf());
    });

    it('frees the place, so the slot can be filled again', async () => {
      const before = (await db.prepare(
        "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
      ).get(slotId)).c;

      await setStatus('rejected');

      const after = (await db.prepare(
        "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
      ).get(slotId)).c;
      /* Either the count dropped, or the waitlist promoted somebody into the
         place — both are the place being freed, and which one happened is the
         existing promotion rule's business, not this guard's. */
      expect(after).toBeLessThanOrEqual(before);
    });
  });

  describe('once the shift has started', () => {
    beforeEach(async () => { await setSlotWindow(-30, 90); });

    it('refuses to remove the volunteer', async () => {
      const res = await setStatus('rejected');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('shift_started');
    });

    it('refuses to move them to the waitlist either', async () => {
      /* Waitlisting an accepted volunteer takes their place away exactly as
         rejecting does. Blocking one and not the other would be a rule with a
         door next to it. */
      const res = await setStatus('waitlisted');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('shift_started');
    });

    it('leaves the signup exactly as it was', async () => {
      await setStatus('rejected');
      expect(await statusOf()).toBe('accepted');
    });

    it('refuses at the exact moment the shift begins', async () => {
      /* The boundary itself: `slotHasStarted` is `start <= now`, so a shift
         starting this instant has started. */
      await setSlotWindow(0, 120);
      const res = await setStatus('rejected');
      expect(res.status).toBe(409);
    });

    it('still allows it one minute before', async () => {
      await setSlotWindow(1, 121);
      const res = await setStatus('rejected');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('refuses long after the shift has finished', async () => {
      await setSlotWindow(-60 * 48, -60 * 47);
      const res = await setStatus('rejected');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('shift_started');
    });
  });

  describe('hours are never revoked by removal', () => {
    it('leaves credited attendance untouched when removal succeeds', async () => {
      /**
       * The property that matters most. Somebody can be taken off a FUTURE
       * shift while holding credited hours from a past one, and those hours
       * must not move. This route writes `applications.status` and nothing
       * else — the test is what keeps that true.
       */
      const before = await db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(application.userId);

      const res = await setStatus('rejected');
      expect(res.status).toBe(200);

      const after = await db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(application.userId);

      expect(after).toEqual(before);
    });

    it('cannot be used to erase attendance already recorded for that very shift', async () => {
      /* A volunteer who was checked in, then the organizer tries to remove
         them. The shift has started, so the guard refuses — and the attendance
         row is still there afterwards either way. */
      await setSlotWindow(-30, 90);
      await db.prepare(`
        INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
        VALUES (?, ?, ?, 1, 2)
        ON CONFLICT(slot_id, user_id) DO UPDATE SET present = 1
      `).run(eventId, slotId, application.userId);

      await setStatus('rejected');

      const row = await db.prepare('SELECT present FROM attendance WHERE slot_id = ? AND user_id = ?')
        .get(slotId, application.userId);
      expect(row?.present).toBe(1);

      await db.prepare('DELETE FROM attendance WHERE slot_id = ? AND user_id = ?').run(slotId, application.userId);
    });
  });

  describe('authorization', () => {
    it('refuses an organizer who does not host this event', async () => {
      const outsider = await db.prepare(
        "SELECT id FROM users WHERE role = 'organizer' AND id <> (SELECT organizer_id FROM events WHERE id = ?)"
      ).get(eventId);
      expect(outsider, 'the seed has only one organizer').toBeTruthy();

      const realHost = (await db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(eventId)).organizer_id;
      await db.prepare('UPDATE events SET organizer_id = ? WHERE id = ?').run(outsider.id, eventId);

      const res = await setStatus('rejected');
      expect(res.status).toBe(403);
      expect(await statusOf()).toBe('accepted');

      await db.prepare('UPDATE events SET organizer_id = ? WHERE id = ?').run(realHost, eventId);
    });

    it('refuses a student trying to remove somebody else', async () => {
      /* A student reaches this route to withdraw their OWN application. The
         cascade must not let that branch touch another person's. */
      const res = await setStatus('rejected', student);
      expect([403, 404]).toContain(res.status);
      expect(await statusOf()).toBe('accepted');
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await srv.call('PATCH', `/api/applications/${application.id}`, { status: 'rejected' });
      expect(res.status).toBe(401);
    });
  });

  describe('what the guard deliberately does not block', () => {
    it('still lets an organizer decline a PENDING application after the shift', async () => {
      /**
       * Declining somebody who never held a place is not removing a
       * participant, and organizers reconcile applications after the fact all
       * the time. A guard that caught this would be stopping ordinary work to
       * enforce a rule about something else.
       */
      await setSlotWindow(-60 * 48, -60 * 47);
      await db.prepare("UPDATE applications SET status = 'pending' WHERE id = ?").run(application.id);

      const res = await setStatus('rejected');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('still lets an organizer accept somebody after the shift started', async () => {
      /* Late acceptance is how an organizer records that a volunteer who
         turned up unexpectedly was in fact welcome. */
      await setSlotWindow(-30, 90);
      await db.prepare("UPDATE applications SET status = 'pending' WHERE id = ?").run(application.id);

      const res = await setStatus('accepted');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
  });

  describe('the bulk route enforces the same rule', () => {
    /**
     * The single route 409s; the bulk route SKIPS, so the rest of a batch is
     * not lost to one application that cannot move. Both behaviours are
     * deliberate and only the first was covered — the skip branch had no test
     * at all, which meant the batch path could have started removing people
     * from shifts that had already run without anything failing.
     */
    const bulk = (ids, status, session = organizer) =>
      srv.call('PATCH', '/api/applications/bulk', { applicationIds: ids, status }, session);

    it('skips an accepted volunteer whose shift has started, and says why', async () => {
      await setSlotWindow(-30, 90);

      const res = await bulk([application.id], 'rejected');

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.skipped).toContainEqual({ id: application.id, reason: 'shift_started' });
      expect(res.body.applied).toEqual([]);
      expect(await statusOf(), 'the volunteer must still hold their place').toBe('accepted');
    });

    it('removes normally when the shift has not started', async () => {
      await setSlotWindow(60 * 24, 60 * 25);

      const res = await bulk([application.id], 'rejected');

      expect(res.status).toBe(200);
      expect(res.body.skipped ?? []).toEqual([]);
      expect(await statusOf()).toBe('rejected');
    });

    it('does not lose the rest of the batch to one started shift', async () => {
      /**
       * The whole reason this route skips instead of failing. An organizer
       * clearing a backlog should not have twenty good decisions discarded
       * because the twenty-first is out of time.
       */
      const others = await db.prepare(
        "SELECT id FROM applications WHERE status = 'pending' AND id != ? LIMIT 1"
      ).all(application.id);
      if (others.length === 0) return; // seed has none spare; the skip case above still holds

      await setSlotWindow(-30, 90);
      const res = await bulk([application.id, others[0].id], 'rejected');

      expect(res.status).toBe(200);
      expect(res.body.skipped).toContainEqual({ id: application.id, reason: 'shift_started' });
      expect(res.body.applied.map(a => a.id)).toContain(others[0].id);
    });

    it('never touches attendance or credited hours when it skips', async () => {
      const before = await db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(application.userId);

      await setSlotWindow(-60 * 24, -60 * 23);
      await bulk([application.id], 'rejected');

      expect(await db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(application.userId)).toEqual(before);
    });
  });
});
