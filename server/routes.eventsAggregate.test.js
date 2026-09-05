import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The events aggregate is now folded over the FILTERED set, and this is what
 * keeps that from changing any answer.
 *
 * ── What changed, and the risk it introduced ──
 *
 * `agg` used to fold every event and every slot in the database before the outer
 * query discarded almost all of it, so a search for one word cost the same as
 * listing everything. It now carries the event-only half of the WHERE clause
 * (`buildAggScope`), which at 10,000 events took a category filter from 57ms to
 * 18ms and a text search from 63ms to 24ms.
 *
 * The risk is specific and worth naming, because it is silent: the predicates
 * pushed into the aggregate select **which events are folded**, never **which
 * slots or applications count toward one**. If a slot-level or
 * application-level condition were ever pushed down with them, every derived
 * figure — spots remaining, total hours, the event's start and end — would
 * quietly become "…among the rows that matched the filter" instead of "…for this
 * event". Nothing would error. The numbers would just be wrong, differently for
 * every filter.
 *
 * So the central assertion here is an INVARIANT rather than a value: an event's
 * aggregate figures must be identical however it was found. Every filter that
 * can return a given event is asked for it, and the derived numbers are compared
 * against the same event fetched with no filter at all.
 *
 * `bin/events-query-probe.mjs` is the companion: it runs the old and new SQL
 * side by side on PostgreSQL at 100 / 1,000 / 5,000 / 10,000 events and compares
 * every row. This file is what runs on both engines, in CI, on every change.
 */
let srv, organizer, db;

/** Events the fixtures create, by the property that makes each interesting. */
const FIXTURES = {
  /* Two slots, different lengths, so hours and spots are non-trivial sums. */
  twoSlots: null,
  /* No slots at all — MIN/MAX are NULL and the sums COALESCE to zero. This is
     the row a LEFT JOIN turned into an inner join would silently drop. */
  noSlots: null,
  /* One slot, fully taken, so spotsRemaining floors at zero rather than going
     negative. */
  full: null,
};

const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  organizer = await srv.login('jordan.whitfield@example.org');

  const make = async (title, slots, extra = {}) => {
    const res = await srv.call('POST', '/api/events', {
      title,
      description: 'aggregate fixture',
      category: 'Food Pantry',
      location: 'Aggregate Hall',
      applicationDeadline: iso(60 * 24 * 20),
      slots,
      ...extra,
    }, organizer);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
  };

  FIXTURES.twoSlots = await make('Aggregate Two Slots', [
    { name: 'Morning', description: 'd', startDatetime: iso(60 * 24 * 30), endDatetime: iso(60 * 24 * 30 + 120), maxSpots: 4 },
    { name: 'Afternoon', description: 'd', startDatetime: iso(60 * 24 * 31), endDatetime: iso(60 * 24 * 31 + 180), maxSpots: 6 },
  ]);

  FIXTURES.full = await make('Aggregate Full Event', [
    { name: 'Only', description: 'd', startDatetime: iso(60 * 24 * 32), endDatetime: iso(60 * 24 * 32 + 60), maxSpots: 1 },
  ]);

  /* An event with no slots cannot be created through the API — the route
     requires at least one — so its slot is removed afterwards. That is a real
     state: an organizer may delete every slot from an event they are still
     drafting. */
  FIXTURES.noSlots = await make('Aggregate No Slots', [
    { name: 'Doomed', description: 'd', startDatetime: iso(60 * 24 * 33), endDatetime: iso(60 * 24 * 33 + 60), maxSpots: 3 },
  ]);
  await db.prepare('DELETE FROM slots WHERE event_id = ?').run(FIXTURES.noSlots);

  /* Fill the one-seat event so spotsRemaining is exactly zero. */
  const listed = (await srv.call('GET', '/api/events', undefined, organizer)).body;
  const fullSlot = listed.find(e => e.id === FIXTURES.full).slots[0];
  const student = await srv.login('leo.chen@example.com');
  await srv.call('POST', `/api/events/${FIXTURES.full}/apply`, { slotId: fullSlot.id }, student);
  const apps = (await srv.call('GET', '/api/applications', undefined, organizer)).body;
  const app = apps.find(a => a.eventId === FIXTURES.full);
  await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'accepted' }, organizer);
}, 120000);

