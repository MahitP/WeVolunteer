import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The within-draw overlap rule, through the real API on whichever engine the
 * harness is pointed at.
 *
 * `autoSelect.withinDraw.test.js` covers this exhaustively, but it drives
 * `computeDraw` against a SQLite file it opens itself, so it can never say
 * anything about PostgreSQL. The part of the fix that is engine-dependent is the
 * one that most needed a defined answer: `ORDER BY start_datetime ASC, id ASC`
 * replaced a bare SELECT whose row order was the storage engine's business, and
 * "which of two overlapping shifts does the volunteer keep" must not depend on
 * which database is underneath.
 *
 * So this runs the whole thing — create, apply, draw, confirm — over HTTP, and
 * `WEV_POSTGRES_APP_TEST=1` makes it a PostgreSQL test without another line.
 */
describe('auto-select does not double-book within one draw, over HTTP', () => {
  let srv;

  beforeAll(async () => {
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
  });
  afterAll(async () => { await srv.close(); });

  const withDb = async (fn) => {
    const { db } = await import('./db.js');
    return await fn(db);
  };

  it('seats the volunteer on the earlier shift and queues them on the later one', async () => {
    const orgToken = await srv.login('jordan.whitfield@example.org');
    const day = 40 * 864e5;
    const iso = (offsetHours) => new Date(Date.now() + day + offsetHours * 36e5).toISOString();

    /* One event, two OVERLAPPING shifts: 09:00–13:00 and 11:00–15:00 relative to
       the same future day. Declared later-first so a passing result cannot be
       the insertion order. */
    const mk = await srv.call('POST', '/api/events', {
      title: 'Within-draw overlap', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(),
      autoApprove: true,
      slots: [
        { name: 'Late', description: 'd', startDatetime: iso(11), endDatetime: iso(15), maxSpots: 1 },
        { name: 'Early', description: 'd', startDatetime: iso(9), endDatetime: iso(13), maxSpots: 1 },
      ],
    }, orgToken);
    expect(mk.status, JSON.stringify(mk.body)).toBe(201);
    const evId = mk.body.id;

    const detail = await srv.call('GET', `/api/events/${evId}`, undefined, orgToken);
    const slots = detail.body.event.slots;
    const early = slots.find(s => s.name === 'Early');
    const late = slots.find(s => s.name === 'Late');
    expect(early && late, 'fixture: both shifts exist').toBeTruthy();

    /* One volunteer applies to BOTH, overriding the apply-time clash warning —
       which is exactly how a real double-booking candidate arises. */
    const tok = await srv.login('leo.chen@example.com');
    for (const s of [early, late]) {
      const res = await srv.call('POST', `/api/events/${evId}/apply`,
        { slotId: s.id, overrideConflict: true }, tok);
      expect(res.status, `apply ${s.name}: ${JSON.stringify(res.body)}`).toBe(201);
    }

    await withDb(async (db) => {
      await db.prepare('UPDATE events SET application_deadline = ? WHERE id = ?')
        .run(new Date(Date.now() - 864e5).toISOString(), evId);
    });

    const run = await srv.call('POST', `/api/events/${evId}/auto-select/run`, {}, orgToken);
    expect(run.status, JSON.stringify(run.body)).toBe(200);

    const confirm = await srv.call('POST', `/api/events/${evId}/auto-select/confirm`, {}, orgToken);
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);

    const after = await srv.call('GET', `/api/events/${evId}`, undefined, orgToken);
    const mine = after.body.applications.filter(a => a.slotId === early.id || a.slotId === late.id);
    const accepted = mine.filter(a => a.status === 'accepted');

    expect(
      accepted.length,
      `the draw accepted ${accepted.length} overlapping shifts for one volunteer: `
      + JSON.stringify(mine.map(a => ({ slot: a.slotId, status: a.status }))),
    ).toBe(1);
    expect(accepted[0].slotId, 'the earlier shift is the one kept').toBe(early.id);
    expect(mine.find(a => a.slotId === late.id).status,
      'the losing application must be queued, never dropped').toBe('waitlisted');
  });
});
