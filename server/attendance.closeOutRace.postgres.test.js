import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RUNNING_ON_POSTGRES } from './testEngine.js';

/**
 * The close-out race, on the engine where it exists.
 *
 * ── The defect ──
 *
 * `finalizeAttendance` re-reads `hours_closed_out_at` inside its own
 * transaction, and the comment justifying that said it "closes the window on
 * both engines … PostgreSQL's READ COMMITTED returns the value as of this
 * statement rather than as of the route's."
 *
 * The first half is true and the second does not follow. A statement's snapshot
 * says nothing about what commits AFTERWARDS. The close-out is a bare
 * autocommit CAS in `attendanceRoutes.js`, and the finalize transaction holds
 * no lock on `events` — it writes `attendance` — so a close-out landing between
 * the re-read and the upsert is blocked by nothing, and the correction commits
 * on top of hours that were just made permanent.
 *
 * Measured against real PostgreSQL with the statements this application issues,
 * before the fix: commit order `close-out → correction`. With `FOR UPDATE` on
 * the re-read: `correction → close-out`, the close-out having blocked until the
 * finalize transaction committed — which is the difference between the two acts
 * overlapping and the two acts serialising.
 *
 * ── Why this asserts the LOCK and not an interleaving ──
 *
 * The race needs a commit to land inside a window the test cannot open, and
 * `finalizeAttendance` offers no seam in the middle of itself. Racing two real
 * requests does not reproduce it either — `attendance.closedOut.test.js` says
 * so, and says it verified that the parallel case passes with its own fix
 * reverted.
 *
 * What IS deterministic is the mechanism: while a finalize transaction is open,
 * the events row must be locked, so a concurrent close-out cannot commit. That
 * is the property `FOR UPDATE` buys, it is the only reason the ordering above
 * changes, and a lock either blocks or it does not — there is no timing to
 * tune beyond "did it finish".
 *
 * ── SQLite ──
 *
 * `forUpdate` is empty there and the engine serialises writers, so this suite
 * would assert nothing. `skipIf` rather than an early return, so the skip is
 * visible in the report.
 */
describe.skipIf(!RUNNING_ON_POSTGRES)('a close-out racing a finalisation', () => {
  let srv, db, pg, finalizeAttendance, runInTransaction;
  let organizer, organizerId;

  beforeAll(async () => {
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    ({ finalizeAttendance } = await import('./attendance.js'));
    ({ runInTransaction } = await import('./db/connectionContext.js'));
    pg = (await import('pg')).default;

    organizer = await srv.login('jordan.whitfield@example.org');
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?')
      .get('jordan.whitfield@example.org')).id;
  }, 90000);

  afterAll(async () => { await srv?.close(); });

  /** A completed event with one credited volunteer. */
  async function creditedEvent() {
    const tag = Math.random().toString(36).slice(2);
    const eventId = `event-${tag}`;
    const slotId = `slot-${tag}`;
    const appId = `app-${tag}`;
    const start = new Date(Date.now() - 3 * 86400000);
    const end = new Date(start.getTime() + 4 * 3600000);
    const studentId = (await db.prepare('SELECT id FROM users WHERE email = ?')
      .get('leo.chen@example.com')).id;

    await db.prepare(`INSERT INTO events (id, title, description, category, location,
      organizer_id, status, created_at, application_deadline)
      VALUES (?, ?, 'd', 'Other', 'Park', ?, 'open', ?, ?)`)
      .run(eventId, `Race ${tag}`, organizerId, start.toISOString(), start.toISOString());
    await db.prepare(`INSERT INTO slots (id, event_id, name, description,
      start_datetime, end_datetime, max_spots) VALUES (?, ?, 'Shift', 'd', ?, ?, 4)`)
      .run(slotId, eventId, start.toISOString(), end.toISOString());
    await db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'accepted', ?)`)
      .run(appId, studentId, eventId, slotId, start.toISOString());

    const res = await srv.call('POST', `/api/events/${eventId}/attendance`,
      { attendanceMap: { [appId]: true } }, organizer);
    expect(res.status, 'the fixture was not credited').toBe(200);
    return { eventId, slotId, appId, studentId };
  }

  /** A second real connection, in the harness's own schema. */
  async function otherConnection() {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return client;
  }

  it('holds the events row, so a close-out cannot commit underneath it', async () => {
    const { eventId, appId } = await creditedEvent();
    const other = await otherConnection();

    try {
      const outcome = await runInTransaction(db, async (tx) => {
        /* Goes through the real function, so the lock is taken by the statement
           under test rather than by one this file wrote. A submission that
           changes nothing is enough: the re-read happens before the loop. */
        const r = await finalizeAttendance(tx, {
          event: await tx.prepare('SELECT * FROM events WHERE id = ?').get(eventId),
          attendanceMap: { [appId]: true },
          actor: { id: organizerId, role: 'organizer' },
          now: new Date().toISOString(),
        });

        /* The close-out, exactly as the route issues it. */
        const closeOut = other.query(
          `UPDATE events SET hours_closed_out_at = 'raced', hours_closed_out_by = $1
             WHERE id = $2 AND hours_closed_out_at IS NULL`,
          [organizerId, eventId],
        ).then(() => 'committed');

        const settled = await Promise.race([
          closeOut,
          new Promise(resolve => setTimeout(() => resolve('blocked'), 600)),
        ]);
        expect(settled, 'the close-out committed while a finalisation was open').toBe('blocked');
        return r;
      });

      expect(outcome.ok).toBe(true);
    } finally {
      /* The lock is gone once the transaction above ended, so the queued
         close-out completes; draining it keeps the connection closable. */
      await new Promise(r => setTimeout(r, 200));
      await other.end().catch(() => {});
    }
  }, 30000);

  it('refuses a correction once the close-out has landed', async () => {
    /* The other half of the ordering: with the row locked, the losing act is
       the one that arrives second, and it is refused rather than queued. */
    const { eventId, appId } = await creditedEvent();
    expect((await srv.call('POST', `/api/events/${eventId}/hours/close-out`, {}, organizer)).status)
      .toBe(200);

    const res = await srv.call('POST', `/api/events/${eventId}/attendance`, {
      attendanceMap: { [appId]: true },
      hoursMap: { [appId]: 2.5 },
      reason: 'After the close-out.',
    }, organizer);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hours_locked');
  }, 30000);
});
