import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Regression cover for colliding event ids.
 *
 * `POST /api/events` built its primary key as:
 *
 *     const eventId = `event-${Date.now()}`;
 *
 * A bare millisecond timestamp. Two events created in the same millisecond
 * therefore produced the same `events.id`, the second INSERT violated the PRIMARY
 * KEY, and the request returned 500 with no event created.
 *
 * Found while cleaning up a leaked test database: a loop creating 25 events had
 * TWO of them fail with 500, which had been invisible because the assertion
 * counting them was being satisfied by 797 stale fixtures.
 *
 * In production this is an organizer double-submitting the form, or two
 * organizers saving at the same moment — uncommon, but it loses the event and
 * shows a server error for something the user did nothing wrong in.
 *
 * The rest of the codebase already settled this question; accountRoutes.js even
 * carries the comment "randomUUID, not Date.now(): two deletions in the same
 * millisecond". Users, applications, notifications and audit rows all use
 * randomUUID. Events were the exception.
 */

let srv, organizer;
beforeAll(async () => {
  srv = await startTestServer();
  organizer = await srv.login('jkatzenback@vikings.org');
}, 60000);
afterAll(async () => { await srv?.close(); });

const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();

const makeEvent = (n) => srv.call('POST', '/api/events', {
  title: `Collision Probe ${n}`,
  description: 'id collision fixture',
  category: 'Other',
  location: 'Hall',
  applicationDeadline: iso(60 * 24 * 5),
  slots: [{
    name: 'Shift', description: 'd',
    startDatetime: iso(60 * 24 * 10),
    endDatetime: iso(60 * 24 * 10 + 120),
    maxSpots: 4
  }]
}, organizer);

describe('event ids survive rapid creation', () => {
  it('creates 40 events back to back with no failures', async () => {
    const results = [];
    for (let i = 0; i < 40; i++) results.push(await makeEvent(i));

    const failed = results.filter(r => r.status !== 201);
    expect(
      failed.map(r => `${r.status} ${JSON.stringify(r.body)}`),
      'every creation must succeed — a same-millisecond id collision is the usual cause'
    ).toEqual([]);
  });

  it('gives every event a distinct id', async () => {
    const results = [];
    for (let i = 0; i < 40; i++) results.push(await makeEvent(100 + i));
    const ids = results.map(r => r.body?.id).filter(Boolean);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size, 'duplicate event ids were issued').toBe(40);
  });

  // The tightest case: creations issued concurrently, so they genuinely land in
  // the same millisecond rather than merely close together.
  it('survives concurrent creation', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => makeEvent(200 + i))
    );
    const failed = results.filter(r => r.status !== 201);
    expect(failed.map(r => `${r.status} ${JSON.stringify(r.body)}`)).toEqual([]);
    const ids = results.map(r => r.body?.id);
    expect(new Set(ids).size).toBe(25);
  });

  it('does not build the id from a bare timestamp', async () => {
    const res = await makeEvent(999);
    expect(res.status).toBe(201);
    // `event-1785452776992` is the shape that collided. Anything with real
    // entropy after the prefix is fine.
    expect(res.body.id, `id was ${res.body.id}`).not.toMatch(/^event-\d+$/);
  });
});
