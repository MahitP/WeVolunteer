import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Server-side filtering, sorting and distance for the event list.
 *
 * BrowseEvents used to receive every event and filter in JavaScript, which is why
 * the endpoint had to return the whole table: a text search over "the pages
 * loaded so far" is a wrong answer, not a partial one, so the client could not
 * paginate while it owned the filtering.
 *
 * The property that matters throughout is that a filter is applied to ALL rows
 * and only then paged — `total` must reflect matches across the whole table, not
 * matches within one page.
 */

let srv, organizer, student;
const CATS = ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];
const PLACES = ['Reichler Park', 'Community Center', 'Library'];

beforeAll(async () => {
  srv = await startTestServer();
  organizer = await srv.login('jkatzenback@vikings.org');
  // srv.login resolves with an undefined cookie on failure rather than
  // rejecting, so the seeded address has to be exact.
  student = await srv.login('leo.chen28@gmail.com');
  if (!student) throw new Error('student login failed — check the seeded address');

  const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  for (let i = 0; i < 40; i++) {
    await srv.call('POST', '/api/events', {
      title: i % 4 === 0 ? `Tutoring Session ${i}` : `Park Cleanup ${i}`,
      description: i % 3 === 0 ? 'Involves grilling and cooking.' : 'Sorting and stacking.',
      category: CATS[i % 5],
      location: PLACES[i % 3],
      applicationDeadline: iso(60 * 24 * (2 + (i % 20))),
      slots: [{
        name: 'Shift', description: 'd',
        startDatetime: iso(60 * 24 * (5 + (i % 15))),
        // Between 1 and 4 hours, so minHours has something to bite on.
        endDatetime: iso(60 * 24 * (5 + (i % 15)) + 60 * (1 + (i % 4))),
        maxSpots: 3
      }]
    }, organizer);
  }
}, 90000);

afterAll(async () => { await srv?.close(); });

const q = (qs) => srv.call('GET', `/api/events?${qs}`, undefined, organizer);
const totalOf = async (qs) => (await q(qs)).body.pagination.total;

describe('text search', () => {
  it('searches across all rows, not just one page', async () => {
    // limit=5 returns five rows, but the total must count every match.
    const res = await q('scope=listable&limit=5&q=Tutoring');
    expect(res.body.events).toHaveLength(5);
    expect(res.body.pagination.total).toBeGreaterThan(5);
    // This is the assertion that was impossible with client-side filtering.
    expect(res.body.events.every(e => /Tutoring/i.test(e.title))).toBe(true);
  });

  it('is case-insensitive', async () => {
    expect(await totalOf('scope=listable&limit=5&q=tutoring'))
      .toBe(await totalOf('scope=listable&limit=5&q=TUTORING'));
  });

  it('matches the description as well as the title', async () => {
    const res = await q('scope=listable&limit=50&q=grilling');
    expect(res.body.pagination.total).toBeGreaterThan(0);
    expect(res.body.events.every(e => /grilling/i.test(e.description))).toBe(true);
  });

  it('matches the location', async () => {
    const res = await q('scope=listable&limit=50&q=Reichler');
    expect(res.body.pagination.total).toBeGreaterThan(0);
  });

  it('matches the organizer name', async () => {
    expect(await totalOf('scope=listable&limit=5&q=Katzenback')).toBeGreaterThan(0);
  });

  /**
   * instr on lowered text, not LIKE — so no character in user input can change
   * the shape of the match.
   */
  it('treats LIKE wildcards as literal characters', async () => {
    expect(await totalOf('scope=listable&limit=5&q=%')).toBe(0);
    expect(await totalOf('scope=listable&limit=5&q=_')).toBe(0);
    expect(await totalOf(`scope=listable&limit=5&q=${encodeURIComponent('%Tutoring%')}`)).toBe(0);
  });

  it('returns nothing for a term that matches nothing', async () => {
    expect(await totalOf('scope=listable&limit=5&q=zzzznotathing')).toBe(0);
  });
});