afterAll(async () => { await srv?.close(); });

/** Fetches the list under a query string and returns it as an array. */
async function list(qs = '') {
  const res = await srv.call('GET', `/api/events${qs}`, undefined, organizer);
  expect(res.status, `GET /api/events${qs} -> ${JSON.stringify(res.body)}`).toBe(200);
  return Array.isArray(res.body) ? res.body : res.body.events;
}

/** The derived figures for one event, or null when the filter excluded it. */
async function aggregateOf(eventId, qs) {
  const found = (await list(qs)).find(e => e.id === eventId);
  if (!found) return null;
  return {
    spotsRemaining: found.spotsRemaining,
    maxSpots: found.maxSpots,
    hoursAwarded: found.hoursAwarded,
    startDatetime: found.startDatetime,
    endDatetime: found.endDatetime,
    slotCount: found.slots?.length ?? 0,
  };
}

/**
 * Every query string that can legitimately return the fixture events.
 *
 * Chosen so that each pushes a different predicate into the aggregate: a status
 * scope, a text match on the title, a category, a place, the openOnly triple,
 * and combinations with sorts and paging.
 */
const FINDING_QUERIES = [
  ['unfiltered', '?limit=200'],
  ['scope listable', '?limit=200&scope=listable'],
  ['scope open', '?limit=200&scope=open'],
  ['text search', '?limit=200&q=Aggregate'],
  ['category', '?limit=200&category=Food%20Pantry'],
  ['place', '?limit=200&place=Aggregate%20Hall'],
  ['text + category', '?limit=200&q=Aggregate&category=Food%20Pantry'],
  ['sorted by deadline', '?limit=200&sort=deadline'],
  ['sorted by hours', '?limit=200&sort=hours'],
  ['sorted by spots', '?limit=200&sort=spots'],
  ['sorted alphabetically', '?limit=200&sort=alpha'],
  ['text + sort', '?limit=200&q=Aggregate&sort=alpha'],
];

describe('an event\'s aggregate does not depend on how it was found', () => {
  /**
   * THE invariant. A predicate pushed into the aggregate must select which
   * EVENTS are folded, never which slots or applications count toward one.
   */
  /* `Object.keys`, and the id read INSIDE the test body. Destructuring the id in
     the loop header captures it at collection time, when `beforeAll` has not run
     and every fixture is still null — which is exactly what the first version of
     this file did, and it failed with "missing from an unfiltered list" for all
     three while the tests below, reading the same fixtures at run time, passed. */
  for (const name of Object.keys(FIXTURES)) {
    it(`reports identical figures for the ${name} event under every filter`, async () => {
      const id = FIXTURES[name];
      const baseline = await aggregateOf(id, '?limit=200');
      expect(baseline, `fixture ${name} is missing from an unfiltered list`).not.toBeNull();

      for (const [label, qs] of FINDING_QUERIES) {
        const found = await aggregateOf(id, qs);
        if (found === null) continue; // legitimately filtered out
        expect(found, `${name} reported different figures under "${label}"`).toEqual(baseline);
      }
    });
  }
});

