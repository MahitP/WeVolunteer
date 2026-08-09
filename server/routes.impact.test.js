import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `GET /api/impact`.
 *
 * The module's own suite (`impact.test.js`) owns the arithmetic and the privacy
 * threshold. This owns the boundary: who may ask, and what leaves the building.
 */

/**
 * A seeded demo account, promoted. There is deliberately no code path that
 * CREATES an owner, so the fixture has to be an account the demo seed made —
 * `loginAsOwner` runs the same UPDATE `bin/grant-ownership.mjs` runs.
 */
const OWNER_EMAIL = 'dsanger@outlook.com';
const PARTNER_EMAIL = 'partner@impact.test';

describe('GET /api/impact', () => {
  let srv, student, organizer, partner, admin, owner;

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login('leo.chen28@gmail.com');
    organizer = await srv.login('jkatzenback@vikings.org');
    admin = await srv.login('admin@example.gov');
    owner = await srv.loginAsOwner(OWNER_EMAIL);

    /* `partner` has no seeded fixture: sign one up and promote it, the same way
       `authz.matrix.test.js` does. Identity is re-read from the users row on
       every request, so the role the database holds at request time is the one
       that counts and no re-login is needed after the UPDATE. */
    const signed = await srv.signupConfirmed({
      name: 'Partner Org', username: 'impact_partner', email: PARTNER_EMAIL,
      password: 'Password123!', grade: 'Adult', role: 'student',
    });
    const { db } = await import('./db.js');
    db.prepare("UPDATE users SET role = 'partner', verified = 1 WHERE email = ?").run(PARTNER_EMAIL);
    partner = signed.cookie;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /**
   * ── The policy, and what it replaced ──
   *
   * These figures used to be readable by every signed-in account: `student`,
   * `organizer`, `admin` and `partner` all held `analytics.impact`, and this file
   * asserted that as a feature ("the student writing a college application and
   * the organizer writing a grant report are looking at the same figures").
   *
   * The community impact figures are now administrative. They are an internal
   * view of how the programme is doing — the same conclusion that deleted
   * `/api/public/impact` rather than re-gating it — and the reader they are for
   * is the one accountable for the programme, not everybody in it.
   *
   * Asserted per role rather than once, because the failure mode is ONE role
   * slipping through, not all of them. And asserted here on the API, because the
   * nav entry and the client route are hidden by the same capability and neither
   * of them is a boundary: typing the URL is one keystroke.
   */
  it.each([
    ['a student', () => student],
    ['an organizer', () => organizer],
    /* `partner` is an EXTERNAL organization account, and that is the whole
       argument: it is the audience `/api/public/impact` served, and that route
       was removed on purpose. `analytics.public` remains the reserved name for
       whatever a partner is eventually shown. */
    ['a partner organization', () => partner],
  ])('refuses %s', async (_label, token) => {
    const res = await srv.call('GET', '/api/impact', undefined, token());
    expect(res.status).toBe(403);
    /* A refusal must not carry the payload it refused. A 403 whose body still
       holds the figures is a disclosure with a status code on top. */
    expect(res.body?.community).toBeUndefined();
    expect(res.body?.growth).toBeUndefined();
    expect(res.body?.volunteers).toBeUndefined();
  });

  it.each([
    ['an administrator', () => admin],
    ['the platform owner', () => owner],
  ])('answers %s', async (_label, token) => {
    const res = await srv.call('GET', '/api/impact', undefined, token());
    expect(res.status).toBe(200);
    expect(res.body.community).toBeDefined();
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await srv.call('GET', '/api/impact');
    expect(res.status).toBe(401);
  });

  it('returns every section, so a client never distinguishes missing from none', async () => {
    const res = await srv.call('GET', '/api/impact', undefined, admin);
    expect(Object.keys(res.body).sort()).toEqual(
      ['categories', 'community', 'generatedAt', 'geography', 'growth', 'minBucket', 'tags', 'volunteers']
    );
  });

  /**
   * The assertion that matters most on the wire.
   *
   * The module suite proves the builder emits no identifiers; this proves the
   * response does. They are different claims — a handler that helpfully merged
   * in "top volunteers" would pass the first and fail this.
   */
  it('puts no name, address or identifier on the wire', async () => {
    const { db } = await import('./db.js');
    const person = db.prepare(
      "SELECT name, email, id FROM users WHERE role = 'student' LIMIT 1"
    ).get();

    const res = await srv.call('GET', '/api/impact', undefined, admin);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(person.name);
    expect(body).not.toContain(person.email);
    expect(body).not.toContain(person.id);
    // Nor an event's free-text location, which routinely names a building.
    const place = db.prepare("SELECT location FROM events WHERE location IS NOT NULL LIMIT 1").get();
    if (place?.location) expect(body).not.toContain(place.location);
  });

  /**
   * No filters, deliberately — see the handler. A date range would be a way to
   * ask about smaller and smaller groups until a bucket describes one person,
   * which is exactly what the threshold exists to prevent, and the suppression
   * cannot be applied to a query it does not know about.
   *
   * Asserting that unknown parameters change nothing is how that stays true: a
   * filter added without the matching suppression work fails here.
   */
  it('ignores query parameters rather than filtering by them', async () => {
    const plain = await srv.call('GET', '/api/impact', undefined, admin);
    const filtered = await srv.call(
      'GET', '/api/impact?from=2020-01-01&to=2020-01-02&category=School&userId=user-student-1',
      undefined, admin
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.community).toEqual(plain.body.community);
    expect(filtered.body.categories).toEqual(plain.body.categories);
  });

  it('tells the client the suppression threshold rather than making it guess', async () => {
    const res = await srv.call('GET', '/api/impact', undefined, admin);
    expect(res.body.minBucket).toBeGreaterThanOrEqual(5);
  });
});
