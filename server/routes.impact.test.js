import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `GET /api/impact`.
 *
 * The module's own suite (`impact.test.js`) owns the arithmetic and the privacy
 * threshold. This owns the boundary: who may ask, and what leaves the building.
 */
describe('GET /api/impact', () => {
  let srv, student, organizer, admin;

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login('leo.chen28@gmail.com');
    organizer = await srv.login('jkatzenback@vikings.org');
    admin = await srv.login('admin@example.gov');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /**
   * Everyone signed in can read it, and that is the point of the feature: the
   * student writing a college application and the organizer writing a grant
   * report are looking at the same figures.
   */
  it.each([
    ['a student', () => student],
    ['an organizer', () => organizer],
    ['an administrator', () => admin],
  ])('is readable by %s', async (_label, token) => {
    const res = await srv.call('GET', '/api/impact', undefined, token());
    expect(res.status).toBe(200);
    expect(res.body.community).toBeDefined();
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await srv.call('GET', '/api/impact');
    expect([401, 403]).toContain(res.status);
  });

  it('returns every section, so a client never distinguishes missing from none', async () => {
    const res = await srv.call('GET', '/api/impact', undefined, student);
    expect(Object.keys(res.body).sort()).toEqual(
      ['categories', 'community', 'generatedAt', 'geography', 'growth', 'minBucket', 'volunteers']
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

    const res = await srv.call('GET', '/api/impact', undefined, student);
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
    const plain = await srv.call('GET', '/api/impact', undefined, student);
    const filtered = await srv.call(
      'GET', '/api/impact?from=2020-01-01&to=2020-01-02&category=School&userId=user-student-1',
      undefined, student
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.community).toEqual(plain.body.community);
    expect(filtered.body.categories).toEqual(plain.body.categories);
  });

  it('tells the client the suppression threshold rather than making it guess', async () => {
    const res = await srv.call('GET', '/api/impact', undefined, student);
    expect(res.body.minBucket).toBeGreaterThanOrEqual(5);
  });
});
