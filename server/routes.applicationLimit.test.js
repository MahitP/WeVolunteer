import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * How many opportunities one student may have outstanding at once.
 *
 * ── What this is, and what it is not ──
 *
 * This is a **business-state** limit, not a rate limit. The two answer different
 * questions and neither substitutes for the other: a rate limit bounds how fast
 * requests arrive, and says nothing about how much of a scarce resource one
 * account ends up holding. `applicationLimiter` is the other half and lives in
 * `app.js`.
 *
 * Before this there was no bound of either kind on applying. A student — or one
 * script — could hold an unlimited number of pending applications, each one a
 * row, an organizer notification, and a fan-out notification to every friend.
 *
 * ── Why it counts EVENTS and not applications ──
 *
 * This is the whole design, and getting it wrong would have made the feature
 * actively unfair. An application is per **slot**: `applications.slot_id` is NOT
 * NULL and the uniqueness constraint is `(user_id, slot_id)`. A student who
 * signs up for three shifts of the same festival therefore holds three
 * applications for one opportunity.
 *
 * Counting rows would mean a volunteer who commits to a whole weekend of one
 * event is treated as though they had applied to three different things, while
 * somebody who applied to three unrelated events one shift each is treated
 * identically. The first of those is the behaviour the platform wants. So the
 * unit is the distinct event, and taking extra shifts of something you have
 * already applied to is free.
 *
 * ── Why only `pending` counts ──
 *
 * `accepted` is a commitment, not an outstanding request. If it counted, a
 * student who was accepted to their limit would be frozen out of applying to
 * anything else — penalised for succeeding, with an empty queue.
 *
 * `waitlisted` does not count either, and that one is a fairness point rather
 * than a definitional one: nobody chooses to be waitlisted. It is done TO an
 * applicant by a draw, and `promoteFromWaitlist` can convert it without them
 * acting at all. Counting it would let an unlucky student be locked out of the
 * platform by other people's decisions.
 *
 * `withdrawn` and `rejected` are over, so they are free — which also keeps
 * withdrawing by mistake cheap, as `applicationRoutes.js` already goes out of
 * its way to ensure.
 *
 * A pending application on a **cancelled** event is excluded, for the same
 * reason: the student cannot make it resolve, and it is not their doing.
 *
 * PENDING_APPLICATION_LIMIT is set to 3 below so the suite needs four events
 * rather than eleven. The production default is in `server/config.js`.
 */

let srv;

beforeAll(async () => {
  process.env.PENDING_APPLICATION_LIMIT = '3';
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
  delete process.env.PENDING_APPLICATION_LIMIT;
});

const LIMIT = 3;

/**
 * A day offset that never repeats, across every event this file creates.
 *
 * Every slot gets its own calendar day. Without this the schedule-conflict
 * check fires — it refuses a second application overlapping a live one — and a
 * 409 for an overlap is indistinguishable at a glance from a 409 for the quota.
 * The first draft of this suite put every single-shift event on the same day and
 * failed exactly that way.
 */
let nextDay = 30;

/** An open event with `shifts` non-overlapping slots, far enough out to stay open. */
async function makeEvent(orgToken, title, shifts = 1) {
  const slots = [];
  for (let i = 0; i < shifts; i++) {
    const day = nextDay++;
    slots.push({
      name: `Shift ${i + 1}`,
      description: 'd',
      startDatetime: new Date(Date.now() + day * 864e5).toISOString(),
      endDatetime: new Date(Date.now() + day * 864e5 + 72e5).toISOString(),
      maxSpots: 5,
    });
  }
  const mk = await srv.call('POST', '/api/events', {
    title, description: 'd', category: 'Other', location: 'Hall',
    applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(),
    slots,
  }, orgToken);
  expect(mk.status, JSON.stringify(mk.body)).toBe(201);
  return mk.body.id;
}

async function slotsOf(eventId, token) {
  const events = (await srv.call('GET', '/api/events', undefined, token)).body;
  expect(Array.isArray(events), `event list was ${JSON.stringify(events).slice(0, 120)}`).toBe(true);
  return events.find(e => e.id === eventId).slots;
}

/**
 * Empties a student's pending queue.
 *
 * Every block below uses the same student, because several other seeded accounts
 * do not sign in through `srv.login` — it answers 401 with no token rather than
 * throwing, so the failure surfaces later as "events.find is not a function".
 * Why those accounts do not authenticate is a separate question from this
 * feature, so this suite stops depending on the answer.
 */
async function clearPending(token) {
  const apps = (await srv.call('GET', '/api/applications', undefined, token)).body;
  for (const app of apps.filter(a => a.status === 'pending')) {
    await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'withdrawn' }, token);
  }
}

