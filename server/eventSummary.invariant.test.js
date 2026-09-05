import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { verifyEventSummaries } from './eventSummary.js';

/**
 * `events.first_slot_start` must never disagree with the slots it summarises.
 *
 * ── Why this file carries more weight than a usual test ──
 *
 * This is the only derived value the schema stores, and it is stored because
 * the browse list's default ORDER BY needs an indexable sort key. That makes
 * drift uniquely nasty: the aggregate figures a page REPORTS are still computed
 * live, so a stale column produces a page whose contents are all correct and
 * whose ORDER is wrong. Nothing looks broken. Pagination silently repeats and
 * skips events, because `OFFSET` is only sound over a total order.
 *
 * `server/eventSummary.js` argues that storing it is safe because it is always
 * recomputable and therefore always checkable. This file is that argument's
 * evidence: it exercises every mutation the API offers and then asks
 * `verifyEventSummaries` whether anything drifted.
 *
 * A new slot write path that forgets to refresh the summary fails here.
 */
let srv, organizer, admin;

const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();
const slot = (name, dayOffset, spots = 3) => ({
  name, description: 'd',
  startDatetime: iso(60 * 24 * dayOffset),
  endDatetime: iso(60 * 24 * dayOffset + 120),
  maxSpots: spots,
});

beforeAll(async () => {
  srv = await startTestServer();
  organizer = await srv.login('jordan.whitfield@example.org');
  admin = await srv.login('admin@example.gov');
}, 120000);

afterAll(async () => { await srv?.close(); });

/** Fails with the drifted rows named, not just a count. */
async function expectNoDrift(what) {
  const drift = await verifyEventSummaries(srv.db ?? (await import('./db.js')).db);
  expect(
    drift,
    `${what} left first_slot_start disagreeing with the slots: `
    + JSON.stringify(drift.slice(0, 5)),
  ).toEqual([]);
}

const createEvent = async (title, slots) => (await srv.call('POST', '/api/events', {
  title, description: 'summary invariant', category: 'Other', location: 'Hall',
  applicationDeadline: iso(60 * 24 * 5), slots,
}, organizer)).body.id;

/* `GET /api/events/:id` answers `{ event, applications }` — the event is
   nested, not the body. */
const detail = async (id) =>
  (await srv.call('GET', `/api/events/${id}`, undefined, organizer)).body.event;

const stored = async (id) => {
  const { db } = await import('./db.js');
  return (await db.prepare('SELECT first_slot_start FROM events WHERE id = ?').get(id))?.first_slot_start;
};
const computed = async (id) => {
  const { db } = await import('./db.js');
  return (await db.prepare('SELECT MIN(start_datetime) AS m FROM slots WHERE event_id = ?').get(id))?.m;
};

describe('the seeded database starts consistent', () => {
  it('has no drift before anything is done to it', async () => {
    await expectNoDrift('seeding');
  });
});

