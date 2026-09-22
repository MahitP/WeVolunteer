import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * What a cancelled event is evidence OF, and when badges are told.
 *
 * ── The state this replaces ──
 *
 * `collectStats` excludes cancelled events from a volunteer's hours and event
 * counts — a deliberate, documented decision: "an hour badge could be earned on
 * hours `record.hoursCredited` reports as zero … the profile and the badge must
 * not disagree about the same word."
 *
 * Cancelling an event applied that rule to nobody. `PATCH /api/events/:id/status`
 * re-evaluated `event.organizer_id` and no attendee, so a volunteer kept an hours
 * badge the evaluator would no longer award — until some unrelated action of
 * their own triggered a re-evaluation, which might be next week or never. Two
 * students with identical records could hold different badges depending on
 * whether they happened to volunteer again. That is not grandfathering; it is
 * the outcome depending on timing nobody chose.
 *
 * ── Why immediate, rather than leaving the badge alone ──
 *
 * The repository already argues this, on the organizer half of this very route:
 * "the criterion is the current count of non-cancelled events, so a badge that
 * only ever moves upwards is not reporting that count. Without it, awarding on
 * creation would introduce a staleness that did not exist before." The volunteer
 * half is the same argument about the same route.
 *
 * It is also what makes the profile coherent after owner decision 3. Milestones
 * are derived, so the hours tiers drop the moment an event is cancelled; a badge
 * that did not would leave the same page showing "25 Hours" earned beside a
 * 25-hour milestone unearned.
 *
 * ── The conflict, and how it resolves ──
 *
 * The abuse review records the principle that a student must not be "penalis[ed]
 * for somebody else's cancellation". That is scoped to the Auto Select draw, and
 * it cannot be stretched past the frozen decision that credited hours exclude
 * cancelled events — the transcript already drops those hours. Given that, the
 * badge is being made to agree with the record rather than given a new penalty.
 *
 * What the principle does buy is the pairing below: the loss is never silent.
 * It is audited, with the actor who cancelled, exactly as a manual revocation
 * is.
 *
 * Decided during the 2026-09-21 audit (owner decisions 5A and 5B).
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';