describe('structured filters', () => {
  it('filters by category', async () => {
    const res = await q('scope=listable&limit=50&category=5K');
    expect(res.body.pagination.total).toBeGreaterThan(0);
    expect(res.body.events.every(e => e.category === '5K')).toBe(true);
  });

  it('filters by place', async () => {
    const res = await q(`scope=listable&limit=50&place=${encodeURIComponent('Library')}`);
    expect(res.body.events.every(e => e.location === 'Library')).toBe(true);
  });

  it('filters by minimum hours', async () => {
    const all = await totalOf('scope=listable&limit=1');
    const some = await totalOf('scope=listable&limit=1&minHours=3');
    expect(some).toBeLessThan(all);
    expect(await totalOf('scope=listable&limit=1&minHours=99999')).toBe(0);
  });

  it('combines filters conjunctively', async () => {
    const cat = await totalOf('scope=listable&limit=1&category=5K');
    const both = await totalOf('scope=listable&limit=1&category=5K&q=Cleanup');
    expect(both).toBeLessThanOrEqual(cat);
  });

  it('scope=listable excludes completed and cancelled events', async () => {
    const res = await q('scope=listable&limit=200');
    expect(res.body.events.every(e => ['open', 'closed'].includes(e.status))).toBe(true);
  });

  /**
   * The default must stay 'all'. The dashboards and the calendar render service
   * history, so defaulting to 'listable' would silently blank them.
   */
  it('defaults to every status for backward compatibility', async () => {
    const all = await totalOf('limit=1');
    const listable = await totalOf('scope=listable&limit=1');
    expect(all).toBeGreaterThanOrEqual(listable);
  });

  it('openOnly requires open status, a free spot and an unexpired deadline', async () => {
    const res = await q('scope=listable&limit=100&openOnly=true');
    const now = Date.now();
    expect(res.body.events.every(e =>
      e.status === 'open' && e.spotsRemaining > 0 && new Date(e.applicationDeadline).getTime() > now
    )).toBe(true);
  });

  it('returns the places list for the dropdown, unaffected by the filters', async () => {
    const unfiltered = (await q('scope=listable&limit=1')).body.places;
    const filtered = (await q('scope=listable&limit=1&category=5K')).body.places;
    // A dropdown whose options shrink to match the current selection is a trap.
    expect(filtered).toEqual(unfiltered);
    expect(unfiltered.length).toBeGreaterThan(1);
  });
});

describe('sorting', () => {
  it('sorts by soonest shift', async () => {
    const events = (await q('scope=listable&limit=50&sort=soonest')).body.events.filter(e => e.slots?.length);
    const starts = events.map(e => e.startDatetime);
    expect(starts).toEqual([...starts].sort());
  });

  it('sorts alphabetically', async () => {
    const titles = (await q('scope=listable&limit=50&sort=alpha')).body.events.map(e => e.title.toLowerCase());
    expect(titles).toEqual([...titles].sort());
  });

  it('sorts by most spots open, descending', async () => {
    const spots = (await q('scope=listable&limit=50&sort=spots')).body.events.map(e => e.spotsRemaining);
    expect(spots).toEqual([...spots].sort((a, b) => b - a));
  });

  it('sorts by closing deadline', async () => {
    const d = (await q('scope=listable&limit=50&sort=deadline')).body.events.map(e => e.applicationDeadline);
    expect(d).toEqual([...d].sort());
  });

  it('paginates consistently under a sort', async () => {
    const a = (await q('scope=listable&limit=10&offset=0&sort=alpha')).body.events.map(e => e.id);
    const b = (await q('scope=listable&limit=10&offset=10&sort=alpha')).body.events.map(e => e.id);
    // No row may appear on both pages.
    expect(a.filter(id => b.includes(id))).toEqual([]);
  });
});

