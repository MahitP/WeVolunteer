import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// Lowered so the draw-cap test doesn't need to make five real runs. Must be
// set before testServer.js dynamically imports config.js/eventRoutes.js.
process.env.MAX_AUTO_SELECT_DRAWS = '2';

describe('auto-select: deadline guard, re-draw reasons, and draw cap', () => {
  let srv;

  beforeAll(async () => {
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    delete process.env.MAX_AUTO_SELECT_DRAWS;
  });

  // Direct DB helpers — mirrors the DatabaseSync pattern already used by
  // routes.verification.test.js, and is how Task 8's future-deadline
  // validation on POST /api/events is bypassed here (an Auto Select event
  // must be created with a future deadline to pass creation, then the
  // deadline is pushed into the past directly so the draw can be tested).
  const withDb = (fn) => {
    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    try { return fn(db); } finally { db.close(); }
  };

  const pushDeadlineToPast = (eventId) => withDb((db) => {
    const past = new Date(Date.now() - 864e5).toISOString();
    db.prepare('UPDATE events SET application_deadline = ? WHERE id = ?').run(past, eventId);
  });

  const runReason = (eventId, runNumber) => withDb((db) => {
    const row = db.prepare('SELECT reason FROM auto_select_runs WHERE event_id = ? AND run_number = ?')
      .get(eventId, runNumber);
    return row ? row.reason : undefined;
  });

  // Builds a fresh Auto Select event with one slot of the given capacity and
  // has `applicants` seeded students apply, all while the deadline is still
  // in the future (so both event creation and the applications succeed).
  const seedDrawEvent = async (maxSpots, applicants) => {
    const orgToken = await srv.login('jkatzenback@vikings.org');
    const deadline = new Date(Date.now() + 20 * 864e5).toISOString();
    const start = new Date(Date.now() + 30 * 864e5).toISOString();
    const end = new Date(Date.now() + 30 * 864e5 + 108e5).toISOString();

    const mk = await srv.call('POST', '/api/events', {
      title: 'Auto Select Draw Test', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: deadline, autoApprove: true,
      slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots }]
    }, orgToken);
    const evId = mk.body.id;

    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === evId).slots[0];

    for (const email of applicants) {
      const tok = await srv.login(email);
      await srv.call('POST', `/api/events/${evId}/apply`, { slotId: slot.id }, tok);
    }

    return { evId, slotId: slot.id, orgToken };
  };

  const applicants = ['leo.chen28@gmail.com', 'priya.patel.nhs@outlook.com', 'emiller2027@gmail.com'];

  let evId, orgToken, secondReason;

  it('refuses to run the draw before the application deadline', async () => {
    const seeded = await seedDrawEvent(1, applicants);
    evId = seeded.evId;
    orgToken = seeded.orgToken;

    const res = await srv.call('POST', `/api/events/${evId}/auto-select/run`, {}, orgToken);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('deadline_not_passed');
  });

  it('runs the first draw after the deadline with no reason required, and stores no reason', async () => {
    pushDeadlineToPast(evId);

    const res = await srv.call('POST', `/api/events/${evId}/auto-select/run`, {}, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.runNumber).toBe(1);

    const runs = await srv.call('GET', `/api/events/${evId}/auto-select/runs`, undefined, orgToken);
    expect(runs.status).toBe(200);
    expect(runs.body.length).toBe(1);
    expect(runs.body[0].runNumber).toBe(1);

    expect(runReason(evId, 1)).toBeNull();
  });

  it('rejects a re-draw with no reason', async () => {
    const res = await srv.call('POST', `/api/events/${evId}/auto-select/run`, {}, orgToken);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('reason_required');
  });

  it('accepts and stores a reason on a re-draw', async () => {
    secondReason = 'A selected volunteer reported a scheduling conflict; redrawing per policy.';
    const res = await srv.call('POST', `/api/events/${evId}/auto-select/run`, { reason: secondReason }, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.runNumber).toBe(2);

    const runs = await srv.call('GET', `/api/events/${evId}/auto-select/runs`, undefined, orgToken);
    expect(runs.body.length).toBe(2);

    expect(runReason(evId, 2)).toBe(secondReason);
  });

  it('refuses a draw once the cap is reached, even with a reason supplied', async () => {
    // MAX_AUTO_SELECT_DRAWS=2 for this file, and two runs have already been made.
    const res = await srv.call('POST', `/api/events/${evId}/auto-select/run`, { reason: 'One more try' }, orgToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('draw_cap_reached');
  });

  it('surfaces runCount and redrawReasons in the confirmed selection summary', async () => {
    const confirm = await srv.call('POST', `/api/events/${evId}/auto-select/confirm`, {}, orgToken);
    expect(confirm.status).toBe(200);

    const events = await srv.call('GET', '/api/events', undefined, orgToken);
    const ev = events.body.find(e => e.id === evId);
    expect(ev.selectionSummary).toBeTruthy();
    expect(ev.selectionSummary.runCount).toBe(2);
    expect(ev.selectionSummary.redrawReasons).toEqual([secondReason]);
  });

  it('exposes the re-draw reason on the runs audit endpoint before confirmation', async () => {
    const seeded = await seedDrawEvent(1, applicants);
    const evId2 = seeded.evId;
    const orgToken2 = seeded.orgToken;
    pushDeadlineToPast(evId2);

    const first = await srv.call('POST', `/api/events/${evId2}/auto-select/run`, {}, orgToken2);
    expect(first.status).toBe(200);

    const redrawReason = 'wrong shift assigned';
    const second = await srv.call('POST', `/api/events/${evId2}/auto-select/run`, { reason: redrawReason }, orgToken2);
    expect(second.status).toBe(200);

    const runs = await srv.call('GET', `/api/events/${evId2}/auto-select/runs`, undefined, orgToken2);
    expect(runs.status).toBe(200);
    expect(Array.isArray(runs.body)).toBe(true);
    expect(runs.body.length).toBe(2);

    const run1 = runs.body.find(r => r.runNumber === 1);
    const run2 = runs.body.find(r => r.runNumber === 2);
    expect(run1.reason).toBeNull();
    expect(run2.reason).toBe(redrawReason);
  });
});

describe('auto-select: deterministic seeded draw', () => {
  it('produces the same selection for the same seed and the same ordered applicant list', async () => {
    const { createRandom, performWeightedSelection } = await import('./weighting.js');

    // Fixed, already-ordered input — this is what `ORDER BY a.id` guarantees
    // the run handler feeds into performWeightedSelection on every run.
    const orderedApplicants = [
      { id: 'app-a', totalHours: 0 },
      { id: 'app-b', totalHours: 12 },
      { id: 'app-c', totalHours: 40 },
      { id: 'app-d', totalHours: 5 }
    ];
    const seed = 'event-determinism-test:slot-1:run-1';

    const draw1 = performWeightedSelection(orderedApplicants, 2, createRandom(seed));
    const draw2 = performWeightedSelection(orderedApplicants, 2, createRandom(seed));

    expect(draw1).toEqual(draw2);
    expect(draw1.selectedIds.length).toBe(2);
    expect(draw1.selectedIds.length + draw1.waitlistIds.length).toBe(orderedApplicants.length);
  });
});
