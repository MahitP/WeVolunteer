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

    /**
     * Asserted by PARSING, not by substring.
     *
     * Every `toContain` below this comment used to be the whole test, and all of
     * them passed against a file that was a single line containing the literal
     * text `\r\n` — which no calendar application can open. A substring
     * assertion cannot distinguish a valid calendar from an invalid one, so the
     * structural checks come first and the content checks run against parsed
     * values.
     */
    expect(content).not.toContain('\\r\\n');            // the exact regression
    expect(content.endsWith('\r\n')).toBe(true);         // §3.1 termination
    expect(/(^|[^\r])\n/.test(content)).toBe(false);     // no bare LF

    const unfolded = content.replace(/\r\n[ \t]/g, '');
    const lines = unfolded.split('\r\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(10);            // not one blob
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR');

    // No physical line may exceed 75 octets (§3.1).
    const longest = Math.max(...content.split('\r\n').map(l => Buffer.byteLength(l, 'utf8')));
    expect(longest).toBeLessThanOrEqual(75);

    const props = Object.fromEntries(
      lines.map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)])
    );
    expect(props['VERSION']).toBe('2.0');
    expect(props['UID']).toBe(`${slot.id}@wevolunteer.org`);
    expect(props['SUMMARY']).toBe('ICS Export Test (Slot A)');
    expect(props['DTSTART']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(props['DTEND']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(lines).toContain('BEGIN:VEVENT');
    expect(lines).toContain('END:VEVENT');
  });

  it('escapes a comma in the location so the value is not truncated', async () => {
    const oToken = await srv.login('jkatzenback@vikings.org');
    const res = await srv.call('POST', '/api/events', {
      title: 'Comma Test', description: 'desc', category: 'Other',
      location: '12 Main St, Kendall Park, NJ',
      applicationDeadline: new Date(Date.now() + 2 * 864e5).toISOString(),
      slots: [{ name: 'Slot A', description: 'd', startDatetime: new Date(Date.now() + 5 * 864e5).toISOString(), endDatetime: new Date(Date.now() + 5 * 864e5 + 7200e3).toISOString(), maxSpots: 5 }]
    }, oToken);
    const evId = res.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, oToken)).body.find(e => e.id === evId).slots[0];

    const content = await (await fetch(`${srv.base}/api/events/${evId}/slots/${slot.id}/ics`, {
      headers: { Cookie: `wev_session=${oToken}` }
    })).text();

    const unfolded = content.replace(/\r\n[ \t]/g, '');
    const location = unfolded.split('\r\n').find(l => l.startsWith('LOCATION:')).slice('LOCATION:'.length);
    // A raw comma would make a conformant parser read this as a value list.
    expect(location).toBe('12 Main St\\, Kendall Park\\, NJ');
  });
});
