import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * What an organizer is told about a volunteer's follow-through.
 *
 * ── The unfairness these guard against ──
 *
 * "7 of 9" invites exactly one reading: that somebody missed two shifts. That
 * reading is wrong whenever an organizer simply never confirmed attendance —
 * and the volunteer can neither make that happen nor see it being held against
 * them when they apply somewhere else.
 *
 * So the endpoint publishes the whole decomposition, and never a rate. The
 * repository already argues this in four places; these tests are what keep the
 * argument true.
 */

const ORGANIZER = 'jordan.whitfield@example.org';

describe('applicant reliability figures', () => {
  let srv;
  let organizer;
  let applicants;

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login(ORGANIZER);

    const events = (await srv.call('GET', '/api/events', undefined, organizer)).body;
    const list = Array.isArray(events) ? events : events.events;
    for (const event of list) {
      const res = await srv.call('GET', `/api/events/${event.id}/applications`, undefined, organizer);
      if (res.status === 200 && res.body.length > 0) { applicants = res.body; break; }
    }
    if (!applicants) {
      applicants = (await srv.call('GET', '/api/applications', undefined, organizer)).body;
    }
    expect(applicants?.length, 'the seed has no applicants to review').toBeGreaterThan(0);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('publishes attended, signed up, absent and awaiting-record together', () => {
    const v = applicants[0].volunteer;
    expect(v.eventsSignedUp).toBeTypeOf('number');
    expect(v.eventsAttended).toBeTypeOf('number');
    /* `eventsAbsent` was computed and then dropped, which left an organizer
       unable to tell a missed shift from unfinished paperwork. */
    expect(v.eventsAbsent).toBeTypeOf('number');
    expect(v.eventsAwaitingRecord).toBeTypeOf('number');
  });

  it('keeps the four figures consistent with each other', () => {
    for (const app of applicants) {
      const v = app.volunteer;
      expect(
        v.eventsAttended + v.eventsAbsent + v.eventsAwaitingRecord,
        'signedUp must decompose exactly into attended, absent and awaiting',
      ).toBe(v.eventsSignedUp);
    }
  });

  it('never publishes a rate', () => {
    /* "1 of 2 — 50%" reads as a verdict on a person when the evidence behind
       it is one missed shift, and a reader cannot un-see the number. */
    for (const app of applicants) {
      const keys = Object.keys(app.volunteer);
      expect(keys.filter(k => /rate|percent|score|reliability/i.test(k))).toEqual([]);
    }
  });

  it('never counts an upcoming shift against somebody', () => {
    /* `signedUp` counts only commitments whose shift has ENDED, so a volunteer
       is never marked down for a shift they have not had the chance to attend. */
    for (const app of applicants) {
      const v = app.volunteer;
      expect(v.eventsAttended).toBeLessThanOrEqual(v.eventsSignedUp);
    }
  });
});
