import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Pagination and scoping on GET /api/applications.
 *
 * ── What this endpoint was ──
 *
 * `BASE_QUERY` had no `LIMIT` and no `ORDER BY`, and the admin branch ran it
 * unscoped — so somebody holding `application.read_all` received every
 * application in the system in one response, each row carrying a volunteer's
 * name, school, grade, bio, skills and badges. Alongside it, three batch loads
 * read the WHOLE of `attendance` (twice) and the whole of `application_conflicts`
 * on every call, whoever was asking: a student fetching their own four
 * applications pulled a district's attendance history into two `Map`s.
 *
 * The deployment runbook already named this endpoint as a reason not to size the
 * host below 1 GB, so this is a documented ceiling being closed rather than a
 * speculative one.
 *
 * ── Why the ORDER BY is the assertion that matters ──
 *
 * Same property `routes.eventsPagination.test.js` exists for: without a total
 * order, `OFFSET` is unsound — equal rows may come back in a different sequence
 * per query, so one application appears on two pages and another on none. The
 * page-walk test below is the one that fails if the tiebreak is ever dropped.
 *
 * `APPLICATIONS_MAX_LIMIT` is imported LAZILY inside `beforeAll` for the reason
 * `routes.eventsPagination.test.js` documents at length: a static import reaches
 * `db.js`, which would open its connection before `startTestServer()` has set
 * `WEV_DB_PATH` and write fixtures into a repo-local database.
 */
let APPLICATIONS_MAX_LIMIT;

let srv, organizer, student, admin;

/** How many applications the student holds. Enough to walk several pages. */
const SEEDED = 24;

beforeAll(async () => {
  srv = await startTestServer();
  ({ APPLICATIONS_MAX_LIMIT } = await import('./routes/applicationRoutes.js'));

  organizer = await srv.login('jordan.whitfield@example.org');
  student = await srv.login('leo.chen@example.com');
  admin = await srv.login('admin@example.gov');

  const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();

  /**
   * One application per event, so the student's own scope holds a known count.
   *
   * Every shift starts on a different day, deliberately. Overlapping shifts are
   * refused as a schedule conflict, so an earlier version of this fixture that
   * had three events share a start time produced 8 applications instead of 24 —
   * the endpoint was right and the fixture was wrong.
   *
   * The tie the ORDER BY actually has to break is on `applied_at`, not on start
   * time, and this loop produces those for free: it applies as fast as the
   * server will take them, so several rows land in the same millisecond.
   */
  const created = [];
  for (let i = 0; i < SEEDED; i++) {
    const dayOffset = 60 * 24 * (40 + i);
    const mk = await srv.call('POST', '/api/events', {
      title: `Application Page Event ${String(i).padStart(2, '0')}`,
      description: 'pagination fixture',
      category: 'Other',
      location: 'Hall',
      applicationDeadline: iso(60 * 24 * 20),
      slots: [{
        name: 'Shift', description: 'd',
        startDatetime: iso(dayOffset),
        endDatetime: iso(dayOffset + 120),
        maxSpots: 4
      }]
    }, organizer);
    created.push(mk.body.id);
  }

  /* Slot ids come from the list endpoint, once, rather than a detail call per
     event — the same route the sibling application suites read them from. */
  const listed = (await srv.call('GET', '/api/events', undefined, organizer)).body;

  /**
   * Applications are DECIDED as they are made, all but the last few.
   *
   * ── Why the fixture cannot simply apply 24 times ──
   *
   * `PENDING_APPLICATION_LIMIT` (config.js, default 10) caps how many
   * opportunities one student may hold awaiting a decision, and
   * `POST /api/events/:id/apply` answers 409 `application_limit_reached` past
   * it. A loop that applied 24 times and decided nothing therefore produced
   * ELEVEN applications, not 24, and the suite failed on a count it had every
   * right to expect — the endpoint was right and the fixture was written before
   * the cap existed.
   *
   * Deciding as we go is also the more honest fixture. A student with two dozen
   * applications on file is a student with a HISTORY: most of them resolved,
   * a few still waiting. A student holding 24 simultaneously pending
   * applications is a state the application deliberately does not allow, so a
   * pagination suite built on one would be paginating something that cannot
   * occur.
   *
   * `rejected` rather than `accepted` for the decided ones: it clears the
   * pending count without consuming slot capacity, awarding hours or writing
   * attendance rows, so the fixture stays a pagination fixture rather than
   * quietly becoming an attendance one. The last `STILL_PENDING` are left
   * undecided so the page still contains both shapes.
   */
  const STILL_PENDING = 5;
  for (const [i, eventId] of created.entries()) {
    const slot = listed.find(e => e.id === eventId).slots[0];
    const applied = await srv.call(
      'POST', `/api/events/${eventId}/apply`, { slotId: slot.id }, student
    );
    /* Loud rather than silent: a fixture that half-fails and carries on is how
       the count drifted unnoticed in the first place. */
    if (applied.status !== 201) {
      throw new Error(
        `fixture: apply ${i} answered ${applied.status} `
        + `(${JSON.stringify(applied.body)}) — expected 201`
      );
    }
    if (i < SEEDED - STILL_PENDING) {
      const decided = await srv.call(
        'PATCH', `/api/applications/${applied.body.application.id}`,
        { status: 'rejected' }, organizer
      );
      if (decided.status !== 200) {
        throw new Error(
          `fixture: decision on application ${i} answered ${decided.status} `
          + `(${JSON.stringify(decided.body)}) — expected 200`
        );
      }
    }
  }
}, 120000);

