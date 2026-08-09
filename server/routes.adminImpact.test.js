import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `/api/admin/impact` — the platform-wide figures, and who may read them.
 *
 * ── What this replaced ──
 *
 * `/api/public/impact`, which answered anybody with no session at all. The
 * concept was wrong rather than the implementation: these figures are an
 * internal view of how the programme is doing, not a marketing page. The old
 * route is asserted GONE below rather than merely re-gated, because a route
 * that still exists is a route somebody can still call.
 *
 * ── Why the authorization cases are the first three ──
 *
 * The client route was, for a while, declared in `PUBLIC_ROUTES` carrying a
 * `requiredCap` that nothing in that table reads — so an anonymous visitor
 * rendered the administrator's dashboard. The API was the only thing standing
 * between that page and the data. These three cases are what made that a
 * cosmetic bug instead of a disclosure, so they are pinned here rather than
 * left to the capability matrix.
 */

/**
 * A seeded demo account, promoted. `makeOwner` runs the same UPDATE
 * `bin/grant-ownership.mjs` runs and refuses an address it cannot find — there
 * is deliberately no code path that CREATES an owner, so the fixture has to be
 * an account the demo seed already made.
 */
const OWNER_EMAIL = 'dsanger@outlook.com';

describe('GET /api/admin/impact', () => {
  let srv;

  beforeAll(async () => {
    srv = await startTestServer();
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('refuses a request with no session', async () => {
    const res = await srv.call('GET', '/api/admin/impact');
    expect(res.status).toBe(401);
  });

  it('refuses a signed-in account without analytics.platform', async () => {
    const { cookie } = await srv.signupConfirmed({
      email: 'student@test.local', name: 'Student User', username: 'student_user',
      password: 'Password123!', grade: 'Adult', role: 'student',
    });
    const res = await srv.call('GET', '/api/admin/impact', undefined, cookie);
    expect(res.status).toBe(403);
    /* The refusal must not carry the payload it refused. A 403 whose body still
       holds the figures is a disclosure with a status code on top. */
    expect(res.body?.community).toBeUndefined();
    expect(res.body?.growth).toBeUndefined();
  });

  it('answers the platform owner', async () => {
    const owner = await srv.loginAsOwner(OWNER_EMAIL);
    const res = await srv.call('GET', '/api/admin/impact', undefined, owner);
    expect(res.status).toBe(200);
    expect(res.body.community).toBeTruthy();
  });

  /**
   * The sections the dashboard draws, named individually.
   *
   * Asserted as "these keys are present" rather than "the key set is exactly
   * this", deliberately. `buildImpact` is documented as written to grow — a new
   * section is meant to be additive — and an exact-equality assertion on the
   * key set turns every future section into a failing test in a file that is
   * about authorization. What must not change is that the four things the page
   * renders keep arriving.
   */
  it('carries every section the dashboard renders', async () => {
    const owner = await srv.loginAsOwner(OWNER_EMAIL);
    const { body } = await srv.call('GET', '/api/admin/impact', undefined, owner);

    for (const key of ['community', 'growth', 'volunteers', 'categories', 'geography', 'definitions', 'minBucket', 'generatedAt']) {
      expect(body, `missing section: ${key}`).toHaveProperty(key);
    }
    expect(Array.isArray(body.growth)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
  });

  /**
   * Each figure travels with the sentence that says what it counts.
   *
   * These live in the payload rather than in the client so the definition
   * cannot drift from the query that produced the number — a total whose
   * meaning is described by a hardcoded string three files away is a total that
   * eventually gets quoted wrongly in a grant application.
   */
  it('defines every headline figure it publishes', async () => {
    const owner = await srv.loginAsOwner(OWNER_EMAIL);
    const { body } = await srv.call('GET', '/api/admin/impact', undefined, owner);

    for (const key of Object.keys(body.community)) {
      expect(body.definitions[key], `no definition for community.${key}`).toBeTruthy();
    }
  });

  /**
   * Suppression is a property of the BUCKETS, never of the totals.
   *
   * A platform-wide total describes nobody. A month with two volunteers
   * describes two children, and the server returns it with a null count and
   * `suppressed: true` rather than dropping it, so the page can say something
   * was withheld instead of implying it was nothing. This asserts the shape
   * that promise depends on.
   */
  it('marks a suppressed bucket rather than dropping it', async () => {
    const owner = await srv.loginAsOwner(OWNER_EMAIL);
    const { body } = await srv.call('GET', '/api/admin/impact', undefined, owner);

    expect(body.minBucket).toBeGreaterThan(0);
    for (const bucket of [...body.growth, ...body.categories]) {
      expect(bucket).toHaveProperty('suppressed');
      if (bucket.suppressed) expect(bucket.count).toBeNull();
      else expect(typeof bucket.count).toBe('number');
    }
    /* Never suppressed, whatever the cohort size. */
    expect(typeof body.community.totalVolunteers).toBe('number');
    expect(typeof body.community.totalHours).toBe('number');
  });

  /**
   * Locations are counted, never named.
   *
   * `events.location` is free text an organizer types and routinely contains a
   * specific building. A building, a date and a small volunteer count is a
   * description of where a named child was on a Tuesday.
   */
  it('publishes a count of places and no place names', async () => {
    const owner = await srv.loginAsOwner(OWNER_EMAIL);
    const { body } = await srv.call('GET', '/api/admin/impact', undefined, owner);

    expect(typeof body.geography.distinctLocations).toBe('number');
    expect(body.geography.breakdown).toEqual([]);
  });

  it('has removed the old public route entirely', async () => {
    const res = await srv.call('GET', '/api/public/impact');
    expect(res.status).toBe(404);
  });
});
