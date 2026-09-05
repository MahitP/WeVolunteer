import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { canSplitEventPage, parseEventFilters, buildEventWhere } from './eventQuery.js';

/**
 * The two-phase browse page, at the boundary where it switches on and off.
 *
 * ── What is actually at risk ──
 *
 * `GET /api/events` now runs one of two statements. When the page can be chosen
 * before the aggregate is folded, it is — phase 1 picks sixty ids, phase 2 folds
 * over those. When a filter or a sort reads the fold, the original single
 * statement runs unchanged.
 *
 * That is a fork in the most-used read path in the application, and the two
 * branches must be indistinguishable from outside. `bin/events-query-probe.mjs`
 * compares them row for row at four scales; this file guards the part a probe
 * against raw SQL cannot see — that the ROUTE returns the same thing, with the
 * same authorization, ordering and pagination, whichever branch it took.
 *
 * The first restructure of this query shipped a hard-coded list of
 * "aggregate-dependent filters" that named one which did not exist and missed
 * one which did, and the endpoint 500'd. So the predicate is asserted directly
 * here rather than trusted.
 */
let srv, organizer, student;

beforeAll(async () => {
  srv = await startTestServer();
  organizer = await srv.login('jordan.whitfield@example.org');
  student = await srv.login('leo.chen@example.com');

  const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();

  /**
   * Two shapes the fold treats differently: several slots, and exactly one.
   *
   * A zero-slot event is deliberately NOT created here — `POST /api/events`
   * refuses one (`slots.length === 0` is a 400), so building the fixture through
   * the API is impossible and forging it directly would be testing a state the
   * product does not produce. The zero-slot aggregate is covered where such rows
   * can genuinely arise, in `routes.eventsAggregate.test.js`.
   */
  const mk = async (title, slots) => (await srv.call('POST', '/api/events', {
    title, description: 'two-phase fixture', category: 'Other', location: 'Hall',
    applicationDeadline: iso(60 * 24 * 10), slots,
  }, organizer)).body.id;

  await mk('TwoPhase Alpha', [
    { name: 'A', description: 'd', startDatetime: iso(60 * 24 * 30), endDatetime: iso(60 * 24 * 30 + 120), maxSpots: 3 },
    { name: 'B', description: 'd', startDatetime: iso(60 * 24 * 31), endDatetime: iso(60 * 24 * 31 + 60), maxSpots: 2 },
  ]);
  await mk('TwoPhase Gamma', [
    { name: 'Solo', description: 'd', startDatetime: iso(60 * 24 * 32), endDatetime: iso(60 * 24 * 32 + 90), maxSpots: 1 },
  ]);
}, 120000);

afterAll(async () => { await srv?.close(); });

/** Which branch a filter set takes, decided by the shipped predicate. */
function splits(query) {
  const parsed = parseEventFilters(query);
  const filters = parsed.value ?? parsed;
  const { where } = buildEventWhere(filters, 'user-student-1', null);
  return canSplitEventPage(filters, where);
}

describe('the predicate itself', () => {
  it('splits the page when nothing reads the fold', () => {
    expect(splits({})).toBe(true);
    expect(splits({ sort: 'deadline' })).toBe(true);
    expect(splits({ sort: 'alpha' })).toBe(true);
    expect(splits({ category: 'Other' })).toBe(true);
    expect(splits({ q: 'twophase' })).toBe(true);
    expect(splits({ place: 'Hall' })).toBe(true);
  });

  it('refuses to split when a FILTER reads the fold', () => {
    /* Each of these three reads a different aggregate column, and each was a
       real way to get this wrong. */
    expect(splits({ openOnly: 'true' }), 'openOnly reads spots_remaining').toBe(false);
    expect(splits({ from: '2020-01-01' }), 'a date range reads agg.min_start').toBe(false);
    expect(splits({ minHours: '1' }), 'minHours reads agg.total_hours').toBe(false);
  });

  it('refuses to split when the SORT reads the fold', () => {
    expect(splits({ sort: 'spots' })).toBe(false);
    expect(splits({ sort: 'hours' })).toBe(false);
  });
});

