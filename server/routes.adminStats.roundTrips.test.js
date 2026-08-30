import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * How many database round trips `GET /api/admin/stats` costs.
 *
 * ── Why a count is the assertion ──
 *
 * This endpoint issued fourteen statements in series. On `node:sqlite` that was
 * free — `DatabaseSync` is synchronous, so fourteen statements were fourteen
 * function calls with no waiting. The PostgreSQL port turned every one of them
 * into an `await`, and against a managed provider an `await` is a network round
 * trip: the same handler became fourteen serialised round trips before the page
 * could render, and nothing anywhere said so.
 *
 * A payload test cannot see that, because the payload did not change. The
 * statement count is the only place the cost is visible, so it is what is
 * pinned. `db` is the connection proxy from `db/connectionContext.js`, which
 * implements `defineProperty` specifically so `vi.spyOn` reaches the real
 * connection rather than an inert target.
 *
 * The bound counts EVERY statement the request makes, authentication and the
 * capability check included, so it can only ever be loose in the safe
 * direction — a regression that reintroduces per-figure queries pushes straight
 * through it.
 */
let srv, admin, db;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  admin = await srv.login('admin@example.gov');
}, 60000);

afterAll(async () => { await srv?.close(); });

/**
 * Runs `call` with every `db.prepare(...)` recorded.
 *
 * A PASS-THROUGH wrapper, not a replacement: the handler needs real statements
 * back, and this only notes that one was asked for. `db.prepare` is read off the
 * proxy first, which binds it to the live connection, so the original still runs
 * correctly while the spy is installed.
 */
async function statementsFor(call) {
  const seen = [];
  const original = db.prepare;
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    seen.push(String(sql).replace(/\s+/g, ' ').trim());
    return original(sql);
  });
  try {
    const res = await call();
    return { res, seen };
  } finally {
    spy.mockRestore();
  }
}

describe('GET /api/admin/stats round trips', () => {
  it('answers in a small, bounded number of statements', async () => {
    const { res, seen } = await statementsFor(
      () => srv.call('GET', '/api/admin/stats', undefined, admin)
    );
    expect(res.status).toBe(200);

    /* Fourteen of these were the handler's own before consolidation; it now
       issues five. The bound is set above the whole request's count, not the
       handler's, and generously — its job is to fail when the shape regresses,
       not to track incidental middleware. */
    expect(seen.length, `statements issued:\n${seen.join('\n')}`).toBeLessThanOrEqual(12);
  });

  it('reads the whole-table scalars in one statement', async () => {
    const { seen } = await statementsFor(
      () => srv.call('GET', '/api/admin/stats', undefined, admin)
    );
    const scalarStatements = seen.filter(s => /AS active_volunteers/i.test(s));
    expect(scalarStatements).toHaveLength(1);

    // Ten figures, one statement. If somebody splits it back out, this is the
    // assertion that says why they should not.
    const s = scalarStatements[0];
    for (const column of [
      'AS users', 'AS students', 'AS organizers', 'AS events', 'AS applications',
      'AS hours', 'AS pending_organizers', 'AS attendance_total',
      'AS attendance_present', 'AS active_volunteers'
    ]) {
      expect(s).toContain(column);
    }
  });

  it('reads the events table once for both rollups', async () => {
    const { seen } = await statementsFor(
      () => srv.call('GET', '/api/admin/stats', undefined, admin)
    );
    /* `eventStatus` and `selectionSplit` were two separate full scans of
       `events`. One grouped statement now answers both, so the claim is that
       `events` is grouped exactly once for the whole request. */
    expect(seen.filter(s => /FROM events GROUP BY/i.test(s))).toHaveLength(1);
    expect(seen.filter(s => /GROUP BY status, COALESCE\(auto_approve/i.test(s))).toHaveLength(1);
  });
});

describe('the payload is unchanged by the consolidation', () => {
  it('publishes every field the dashboard reads', async () => {
    const res = await srv.call('GET', '/api/admin/stats', undefined, admin);
    expect(res.status).toBe(200);
    for (const key of [
      'users', 'students', 'organizers', 'events', 'applications', 'hours',
      'pendingOrganizers', 'activeVolunteers', 'attendanceRate', 'completionRate',
      'participationRate', 'eventStatus', 'monthlyHours', 'signupsByMonth',
      'topOrganizers', 'selectionSplit'
    ]) {
      expect(res.body, `missing ${key}`).toHaveProperty(key);
    }
  });

  it('selectionSplit still carries both branches as numbers', async () => {
    const { body } = await srv.call('GET', '/api/admin/stats', undefined, admin);
    expect(typeof body.selectionSplit.manual).toBe('number');
    expect(typeof body.selectionSplit.autoSelect).toBe('number');
    // Every event is one or the other, so the split must account for all of them.
    expect(body.selectionSplit.manual + body.selectionSplit.autoSelect).toBe(body.events);
  });

  it('the status rollup accounts for every event', async () => {
    const { body } = await srv.call('GET', '/api/admin/stats', undefined, admin);
    const summed = Object.values(body.eventStatus).reduce((a, b) => a + b, 0);
    expect(summed).toBe(body.events);
  });

  it('counts and rates stay internally consistent', async () => {
    const { body } = await srv.call('GET', '/api/admin/stats', undefined, admin);
    expect(body.activeVolunteers).toBeLessThanOrEqual(body.students + body.organizers);
    if (body.participationRate !== null) {
      expect(body.participationRate).toBe(
        Math.round((body.activeVolunteers / body.students) * 100)
      );
    }
  });
});
