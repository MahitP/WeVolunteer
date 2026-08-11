import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * EVENTS_MAX_LIMIT is loaded LAZILY, inside beforeAll, and that is load-bearing.
 *
 * It used to be a static import of `./routes/eventRoutes.js`, which transitively
 * imports `db.js`. Static imports are evaluated before any hook runs, so `db.js`
 * opened its connection before `startTestServer()` had set `WEV_DB_PATH` — which
 * means it bound to the DEFAULT path, `server/wevolunteer.db`. The later dynamic
 * import inside startTestServer returned the already-cached module, so the whole
 * file ran against that real file instead of a throwaway one.
 *
 * The damage was cumulative and silent: every run added 25 permanent events to a
 * repo-local database. 797 of them had collected by the time this was found, and
 * the suite finally broke when the count passed the page-walk guard below — a
 * failure that looked like a pagination bug and was really a leaked fixture.
 *
 * Any static import here that reaches db.js reintroduces this. testServer.js now
 * asserts the resolved path is a temporary one, so it fails loudly rather than
 * quietly writing to the wrong database.
 */
let EVENTS_MAX_LIMIT;

/**
 * Pagination on GET /api/events.
 *
 * The endpoint returned every event with no ORDER BY. Two things follow from
 * that, and both are tested here:
 *
 *   1. It was the largest payload the app sends — 690 KB at 503 events, fetched
 *      on every session restore.
 *   2. Pagination could not have been bolted on correctly without first making
 *      the order deterministic. With no ORDER BY, SQLite may return equal rows in
 *      a different sequence per query, so `offset` would let a row appear on two
 *      pages or on none. The stability tests below are the ones that matter most.
 *
 * Pagination is opt-in: no `limit` means the bare array every current client
 * consumer already expects.
 */

let srv, organizer;

beforeAll(async () => {
  srv = await startTestServer();
  // Only now that WEV_DB_PATH points at the throwaway database is it safe to
  // import anything that pulls in db.js.
  ({ EVENTS_MAX_LIMIT } = await import('./routes/eventRoutes.js'));
  organizer = await srv.login('jordan.whitfield@example.org');

  // Enough events to page through, some sharing a start time so the tiebreak is
  // actually exercised rather than incidentally satisfied.
  const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  for (let i = 0; i < 25; i++) {
    // Every third event shares a start time with its predecessor.
    const dayOffset = 60 * 24 * (10 + Math.floor(i / 3));
    await srv.call('POST', '/api/events', {
      title: `Page Event ${String(i).padStart(2, '0')}`,
      description: 'pagination fixture',
      category: 'Other',
      location: 'Hall',
      applicationDeadline: iso(60 * 24 * 5),
      slots: [{
        name: 'Shift', description: 'd',
        startDatetime: iso(dayOffset),
        endDatetime: iso(dayOffset + 120),
        maxSpots: 4
      }]
    }, organizer);
  }
}, 60000);

afterAll(async () => { await srv?.close(); });

const page = (qs) => srv.call('GET', `/api/events${qs}`, undefined, organizer);

describe('backward compatibility', () => {
  it('returns a bare array when no limit is given', async () => {
    const res = await page('');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(25);
  });

  it('the legacy response is not truncated', async () => {
    // Silently shortening this would not error — it would show the calendar the
    // wrong data, because the SPA uses this response as a complete index.
    const all = (await page('')).body;
    const total = (await page('?limit=1')).body.pagination.total;
    expect(all.length).toBe(total);
  });

  it('each legacy item still carries its slots and organizer fields', async () => {
    const all = (await page('')).body;
    const withSlots = all.find(e => e.slots?.length);
    expect(withSlots.organizerName).toBeTruthy();
    expect(withSlots.slots[0]).toHaveProperty('spotsRemaining');
    expect(withSlots).toHaveProperty('hasAttendance');
  });
});

