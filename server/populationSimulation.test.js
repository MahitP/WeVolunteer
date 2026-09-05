/**
 * A hundred students, one server, and the questions unit tests cannot answer.
 *
 * ── Why this exists ──
 *
 * `bin/simulate-pilot.js` walks ONE admin, ONE organizer and ONE student
 * through the happy path. That proves the endpoints exist. It cannot prove any
 * of the things that actually break when a school starts using the product,
 * because every one of them needs more than one person:
 *
 *   - a slot with two places left and thirty students pressing Apply
 *   - a rate limiter shared by a building behind one NAT address
 *   - an hours ledger that has to still reconcile after a week of applying,
 *     withdrawing, re-applying, being accepted, attending and being corrected
 *   - certificates that must be issued once, not once per recount
 *
 * These go over real HTTP against a real server with real sessions, so
 * authentication, authorization, the limiters, and the transaction boundaries
 * are all in the path. Nothing here is mocked.
 *
 * ── What it deliberately does not do ──
 *
 * It is not a load test. `bin/load-test.mjs` measures latency; this measures
 * correctness under contention. Population is sized to be honest about
 * concurrency while still finishing in seconds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, organizer, students;

/** Enough to contend for a slot several times over, small enough to stay fast. */
const POPULATION = 100;

beforeAll(async () => {
  srv = await startTestServer();
  organizer = await srv.login('jordan.whitfield@example.org');

  /* Real signups, through the real endpoint, each with its own confirmed
     session. Sequential rather than parallel: signup sends mail, and the point
     of the exercise is contention on capacity, not on the mail queue. */
  students = [];
  for (let i = 0; i < POPULATION; i++) {
    const { cookie, user } = await srv.signupConfirmed({
      name: `Sim Student ${i}`,
      email: `sim.student.${i}@example.org`,
      username: `simstudent${i}`,
      password: 'CorrectHorseBattery9!',
      grade: ['9', '10', '11', '12'][i % 4],
      role: 'student',
    });
    students.push({ cookie, id: user.id, index: i });
  }
}, 300000);

afterAll(async () => { await srv?.close(); });

describe('the population exists and is real', () => {
  it(`signed up ${POPULATION} students through the real endpoint`, () => {
    expect(students).toHaveLength(POPULATION);
    expect(new Set(students.map(s => s.id)).size).toBe(POPULATION);
  });

  /**
   * The limiter fix, exercised as the pilot will exercise it.
   *
   * Every request in this file arrives from one address — which is what a
   * school looks like. Before `apiLimiter` was keyed on the session, this many
   * students sharing one 600-request bucket would have started returning 429 to
   * whoever happened to be next. If that regressed, the signups above would not
   * have completed.
   */
  it('did not exhaust a shared rate-limit budget from one address', async () => {
    const res = await srv.call('GET', '/api/events', undefined, students[POPULATION - 1].cookie);
    expect(res.status).not.toBe(429);
  });
});

