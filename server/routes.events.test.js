import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('events: ICS Export', () => {
  let srv;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });

  it('exports a valid ICS file for a given event and slot', async () => {
    const oToken = await srv.login('jkatzenback@vikings.org');
    
    // Create an event
    const res = await srv.call('POST', '/api/events', {
      title: 'ICS Export Test', description: 'desc', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 2 * 864e5).toISOString(),
      slots: [{ name: 'Slot A', description: 'desc', startDatetime: new Date(Date.now() + 5 * 864e5).toISOString(), endDatetime: new Date(Date.now() + 5 * 864e5 + 7200e3).toISOString(), maxSpots: 5 }]
    }, oToken);
    
    expect(res.status).toBe(201);
    const evId = res.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, oToken)).body.find(e => e.id === evId).slots[0];
    
    // Request ICS
    // srv.call only parses JSON, so we use fetch directly to read the text body.
    const icsRes = await fetch(`${srv.base}/api/events/${evId}/slots/${slot.id}/ics`, {
      headers: { Cookie: `wev_session=${oToken}` }
    });
    expect(icsRes.status).toBe(200);
    expect(icsRes.headers.get('content-type')).toContain('text/calendar');
    
    const content = await icsRes.text();
    expect(content).toContain('BEGIN:VCALENDAR');
    expect(content).toContain('VERSION:2.0');
    expect(content).toContain('BEGIN:VEVENT');
    expect(content).toContain(`UID:${slot.id}@wevolunteer.org`);
    expect(content).toContain('SUMMARY:ICS Export Test (Slot A)');
    expect(content).toContain('END:VEVENT');
    expect(content).toContain('END:VCALENDAR');
  });
});