describe('badges when an event is cancelled', () => {
  let srv, db, badgeService, organizer, organizerId, studentId;
  let n = 0;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    ({ badgeService } = await import('./services/badgeService.js'));
    organizer = await srv.login(ORGANIZER);
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(ORGANIZER)).id;
    studentId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(STUDENT)).id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /** An open event with `hours` of credited attendance for `studentId`. */
  const creditedEvent = async (hours) => {
    n += 1;
    const eventId = `evt-badge-cancel-${n}`;
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location,
                          application_deadline, organizer_id, status, created_at)
      VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, 'open', ?)
    `).run(eventId, `Badge fixture ${n}`, 'Synthetic fixture.', 'Springfield',
      '2026-07-20T00:00:00.000Z', organizerId, '2026-07-01T00:00:00.000Z');
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Afternoon', 'Synthetic fixture.', ?, ?, 20)
    `).run(`slot-badge-cancel-${n}`, eventId, '2026-07-23T13:00:00.000Z', '2026-07-23T17:00:00.000Z');
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, ?, ?, 1, ?)
    `).run(eventId, `slot-badge-cancel-${n}`, studentId, hours);
    return eventId;
  };

  /** A fresh account, so a fixture cannot inherit the seed's history. */
  const makeStudent = async (suffix) => {
    const id = `user-cancel-badge-${suffix}`;
    await db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, created_at)
      SELECT ?, ?, ?, ?, password_hash, '11', 'student', 1, ?
      FROM users WHERE id = 'user-student-1'
    `).run(id, `Cancel Badge ${suffix}`, `cancel.badge.${suffix}@example.com`,
      `cancelbadge${suffix}`, '2026-01-01T00:00:00.000Z');
    return id;
  };

  /** An accepted commitment that ended in the past, with a recorded outcome. */
  const commitment = async (userId, suffix, { present, endsAt, status = 'open' }) => {
    const eventId = `evt-rel-${suffix}`;
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location,
                          application_deadline, organizer_id, status, created_at)
      VALUES (?, ?, ?, 'Donation Drive', ?, ?, ?, ?, ?)
    `).run(eventId, `Reliability fixture ${suffix}`, 'Synthetic fixture.', 'Springfield',
      '2026-01-02T00:00:00.000Z', organizerId, status, '2026-01-01T00:00:00.000Z');
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Shift', 'Synthetic fixture.', ?, ?, 20)
    `).run(`slot-rel-${suffix}`, eventId, endsAt, endsAt);
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'accepted', ?)
    `).run(`app-rel-${suffix}`, userId, eventId, `slot-rel-${suffix}`, '2026-01-01T00:00:00.000Z');
    await db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?, ?, ?, ?, 1)
    `).run(eventId, `slot-rel-${suffix}`, userId, present);
    return eventId;
  };

  const holds = async (name) => Boolean(await db.prepare(`
    SELECT 1 AS x FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ? AND b.name = ?
  `).get(studentId, name));

  const auditRows = async (action) => db.prepare(
    'SELECT * FROM admin_audit_logs WHERE action = ? AND target_user_id = ? ORDER BY created_at DESC'
  ).all(action, studentId);

  const cancel = (eventId) =>
    srv.call('PATCH', `/api/events/${eventId}/status`, { status: 'cancelled' }, organizer);

  it('withdraws an hours badge the cancelled event was holding up', async () => {
    /* 500 hours is the top seeded tier, so no other fixture can be propping it
       up and the case cannot pass by accident. */
    const eventId = await creditedEvent(500);
    await badgeService.evaluateBadges(studentId);
    expect(await holds('500 Hours'), 'the fixture never earned the badge').toBe(true);

    const res = await cancel(eventId);
    expect(res.status).toBe(200);

    expect(
      await holds('500 Hours'),
      'the badge outlived the evidence, until some unrelated action happened to re-evaluate it'
    ).toBe(false);
  });

  it('records the withdrawal, with the person who caused it', async () => {
    const eventId = await creditedEvent(500);
    await badgeService.evaluateBadges(studentId);
    expect(await holds('500 Hours')).toBe(true);

    const before = (await auditRows('BADGE_WITHDRAWN')).length;
    await cancel(eventId);
    const after = await auditRows('BADGE_WITHDRAWN');

    /* Counted as "more than before" rather than "one more": dropping below the
       top tier drops every tier under it, and each withdrawal is its own row —
       which is what an audit trail should say. */
    expect(after.length, 'a badge disappeared with no record of why')
      .toBeGreaterThan(before);
    const row = after.find(r => /500 Hours/.test(r.details));
    expect(row, 'the withdrawal of the badge under test was not recorded').toBeTruthy();
    expect(row.admin_id, 'the record does not say who caused it').toBe(organizerId);
    expect(row.details).toMatch(/automatically/);
  });

  it('does not notify the volunteer, matching a manual revocation', async () => {
    /* The only existing path that takes a badge away — `DELETE
       /api/admin/users/:userId/badges/:badgeId` — audits and does not notify.
       This follows it rather than inventing a BADGE_LOST kind. */
    const eventId = await creditedEvent(500);
    await badgeService.evaluateBadges(studentId);

    const before = (await db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'VOLUNTEER'"
    ).get(studentId)).n;
    await cancel(eventId);
    const after = (await db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'VOLUNTEER'"
    ).get(studentId)).n;

    expect(after).toBe(before);
  });

  it('gives the badge back if the event is reinstated', async () => {
    /* `cancelled -> open` is a legal transition; only a completed event refuses
       one. A re-evaluation that only ever removed would be the same
       one-directional fault in the other direction. */
    const eventId = await creditedEvent(500);
    await badgeService.evaluateBadges(studentId);
    await cancel(eventId);
    expect(await holds('500 Hours')).toBe(false);

    const res = await srv.call('PATCH', `/api/events/${eventId}/status`, { status: 'open' }, organizer);
    expect(res.status).toBe(200);
    expect(await holds('500 Hours')).toBe(true);
  });

  /**
   * Last, deliberately. It re-stamps the badge as a hand grant, and a hand
   * grant is never withdrawn automatically — so any case declared after this
   * one would be testing against a badge that can no longer move.
   */
  it('never touches a badge an administrator granted by hand', async () => {
    const eventId = await creditedEvent(500);
    await badgeService.evaluateBadges(studentId);
    /* Re-stamp the automatic award as a hand grant; `evaluateBadges` withdraws
       only `awarded_by IS NULL`, and that rule is not this decision's to move. */
    await db.prepare(`
      UPDATE user_badges SET awarded_by = ?
      WHERE user_id = ? AND badge_id = (SELECT id FROM badges WHERE name = '500 Hours')
    `).run(organizerId, studentId);

    await cancel(eventId);
    expect(await holds('500 Hours')).toBe(true);
  });

  it('still re-evaluates the organizer, which is what it already did', async () => {
    /* The half that was already right must not be lost while adding the other.
       `events_created` counts non-cancelled events, so cancelling one moves the
       organizer's own count. */
    const eventId = await creditedEvent(1);
    const countBefore = (await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE organizer_id = ? AND status != 'cancelled'"
    ).get(organizerId)).n;
    await cancel(eventId);
    const countAfter = (await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE organizer_id = ? AND status != 'cancelled'"
    ).get(organizerId)).n;
    expect(countAfter).toBe(countBefore - 1);

    /* The organizer still holds Organizer, because one cancellation does not
       take them under the threshold — the assertion that matters is that the
       call still happens, which the fixture above would break if it did not. */
    const org = (await db.prepare(`
      SELECT 1 AS x FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
      WHERE ub.user_id = ? AND b.name = 'Organizer'
    `).get(organizerId));
    expect(Boolean(org)).toBe(true);
  });

  /**
   * The absentee is affected too, and was not re-evaluated.
   *
   * ── The gap ──
   *
   * The trigger selected `present = 1`, which is the right set for the hours
   * and events criteria: those are the people the event contributed a figure
   * for. It is the wrong set for RELIABILITY. `reliabilityOf`'s query is over
   * ACCEPTED APPLICATIONS left-joined to attendance and excludes cancelled
   * events, so cancelling removes the commitment from the denominator for
   * everyone who was accepted — including somebody marked absent, whose rate
   * therefore RISES.
   *
   * So a volunteer held under the Reliable Volunteer threshold by one absence
   * at an event that was then called off stayed under it, until some unrelated
   * action of their own re-evaluated them. That is the same staleness owner
   * decision 5A removed for the hours criteria, left behind on the one
   * criterion where the affected set is different — and it fails in the
   * direction of withholding recognition the volunteer has earned.
   *
   * Found by the post-implementation audit of owner decision 5A.
   */
  describe('and the people who were marked absent', () => {
    it('re-evaluates an absentee whose rate the cancellation raises', async () => {
      const student = await makeStudent('absent');

      /* Four commitments kept, which clears the smoothed threshold on its own,
         and one missed, which drops it under. Recency-weighted, so the missed
         one is stamped most recent to carry full weight. */
      await commitment(student, 'k1', { present: 1, endsAt: '2026-02-01T17:00:00.000Z' });
      await commitment(student, 'k2', { present: 1, endsAt: '2026-02-08T17:00:00.000Z' });
      await commitment(student, 'k3', { present: 1, endsAt: '2026-02-15T17:00:00.000Z' });
      await commitment(student, 'k4', { present: 1, endsAt: '2026-02-22T17:00:00.000Z' });
      const missedId = await commitment(student, 'miss', {
        present: 0, endsAt: '2026-03-01T17:00:00.000Z',
      });

      await badgeService.evaluateBadges(student);
      const held = async () => Boolean(await db.prepare(`
        SELECT 1 AS x FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id = ? AND b.name = 'Reliable Volunteer'
      `).get(student));
      expect(held(), 'the fixture did not hold the badge back').resolves.toBe(false);

      const res = await srv.call(
        'PATCH', `/api/events/${missedId}/status`, { status: 'cancelled' }, organizer,
      );
      expect(res.status).toBe(200);

      expect(
        await held(),
        'the absence stopped counting against them and nothing re-evaluated the badge'
      ).toBe(true);
    });
  });
});