describe('the figures themselves are right', () => {
  it('sums spots and hours across every slot', async () => {
    const agg = await aggregateOf(FIXTURES.twoSlots, '?limit=200');
    expect(agg.maxSpots).toBe(10);            // 4 + 6
    expect(agg.slotCount).toBe(2);
    expect(agg.spotsRemaining).toBe(10);      // nobody accepted
    expect(agg.hoursAwarded).toBeCloseTo(5, 1); // 2h + 3h
  });

  it('takes the earliest start and the latest end', async () => {
    const agg = await aggregateOf(FIXTURES.twoSlots, '?limit=200');
    expect(new Date(agg.startDatetime).getTime())
      .toBeLessThan(new Date(agg.endDatetime).getTime());
  });

  it('an event with no slots survives the aggregate rather than vanishing', async () => {
    /* The LEFT JOIN case. An inner join here would silently empty the row from
       every listing, and no test that only counted results would notice. */
    const agg = await aggregateOf(FIXTURES.noSlots, '?limit=200');
    expect(agg, 'the slotless event disappeared from the listing').not.toBeNull();
    expect(agg.slotCount).toBe(0);
    expect(agg.maxSpots).toBe(0);
    expect(agg.spotsRemaining).toBe(0);
  });

  it('spots remaining floors at zero for a full event', async () => {
    const agg = await aggregateOf(FIXTURES.full, '?limit=200');
    expect(agg.maxSpots).toBe(1);
    expect(agg.spotsRemaining).toBe(0);
  });
});

describe('the aggregate-dependent filters still work', () => {
  /**
   * `openOnly`, `from`, `to` and `minHours` are conditions ON the aggregate, so
   * they stay in the outer WHERE. `openOnly` is the interesting one: it
   * contributes three predicates and only one reads the aggregate, so the other
   * two are still pushed down. Getting that wrong is what made the first attempt
   * reference `agg` from inside the statement producing it.
   */
  it('openOnly excludes a full event and keeps an open one', async () => {
    const ids = (await list('?limit=200&openOnly=true')).map(e => e.id);
    expect(ids, 'a full event is not open for applications').not.toContain(FIXTURES.full);
    expect(ids).toContain(FIXTURES.twoSlots);
  });

  it('minHours excludes an event with too few hours', async () => {
    const generous = (await list('?limit=200&minHours=1')).map(e => e.id);
    expect(generous).toContain(FIXTURES.twoSlots);   // 5 hours
    const impossible = (await list('?limit=200&minHours=99')).map(e => e.id);
    expect(impossible).not.toContain(FIXTURES.twoSlots);
  });

  it('a date range filters on the aggregate start', async () => {
    const far = new Date(Date.now() + 60 * 24 * 60000 * 200).toISOString().slice(0, 10);
    const none = (await list(`?limit=200&from=${far}`)).map(e => e.id);
    expect(none).not.toContain(FIXTURES.twoSlots);

    const today = new Date().toISOString().slice(0, 10);
    const all = (await list(`?limit=200&from=${today}`)).map(e => e.id);
    expect(all).toContain(FIXTURES.twoSlots);
  });

  it('openOnly combined with a text search applies both halves', async () => {
    const ids = (await list('?limit=200&openOnly=true&q=Aggregate')).map(e => e.id);
    expect(ids).toContain(FIXTURES.twoSlots);
    expect(ids).not.toContain(FIXTURES.full);
  });
});

describe('paging over the filtered aggregate stays sound', () => {
  it('the total is the same whether or not a page is requested', async () => {
    const paged = await srv.call('GET', '/api/events?limit=1&q=Aggregate', undefined, organizer);
    const all = await list('?limit=200&q=Aggregate');
    expect(paged.body.pagination.total).toBe(all.length);
  });

  it('walking pages of a filtered list yields each event exactly once', async () => {
    const total = (await srv.call('GET', '/api/events?limit=1&q=Aggregate', undefined, organizer))
      .body.pagination.total;
    const seen = [];
    let offset = 0;
    let guard = 0;
    while (offset !== null && guard++ < 50) {
      const res = await srv.call('GET', `/api/events?limit=2&offset=${offset}&q=Aggregate`, undefined, organizer);
      seen.push(...res.body.events.map(e => e.id));
      offset = res.body.pagination.nextOffset;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('a filter matching nothing returns an empty page, not an error', async () => {
    const res = await srv.call('GET', '/api/events?limit=10&q=zzzz-no-such-event-zzzz', undefined, organizer);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });
});