describe('every mutation keeps the summary honest', () => {
  it('creating an event stores the earliest of its slots', async () => {
    /* Deliberately NOT in chronological order, so a summary that took the
       first slot in the payload rather than the minimum would fail here. */
    const id = await createEvent('Summary Create', [slot('later', 40), slot('earliest', 20), slot('middle', 30)]);
    expect(await stored(id)).toBe(await computed(id));
    await expectNoDrift('creating an event');
  });

  it('adding an EARLIER slot moves the summary', async () => {
    const id = await createEvent('Summary Add Earlier', [slot('a', 50)]);
    const before = await stored(id);

    const ev = await detail(id);
    const res = await srv.call('PUT', `/api/events/${id}`, {
      ...ev,
      applicationDeadline: ev.applicationDeadline ?? iso(60 * 24 * 5),
      slots: [
        { id: ev.slots[0].id, name: 'a', description: 'd', startDatetime: ev.slots[0].startDatetime, endDatetime: ev.slots[0].endDatetime, maxSpots: 3 },
        slot('earlier', 10),
      ],
    }, organizer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await stored(id)).toBe(await computed(id));
    expect(await stored(id), 'the summary did not move to the new earliest slot').not.toBe(before);
    await expectNoDrift('adding an earlier slot');
  });

  it('DELETING the earliest slot moves the summary forward', async () => {
    /**
     * The case a naive implementation gets wrong. Maintaining a minimum on
     * insert is easy; the hard direction is removal, where the stored value
     * must move to whatever is now earliest — or to NULL.
     */
    const id = await createEvent('Summary Delete Earliest', [slot('first', 12), slot('second', 25)]);
    const ev = await detail(id);
    const keep = ev.slots.find(s => s.name === 'second');

    const res = await srv.call('PUT', `/api/events/${id}`, {
      ...ev,
      applicationDeadline: ev.applicationDeadline ?? iso(60 * 24 * 5),
      slots: [{ id: keep.id, name: 'second', description: 'd', startDatetime: keep.startDatetime, endDatetime: keep.endDatetime, maxSpots: 3 }],
    }, organizer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await stored(id)).toBe(await computed(id));
    await expectNoDrift('deleting the earliest slot');
  });

  it('MOVING the earliest slot later moves the summary', async () => {
    const id = await createEvent('Summary Move', [slot('only', 15)]);
    const ev = await detail(id);
    const s0 = ev.slots[0];

    const res = await srv.call('PUT', `/api/events/${id}`, {
      ...ev,
      applicationDeadline: ev.applicationDeadline ?? iso(60 * 24 * 5),
      slots: [{
        id: s0.id, name: 'only', description: 'd',
        startDatetime: iso(60 * 24 * 60), endDatetime: iso(60 * 24 * 60 + 120), maxSpots: 3,
      }],
    }, organizer);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await stored(id)).toBe(await computed(id));
    await expectNoDrift('moving the earliest slot later');
  });

  it('duplicating an event summarises the COPY, not the original', async () => {
    const id = await createEvent('Summary Duplicate', [slot('x', 22)]);
    const res = await srv.call('POST', `/api/events/${id}/duplicate`, {}, organizer);
    if (res.status === 404) return; /* route not offered in this build */
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const copyId = res.body.id;
    expect(await stored(copyId)).toBe(await computed(copyId));
    expect(await stored(copyId), 'the copy has no summary at all').toBeTruthy();
    await expectNoDrift('duplicating an event');
  });

  it('deleting an event leaves nothing behind to drift', async () => {
    const id = await createEvent('Summary Delete Event', [slot('y', 18)]);
    const res = await srv.call('DELETE', `/api/events/${id}`, undefined, admin);
    expect([200, 204]).toContain(res.status);
    await expectNoDrift('deleting an event');
  });
});

describe('the checker actually detects drift', () => {
  it('reports a row whose stored value has been corrupted', async () => {
    /**
     * A consistency checker nobody has seen fail is a consistency checker
     * nobody should trust. This corrupts one row deliberately, asserts the
     * checker names it, and puts it back.
     */
    const { db } = await import('./db.js');
    const id = await createEvent('Summary Corruption', [slot('z', 33)]);
    const good = await stored(id);

    await db.prepare('UPDATE events SET first_slot_start = ? WHERE id = ?')
      .run('1999-01-01T00:00:00.000Z', id);

    const drift = await verifyEventSummaries(db);
    expect(drift.map(r => r.id), 'the checker missed a corrupted row').toContain(id);

    await db.prepare('UPDATE events SET first_slot_start = ? WHERE id = ?').run(good, id);
    await expectNoDrift('repairing the corrupted row');
  });

  it('does not report an event that genuinely has no slots', async () => {
    /**
     * NULL on both sides must compare equal. Written with `<>` alone this
     * check would be NULL — never true — and the checker would silently pass
     * on every row it exists to examine.
     */
    const { db } = await import('./db.js');
    const id = await createEvent('Summary Null', [slot('w', 44)]);
    await db.prepare('DELETE FROM slots WHERE event_id = ?').run(id);
    await db.prepare('UPDATE events SET first_slot_start = NULL WHERE id = ?').run(id);

    const drift = await verifyEventSummaries(db);
    expect(drift.map(r => r.id), 'a slotless event with a NULL summary was reported as drift')
      .not.toContain(id);
  });
});
