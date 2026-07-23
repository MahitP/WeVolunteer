import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('check-in', () => {
  let srv, orgToken, eventId, application;

  beforeAll(async () => {
    srv = await startTestServer();
    orgToken = await srv.login('jkatzenback@vikings.org');
    const apps = (await srv.call('GET', '/api/applications', undefined, orgToken)).body;
    application = apps.find(a => a.status === 'accepted');
    eventId = application.eventId;
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
    const student = await srv.login('leo.chen28@gmail.com');
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
});