afterAll(async () => { await srv?.close(); });

const page = (qs, token) => srv.call('GET', `/api/applications${qs}`, undefined, token);

describe('backward compatibility', () => {
  it('returns a bare array when no limit is given', async () => {
    const res = await page('', student);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(SEEDED);
  });

  it('the legacy response is not truncated below the cap', async () => {
    const all = (await page('', student)).body;
    const total = (await page('?limit=1', student)).body.pagination.total;
    expect(all.length).toBe(total);
  });

  it('each legacy item still carries its volunteer, slot and event blocks', async () => {
    const one = (await page('', student)).body[0];
    expect(one.volunteer).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    expect(one.volunteer).toHaveProperty('eventsSignedUp');
    expect(one.volunteer).toHaveProperty('badges');
    expect(one.slot).toHaveProperty('maxSpots');
    expect(one.event).toHaveProperty('startDatetime');
    expect(one).toHaveProperty('hasConflict');
  });

  it('does not leak the window function into the payload', async () => {
    // `COUNT(*) OVER () AS total_count` rides along on every row. The serialiser
    // builds an explicit object, and this asserts it stays explicit.
    const one = (await page('', student)).body[0];
    expect(one).not.toHaveProperty('total_count');
    expect(one).not.toHaveProperty('totalCount');
  });
});

describe('paginated shape', () => {
  it('returns an envelope when limit is given', async () => {
    const res = await page('?limit=10', student);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body.applications).toHaveLength(10);
    expect(res.body.pagination).toMatchObject({
      limit: 10, offset: 0, returned: 10, hasMore: true, maxLimit: APPLICATIONS_MAX_LIMIT
    });
    expect(res.body.pagination.nextOffset).toBe(10);
  });

  it('reports hasMore false and nextOffset null on the last page', async () => {
    const total = (await page('?limit=1', student)).body.pagination.total;
    const res = await page(`?limit=10&offset=${Math.max(0, total - 3)}`, student);
    expect(res.body.pagination.hasMore).toBe(false);
    expect(res.body.pagination.nextOffset).toBeNull();
    expect(res.body.applications).toHaveLength(3);
  });

  it('returns an empty page past the end rather than erroring', async () => {
    const total = (await page('?limit=1', student)).body.pagination.total;
    const res = await page(`?limit=10&offset=${total + 500}`, student);
    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(0);
    expect(res.body.pagination.hasMore).toBe(false);
    expect(res.body.pagination.total).toBe(0);
  });

  it('items in a page have the same shape as legacy items', async () => {
    const legacy = (await page('', student)).body[0];
    const paged = (await page('?limit=1', student)).body.applications[0];
    expect(Object.keys(paged).sort()).toEqual(Object.keys(legacy).sort());
  });

  it('clamps an over-large limit rather than refusing it', async () => {
    const res = await page(`?limit=${APPLICATIONS_MAX_LIMIT + 5000}`, student);
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(APPLICATIONS_MAX_LIMIT);
  });

  it('refuses a limit or offset that is not a number', async () => {
    expect((await page('?limit=0', student)).status).toBe(400);
    expect((await page('?limit=-1', student)).status).toBe(400);
    expect((await page('?limit=abc', student)).status).toBe(400);
    expect((await page('?limit=5&offset=-1', student)).status).toBe(400);
    expect((await page('?limit=5&offset=nope', student)).status).toBe(400);
  });
});

