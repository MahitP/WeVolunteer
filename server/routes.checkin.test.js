import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startTestServer } from './testServer.js';

describe('check-in', () => {
  let srv, orgToken, eventId, application, db;

  /**
   * Moves the fixture event's shifts into the present.
   *
   * ── Why the fixture has to be dated at all now ──
   *
   * Check-in opens two hours before the first shift starts (see
   * `checkinWindowState`). The seeded events sit days in the future, so every
   * case here was quietly exercising "mark a roster present for an event that
   * has not happened" — which is the thing the window exists to refuse, and
   * which these tests were pinning as normal simply because nothing stopped it.
   *
   * Taking attendance for a shift that is currently running is what the endpoint
   * is FOR, so that is what the fixture now describes. The refusals get their own
   * cases below rather than being the accidental default of every other one.
   */
  const startShiftsNow = (id) => {
    const now = Date.now();
    db.prepare('UPDATE slots SET start_datetime = ?, end_datetime = ? WHERE event_id = ?').run(
      new Date(now - 30 * 60 * 1000).toISOString(),
      new Date(now + 90 * 60 * 1000).toISOString(),
      id
    );
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    orgToken = await srv.login('jordan.whitfield@example.org');
    const apps = (await srv.call('GET', '/api/applications', undefined, orgToken)).body;
    application = apps.find(a => a.status === 'accepted');
    eventId = application.eventId;
    startShiftsNow(eventId);
  });
  afterAll(async () => { await srv.close(); });

  it('serves a single event with its applications', async () => {
    const res = await srv.call('GET', `/api/events/${eventId}`, undefined, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe(eventId);
    expect(Array.isArray(res.body.event.slots)).toBe(true);
    expect(Array.isArray(res.body.applications)).toBe(true);
  });

  it('refuses a single event to a student', async () => {
    const student = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', `/api/events/${eventId}`, undefined, student);
    expect(res.status).toBe(403);
  });

  it('404s an unknown event', async () => {
    const res = await srv.call('GET', '/api/events/does-not-exist', undefined, orgToken);
    expect(res.status).toBe(404);
  });

  it('records a check-in keyed by application id', async () => {
    const res = await srv.call('POST', `/api/events/${eventId}/checkin`,
      { checkinMap: { [application.id]: true } }, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(res.body.skipped).toEqual([]);
  });

  it('reads the mark back', async () => {
    const res = await srv.call('GET', `/api/events/${eventId}/checkin`, undefined, orgToken);
    const mark = res.body.find(c => c.userId === application.userId && c.slotId === application.slotId);
    expect(mark.present).toBe(true);
  });

  it('reports keys it could not match rather than silently dropping them', async () => {
    const res = await srv.call('POST', `/api/events/${eventId}/checkin`,
      { checkinMap: { 'slot-x:user-y': true } }, orgToken);
    expect(res.body.marked).toBe(0);
    expect(res.body.skipped).toContain('slot-x:user-y');
  });
  /* ── The two refusals ─────────────────────────────────────────────────── */

  describe('when attendance cannot be taken', () => {
    const setSlots = (startOffsetMs, endOffsetMs) => {
      const now = Date.now();
      db.prepare('UPDATE slots SET start_datetime = ?, end_datetime = ? WHERE event_id = ?').run(
        new Date(now + startOffsetMs).toISOString(),
        new Date(now + endOffsetMs).toISOString(),
        eventId
      );
    };

    afterEach(() => {
      /* 'open', not 'approved' — the column carries a CHECK constraint of
         ('open','closed','completed','cancelled') and there is no 'approved'. */
      db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
      startShiftsNow(eventId);
    });

    /**
     * Marking a roster present days ahead is a prediction, not attendance — and
     * an attendance record that was filled in rather than observed is the one
     * thing this table must not contain.
     */
    it('refuses check-in before the window opens', async () => {
      setSlots(3 * 24 * 60 * 60 * 1000, 3 * 24 * 60 * 60 * 1000 + 3600_000);

      const res = await srv.call('POST', `/api/events/${eventId}/checkin`,
        { checkinMap: { [application.id]: true } }, orgToken);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('checkin_not_open');
      expect(res.body.opensAt).toBeTruthy();
    });

    /** Two hours before is inside the window; three hours before is not. */
    it('allows check-in once the window has opened', async () => {
      setSlots(60 * 60 * 1000, 4 * 60 * 60 * 1000);

      const res = await srv.call('POST', `/api/events/${eventId}/checkin`,
        { checkinMap: { [application.id]: true } }, orgToken);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    /**
     * The finalise route has refused a cancelled event since it was written.
     * Check-in did not, which left the two halves of one workflow disagreeing
     * about whether a cancelled event still happened.
     */
    it('refuses check-in for a cancelled event', async () => {
      db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(eventId);

      const res = await srv.call('POST', `/api/events/${eventId}/checkin`,
        { checkinMap: { [application.id]: true } }, orgToken);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('event_cancelled');
    });

    /** And it writes nothing while refusing. */
    it('records no mark when it refuses', async () => {
      db.prepare('DELETE FROM attendance_checkin WHERE event_id = ?').run(eventId);
      db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(eventId);

      await srv.call('POST', `/api/events/${eventId}/checkin`,
        { checkinMap: { [application.id]: true } }, orgToken);

      expect(db.prepare(
        'SELECT COUNT(*) AS n FROM attendance_checkin WHERE event_id = ?'
      ).get(eventId).n).toBe(0);
    });
  });
});
