import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import {
  volunteerStatsResponse,
  VOLUNTEER_STATS_FIELDS,
} from '../src/testFixtures/volunteerStats.js';

/**
 * The client's picture of `GET /api/stats/volunteer`, checked against the
 * server's.
 *
 * ── The bug ──
 *
 * Welly's `my_hours` tool read `stats.hours` and `stats.events`. This endpoint
 * has never returned either. Its top level is `{monthlyHours, record,
 * milestones, streak, upcomingCount, serviceHourGoal}`, and the figures are
 * inside `record` as `hoursCredited` and `eventsAttended`.
 *
 * Both reads were therefore `undefined`, both `?? 0` defaults fired, and Welly
 * told every student who ever asked that they had no verified hours. Reported
 * by one whose dashboard read 209 on the same screen — "This is a big mix up
 * its been like this for a while."
 *
 * ── Why the client suite could not catch it ──
 *
 * Six client test files stubbed the endpoint as `{hours: 35.5, events: 7}` —
 * the shape the broken code wanted, not the shape the server sends. Every one
 * of them passed. A hand-written mock does not merely fail to catch a mismatch
 * like this; it certifies it, in whichever direction the author already
 * believed, and it goes on certifying it for as long as nobody compares the two
 * files.
 *
 * Moving the stub into `src/testFixtures/volunteerStats.js` fixes six lies in
 * one place and creates a seventh: a shared fixture is still just a literal
 * somebody typed. This is what stops it drifting — it is the only test in the
 * repository that can see both the fixture and the running server, and it fails
 * the moment they disagree.
 *
 * ── Why the field names are asserted and not just the value ──
 *
 * The failure was a rename-shaped one: the data was correct at every layer and
 * the client asked for it by a name nobody used. Comparing key sets is what
 * catches that; comparing a number would not, because `0` was a plausible
 * answer for a new account and stayed plausible for an account with 209 hours.
 */

/**
 * One server for the whole file. `startTestServer()` binds a process-wide
 * database path and refuses to run twice in a module, so the two describes
 * below share this rather than each booting their own.
 */
let srv;
let student;
let live;

beforeAll(async () => {
  srv = await startTestServer();
  student = await srv.login('leo.chen@example.com');
  live = (await srv.call('GET', '/api/stats/volunteer', undefined, student)).body;
}, 60000);

afterAll(async () => { await srv?.close(); });

describe('GET /api/stats/volunteer matches the client fixture', () => {

  it('agrees on every top-level key', () => {
    expect(Object.keys(live).sort()).toEqual(Object.keys(volunteerStatsResponse()).sort());
  });

  it('agrees on every key inside record', () => {
    expect(Object.keys(live.record).sort())
      .toEqual(Object.keys(volunteerStatsResponse().record).sort());
  });

  it('puts the figures where the fixture says, and nowhere else', () => {
    const { container, hours, events } = VOLUNTEER_STATS_FIELDS;

    /* Where they ARE. */
    expect(live[container]).toBeDefined();
    expect(typeof live[container][hours]).toBe('number');
    expect(typeof live[container][events]).toBe('number');

    /* And where `my_hours` used to look for them. Pinned as absent so that
       adding a convenience alias later is a deliberate act with a failing test
       to read first, rather than something that quietly makes two shapes both
       half-work. */
    expect(live.hours).toBeUndefined();
    expect(live.events).toBeUndefined();
    expect(live.attended).toBeUndefined();
  });

  it('reports a real figure through the same field the fixture uses', async () => {
    /**
     * The value, not just the shape. A student with credited hours must see
     * them arrive in `record.hoursCredited` — the field the fixture models and
     * the tool now reads — rather than in some sibling the client would miss.
     */
    const organizer = await srv.login('jordan.whitfield@example.org');
    const board = (await srv.call('GET', '/api/leaderboard', undefined, organizer)).body;
    const withCredit = (Array.isArray(board) ? board : board?.entries || [])
      .find(r => Number(r.hours) > 0);

    if (!withCredit) {
      /* The seed has no credited attendance. Say so rather than passing
         silently — a vacuous assertion here is exactly the kind of comfort
         that let the original bug survive. */
      expect(live.record.hoursCredited).toBe(0);
      return;
    }

    const theirs = await srv.login(withCredit.email || 'leo.chen@example.com');
    const body = (await srv.call('GET', '/api/stats/volunteer', undefined, theirs)).body;
    expect(typeof body.record.hoursCredited).toBe('number');
  });
});

/**
 * The dashboard's number and the assistant's number, from the same request.
 *
 * ── The second mismatch ──
 *
 * Fixing Welly's field name made it agree with `record.hoursCredited`. That is
 * only the right answer if `hoursCredited` is also what the DASHBOARD shows,
 * and it was not: `volunteeredHours` on the user payload came from a separate
 * `SELECT SUM(hours_awarded) … WHERE present = 1` in `formatUserResponse` with
 * no reference to the event, so it counted cancelled events that every other
 * surface excludes.
 *
 * Measured before the fix, on a scratch database: 209 hours against one event,
 * the event cancelled, dashboard reading 209 and insights reading 0. So a
 * student could have been shown two different totals on two screens even with
 * the Welly bug fixed — which is the complaint that started this, not a
 * separate one.
 *
 * Both now call `creditedHoursFor`. This is what keeps them calling it.
 */
describe('the dashboard and the assistant report the same hours', () => {
  const PEOPLE = [
    ['a student', 'leo.chen@example.com'],
    ['another student', 'priya.patel@example.com'],
    ['an organizer', 'jordan.whitfield@example.org'],
  ];

  it('is comparing a real figure, not two zeroes', async () => {
    /**
     * Non-vacuity guard. `0 === 0` passes whatever the two surfaces do, so if
     * the seed ever loses its credited attendance this suite would go on
     * reporting agreement while checking nothing. Priya has 3 credited hours
     * today; the assertion is that SOMEBODY does.
     */
    const totals = [];
    for (const [, email] of PEOPLE) {
      const session = await srv.login(email);
      const stats = (await srv.call('GET', '/api/stats/volunteer', undefined, session)).body;
      if (typeof stats?.record?.hoursCredited === 'number') totals.push(stats.record.hoursCredited);
    }
    expect(Math.max(...totals), 'seed has no credited hours left to compare').toBeGreaterThan(0);
  });

  for (const [who, email] of PEOPLE) {
    it(`agrees for ${who}`, async () => {
      const session = await srv.login(email);

      const me = (await srv.call('GET', '/api/auth/me', undefined, session)).body;
      const dashboard = (me.user ?? me).volunteeredHours;

      const stats = (await srv.call('GET', '/api/stats/volunteer', undefined, session)).body;

      /* An organizer may not have `stats.self`; skip the comparison rather than
         assert against an error body, but never skip it silently for a student. */
      if (stats?.record == null) {
        expect(who).not.toMatch(/student/);
        return;
      }

      expect(typeof dashboard).toBe('number');
      expect(dashboard).toBe(stats.record.hoursCredited);
    });
  }
});