describe('paginated shape', () => {
  it('returns an envelope when limit is given', async () => {
    const res = await page('?limit=10');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body.events).toHaveLength(10);
    expect(res.body.pagination).toMatchObject({
      limit: 10, offset: 0, returned: 10, hasMore: true
    });
    expect(res.body.pagination.total).toBeGreaterThan(25);
    expect(res.body.pagination.nextOffset).toBe(10);
  });

  it('reports hasMore false and nextOffset null on the last page', async () => {
    const total = (await page('?limit=1')).body.pagination.total;
    const res = await page(`?limit=10&offset=${Math.max(0, total - 3)}`);
    expect(res.body.pagination.hasMore).toBe(false);
    expect(res.body.pagination.nextOffset).toBeNull();
    expect(res.body.events).toHaveLength(3);
  });

  it('returns an empty page past the end rather than erroring', async () => {
    const total = (await page('?limit=1')).body.pagination.total;
    const res = await page(`?limit=10&offset=${total + 500}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(0);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  it('items in a page have the same shape as legacy items', async () => {
    const legacy = (await page('')).body[0];
    const paged = (await page('?limit=1')).body.events[0];
    expect(Object.keys(paged).sort()).toEqual(Object.keys(legacy).sort());
  });
});

describe('offset soundness — the property that needs the ORDER BY', () => {
  /**
   * Walking every page must yield each event exactly once. Without a stable sort
   * this is the assertion that fails: rows tie, SQLite reorders them between
   * queries, and ids duplicate across pages while others vanish.
   */
  it('walking all pages yields every event exactly once', async () => {
    const total = (await page('?limit=1')).body.pagination.total;
    const LIMIT = 7;
    const seen = [];
    let offset = 0;
    // Derived from `total` rather than a fixed 100. The old constant capped the
    // walk at 100 * 7 = 700 ids, so once the database held more than that the
    // assertion failed with an off-by-26 that looked like a pagination fault and
    // was really the guard cutting the walk short. Sized to the data, plus a
    // couple of turns of slack, it can only trip on a genuine non-terminating
    // `nextOffset`.
    const maxPages = Math.ceil(total / LIMIT) + 2;
    let pages = 0;

    while (offset !== null && pages++ < maxPages) {
      const res = await page(`?limit=${LIMIT}&offset=${offset}`);
      seen.push(...res.body.events.map(e => e.id));
      offset = res.body.pagination.nextOffset;
    }

    expect(pages, 'nextOffset never terminated').toBeLessThanOrEqual(maxPages);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);   // no duplicates, no omissions
  });

  it('returns the same order on repeated identical requests', async () => {
    const a = (await page('?limit=20')).body.events.map(e => e.id);
    const b = (await page('?limit=20')).body.events.map(e => e.id);
    const c = (await page('?limit=20')).body.events.map(e => e.id);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('paginated order matches the legacy order', async () => {
    const legacy = (await page('')).body.map(e => e.id);
    const firstPage = (await page('?limit=15')).body.events.map(e => e.id);
    expect(firstPage).toEqual(legacy.slice(0, 15));
  });

  it('sorts by soonest shift', async () => {
    const events = (await page('?limit=30')).body.events.filter(e => e.slots?.length);
    const starts = events.map(e => e.startDatetime);
    const sorted = [...starts].sort();
    expect(starts).toEqual(sorted);
  });

  it('places events with no slots last, not first', async () => {
    // A NULL start sorts before every real date in SQLite; COALESCE prevents an
    // unscheduled event floating to the top of the browse list.
    await srv.call('POST', '/api/events', {
      title: 'No Slots Yet', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 6 * 864e5).toISOString(),
      slots: []
    }, organizer).catch(() => null);

    const all = (await page('')).body;
    const noSlotIndexes = all.map((e, i) => (e.slots?.length ? -1 : i)).filter(i => i >= 0);
    if (noSlotIndexes.length) {
      // Every slot-less event sits after every scheduled one.
      const lastScheduled = all.map((e, i) => (e.slots?.length ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
      expect(Math.min(...noSlotIndexes)).toBeGreaterThan(lastScheduled);
    }
  });
});

describe('parameter validation', () => {
  it('clamps an oversized limit instead of rejecting it', async () => {
    const res = await page('?limit=100000');
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(EVENTS_MAX_LIMIT);
    expect(res.body.pagination.maxLimit).toBe(EVENTS_MAX_LIMIT);
  });

  it('rejects a non-positive limit', async () => {
    expect((await page('?limit=0')).status).toBe(400);
    expect((await page('?limit=-5')).status).toBe(400);
  });

  it('rejects a non-numeric limit', async () => {
    const res = await page('?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('limit');
  });

  it('rejects a negative offset', async () => {
    const res = await page('?limit=10&offset=-1');
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('offset');
  });

  it('truncates a fractional limit rather than failing', async () => {
    const res = await page('?limit=7.9');
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(7);
  });

  it('defaults offset to zero when only limit is given', async () => {
    expect((await page('?limit=5')).body.pagination.offset).toBe(0);
  });
});

describe('a page does not do whole-table work', () => {
  /**
   * The batch loads for slots, accepted counts and attendance previously read the
   * entire table regardless of what was being returned, so a 20-event page cost
   * the same as the full list and pagination would have saved nothing on the
   * server. Scoping is asserted through payload size, which is the observable
   * consequence.
   */
  it('a small page is dramatically smaller than the full list', async () => {
    const full = await fetch(`${srv.base}/api/events`, { headers: { Cookie: `wev_session=${organizer}` } });
    const fullBytes = (await full.text()).length;

    const one = await fetch(`${srv.base}/api/events?limit=5`, { headers: { Cookie: `wev_session=${organizer}` } });
    const pageBytes = (await one.text()).length;

    expect(pageBytes).toBeLessThan(fullBytes / 3);
  });

  it('still requires authentication', async () => {
    const res = await fetch(`${srv.base}/api/events?limit=5`);
    expect([401, 403]).toContain(res.status);
  });
});
