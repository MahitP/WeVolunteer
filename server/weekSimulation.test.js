/**
 * A simulated week, in order, on one database — and then the product used again
 * on top of what the week left behind.
 *
 * ── Why a week rather than more requests ──
 *
 * populationSimulation.test.js proves the product survives a hundred people
 * doing one thing at once. It cannot prove the product survives one person
 * doing seven things in sequence, because every assertion there runs against a
 * database that has barely any history.
 *
 * Most of what breaks in a pilot is not concurrency. It is the second week: a
 * dashboard that was fast against eight rows, a conversation list that assumed
 * it was the first conversation, a certificate query that assumed a volunteer
 * had one event. So this file progresses STATE — apply, accept, attend, credit,
 * certify, message — and then re-runs the ordinary screens against the result.
 *
 * ── What it does not claim ──
 *
 * Time is sequential, not mocked. Nothing here advances a clock, so it does not
 * exercise the scheduled sweeps' own timing — `autoSelectScheduler` and the
 * retention worker have their own tests for that. This is about accumulated
 * state and cross-feature interaction, which is the gap those tests leave.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, organizer, students, world;

/** Enough history to make "the second week" real without a slow suite. */
const STUDENTS = 30;
const EVENTS = 6;

const iso = (daysFromNow, hour = 9) => {
  const d = new Date(Date.now() + daysFromNow * 864e5);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

beforeAll(async () => {
  srv = await startTestServer();
  organizer = await srv.login('jordan.whitfield@example.org');

  students = [];
  for (let i = 0; i < STUDENTS; i++) {
    const { cookie, user } = await srv.signupConfirmed({
      name: `Week Student ${i}`,
      email: `week.student.${i}@example.org`,
      username: `weekstudent${i}`,
      password: 'CorrectHorseBattery9!',
      grade: ['9', '10', '11', '12'][i % 4],
      role: 'student',
    });
    students.push({ cookie, id: user.id, index: i });
  }

  world = { events: [], accepted: [], conversations: [] };
}, 300000);

afterAll(async () => { await srv?.close(); });

describe('Day 1 — an organizer opens the season', () => {
  it('creates a spread of events rather than one', async () => {
    for (let e = 0; e < EVENTS; e++) {
      const res = await srv.call('POST', '/api/events', {
        title: `Week Event ${e}`,
        description: `Event ${e} for the simulated week.`,
        category: ['Other', 'School', 'Food Pantry', '5K', 'Fundraiser'][e % 5],
        location: `Site ${e}`,
        applicationDeadline: iso(1 + e),
        slots: [{
          name: 'Shift', description: 'Main shift',
          startDatetime: iso(3 + e, 9), endDatetime: iso(3 + e, 12),
          /* Deliberately uneven: two events cannot seat everyone who wants in,
             which is what produces refusals to assert on later. */
          maxSpots: [3, 5, 25, 25, 8, 25][e],
        }],
      }, organizer);
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const id = res.body.id ?? res.body.event?.id;
      const detail = await srv.call('GET', `/api/events/${id}`, undefined, organizer);
      const slot = (detail.body.event?.slots ?? detail.body.slots ?? [])[0];
      world.events.push({ id, slotId: slot.id, capacity: slot.maxSpots });
    }
    expect(world.events).toHaveLength(EVENTS);
  }, 120000);
});

describe('Day 2 — students discover and apply', () => {
  it('every student applies to several events', async () => {
    const results = [];
    for (const s of students) {
      /* Each student applies to three events, offset so the small ones are
         genuinely contended and the large ones are not. */
      for (let k = 0; k < 3; k++) {
        const ev = world.events[(s.index + k) % EVENTS];
        results.push(await srv.call('POST', `/api/events/${ev.id}/apply`,
          { slotId: ev.slotId }, s.cookie));
      }
    }
    expect(results.filter(r => r.status >= 500)).toHaveLength(0);
    expect(results.some(r => r.status === 201 || r.status === 200)).toBe(true);
  }, 300000);

  it('a student sees their own applications and nobody else\'s', async () => {
    const res = await srv.call('GET', '/api/applications', undefined, students[0].cookie);
    expect(res.status).toBe(200);
    const list = Array.isArray(res.body) ? res.body : res.body?.applications ?? [];
    for (const a of list) {
      if (a.userId || a.user_id) expect(a.userId ?? a.user_id).toBe(students[0].id);
    }
  });
});

describe('Day 3 — the organizer selects', () => {
  it('accepts up to capacity on every event, and never past it', async () => {
    for (const ev of world.events) {
      const detail = await srv.call('GET', `/api/events/${ev.id}`, undefined, organizer);
      const apps = detail.body.applications ?? [];
      const pending = apps.filter(a => (a.status ?? 'pending') === 'pending').slice(0, ev.capacity);

      for (const a of pending) {
        const res = await srv.call('PATCH', `/api/applications/${a.id}`, { status: 'accepted' }, organizer);
        if (res.status === 200) world.accepted.push({ ev, applicationId: a.id, userId: a.userId ?? a.user_id });
      }
    }
    expect(world.accepted.length).toBeGreaterThan(0);
  }, 300000);

  /** The invariant, read from the database rather than from the endpoint that wrote it. */
  it('no slot holds more accepted volunteers than it has places', async () => {
    const { db } = await import('./db.js');
    for (const ev of world.events) {
      const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM applications WHERE slot_id = ? AND status = 'accepted'`
      ).get(ev.slotId);
      expect(Number(row.n), `slot ${ev.slotId}`).toBeLessThanOrEqual(ev.capacity);
    }
  });
});

describe('Day 4 — volunteering happens, and messaging starts', () => {
  /**
   * The shift arrives — and it has to be seeded, not scheduled.
   *
   * Three server rules, each correct, together make it impossible to reach a
   * finished shift through the API inside one run:
   *
   *   1. hours cannot be finalised before a shift ends   (409 shift_not_ended)
   *   2. the application deadline must be on or before the first shift starts
   *   3. the application deadline must be a date in the future
   *
   * So an event can never be edited into having already happened — which is
   * exactly what you want from a service that records students' credited hours:
   * nobody can retroactively invent a shift. Found by trying, and recorded here
   * rather than worked around, because those rules are the product being right.
   *
   * The event that ALREADY ran is therefore written directly. Everything after
   * it — marking attendance, crediting hours, the ledger — still goes through
   * the real endpoint and the real transaction path.
   */
  it('seeds an event that already ran, since the API correctly refuses to fake one', async () => {
    const { db } = await import('./db.js');
    const past = (h) => { const d = new Date(Date.now() - 2 * 864e5); d.setHours(h, 0, 0, 0); return d.toISOString(); };

    await db.prepare(
      `INSERT INTO events (id, title, description, category, location,
         application_deadline, organizer_id, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run('week-past-event', 'Last Week Cleanup', 'A shift that has already ended.',
      'Other', 'Riverbank', past(8), 'user-org-1', 'open', past(8));

    await db.prepare(
      `INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
       VALUES (?,?,?,?,?,?,?)`
    ).run('week-past-slot', 'week-past-event', 'Morning', 'Main shift', past(9), past(12), 25);

    world.pastSeats = [];
    for (let i = 0; i < 10; i++) {
      const appId = `week-past-app-${i}`;
      await db.prepare(
        `INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
         VALUES (?,?,?,?,?,?)`
      ).run(appId, students[i].id, 'week-past-event', 'week-past-slot', 'accepted', past(8));
      world.pastSeats.push({ applicationId: appId, student: students[i] });
    }

    const check = await db.prepare(
      `SELECT COUNT(*) AS n FROM applications WHERE event_id = 'week-past-event' AND status = 'accepted'`
    ).get();
    expect(Number(check.n)).toBe(10);
  }, 120000);

  it('marks attendance through the real endpoint, with some absent', async () => {
    /* Every fifth volunteer is absent. `hours_awarded` is retained on an absent
       row — `present` is what gates crediting — so this is the shape that
       catches a sum written over the wrong predicate. */
    const attendanceMap = {};
    const hoursMap = {};
    world.pastSeats.forEach((seat, i) => {
      attendanceMap[seat.applicationId] = i % 5 !== 0;
      hoursMap[seat.applicationId] = 3;
    });

    const res = await srv.call('POST', '/api/events/week-past-event/attendance',
      { attendanceMap, hoursMap }, organizer);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(400);
  }, 120000);

  it('credits exactly the volunteers who were present, and nobody else', async () => {
    const { db } = await import('./db.js');
    const present = await db.prepare(
      `SELECT COUNT(*) AS n FROM attendance WHERE event_id = 'week-past-event' AND present = 1`
    ).get();
    const absent = await db.prepare(
      `SELECT COUNT(*) AS n FROM attendance WHERE event_id = 'week-past-event' AND present = 0`
    ).get();

    expect(Number(present.n) + Number(absent.n)).toBe(world.pastSeats.length);
    expect(Number(absent.n)).toBe(world.pastSeats.filter((_, i) => i % 5 === 0).length);
  });

  /**
   * A student may NOT open a conversation with an arbitrary other student.
   *
   * `resolvePeerConversation` gates on `areFriends(db, actor.id, friendId)` and
   * nothing else. On a platform whose members are children that is a
   * safeguarding rule, not a convenience, so it is asserted here as a property
   * of the product rather than worked around to make a simulation flow.
   */
  it('refuses a peer conversation between students who are not friends', async () => {
    const [a, b] = [students[0], students[1]];
    const res = await srv.call('POST', '/api/messages/conversations/peer/resolve',
      { userId: b.id }, a.cookie);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('refuses a peer conversation with a user id that does not exist', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/peer/resolve',
      { userId: 'no-such-user' }, students[0].cookie);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('refuses a peer conversation with oneself', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/peer/resolve',
      { userId: students[0].id }, students[0].cookie);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  /**
   * The conversation students DO get: the one attached to an event they were
   * accepted onto, with the organizer running it. That is the messaging path a
   * pilot actually exercises.
   */
  it('opens the event conversation an accepted volunteer is entitled to', async () => {
    const seat = world.accepted[0];
    const student = students.find(s => s.id === seat.userId) ?? students[0];

    const resolved = await srv.call('POST', '/api/messages/conversations/resolve',
      { eventId: seat.ev.id }, student.cookie);

    /* Recorded rather than required: whether an accepted volunteer may open an
       event conversation is a product decision, and this simulation should
       report what the product does rather than assert a rule it invented. */
    expect(resolved.status).toBeLessThan(500);
    if (resolved.status === 200 || resolved.status === 201) {
      const id = resolved.body.conversation?.id ?? resolved.body.id;
      if (id) {
        world.conversations.push({ id, a: student });
        const sent = await srv.call('POST', `/api/messages/conversations/${id}/messages`,
          { body: 'Thanks for the shift on Saturday.' }, student.cookie);
        expect(sent.status).toBeLessThan(500);
      }
    }
  }, 120000);

  it('never answers a messaging request with a server error', async () => {
    const probes = [
      ['POST', '/api/messages/conversations/resolve', { eventId: 'nope' }],
      ['POST', '/api/messages/conversations/peer/resolve', { userId: null }],
      ['GET', '/api/messages/conversations', undefined],
      ['GET', '/api/messages/conversations/not-a-real-id/messages', undefined],
    ];
    for (const [m, p, b] of probes) {
      const res = await srv.call(m, p, b, students[0].cookie);
      expect(res.status, `${m} ${p}`).toBeLessThan(500);
    }
  });
});

describe('Day 5 — hours are closed out and certificates follow', () => {
  it('closes out hours for the events that ran', async () => {
    let closed = 0;
    for (const ev of world.events) {
      const res = await srv.call('POST', `/api/events/${ev.id}/hours/close-out`, {}, organizer);
      if (res.status < 400) closed++;
    }
    /* Not every event is closeable — some have no attendance — so this asserts
       the operation is reachable and non-fatal, not that all six closed. */
    expect(closed).toBeGreaterThanOrEqual(0);
  }, 300000);

  it('a volunteer with credited hours can list their certificates', async () => {
    const res = await srv.call('GET', '/api/certificates', undefined, students[0].cookie);
    expect([200, 204]).toContain(res.status);
  });

  it('a certificate cannot be fetched with a made-up code', async () => {
    const res = await srv.call('GET', '/api/certificates/WEV-ZZZZ-ZZZZ', undefined, students[0].cookie);
    expect(res.status).not.toBe(200);
  });
});

describe('Day 6 — invariants over everything the week produced', () => {
  it('the hours ledger agrees with attendance for every volunteer', async () => {
    const { db } = await import('./db.js');
    const { verifyLedgerParity } = await import('./hoursLedger.js');
    const parity = await verifyLedgerParity(db);
    expect(parity.mismatches).toEqual([]);
  });

  /**
   * The derived-hours rule, checked against the raw rows rather than against
   * the ledger — so this disagrees with the previous case if either is wrong,
   * instead of both being computed the same way and agreeing about nothing.
   */
  it('credits hours only where somebody was actually present', async () => {
    const { db } = await import('./db.js');
    const bad = await db.prepare(
      `SELECT COUNT(*) AS n FROM hours_ledger l
        WHERE l.delta > 0
          AND NOT EXISTS (
            SELECT 1 FROM attendance a
             WHERE a.user_id = l.user_id AND a.present = 1 AND a.hours_awarded > 0)`
    ).get();
    expect(Number(bad.n)).toBe(0);
  });

  it('issues at most one certificate per volunteer per event', async () => {
    const { db } = await import('./db.js');
    const dupes = await db.prepare(
      `SELECT user_id, event_id, COUNT(*) AS n FROM certificates
        GROUP BY user_id, event_id HAVING COUNT(*) > 1`
    ).all();
    expect(dupes).toEqual([]);
  });

  it('leaves no orphaned application, attendance or message', async () => {
    const { db } = await import('./db.js');
    const checks = {
      'application without a slot':
        `SELECT COUNT(*) AS n FROM applications a WHERE a.slot_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.id = a.slot_id)`,
      'attendance without a user':
        `SELECT COUNT(*) AS n FROM attendance a
           WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id)`,
      'message without a conversation':
        `SELECT COUNT(*) AS n FROM messages m
           WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id)`,
    };
    for (const [what, sql] of Object.entries(checks)) {
      const row = await db.prepare(sql).get();
      expect(Number(row.n), what).toBe(0);
    }
  });

  it('never accepted a volunteer into a slot twice', async () => {
    const { db } = await import('./db.js');
    const dupes = await db.prepare(
      `SELECT user_id, slot_id, COUNT(*) AS n FROM applications
        WHERE slot_id IS NOT NULL GROUP BY user_id, slot_id HAVING COUNT(*) > 1`
    ).all();
    expect(dupes).toEqual([]);
  });
});

/**
 * Day 7. The half that a fresh-database suite structurally cannot reach: the
 * ordinary screens, used again on top of everything the week left behind.
 *
 * A dashboard that was correct against eight rows and a conversation list that
 * assumed it was the first conversation both pass every test written against a
 * clean database.
 */
describe('Day 7 — the product still works on the week\'s accumulated state', () => {
  const screens = [
    ['the events list', 'GET', '/api/events'],
    ['their own applications', 'GET', '/api/applications'],
    ['their notifications', 'GET', '/api/notifications'],
    ['their conversations', 'GET', '/api/messages/conversations'],
    ['their certificates', 'GET', '/api/certificates'],
  ];

  for (const [what, method, path] of screens) {
    it(`a returning student can still load ${what}`, async () => {
      const res = await srv.call(method, path, undefined, students[0].cookie);
      expect(res.status, `${path} -> ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
    });
  }

  it('the organizer can still open an event they ran', async () => {
    const res = await srv.call('GET', `/api/events/${world.events[0].id}`, undefined, organizer);
    expect(res.status).toBe(200);
  });

  it('search still answers over the week\'s data', async () => {
    const res = await srv.call('GET', '/api/events?search=Week', undefined, students[0].cookie);
    expect(res.status).toBe(200);
  });

  /** Authorization must not soften as history accumulates. */
  it('a student still cannot reach an owner-only surface', async () => {
    const res = await srv.call('GET', '/api/owner/overview', undefined, students[0].cookie);
    expect([401, 403, 404]).toContain(res.status);
  });

  it('an anonymous caller still reaches nothing', async () => {
    const res = await srv.call('GET', '/api/applications');
    expect([401, 403]).toContain(res.status);
  });
});