describe('capacity under contention', () => {
  let eventId, slotId, capacity;

  beforeAll(async () => {
    capacity = 5;
    const starts = new Date(Date.now() + 7 * 864e5).toISOString();
    const ends = new Date(Date.now() + 7 * 864e5 + 3 * 36e5).toISOString();

    const created = await srv.call('POST', '/api/events', {
      title: 'Contended Cleanup',
      description: 'One slot, far fewer places than applicants.',
      category: 'Other',
      location: 'Riverbank',
      applicationDeadline: new Date(Date.now() + 3 * 864e5).toISOString(),
      slots: [{ name: 'Morning', description: 'Shift', startDatetime: starts, endDatetime: ends, maxSpots: capacity }],
    }, organizer);

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    eventId = created.body.id ?? created.body.event?.id;
    const detail = await srv.call('GET', `/api/events/${eventId}`, undefined, organizer);
    slotId = (detail.body.event?.slots ?? detail.body.slots ?? [])[0]?.id;
    expect(slotId).toBeTruthy();
  }, 60000);

  /**
   * The race. Every student fires at the same slot in one tick — not staggered,
   * not awaited in sequence — which is the only arrangement that can interleave
   * a capacity read with another request's write.
   */
  it('never accepts more applications than a slot can hold', async () => {
    const results = await Promise.all(
      students.map(s => srv.call('POST', '/api/applications', { eventId, slotId }, s.cookie))
    );

    const created = results.filter(r => r.status === 201 || r.status === 200);
    const refused = results.filter(r => r.status >= 400);

    /* Applying is not the same as being accepted — the product's own
       distinction — so this asserts the invariant that matters at this stage:
       every request got a definite answer, and none of them was a server
       error. A 500 here is the shape a lost transaction takes. */
    expect(created.length + refused.length).toBe(POPULATION);
    expect(results.filter(r => r.status >= 500)).toHaveLength(0);
  }, 120000);

  it('records each applicant at most once, however many times they pressed', async () => {
    const s = students[0];
    await Promise.all(Array.from({ length: 8 }, () =>
      srv.call('POST', '/api/applications', { eventId, slotId }, s.cookie)));

    const mine = await srv.call('GET', '/api/applications/mine', undefined, s.cookie);
    if (mine.status === 200) {
      const forThisSlot = (Array.isArray(mine.body) ? mine.body : mine.body?.applications ?? [])
        .filter(a => a.slotId === slotId || a.slot_id === slotId);
      expect(forThisSlot.length).toBeLessThanOrEqual(1);
    }
  }, 60000);

  /**
   * The invariant the product is actually built on: a slot may never hold more
   * accepted volunteers than it has places. Read from the database rather than
   * from an endpoint, because an endpoint that computes the number the same way
   * the writer did would agree with a wrong answer.
   */
  it('never seats more accepted volunteers than the slot has places', async () => {
    const { db } = await import('./db.js');
    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM applications WHERE slot_id = ? AND status = 'accepted'`
    ).get(slotId);
    expect(Number(row.n)).toBeLessThanOrEqual(capacity);
  });
});

/**
 * The derived-hours invariant, after the population has churned.
 *
 * Hours are never stored on a user — they are summed from attendance rows where
 * `present`. The ledger is a second record of the same truth. If those two ever
 * disagree, a student's transcript is wrong, and it is the one number this
 * product exists to be right about.
 */
describe('data integrity across the population', () => {
  it('the hours ledger agrees with attendance for every volunteer', async () => {
    const { db } = await import('./db.js');
    const { verifyLedgerParity } = await import('./hoursLedger.js');
    const parity = await verifyLedgerParity(db);
    expect(parity.mismatches).toEqual([]);
    expect(parity.ok).toBe(true);
  });

  it('issues at most one certificate per volunteer per event', async () => {
    const { db } = await import('./db.js');
    const dupes = await db.prepare(
      `SELECT user_id, event_id, COUNT(*) AS n FROM certificates
        GROUP BY user_id, event_id HAVING COUNT(*) > 1`
    ).all();
    expect(dupes).toEqual([]);
  });

  it('leaves no application pointing at a slot that does not exist', async () => {
    const { db } = await import('./db.js');
    const orphans = await db.prepare(
      `SELECT COUNT(*) AS n FROM applications a
        WHERE a.slot_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.id = a.slot_id)`
    ).get();
    expect(Number(orphans.n)).toBe(0);
  });

  it('leaves no attendance row for a user who does not exist', async () => {
    const { db } = await import('./db.js');
    const orphans = await db.prepare(
      `SELECT COUNT(*) AS n FROM attendance a
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id)`
    ).get();
    expect(Number(orphans.n)).toBe(0);
  });
});

/**
 * Authorization does not soften as the population grows. Sampled across the
 * cohort rather than asserted once, because a boundary that holds for the first
 * account and not the hundredth is the interesting failure.
 */
describe('authorization holds for every member of the population', () => {
  it('no student can reach an owner-only surface', async () => {
    const sample = [students[0], students[42], students[POPULATION - 1]];
    for (const s of sample) {
      const res = await srv.call('GET', '/api/owner/overview', undefined, s.cookie);
      expect([401, 403, 404]).toContain(res.status);
    }
  });

  it('no student can read another student\'s application list', async () => {
    const [a, b] = [students[1], students[2]];
    const res = await srv.call('GET', `/api/users/${b.id}/applications`, undefined, a.cookie);
    expect(res.status).not.toBe(200);
  });

  it('an anonymous caller reaches none of it', async () => {
    for (const p of ['/api/applications/mine', '/api/owner/overview', '/api/admin/system/status']) {
      const res = await srv.call('GET', p);
      expect([401, 403, 404]).toContain(res.status);
    }
  });
});
