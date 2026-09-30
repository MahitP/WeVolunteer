/**
 * Spike: one event, start to certificate, with the clock moved rather than the
 * rows.
 *
 * Every existing lifecycle test moves a shift's times with a direct UPDATE so
 * that "now" falls inside it. That is the right tool for a unit of behaviour and
 * the wrong one for a rehearsal, whose whole point is that every write goes
 * through a route a person could have called. So this moves `Date` instead —
 * and ONLY `Date`: timers stay real, so the HTTP server, the database driver
 * and the in-process workers all keep running.
 *
 * If this passes, the week can be built the same way. If it cannot pass, the
 * reason is the finding.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer } from '../testServer.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe('spike: one event lifecycle under a moved clock', () => {
  let srv;
  let t0;

  const at = (ms) => vi.setSystemTime(new Date(ms));

  beforeAll(async () => {
    t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    at(t0);
    srv = await startTestServer();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await srv?.close();
  });

  it('create → apply → accept → QR check-in → credit → close-out → certificate', async () => {
    let organizer = await srv.login('jordan.whitfield@example.org');
    let student = await srv.login('leo.chen@example.com');

    const start = t0 + 3 * DAY;
    const made = await srv.call('POST', '/api/events', {
      title: 'Spike: riverbank cleanup', description: 'Litter pick along the towpath.',
      category: 'Other', location: 'Reichler Park',
      applicationDeadline: new Date(t0 + 2 * DAY).toISOString(),
      slots: [{ name: 'Morning', description: 'Bags and gloves provided',
        startDatetime: new Date(start).toISOString(),
        endDatetime: new Date(start + 2 * HOUR).toISOString(), maxSpots: 5 }],
    }, organizer);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const eventId = made.body.id;

    const detail = await srv.call('GET', `/api/events/${eventId}`, undefined, organizer);
    const slotId = detail.body.event.slots[0].id;

    const applied = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, student);
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);

    const roster = await srv.call('GET', `/api/events/${eventId}`, undefined, organizer);
    const app = roster.body.applications.find(a => a.slotId === slotId);
    const accepted = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'accepted' }, organizer);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    // Before the shift: no code can exist yet (the rule verified at the gate).
    const early = await srv.call('POST', `/api/applications/${app.id}/checkin-code`, {}, student);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('checkin_not_started');

    // Move to ten minutes into the shift. Sessions may have expired over three
    // simulated days, so sign in again rather than assume they survived.
    at(start + 10 * 60_000);
    organizer = await srv.login('jordan.whitfield@example.org');
    student = await srv.login('leo.chen@example.com');

    const code = await srv.call('POST', `/api/applications/${app.id}/checkin-code`, {}, student);
    expect(code.status, JSON.stringify(code.body)).toBe(200);
    expect(code.body.displayName).toMatch(/^@|Leo/);
    const scanned = await srv.call('POST', `/api/events/${eventId}/checkin/scan`, { token: code.body.token }, organizer);
    expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);

    // After the shift: credit, then close out.
    at(start + 3 * HOUR);
    organizer = await srv.login('jordan.whitfield@example.org');
    const credited = await srv.call('POST', `/api/events/${eventId}/attendance`, { attendanceMap: { [app.id]: true } }, organizer);
    expect(credited.status, JSON.stringify(credited.body)).toBe(200);
    const closed = await srv.call('POST', `/api/events/${eventId}/hours/close-out`, {}, organizer);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    // The lock holds after close-out.
    const relock = await srv.call('POST', `/api/events/${eventId}/attendance`, { attendanceMap: { [app.id]: false } }, organizer);
    expect(relock.status).toBe(409);

    student = await srv.login('leo.chen@example.com');
    const certs = await srv.call('GET', '/api/certificates', undefined, student);
    expect(certs.status).toBe(200);
    const list = Array.isArray(certs.body) ? certs.body : (certs.body.certificates || []);
    expect(list.some(c => (c.eventTitle || c.event_title || c.title || '').includes('riverbank'))).toBe(true);
  });
});
