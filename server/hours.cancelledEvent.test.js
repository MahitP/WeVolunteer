import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * One rule, asked of every surface that presents credited service.
 *
 * ── The established invariant, and where it comes from ──
 *
 * `creditedHoursFor` (volunteerStats.js) is described in its own header as "the
 * canonical definition behind every total in the product", and it excludes
 * `events.status = 'cancelled'`. Commit b8cfb09 states the scope in the words
 * this file tests against: "the platform-wide 'cancelled events count for
 * nothing' rule was applied everywhere hours are presented as credited service
 * EXCEPT the largest number on the first screen a student sees."
 *
 * That commit also settles that this is not a policy choice being made here.
 * The Volunteer Record Policy publishes Auto Select's input as "total credited
 * hours" and states the same principle for the neighbouring term — "neither is
 * an event that was cancelled" — so the commit records: "The code disagreed
 * with published policy rather than implementing a different intent, so no
 * policy text changes."
 *
 * It has been applied twice as a correctness fix — to `formatUserResponse`
 * (the dashboard's big number, found at 209 hours against a cancelled event
 * while the same student's profile read 0) and to Auto Select's four weighting
 * queries. Both times, one surface was missed. This file exists so the next
 * missed surface fails a test instead of reaching a student.
 *
 * ── What is deliberately NOT asserted here ──
 *
 * Not every SUM over attendance presents credited service. The hours ledger and
 * `verifyHours` reconcile against RAW attendance and must stay unfiltered or the
 * parity check becomes circular. An issued certificate is never voided — a
 * published policy, pinned by `certificates.cancelled.test.js` — so the public
 * verification endpoint keeps answering for one. Those are out of scope by
 * design, not by omission.
 */

const STUDENT = 'leo.chen@example.com';

describe('a credited event that is cancelled afterwards', () => {
  let srv, student, db, userId;
  let before = {};

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login(STUDENT);
    if (!student) throw new Error('seeded student login failed');

    const me = (await srv.call('GET', '/api/auth/me', undefined, student)).body;
    userId = (me.user ?? me).id;

    ({ db } = await import('./db.js'));

    /**
     * A controlled event of its own rather than one of the seed's, so
     * cancelling it cannot move a figure another suite depends on. Inserted
     * directly because what is under test is the READ derivations; the write
     * pipeline has its own coverage in `attendance.test.js`.
     */
    const now = Date.now();
    const iso = (mins) => new Date(now + mins * 60000).toISOString();
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, organizer_id, status, created_at, application_deadline)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
    `).run('ev-cancel-probe', 'Cancellation Probe', 'd', 'Other', 'Reichler Park',
      userId, new Date(now).toISOString(), iso(-60 * 24 * 10));
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('slot-cancel-probe', 'ev-cancel-probe', 'Shift', 'd', iso(-60 * 24 * 9), iso(-60 * 24 * 9 + 120), 4);
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, ?, ?, 1, ?)
    `).run('ev-cancel-probe', 'slot-cancel-probe', userId, 7);

    /* The figures WITH the event live. Every assertion below is a comparison
       against these rather than an absolute, so the seed's own history cannot
       make a case pass or fail for the wrong reason. */
    before = {
      me: ((await srv.call('GET', '/api/auth/me', undefined, student)).body),
      stats: (await srv.call('GET', '/api/stats/volunteer', undefined, student)).body,
      profile: (await srv.call('GET', `/api/users/${userId}/profile`, undefined, student)).body,
    };

    await db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run('ev-cancel-probe');
  }, 90000);

  afterAll(async () => { await srv?.close(); });

  const me = async () => {
    const body = (await srv.call('GET', '/api/auth/me', undefined, student)).body;
    return body.user ?? body;
  };
  const stats = async () => (await srv.call('GET', '/api/stats/volunteer', undefined, student)).body;
  const profile = async () =>
    (await srv.call('GET', `/api/users/${userId}/profile`, undefined, student)).body;

  it('is a real seven hours before it is cancelled', () => {
    /* Non-vacuity. Without this the whole file could pass against a fixture
       that never credited anything. */
    const liveHours = (before.me.user ?? before.me).volunteeredHours;
    expect(liveHours, 'the probe event credited nothing').toBeGreaterThanOrEqual(7);
    expect(before.stats.record.hoursCredited).toBe(liveHours);
  });

  it('drops out of the dashboard total, which already applied the rule', async () => {
    const after = await me();
    const wasLive = (before.me.user ?? before.me).volunteeredHours;
    expect(after.volunteeredHours).toBe(wasLive - 7);
  });

  it('drops out of record.hoursCredited', async () => {
    const after = await stats();
    expect(after.record.hoursCredited).toBe(before.stats.record.hoursCredited - 7);
  });

  /**
   * ── The one figure that deliberately still counts it ──
   *
   * `milestones` comes from `milestoneInputs`, which does NOT exclude a
   * cancelled event. That is a recorded owner decision —
   * `volunteerInsights.test.js`, "counts a cancelled event, because the service
   * still happened", explicitly "deliberately different from
   * `volunteerStats().eventsAttended`" — so it is left alone and asserted as-is
   * rather than quietly brought into line.
   *
   * It is flagged in the audit ledger as the open question it is: a milestone
   * is recomputed on every read, so unlike a streak badge or an issued
   * certificate it is not actually protected from changing, and a student can
   * still see a tier beside an hours total that no longer supports it. Which of
   * the two should move is a product decision, not an implementation one.
   */
  it('still counts towards the milestone ladder, by recorded decision', async () => {
    const after = await stats();
    expect(after.milestones).toEqual(before.stats.milestones);
  });

  it('stops counting towards shiftsWorked, beside the total that excludes it', async () => {
    const after = await stats();
    expect(after.record.shiftsWorked).toBe(before.stats.record.shiftsWorked - 1);
  });

  it('leaves the monthly chart agreeing with the total above it', async () => {
    const after = await stats();
    const sum = (b) => b.monthlyHours.reduce((t, m) => t + m.hours, 0);
    expect(sum(after)).toBe(sum(before.stats) - 7);
  });

  it('stops counting towards the profile total', async () => {
    /* `stats.hours` on the public profile, which is the number a reader takes
       as this student's service record. */
    const after = await profile();
    expect(after.stats.hours).toBe(before.profile.stats.hours - 7);
  });

  it('stops counting towards the profile event and shift counts', async () => {
    const after = await profile();
    expect(after.stats.eventsCompleted).toBe(before.profile.stats.eventsCompleted - 1);
    expect(after.stats.shiftsCompleted).toBe(before.profile.stats.shiftsCompleted - 1);
  });

  it('keeps the profile total and its itemised list in agreement', async () => {
    /**
     * The clearest user-visible form of the defect. `completed[]` carries
     * `AND e.status <> 'cancelled'` and its comment says "Same rule as
     * volunteerStats.hoursCredited"; `stats.hours` did not. So the page could
     * show hours beside an empty list of the events that produced them.
     */
    const after = await profile();
    const itemised = after.completed.reduce((t, r) => t + Number(r.hours_awarded || 0), 0);
    expect(after.stats.hours).toBe(itemised);
  });

  it('stops counting towards hours-by-category', async () => {
    const after = await profile();
    const total = (b) => b.byCategory.reduce((t, c) => t + Number(c.hours || 0), 0);
    expect(total(after)).toBe(total(before.profile) - 7);
  });

  it('stops being the date this student last volunteered', async () => {
    /* Read on a public profile as evidence that somebody is still active —
       `lastVolunteeredAt`'s own comment says "evidence nobody checked is not
       evidence", and a called-off event is exactly that. */
    const after = await stats();
    expect(after.record.lastVolunteeredAt).not.toBe(before.stats.record.lastVolunteeredAt);
  });

  it('stops being the date they first volunteered', async () => {
    const after = await stats();
    expect(after.record.firstVolunteeredAt).not.toBe(before.stats.record.firstVolunteeredAt);
  });

  it('stops counting towards the kinds of service served in', async () => {
    const after = await stats();
    expect(after.record.kindsOfService).toBe(before.stats.record.kindsOfService - 1);
  });

  /**
   * Badges are a TOTAL here, not a permanent recognition.
   *
   * `evaluateBadges` withdraws an automatic award when it is no longer earned,
   * and the hour tiers are automatic — so an hour badge tracks current credited
   * hours by design, unlike a streak badge, which is deliberately awarded on
   * the LONGEST run and can never be withdrawn. `collectStats` was the last
   * query in that file still counting a cancelled event, so a badge could be
   * held on hours `record.hoursCredited` reports as zero.
   */
  it('stops counting towards the hours behind an hour badge', async () => {
    const { badgeService } = await import('./services/badgeService.js');
    const stats = await badgeService.collectStats(userId);
    const itemised = (await profile()).completed
      .reduce((t, r) => t + Number(r.hours_awarded || 0), 0);
    expect(stats.totalHours).toBe(itemised);
  });

  it('stops counting towards the events behind an events badge', async () => {
    const { badgeService } = await import('./services/badgeService.js');
    const stats = await badgeService.collectStats(userId);
    expect(stats.eventsAttended).toBe((await profile()).stats.eventsCompleted);
  });
});
