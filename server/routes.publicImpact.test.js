import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { MIN_BUCKET } from './impact.js';

/**
 * The community figures anybody may read, without an account.
 *
 * ── What is being defended ──
 *
 * Not the numbers. The two properties that would fail quietly:
 *
 *   1. **Nothing that identifies anybody escapes.** The private dashboard carries
 *      breakdowns by category, month and place; every one of them is a way of
 *      asking about a smaller group, and none may appear here. `buildPublicImpact`
 *      names its fields rather than filtering the private payload precisely so a
 *      new breakdown cannot arrive by inheritance — and the exhaustive key
 *      assertion below is what notices if somebody changes that.
 *
 *   2. **It is genuinely reachable without a session.** A "public" endpoint that
 *      401s is the failure the whole feature exists to avoid, and it is the sort
 *      of thing that gets introduced by adding `authenticateToken` "for
 *      consistency" while every existing test still passes because every existing
 *      test happens to be signed in.
 */
describe('GET /api/public/impact', () => {
  let srv, db;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /** No token — the whole point. */
  const fetchPublic = () => srv.call('GET', '/api/public/impact');

  it('answers without any session at all', async () => {
    const res = await fetchPublic();
    expect(res.status).toBe(200);
  });

  /**
   * A signed-out caller and a signed-in one get the same bytes.
   *
   * If they ever differ, something is varying by principal — which means there IS
   * a principal, which means this is an authenticated route wearing a public
   * route's clothes.
   */
  it('answers identically whether or not somebody is signed in', async () => {
    const anonymous = await fetchPublic();
    const student = await srv.login('leo.chen28@gmail.com');
    const signedIn = await srv.call('GET', '/api/public/impact', undefined, student);

    const withoutClock = (b) => ({ ...b, generatedAt: undefined });
    expect(withoutClock(signedIn.body)).toEqual(withoutClock(anonymous.body));
  });

  /**
   * The allowlist, asserted exhaustively.
   *
   * `toEqual` on the sorted key list rather than a set of `toHaveProperty` calls:
   * the risk here is a field APPEARING, and a positive-only test cannot see one.
   */
  it('emits exactly the agreed top-level fields and no others', async () => {
    const { body } = await fetchPublic();

    /* `reason` appears only in the withheld shape, where it carries the sentence
       explaining what the reader is not being shown. Asserting the two shapes
       separately rather than allowing `reason` unconditionally: "may or may not
       be present" is how a field nobody meant to publish stops being noticed. */
    const expected = body.available
      ? ['available', 'community', 'definitions', 'generatedAt', 'minBucket', 'participation']
      : ['available', 'community', 'definitions', 'generatedAt', 'minBucket', 'participation', 'reason'];

    expect(Object.keys(body).sort()).toEqual(expected.sort());
  });

  it('never emits a breakdown by category, month, place or person', async () => {
    const { body } = await fetchPublic();
    const serialized = JSON.stringify(body);

    for (const forbidden of ['categories', 'growth', 'geography', 'months', 'volunteers']) {
      expect(serialized, `"${forbidden}" reached the public payload`).not.toContain(`"${forbidden}"`);
    }
  });

  /**
   * Every figure arrives with the sentence that says what it counts.
   *
   * "318 hours" invites "hours of what, claimed by whom". The definitions travel
   * in the payload rather than living in the client so they cannot drift from the
   * query that produced the number — and this asserts one exists for every figure
   * actually published, so adding a fifth without explaining it fails.
   */
  it('defines every figure it publishes', async () => {
    const { body } = await fetchPublic();
    const published = [...Object.keys(body.community ?? {}), ...Object.keys(body.participation ?? {})];

    for (const key of published) {
      if (key === 'cohort') continue;   // the denominator for returningRate, not a figure
      expect(body.definitions[key], `${key} is published with no definition`).toBeTruthy();
    }
  });

  /* ── The floor ──────────────────────────────────────────────────────────── */

  /**
   * Below the floor it says so, rather than publishing the number.
   *
   * A total over a whole population identifies nobody — which is the argument for
   * publishing these four at all. That argument weakens when the population is
   * four people at a named school, so the same threshold every other breakdown
   * uses applies to the totals themselves here.
   *
   * Asserted by emptying `attendance`, which is what every figure derives from.
   */
  it('withholds the figures rather than describing almost-individuals', async () => {
    const saved = db.prepare('SELECT * FROM attendance').all();
    db.exec('DELETE FROM attendance');
    try {
      const { body } = await fetchPublic();

      expect(body.available).toBe(false);
      expect(body.community).toBeNull();
      expect(body.participation).toBeNull();
      /* Not zeros. "0 volunteers" is a different claim from "not published yet",
         and it is a false one. */
      expect(JSON.stringify(body)).not.toContain('"totalVolunteers":0');
      expect(body.reason).toMatch(new RegExp(String(MIN_BUCKET)));
      /* The definitions still ship, so the page can explain what it WILL show. */
      expect(body.definitions.totalHours).toBeTruthy();
    } finally {
      const cols = Object.keys(saved[0] ?? {});
      if (cols.length) {
        const stmt = db.prepare(
          `INSERT INTO attendance (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        );
        for (const row of saved) stmt.run(...cols.map(c => row[c]));
      }
    }
  });

  /* ── Above the floor, which is the path the feature exists for ──────────── */

  /**
   * The published shape.
   *
   * The seeded database sits BELOW `MIN_BUCKET`, so without this the only path
   * these tests exercise is the one that withholds everything — the feature could
   * be entirely broken above the floor and the file would still be green. Enough
   * attendance is inserted to cross it, deliberately spread over two events for
   * two of the volunteers so `returningRate` has something real to compute.
   */
  it('publishes the four totals and the returning rate once past the floor', async () => {
    const saved = db.prepare('SELECT * FROM attendance').all();
    db.exec('DELETE FROM attendance');

    const insert = db.prepare(
      'INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, 1, ?)',
    );
    /* Real ids, read from the seed. `attendance` has foreign keys onto users,
       slots AND events, so invented ids are rejected — and inventing them was
       how the first version of this test failed. */
    const users = db.prepare('SELECT id FROM users LIMIT ?').all(MIN_BUCKET).map(r => r.id);
    const slotsByEvent = db.prepare(
      'SELECT id, event_id FROM slots ORDER BY event_id, id'
    ).all();
    const events = [...new Set(slotsByEvent.map(s => s.event_id))];

    try {
      expect(users.length, 'seed has too few users for this test').toBe(MIN_BUCKET);
      expect(events.length, 'seed needs two events with slots').toBeGreaterThanOrEqual(2);

      const slotsFor = (eventId) => slotsByEvent.filter(s => s.event_id === eventId);
      const first = slotsFor(events[0]);
      const second = slotsFor(events[1]);

      /* MIN_BUCKET distinct volunteers, so the floor is crossed by exactly the
         margin the threshold describes rather than by a comfortable excess. */
      for (let i = 0; i < MIN_BUCKET; i++) {
        insert.run(events[0], first[i % first.length].id, users[i], 2);
      }
      /* Two of them come back to a DIFFERENT event — `returningRate` counts
         distinct events, so a second shift at the same event must not count. */
      insert.run(events[1], second[0].id, users[0], 3);
      insert.run(events[1], second[1 % second.length].id, users[1], 3);

      const { body } = await fetchPublic();

      expect(body.available).toBe(true);
      expect(body.reason).toBeUndefined();

      expect(body.community.totalVolunteers).toBe(MIN_BUCKET);
      expect(body.community.totalHours).toBe(MIN_BUCKET * 2 + 6);
      expect(body.community.eventsCompleted).toBe(2);

      /* 2 of 5 came back to a second distinct event. */
      expect(body.participation.returningRate).toBe(Math.round((2 / MIN_BUCKET) * 100));
      expect(body.participation.cohort).toBe(MIN_BUCKET);
    } finally {
      db.exec('DELETE FROM attendance');
      const cols = Object.keys(saved[0] ?? {});
      if (cols.length) {
        const restore = db.prepare(
          `INSERT INTO attendance (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        );
        for (const row of saved) restore.run(...cols.map(c => row[c]));
      }
    }
  });

  /* ── No filters ─────────────────────────────────────────────────────────── */

  /**
   * A query string changes nothing.
   *
   * A date range is a way to ask about smaller and smaller groups until a figure
   * describes one person. The handler takes no parameters, so this asserts that
   * staying true rather than a refusal — a 400 would be fine too, but silently
   * honouring `?from=` would not.
   */
  it('ignores any filter it is handed', async () => {
    const plain = await fetchPublic();
    const filtered = await srv.call('GET', '/api/public/impact?from=2026-08-01&category=School&userId=user-student-1');

    const withoutClock = (b) => ({ ...b, generatedAt: undefined });
    expect(withoutClock(filtered.body)).toEqual(withoutClock(plain.body));
  });
});
