/**
 * Recording the hours a volunteer ACTUALLY completed, and events that credit
 * no hours at all.
 *
 * ── Why this needed changing ──
 *
 * Before v1.3 the only number that could ever be credited was the scheduled
 * duration of the slot. A volunteer rostered for four hours who left after two
 * and a half was credited four; one who stayed an extra hour was credited
 * three. The scheduled duration is a default, not a fact, and an organizer had
 * no way to say so.
 *
 * The tests below are as much about the guardrails as the feature. Credited
 * hours are a student's graduation record: an edit to one has to be bounded,
 * reasoned, and written to the ledger, or the correction mechanism becomes a
 * quieter way to alter somebody's transcript than the one that already exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('actual hours, and events that credit none', () => {
  let srv, db;
  let organizer, admin, student, studentId, organizerId;

  /** An event whose single shift is already over, with one accepted volunteer. */
  async function pastEventWithApplicant({ creditsHours = true, hours = 4 } = {}) {
    const start = new Date(Date.now() - 3 * 86400000);
    const end = new Date(start.getTime() + hours * 3600000);
    const eventId = `event-${Math.random().toString(36).slice(2)}`;
    const slotId = `slot-${Math.random().toString(36).slice(2)}`;
    const appId = `app-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();

    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, created_at, credits_hours)
      VALUES (?, 'Past shift', 'd', 'Other', 'Somewhere', ?, ?, 'open', ?, ?)
    `).run(eventId, start.toISOString(), organizerId, now, creditsHours ? 1 : 0);
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Shift', 'd', ?, ?, 5)
    `).run(slotId, eventId, start.toISOString(), end.toISOString());
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'accepted', ?)
    `).run(appId, studentId, eventId, slotId, now);

    return { eventId, slotId, appId };
  }

  const credited = async (slotId) => await db.prepare(
    'SELECT present, hours_awarded FROM attendance WHERE slot_id = ? AND user_id = ?'
  ).get(slotId, studentId);

  const ledger = async (slotId) => await db.prepare(
    'SELECT * FROM hours_ledger WHERE slot_id = ? ORDER BY rowid'
  ).all(slotId);

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login('jordan.whitfield@example.org');
    admin = await srv.login('admin@example.gov');
    student = await srv.login('leo.chen@example.com');
    ({ db } = await import('./db.js'));
    studentId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('leo.chen@example.com')).id;
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('jordan.whitfield@example.org')).id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  describe('the scheduled duration remains the default', () => {
    it('credits the slot duration when no override is given', async () => {
      const { eventId, slotId, appId } = await pastEventWithApplicant({ hours: 4 });
      const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true },
      }, organizer);
      expect(res.status).toBe(200);
      expect((await credited(slotId)).hours_awarded).toBe(4);
    });
  });

  describe('an organizer can record what actually happened', () => {
    it('credits fewer hours when a volunteer left early', async () => {
      const { eventId, slotId, appId } = await pastEventWithApplicant({ hours: 4 });
      const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true },
        hoursMap: { [appId]: 2.5 },
      }, organizer);
      expect(res.status).toBe(200);
      expect(await credited(slotId)).toMatchObject({ present: 1, hours_awarded: 2.5 });
    });

    it('credits more hours when a volunteer stayed on', async () => {
      const { eventId, slotId, appId } = await pastEventWithApplicant({ hours: 3 });
      await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true }, hoursMap: { [appId]: 4 },
      }, organizer);
      expect((await credited(slotId)).hours_awarded).toBe(4);
    });

    /**
     * The single most likely reason to reopen this screen: the attendance flag
     * is right and only the number is wrong. Before the fix this was skipped as
     * "unchanged" and silently did nothing.
     */
    it('applies an hours-only correction rather than skipping it as unchanged', async () => {
      const { eventId, slotId, appId } = await pastEventWithApplicant({ hours: 4 });
      await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true },
      }, organizer);
      expect((await credited(slotId)).hours_awarded).toBe(4);

      const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true }, hoursMap: { [appId]: 1.5 },
        reason: 'Left after the first hour and a half.',
      }, organizer);
      expect(res.status).toBe(200);
      expect((await credited(slotId)).hours_awarded).toBe(1.5);
    });
  });

  describe('a correction is bounded, reasoned, and recorded', () => {
    it('requires a reason to change an existing record', async () => {
      const { eventId, appId } = await pastEventWithApplicant({ hours: 4 });
      await srv.call('POST', `/api/events/${eventId}/attendance`, { attendanceMap: { [appId]: true } }, organizer);

      const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true }, hoursMap: { [appId]: 2 },
      }, organizer);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('reason_required');
      /* The refusal names what would have changed, in both dimensions. */
      expect(res.body.corrections[0]).toMatchObject({ hoursFrom: 4, hoursTo: 2 });
    });

    it('rolls the whole submission back when it is refused', async () => {
      const { eventId, slotId, appId } = await pastEventWithApplicant({ hours: 4 });
      await srv.call('POST', `/api/events/${eventId}/attendance`, { attendanceMap: { [appId]: true } }, organizer);
      await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true }, hoursMap: { [appId]: 2 },
      }, organizer);
      expect((await credited(slotId)).hours_awarded).toBe(4);
    });

    it('refuses an out-of-range or unparseable number', async () => {
      for (const bad of [-1, 500, 'lots', NaN, null]) {
        const { eventId, appId } = await pastEventWithApplicant({ hours: 4 });
        const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
          attendanceMap: { [appId]: true }, hoursMap: { [appId]: bad },
        }, organizer);
        expect(res.status, `hoursMap value ${String(bad)} must be refused`).toBe(400);
        expect(res.body.code).toBe('invalid_hours');
      }
    });

    /**
     * An hours-only change lands as `adjusted`, not as a second `credited`.
     * "Credited 2.5" after "credited 4" reads as two separate awards; the
     * distinction is what makes the trail legible to whoever reads it later.
     */
    it('writes an adjusted ledger entry carrying the before and after', async () => {
      const { eventId, slotId, appId } = await pastEventWithApplicant({ hours: 4 });
      await srv.call('POST', `/api/events/${eventId}/attendance`, { attendanceMap: { [appId]: true } }, organizer);
      await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true }, hoursMap: { [appId]: 2.5 },
        reason: 'Left early — family pickup.',
      }, organizer);

      const rows = await ledger(slotId);
      expect(rows).toHaveLength(2);
      expect(rows[0].action).toBe('credited');
      expect(rows[1]).toMatchObject({
        action: 'adjusted', hours_before: 4, hours_after: 2.5, delta: -1.5,
        actor_id: organizerId, source: 'attendance_screen',
        reason: 'Left early — family pickup.',
      });
    });

    it('refuses an organizer who does not host the event', async () => {
      const { eventId, appId } = await pastEventWithApplicant({ hours: 4 });
      const other = await srv.signupConfirmed({
        name: 'Other Organizer', username: 'otherorg', email: 'other.org.contact@example.net',
        grade: 'Adult', role: 'organizer', password: 'TestPass123!',
      });
      const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true }, hoursMap: { [appId]: 99 },
      }, other.cookie);
      expect([403, 401]).toContain(res.status);
    });

    it('refuses a student outright', async () => {
      const { eventId, appId } = await pastEventWithApplicant({ hours: 4 });
      const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true }, hoursMap: { [appId]: 12 },
      }, student);
      expect(res.status).toBe(403);
    });
  });

  describe('events that credit no hours', () => {
    it('records attendance and credits zero', async () => {
      const { eventId, slotId, appId } = await pastEventWithApplicant({ creditsHours: false, hours: 4 });
      const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true },
      }, organizer);
      expect(res.status).toBe(200);
      expect(await credited(slotId)).toMatchObject({ present: 1, hours_awarded: 0 });
    });

    /* The flag carries the meaning, so an hours override on such an event has
       nothing to correct — it is ignored rather than refused. */
    it('ignores an hours override on a participation event', async () => {
      const { eventId, slotId, appId } = await pastEventWithApplicant({ creditsHours: false, hours: 4 });
      await srv.call('POST', `/api/events/${eventId}/attendance`, {
        attendanceMap: { [appId]: true }, hoursMap: { [appId]: 6 },
      }, organizer);
      expect((await credited(slotId)).hours_awarded).toBe(0);
    });

    it('is created through the API with creditsHours: false, and reports it back', async () => {
      const res = await srv.call('POST', '/api/events', {
        title: 'Coat drive', description: 'Drop coats at the gym.', category: 'Other',
        location: 'Gym', applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
        creditsHours: false,
        slots: [{
          name: 'Collection', description: 'Sort coats', maxSpots: 10,
          startDatetime: new Date(Date.now() + 9 * 86400000).toISOString(),
          endDatetime: new Date(Date.now() + 9 * 86400000 + 3600000).toISOString(),
        }],
      }, organizer);
      expect(res.status).toBe(201);
      expect(res.body.creditsHours).toBe(false);

      /* `GET /api/events/:id` is deliberately staff-only — it carries the
         applicant roster — so the organizer reads it here. */
      const detail = await srv.call('GET', `/api/events/${res.body.id}`, undefined, organizer);
      expect(detail.status).toBe(200);
      expect(detail.body.event.creditsHours).toBe(false);

      /* And the student-facing list, which is where a volunteer actually
         learns that an opportunity is participation-only. */
      const browse = await srv.call('GET', '/api/events?limit=100', undefined, student);
      const listed = (Array.isArray(browse.body) ? browse.body : browse.body.events)
        .find(e => e.id === res.body.id);
      expect(listed.creditsHours).toBe(false);
    });

    /**
     * The default has to be TRUE. Every existing client sends no such field and
     * every existing event awards hours; defaulting the other way would turn the
     * whole back catalogue into participation-only events.
     */
    it('defaults to crediting hours when the field is absent', async () => {
      const res = await srv.call('POST', '/api/events', {
        title: 'Ordinary event', description: 'd', category: 'Other', location: 'l',
        applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
        slots: [{
          name: 's', description: 'd', maxSpots: 3,
          startDatetime: new Date(Date.now() + 9 * 86400000).toISOString(),
          endDatetime: new Date(Date.now() + 9 * 86400000 + 3600000).toISOString(),
        }],
      }, organizer);
      expect(res.status).toBe(201);
      expect(res.body.creditsHours).toBe(true);
    });

    it('does not disturb the derived-hours total', async () => {
      const before = (await db.prepare(
        'SELECT COALESCE(SUM(hours_awarded), 0) AS h FROM attendance WHERE user_id = ? AND present = 1'
      ).get(studentId)).h;
      const { eventId, appId } = await pastEventWithApplicant({ creditsHours: false, hours: 8 });
      await srv.call('POST', `/api/events/${eventId}/attendance`, { attendanceMap: { [appId]: true } }, organizer);
      const after = (await db.prepare(
        'SELECT COALESCE(SUM(hours_awarded), 0) AS h FROM attendance WHERE user_id = ? AND present = 1'
      ).get(studentId)).h;
      expect(after).toBe(before);
    });

    /* The event still counts as attended — participation is the point of it. */
    it('still counts toward the participation statistics', async () => {
      const { volunteerStats } = await import('./volunteerStats.js');
      const { eventId, appId } = await pastEventWithApplicant({ creditsHours: false, hours: 2 });
      const before = (await volunteerStats(db, studentId)).eventsAttended;
      await srv.call('POST', `/api/events/${eventId}/attendance`, { attendanceMap: { [appId]: true } }, organizer);
      expect((await volunteerStats(db, studentId)).eventsAttended).toBe(before + 1);
    });
  });
});
