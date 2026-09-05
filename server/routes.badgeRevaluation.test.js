import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import './testServer.js';

/**
 * Badge re-evaluation through the REAL finalisation route.
 *
 * `badges.revaluation.test.js` proves `evaluateBadges` knows how to withdraw an
 * automatically-awarded badge. This proves the route actually asks it to, which
 * is where the gap was: the handler looped over `credited` and called it, and
 * looped over `revoked` and did not.
 *
 * A separate file because the unit tests stub `db.js` at module scope, and
 * `startTestServer` refuses to run against a connection it did not open.
 */

describe('badge re-evaluation through the attendance route', () => {
  let srv;
  let realDb;
  let organizer;

  const ORGANIZER = 'jordan.whitfield@example.org';

  /** Every accepted application on an event whose shifts have ended. */
  const rosterFor = async (eventId) => await realDb.prepare(`
    SELECT a.id, a.user_id AS "userId" FROM applications a
    WHERE a.event_id = ? AND a.status = 'accepted'
  `).all(eventId);

  beforeAll(async () => {
    const mod = await import('./testServer.js');
    srv = await mod.startTestServer();
    ({ db: realDb } = await import('./db.js'));
    organizer = await srv.login(ORGANIZER);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('withdraws an automatic badge when a volunteer is marked absent', async () => {
    /**
     * The regression. Before the fix the route called `evaluateBadges` only for
     * volunteers being credited, so marking somebody absent — the one action
     * that should be able to take a badge away — recomputed nothing.
     */
    /**
     * The target has to be an accepted application that has NOT been credited
     * yet, and whose volunteer holds no hours from anywhere else.
     *
     * This used to be `apps.find(a => a.status === 'accepted')` — the first
     * accepted row in whatever order the endpoint happened to return. That
     * worked only by accident. `GET /api/applications` now has a deterministic
     * `ORDER BY applied_at DESC, id ASC` (it had no ORDER BY at all, which made
     * its pagination unsound), and under that order the first accepted row is
     * `app-past-p1` — a volunteer on a COMPLETED event who is already marked
     * present for three hours.
     *
     * Crediting somebody who is already credited changes nothing, so the route
     * correctly reports `unchanged: 1`, puts nobody in `credited`, and never
     * calls `evaluateBadges`. That is right, and the fixture was wrong: it
     * needed a volunteer with something to gain.
     *
     * The zero-hours condition matters for the second half. The badge is
     * `hours >= 1`, so a volunteer holding credited hours from another event
     * would keep it after being marked absent here — and the withdrawal this
     * test exists to prove would look broken when it was working.
     */
    const apps = (await srv.call('GET', '/api/applications', undefined, organizer)).body;
    const target = apps.find(a =>
      a.status === 'accepted' && !a.attendance && a.volunteer.volunteeredHours === 0);
    expect(
      target,
      'the seed has no accepted, uncredited application for a volunteer with no other hours'
    ).toBeTruthy();

    /* Put the shift in the past so finalisation is permitted. */
    const start = new Date(Date.now() - 3 * 86400000).toISOString();
    const end = new Date(Date.now() - 3 * 86400000 + 2 * 3600000).toISOString();
    await realDb.prepare('UPDATE slots SET start_datetime = ?, end_datetime = ? WHERE id = ?')
      .run(start, end, target.slotId);
    await realDb.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(target.eventId);

    /* A badge this volunteer holds and would lose the moment hours vanish. */
    const badgeId = 'test-hours-tier';
    await realDb.prepare(`
      INSERT INTO badges (id, name, description, icon, category, criteria_type, criteria_value, active, created_at)
      VALUES (?, 'Fixture hours tier', 'Fixture', '*', 'Fixture', 'hours', 1, 1, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, icon = excluded.icon, category = excluded.category, criteria_type = excluded.criteria_type, criteria_value = excluded.criteria_value, active = excluded.active, created_at = excluded.created_at
    `).run(badgeId, new Date().toISOString());

    /* Credit them first, through the route, so the badge is genuinely earned. */
    const credited = await srv.call('POST', `/api/events/${target.eventId}/attendance`,
      { attendanceMap: { [target.id]: true } }, organizer);
    expect(credited.status, JSON.stringify(credited.body)).toBe(200);

    const heldAfterCredit = !!await realDb.prepare(
      'SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?'
    ).get(target.userId, badgeId);
    expect(heldAfterCredit, 'the fixture badge should have been awarded on credit').toBe(true);

    /* Now revoke it: mark the same volunteer absent. */
    const revoked = await srv.call('POST', `/api/events/${target.eventId}/attendance`,
      { attendanceMap: { [target.id]: false }, reason: 'Did not attend after all' }, organizer);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const stillHeld = !!await realDb.prepare(
      'SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?'
    ).get(target.userId, badgeId);

    const hours = (await realDb.prepare(
      'SELECT COALESCE(SUM(hours_awarded), 0) AS h FROM attendance WHERE user_id = ? AND present = 1'
    ).get(target.userId)).h;

    expect(stillHeld, `volunteer now has ${hours} credited hours but still holds a 1-hour badge`).toBe(false);
  });
});