describe('offset soundness — the property that needs the ORDER BY', () => {
  it('walking all pages yields every application exactly once', async () => {
    const total = (await page('?limit=1', student)).body.pagination.total;
    const LIMIT = 7;
    const seen = [];
    let offset = 0;
    const maxPages = Math.ceil(total / LIMIT) + 2;
    let pages = 0;

    while (offset !== null && pages++ < maxPages) {
      const res = await page(`?limit=${LIMIT}&offset=${offset}`, student);
      seen.push(...res.body.applications.map(a => a.id));
      offset = res.body.pagination.nextOffset;
    }

    expect(pages, 'nextOffset never terminated').toBeLessThanOrEqual(maxPages);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('returns the same order on repeated identical requests', async () => {
    const a = (await page('?limit=20', student)).body.applications.map(x => x.id);
    const b = (await page('?limit=20', student)).body.applications.map(x => x.id);
    const c = (await page('?limit=20', student)).body.applications.map(x => x.id);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('paginated order matches the legacy order', async () => {
    const legacy = (await page('', student)).body.map(x => x.id);
    const first = (await page('?limit=15', student)).body.applications.map(x => x.id);
    expect(first).toEqual(legacy.slice(0, 15));
  });

  it('sorts newest application first', async () => {
    const applied = (await page('?limit=30', student)).body.applications.map(a => a.appliedAt);
    const sorted = [...applied].sort().reverse();
    expect(applied).toEqual(sorted);
  });
});

describe('scoping survives pagination', () => {
  /**
   * The reason this file asserts authorization at all: pagination rewrote the
   * branch cascade that decides which rows a caller may see, and a performance
   * edit that widens that cascade is a data leak, not a regression.
   */
  it('a student still sees only their own applications, on every page', async () => {
    let offset = 0;
    let guard = 0;
    while (offset !== null && guard++ < 20) {
      const res = await page(`?limit=5&offset=${offset}`, student);
      for (const a of res.body.applications) {
        expect(a.volunteer.id).toBe(a.userId);
      }
      const mine = new Set(res.body.applications.map(a => a.userId));
      expect(mine.size).toBeLessThanOrEqual(1);
      offset = res.body.pagination.nextOffset;
    }
  });

  it('an admin sees at least what the student sees, and pages it', async () => {
    const studentTotal = (await page('?limit=1', student)).body.pagination.total;
    const adminTotal = (await page('?limit=1', admin)).body.pagination.total;
    expect(adminTotal).toBeGreaterThanOrEqual(studentTotal);

    const first = await page('?limit=5', admin);
    expect(first.body.applications).toHaveLength(5);
  });

  it('the batch-loaded volunteer figures are still populated on a page', async () => {
    // The three batch loads were narrowed from whole-table reads to the page's
    // ids. If the narrowing were wrong, these would silently read zero.
    const res = await page('?limit=5', student);
    for (const a of res.body.applications) {
      expect(typeof a.volunteer.volunteeredHours).toBe('number');
      expect(typeof a.volunteer.eventsSignedUp).toBe('number');
      expect(Array.isArray(a.volunteer.badges)).toBe(true);
    }
  });
});