describe('distance', () => {
  beforeAll(async () => {
    /**
     * Coordinates are written straight to the database.
     *
     * PATCH /api/events/:id does not persist latitude/longitude — they are set
     * through the location picker on create — so going through the API left every
     * event without coordinates and the distance assertions had nothing to
     * measure.
     */
    const { db } = await import('./db.js');
    const list = (await q('scope=listable&limit=2')).body.events;
    // Two points roughly 8.7 miles apart.
    db.prepare('UPDATE events SET latitude = ?, longitude = ? WHERE id = ?').run(40.39, -74.52, list[0].id);
    db.prepare('UPDATE events SET latitude = ?, longitude = ? WHERE id = ?').run(40.49, -74.42, list[1].id);
  });

  it('reports distance in miles', async () => {
    const res = await q('scope=listable&limit=50&lat=40.39&lng=-74.52&sort=distance');
    const withDistance = res.body.events.filter(e => e.distance != null);
    expect(withDistance.length).toBeGreaterThan(0);
    // ~8.7 miles, not ~14 (which is what kilometres would give).
    expect(Math.max(...withDistance.map(e => e.distance))).toBeLessThan(30);
  });

  it('excludes events without coordinates from a distance filter', async () => {
    const res = await q('scope=listable&limit=50&lat=40.39&lng=-74.52&maxDistance=50');
    expect(res.body.events.every(e => e.distance != null)).toBe(true);
  });

  it('sorts nearest first and places unknown distances last', async () => {
    const d = (await q('scope=listable&limit=50&lat=40.39&lng=-74.52&sort=distance')).body.events
      .map(e => (e.distance == null ? Infinity : e.distance));
    expect(d).toEqual([...d].sort((a, b) => a - b));
  });

  it('narrows as the radius shrinks', async () => {
    const wide = await totalOf('scope=listable&limit=1&lat=40.39&lng=-74.52&maxDistance=100');
    const tight = await totalOf('scope=listable&limit=1&lat=40.39&lng=-74.52&maxDistance=1');
    expect(tight).toBeLessThanOrEqual(wide);
  });
});

describe('the mine filter — what lets the client stop loading everything', () => {
  it('returns far fewer events for a user who owns none', async () => {
    // The organizer authored every fixture event, so `mine` is legitimately the
    // whole list for THEM — the reduction has to be measured from a student.
    const all = (await srv.call('GET', '/api/events?limit=1', undefined, student)).body.pagination.total;
    const mine = (await srv.call('GET', '/api/events?limit=1&mine=true', undefined, student)).body.pagination.total;
    expect(mine).toBeLessThan(all);
  });

  it('includes events the caller hosts', async () => {
    const res = await q('limit=200&mine=true');
    // The organizer created every fixture event.
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.events.every(e => e.organizerId === 'user-org-1')).toBe(true);
  });

  it('is scoped per user', async () => {
    const orgTotal = (await srv.call('GET', '/api/events?limit=1&mine=true', undefined, organizer)).body.pagination.total;
    const studentTotal = (await srv.call('GET', '/api/events?limit=1&mine=true', undefined, student)).body.pagination.total;
    expect(orgTotal).not.toBe(studentTotal);
  });
});

describe('validation', () => {
  const bad = async (qs, field) => {
    const res = await q(qs);
    expect(res.status).toBe(400);
    if (field) expect(res.body.field).toBe(field);
  };

  it('rejects an unknown sort', () => bad('limit=5&sort=nope', 'sort'));
  it('rejects an unknown scope', () => bad('limit=5&scope=nope', 'scope'));
  it('rejects lat without lng', () => bad('limit=5&lat=40', 'lng'));
  it('rejects maxDistance without coordinates', () => bad('limit=5&maxDistance=5', 'maxDistance'));
  it('rejects distance sort without coordinates', () => bad('limit=5&sort=distance', 'sort'));
  it('rejects an out-of-range latitude', () => bad('limit=5&lat=200&lng=0', 'lat'));
  it('rejects a malformed date', () => bad('limit=5&from=2026/01/01', 'from'));
  it('rejects a negative minHours', () => bad('limit=5&minHours=-1', 'minHours'));

  it('still requires authentication', async () => {
    const res = await fetch(`${srv.base}/api/events?limit=5&q=anything`);
    expect([401, 403]).toContain(res.status);
  });
});