describe('a student may hold only so many opportunities at once', () => {
  let student, org, events;

  beforeAll(async () => {
    student = await srv.login('leo.chen@example.com');
    org = await srv.login('jordan.whitfield@example.org');
    events = [];
    for (let i = 0; i <= LIMIT; i++) {
      events.push(await makeEvent(org, `Quota Event ${i}`));
    }
  });

  const applyTo = async (eventId) => {
    const slots = await slotsOf(eventId, student);
    return srv.call('POST', `/api/events/${eventId}/apply`, { slotId: slots[0].id }, student);
  };

  it('lets the student reach the limit', async () => {
    for (let i = 0; i < LIMIT; i++) {
      const res = await applyTo(events[i]);
      expect(res.status, `application ${i + 1} of ${LIMIT}: ${JSON.stringify(res.body)}`).toBe(201);
    }
  });

  it('refuses the one after that, and says why', async () => {
    const res = await applyTo(events[LIMIT]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('application_limit_reached');
    /* The message has to name the number and the way out. "Too many" with no
       figure and no instruction is the shape of a dead end. */
    expect(res.body.error).toContain(String(LIMIT));
    expect(res.body.error.toLowerCase()).toContain('withdraw');
    expect(res.body.limit).toBe(LIMIT);
    expect(res.body.pending).toBe(LIMIT);
  });

  it('frees a place when the student withdraws one', async () => {
    const apps = (await srv.call('GET', '/api/applications', undefined, student)).body;
    const live = apps.find(a => a.status === 'pending');
    const drop = await srv.call('PATCH', `/api/applications/${live.id}`, { status: 'withdrawn' }, student);
    expect(drop.status).toBe(200);

    const res = await applyTo(events[LIMIT]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('extra shifts of an opportunity already applied to are free', () => {
  let student, org, multi, filler;

  beforeAll(async () => {
    student = await srv.login('leo.chen@example.com');
    await clearPending(student);
    org = await srv.login('jordan.whitfield@example.org');
    /* One event with more shifts than the whole quota. Counting rows would
       refuse the fourth shift; counting events must not. */
    multi = await makeEvent(org, 'Weekend Festival', LIMIT + 2);
    filler = [];
    for (let i = 0; i < LIMIT - 1; i++) {
      filler.push(await makeEvent(org, `Filler ${i}`));
    }
  });

  it('lets a student take every shift of one event even past the limit', async () => {
    const slots = await slotsOf(multi, student);
    expect(slots.length).toBe(LIMIT + 2);

    for (const [i, slot] of slots.entries()) {
      const res = await srv.call('POST', `/api/events/${multi}/apply`, { slotId: slot.id }, student);
      expect(res.status, `shift ${i + 1} of ${slots.length}: ${JSON.stringify(res.body)}`).toBe(201);
    }
  });

  it('still counts that event as exactly one against the quota', async () => {
    /* The festival is 1. Fill to the limit, then prove the next NEW event is
       refused — which shows the festival's extra shifts consumed nothing. */
    for (const [i, id] of filler.entries()) {
      const slots = await slotsOf(id, student);
      const res = await srv.call('POST', `/api/events/${id}/apply`, { slotId: slots[0].id }, student);
      expect(res.status, `filler ${i}: ${JSON.stringify(res.body)}`).toBe(201);
    }

    const oneMore = await makeEvent(org, 'One Too Many');
    const slots = await slotsOf(oneMore, student);
    const res = await srv.call('POST', `/api/events/${oneMore}/apply`, { slotId: slots[0].id }, student);
    expect(res.status).toBe(409);
    expect(res.body.pending).toBe(LIMIT);
  });
});

describe('what does not count against the quota', () => {
  let student, org;

  beforeAll(async () => {
    student = await srv.login('leo.chen@example.com');
    await clearPending(student);
    org = await srv.login('jordan.whitfield@example.org');
  });

  it('does not count an accepted application', async () => {
    /* Fill the quota, then have the organizer accept one. The student should be
       able to apply again: they hold a commitment, not an outstanding request. */
    const ids = [];
    for (let i = 0; i < LIMIT; i++) ids.push(await makeEvent(org, `Accept Case ${i}`));
    for (const id of ids) {
      const slots = await slotsOf(id, student);
      const res = await srv.call('POST', `/api/events/${id}/apply`, { slotId: slots[0].id }, student);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const apps = (await srv.call('GET', '/api/applications', undefined, student)).body;
    const pending = apps.filter(a => a.status === 'pending');
    const accept = await srv.call(
      'PATCH', `/api/applications/${pending[0].id}`, { status: 'accepted' }, org
    );
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);

    const next = await makeEvent(org, 'After An Acceptance');
    const slots = await slotsOf(next, student);
    const res = await srv.call('POST', `/api/events/${next}/apply`, { slotId: slots[0].id }, student);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('does not count a pending application on a cancelled event', async () => {
    const student2 = await srv.login('leo.chen@example.com');
    await clearPending(student2);
    const ids = [];
    for (let i = 0; i < LIMIT; i++) ids.push(await makeEvent(org, `Cancel Case ${i}`));
    for (const id of ids) {
      const slots = await slotsOf(id, student2);
      const res = await srv.call('POST', `/api/events/${id}/apply`, { slotId: slots[0].id }, student2);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    /* The student cannot make a cancelled event's application resolve, and did
       not cause it. Holding their quota against them would be a penalty for
       somebody else's decision. */
    const kill = await srv.call('PATCH', `/api/events/${ids[0]}/status`, { status: 'cancelled' }, org);
    expect(kill.status, JSON.stringify(kill.body)).toBe(200);

    const next = await makeEvent(org, 'After A Cancellation');
    const slots = await slotsOf(next, student2);
    const res = await srv.call('POST', `/api/events/${next}/apply`, { slotId: slots[0].id }, student2);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
