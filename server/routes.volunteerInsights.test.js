import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * `/api/stats/volunteer` through the real stack.
 *
 * The unit tests in `volunteerInsights.test.js` cover the definitions. These
 * cover the things only the running server can answer: the response shape the
 * dashboard binds to, that removed fields stay removed, that one student's
 * figures never reflect another's, and — the important one — that the dashboard
 * and the public profile cannot disagree about a milestone.
 */

const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';
const ORGANIZER = 'jordan.whitfield@example.org';

describe('volunteer insights endpoint', () => {
  let srv;
  let student;
  let other;
  let organizer;

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login(STUDENT);
    other = await srv.login(OTHER_STUDENT);
    organizer = await srv.login(ORGANIZER);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const insights = async (session = student) =>
    (await srv.call('GET', '/api/stats/volunteer', undefined, session)).body;

  it('returns six months of hours, always', () => {
    return insights().then(async (body) => {
      expect(body.monthlyHours).toHaveLength(6);
      /* Ascending, and ending in the current month — which is what makes the
         chart's last column mean "this month". */
      const months = body.monthlyHours.map(m => m.month);
      expect([...months].sort()).toEqual(months);
      expect(months.at(-1)).toBe(new Date().toISOString().slice(0, 7));
    });
  });

  it('carries a record, milestones and a streak', async () => {
    const body = await insights();
    expect(body.record).toBeTypeOf('object');
    expect(Array.isArray(body.milestones)).toBe(true);
    expect(body.streak).toMatchObject({ current: expect.any(Number), longest: expect.any(Number) });
    expect(body.upcomingCount).toBeTypeOf('number');
  });

  it('keeps serviceHourGoal, which the progress meter is drawn against', async () => {
    /* Removing it would break the meter silently and fail a test in a file
       nobody would think to look in (badges.test.js). */
    const body = await insights();
    expect(body.serviceHourGoal).toBeGreaterThan(0);
  });

  it('no longer computes fields nothing rendered', async () => {
    /* `categoryHours` and `applications` were built on every request and had
       never been displayed. Asserted so that adding either back is a decision
       somebody makes rather than a shape that drifts. */
    const body = await insights();
    expect(body.categoryHours).toBeUndefined();
    expect(body.applications).toBeUndefined();
  });

  it('reports only the caller\'s own service', async () => {
    const mine = await insights(student);
    const theirs = await insights(other);
    expect(mine.record).not.toEqual(theirs.record);
  });

  it('refuses a non-student, because this is the self-statistics route', async () => {
    const res = await srv.call('GET', '/api/stats/volunteer', undefined, organizer);
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await srv.call('GET', '/api/stats/volunteer');
    expect(res.status).toBe(401);
  });

  /**
   * The test this whole extraction exists for.
   *
   * `buildMilestones` needs distinct events with credited attendance.
   * `volunteerStats().eventsAttended` is a different number — it excludes
   * cancelled events and shifts that have not ended. Feeding the wrong one in
   * would let the dashboard show a tier as unearned while the profile shows it
   * earned, for the same student, on the same afternoon. Both now derive it
   * through `milestoneInputs`; this asserts they agree.
   */
  it('agrees with the public profile about every milestone', async () => {
    const me = (await srv.call('GET', '/api/auth/me', undefined, student)).body;

    const dashboard = (await insights(student)).milestones;
    const profile = (await srv.call('GET', `/api/users/${me.id}/profile`, undefined, student)).body.milestones;

    expect(profile).toBeTruthy();
    expect(dashboard).toEqual(profile);
  });

  /**
   * The leaderboard lives in this file rather than its own because
   * `startTestServer` binds db.js at module scope: a second call in one file
   * cannot rebind it, and the anti-leak guard rightly refuses.
   */
  describe('leaderboard', () => {
  it('does not rank a deleted account', async () => {
    /**
     * Deleting an account renames the row and keeps its role, its opt-in and
     * its attendance. Without the filter a tombstoned student went on holding
     * a rank, under their anonymised name, with their hours intact, on a board
     * they can no longer ask to be removed from.
     */
    const { db } = await import('./db.js');
    const signed = await srv.signupConfirmed({
      name: 'Ranked Then Gone',
      username: 'ranked_then_gone',
      email: 'ranked.then.gone@example.com',
      password: 'Password123',
      grade: '11',
      role: 'student',
    });

    await db.prepare('UPDATE users SET leaderboard_opt_in = 1 WHERE email = ?').run('ranked.then.gone@example.com');

    const before = (await srv.call('GET', '/api/leaderboard', undefined, student)).body;
    expect(before.some(r => r.name === 'Ranked Then Gone')).toBe(true);

    await db.prepare("UPDATE users SET account_status = 'deleted', deleted_at = ? WHERE email = ?")
      .run(new Date().toISOString(), 'ranked.then.gone@example.com');

    const after = (await srv.call('GET', '/api/leaderboard', undefined, student)).body;
    expect(after.some(r => r.name === 'Ranked Then Gone')).toBe(false);
    expect(signed).toBeTruthy();
  });

  it('does not list a student who never opted in', async () => {
    const board = (await srv.call('GET', '/api/leaderboard', undefined, student)).body;
    /* The board is opt-in by construction; nobody is ranked against their will. */
    expect(Array.isArray(board)).toBe(true);
    const { db } = await import('./db.js');
    for (const row of board) {
      const optIn = (await db.prepare('SELECT leaderboard_opt_in AS o FROM users WHERE id = ?').get(row.id))?.o;
      expect(optIn).toBe(1);
    }
  });
});

  /**
   * The same pairing, exercised where it can actually differ.
   *
   * The agreement case above passes whichever derivation each surface uses,
   * because the seeded student has no credited attendance at a cancelled
   * event — so it cannot see the two routes drift apart on the one input that
   * distinguishes them. Mutation-checked: reverting `userRoutes.js` alone left
   * it green.
   *
   * Placed last in the file and mutating shared fixture state on purpose: it
   * credits a cancelled event to this student, which every earlier case in
   * this file would otherwise have to account for.
   *
   * Decided during the 2026-09-21 audit (owner decision 3).
   */
  describe('once a cancelled event carries credited hours', () => {
    it('keeps the hours tiers on credited hours, on both surfaces', async () => {
      const { db } = await import('./db.js');
      const me = (await srv.call('GET', '/api/auth/me', undefined, student)).body;

      const before = (await insights(student)).record.hoursCredited;

      /* Enough to cross a tier on its own, so the case cannot pass by accident
         on a student who was already past every threshold. */
      const eventId = 'evt-cancelled-milestone';
      const slotId = 'slot-cancelled-milestone';
      await db.prepare(`
        INSERT INTO events (id, title, description, category, location,
                            application_deadline, organizer_id, status, created_at)
        VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'cancelled', ?)
      `).run(
        eventId, 'Called-off drive', 'Synthetic fixture for the milestone split.',
        'Springfield', '2026-07-20T00:00:00.000Z', me.id, '2026-07-01T00:00:00.000Z',
      );
      await db.prepare(`
        INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
        VALUES (?, ?, 'Afternoon', 'Synthetic fixture.', ?, ?, 5)
      `).run(slotId, eventId, '2026-07-23T13:00:00.000Z', '2026-07-23T17:00:00.000Z');
      await db.prepare(
        'INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, 1, ?)'
      ).run(eventId, slotId, me.id, 500);

      const after = await insights(student);
      const profile = (await srv.call('GET', `/api/users/${me.id}/profile`, undefined, student)).body;

      /* The cancelled hours reach no total ... */
      expect(after.record.hoursCredited).toBe(before);
      /* ... and no hours tier. 500 hours would clear every one of them. */
      const hourTiers = after.milestones.filter(m => m.metric === 'hours');
      expect(hourTiers.length).toBeGreaterThan(0);
      for (const tier of hourTiers) {
        if (tier.threshold > before) {
          expect(tier.earned, `${tier.label} was reached on cancelled hours`).toBe(false);
        }
      }

      /* And the two surfaces still say the same thing, which is what the
         agreement case exists to protect. */
      expect(profile.milestones).toEqual(after.milestones);
    });
  });
});