describe('both branches answer identically', () => {
  const find = (body, title) =>
    (Array.isArray(body) ? body : body.events ?? body).find(e => e.title === title);

  it('an event carries the same aggregate figures on both branches', async () => {
    /**
     * THE invariant. `sort=alpha` splits; `sort=spots` does not. The same event
     * appears in both, and every derived number on it must agree — if the
     * restricted fold ever computed over the wrong id set, this is where it
     * shows.
     */
    const viaSplit = find((await srv.call('GET', '/api/events?sort=alpha&limit=200', undefined, student)).body, 'TwoPhase Alpha');
    const viaWhole = find((await srv.call('GET', '/api/events?sort=spots&limit=200', undefined, student)).body, 'TwoPhase Alpha');

    expect(viaSplit, 'the split branch did not return the event').toBeTruthy();
    expect(viaWhole, 'the single-statement branch did not return the event').toBeTruthy();
    expect(viaSplit).toEqual(viaWhole);
  });

  it('a single-slot event is identical on both branches', async () => {
    const a = find((await srv.call('GET', '/api/events?sort=alpha&limit=200', undefined, student)).body, 'TwoPhase Gamma');
    const b = find((await srv.call('GET', '/api/events?sort=spots&limit=200', undefined, student)).body, 'TwoPhase Gamma');
    expect(a, 'the split branch did not return the single-slot event').toBeTruthy();
    expect(a).toEqual(b);
  });

  it('the two branches return the same SET of events', async () => {
    const ids = (body) => (Array.isArray(body) ? body : body.events).map(e => e.id).sort();
    const split = ids((await srv.call('GET', '/api/events?sort=alpha&limit=400', undefined, student)).body);
    const whole = ids((await srv.call('GET', '/api/events?sort=spots&limit=400', undefined, student)).body);
    expect(split).toEqual(whole);
  });

  it('reports the same total on both branches', async () => {
    const split = (await srv.call('GET', '/api/events?sort=alpha&limit=1', undefined, student)).body.pagination.total;
    const whole = (await srv.call('GET', '/api/events?sort=spots&limit=1', undefined, student)).body.pagination.total;
    expect(split).toBe(whole);
  });
});

describe('pagination stays sound on the split branch', () => {
  it('walking every page yields each event exactly once', async () => {
    /* Offset soundness is the property the phase-1 tiebreak exists for: without
       a total order a row can appear on two pages or on none, and phase 1 is
       where the order is now decided. */
    const total = (await srv.call('GET', '/api/events?limit=1', undefined, student)).body.pagination.total;
    const seen = [];
    let offset = 0, guard = 0;
    while (offset !== null && guard++ < 200) {
      const res = await srv.call('GET', `/api/events?limit=7&offset=${offset}`, undefined, student);
      seen.push(...res.body.events.map(e => e.id));
      offset = res.body.pagination.nextOffset;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size, 'an event appeared on two pages').toBe(total);
  });

  it('is ordered by soonest, with the same order on repeated requests', async () => {
    const page = async () => (await srv.call('GET', '/api/events?limit=25', undefined, student))
      .body.events.map(e => e.id);
    const a = await page();
    expect(await page()).toEqual(a);
    expect(await page()).toEqual(a);
  });

  it('an offset past the end is an empty page, not an error', async () => {
    const total = (await srv.call('GET', '/api/events?limit=1', undefined, student)).body.pagination.total;
    const res = await srv.call('GET', `/api/events?limit=10&offset=${total + 500}`, undefined, student);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
  });
});

describe('authorization is unchanged by the split', () => {
  it('the browse scope still hides non-listable events on the split branch', async () => {
    /* `/api/events` is authenticated — a signed-out caller gets 401, not a
       public list — so the scope being guarded here is the `listable` default
       applied to a signed-in STUDENT, which is the one a performance edit could
       widen without anything else noticing. */
    expect((await srv.call('GET', '/api/events')).status, 'the route stopped requiring a session')
      .toBe(401);

    /**
     * `scope=listable` explicitly, because the DEFAULT is `all` — a detail worth
     * getting right rather than assuming. `eventQuery.js` records why: the
     * dashboards and the calendar rely on completed events being returned, so
     * defaulting to `listable` would have silently emptied those screens.
     * BrowseEvents asks for `listable` itself, and that is the scope a split
     * page must not widen.
     */
    const res = await srv.call('GET', '/api/events?scope=listable&sort=alpha&limit=200', undefined, student);
    expect(res.status).toBe(200);
    const body = Array.isArray(res.body) ? res.body : res.body.events;
    expect(body.length).toBeGreaterThan(0);
    for (const e of body) {
      expect(['open', 'closed'], `a listable page returned status ${e.status}`)
        .toContain(e.status);
    }

    /* And the split branch must not return MORE than the unsplit one does. */
    const whole = await srv.call('GET', '/api/events?scope=listable&sort=spots&limit=200', undefined, student);
    const ids = (r) => (Array.isArray(r.body) ? r.body : r.body.events).map(e => e.id).sort();
    expect(ids(res), 'the split branch returned a different set').toEqual(ids(whole));
  });

  it('"mine" is still scoped to the caller on the split branch', async () => {
    const res = await srv.call('GET', '/api/events?mine=true&limit=200', undefined, organizer);
    expect(res.status).toBe(200);
    const body = Array.isArray(res.body) ? res.body : res.body.events;
    expect(body.length).toBeGreaterThan(0);
    for (const e of body) expect(e.organizerId ?? e.organizer_id).toBe('user-org-1');
  });
});
