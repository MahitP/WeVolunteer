import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';

/**
 * When badge eligibility is actually evaluated.
 *
 * ── The defect ──
 *
 * `evaluateBadges` had exactly two production callers, both in
 * `POST /api/events/:id/attendance`, and both for the VOLUNTEER whose
 * attendance had just been marked. Nothing else on the platform ever asked.
 *
 * Two criteria do not depend on attendance at all:
 *
 *   events_created  Organizer (>= 1), Community Builder (>= 10) — an
 *                   organizer's own activity
 *   early_adopter   Early Supporter — decided by `joinRank`, fixed at signup
 *
 * Measured before the fix: an organizer with **twelve** non-cancelled events
 * and no volunteering of their own held **zero** badges. The moment that same
 * account was credited as a volunteer at somebody else's event, all three
 * arrived at once. A student at `joinRank` 17 who never volunteered held no
 * Early Supporter badge either.
 *
 * So the badges were not unearnable in the abstract — they were reachable only
 * through an unrelated action, and unreachable for anybody who never performs
 * it. `badgeService` already describes that exact state as the bug it fixed
 * once before: the `early_adopter` branch used to be empty, leaving the badge
 * "unearnable by every code path in the application — it sat in the catalogue
 * looking like something to aim for". The evaluator was fixed; the trigger was
 * not.
 *
 * ── Why the trigger is creation, not completion ──
 *
 * `collectStats` counts `status != 'cancelled'` rather than `completed`, and
 * says why: requiring completion would mean an organizer "could not earn the
 * Organizer badge for creating an opportunity until that opportunity had
 * already finished — which is not what it says, and is not when the
 * recognition is worth anything."
 */
describe('badge evaluation runs when eligibility is actually reached', () => {
  let srv, db, organizer, organizerId;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    organizer = await srv.login('jordan.whitfield@example.org');
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?')
      .get('jordan.whitfield@example.org')).id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const badgeNames = async (userId) => (await db.prepare(`
    SELECT b.name FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ? ORDER BY b.name`).all(userId)).map(r => r.name);

  const earnedAt = async (userId, name) => (await db.prepare(`
    SELECT ub.earned_at FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ? AND b.name = ?`).get(userId, name))?.earned_at ?? null;

  /** A fresh organizer with no history of any kind. */
  async function freshOrganizer() {
    const id = `user-bt-${Math.random().toString(36).slice(2)}`;
    await db.prepare(`INSERT INTO users (id, name, email, password_hash, grade, role, verified, created_at)
      VALUES (?, ?, ?, 'x', 'Adult', 'organizer', 1, ?)`)
      .run(id, 'Badge Trigger Org', `${id}@example.org`, new Date().toISOString());
    expect(await badgeNames(id), 'the fixture starts with badges').toEqual([]);
    return id;
  }

  /** Creates one event through the real endpoint, as `who`. */
  async function createEvent(who, n = 0) {
    const iso = (mins) => new Date(Date.now() + mins * 60000).toISOString();
    const res = await srv.call('POST', '/api/events', {
      title: `Trigger Event ${n} ${Math.random().toString(36).slice(2)}`,
      description: 'd', category: 'Other', location: 'Reichler Park',
      applicationDeadline: iso(60 * 24 * 2),
      slots: [{ name: 'Shift', description: 'd', startDatetime: iso(60 * 24 * 5),
        endDatetime: iso(60 * 24 * 5 + 120), maxSpots: 4 }],
    }, who);
    expect(res.status, `event ${n} was not created`).toBe(201);
    return res.body?.event?.id ?? res.body?.id;
  }

  describe('an organizer creating opportunities', () => {
    it('earns Organizer on the first one, without volunteering for anything', async () => {
      const host = await srv.login('jordan.whitfield@example.org');
      const id = await freshOrganizer();
      /* The fixture organizer cannot call the API (no password), so the event
         is created by the seeded host and re-attributed — the trigger is about
         whose count changed, which is what this asserts. */
      const eventId = await createEvent(host, 1);
      await db.prepare('UPDATE events SET organizer_id = ? WHERE id = ?').run(id, eventId);

      const { badgeService } = await import('./services/badgeService.js');
      await badgeService.evaluateBadges(id);
      expect(await badgeNames(id)).toContain('Organizer');
    });

    it('earns Organizer through the create endpoint itself', async () => {
      /* The regression that matters: the production path, with no attendance
         anywhere and nothing else calling the evaluator. */
      const before = await badgeNames(organizerId);
      await db.prepare('DELETE FROM user_badges WHERE user_id = ?').run(organizerId);

      await createEvent(organizer, 2);

      const after = await badgeNames(organizerId);
      expect(after, 'creating an event evaluated nothing').toContain('Organizer');
      expect(before.length).toBeGreaterThanOrEqual(0);
    });

    it('earns Community Builder once ten stand', async () => {
      const count = (await db.prepare(
        "SELECT COUNT(*) n FROM events WHERE organizer_id = ? AND status != 'cancelled'"
      ).get(organizerId)).n;
      for (let i = count; i < 10; i++) await createEvent(organizer, 100 + i);

      expect(await badgeNames(organizerId)).toContain('Community Builder');
    }, 60000);

    it('evaluates on duplicate too, which is the other way an event appears', async () => {
      const eventId = await createEvent(organizer, 3);
      await db.prepare('DELETE FROM user_badges WHERE user_id = ?').run(organizerId);

      const res = await srv.call('POST', `/api/events/${eventId}/duplicate`, {}, organizer);
      expect(res.status).toBe(201);

      expect(await badgeNames(organizerId)).toContain('Organizer');
    });
  });

  describe('a new account in the early cohort', () => {
    it('earns Early Supporter at signup, not at its first shift', async () => {
      const email = `early.${Math.random().toString(36).slice(2)}@example.org`;
      const res = await srv.call('POST', '/api/auth/signup', {
        ...TEST_SIGNUP_DEFAULTS, email, password: 'Password123',
        name: 'Early Cohort', role: 'student', grade: '10',
        username: `early_${Math.random().toString(36).slice(2, 8)}`,
      });
      expect(res.status, 'the signup fixture failed').toBe(201);

      const id = (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
      expect(await badgeNames(id), 'signup evaluated nothing').toContain('Early Supporter');
    });

    it('dates it at the moment the account joined, within a second', async () => {
      /* The criterion is `joinRank`, which is fixed the instant the row exists.
         Awarding later would date the badge to whenever the holder happened to
         volunteer — which for somebody who never does is never. */
      const email = `early.${Math.random().toString(36).slice(2)}@example.org`;
      await srv.call('POST', '/api/auth/signup', {
        ...TEST_SIGNUP_DEFAULTS, email, password: 'Password123',
        name: 'Early Cohort Two', role: 'student', grade: '10',
        username: `early_${Math.random().toString(36).slice(2, 8)}`,
      });
      const row = await db.prepare('SELECT id, created_at FROM users WHERE email = ?').get(email);
      const awarded = await earnedAt(row.id, 'Early Supporter');

      expect(awarded).toBeTruthy();
      expect(Math.abs(new Date(awarded) - new Date(row.created_at))).toBeLessThan(1000);
    });
  });

  describe('and when the count falls again', () => {
    it('withdraws Community Builder once fewer than ten stand', async () => {
      /**
       * The mirror of the award, and it has to exist for the same reason the
       * attendance route evaluates on the way DOWN as well as up: the criterion
       * is the current count of non-cancelled events, so a badge that only ever
       * moves upwards is not reporting that count.
       *
       * Without it, awarding on creation would introduce a staleness that did
       * not exist before — the badge was previously unreachable, so it could
       * not be stale.
       */
      const host = await srv.login('jordan.whitfield@example.org');
      const ids = [];
      for (let i = 0; i < 10; i++) ids.push(await createEvent(host, 300 + i));
      expect(await badgeNames(organizerId)).toContain('Community Builder');

      /* Cancel until fewer than ten stand. A completed event refuses a status
         change, so the loop skips those and keeps going rather than assuming a
         fixed number will move. */
      const standing = (await db.prepare(
        "SELECT id, status FROM events WHERE organizer_id = ? AND status != 'cancelled'"
      ).all(organizerId));
      const countLeft = async () => (await db.prepare(
        "SELECT COUNT(*) n FROM events WHERE organizer_id = ? AND status != 'cancelled'"
      ).get(organizerId)).n;

      for (const row of standing) {
        if (await countLeft() < 10) break;
        if (row.status === 'completed') continue;
        await srv.call('PATCH', `/api/events/${row.id}/status`, { status: 'cancelled' }, host);
      }

      const left = await countLeft();
      expect(left, 'the fixture could not drop below ten; the case would prove nothing')
        .toBeLessThan(10);
      expect(await badgeNames(organizerId)).not.toContain('Community Builder');
    }, 90000);
  });

  describe('what must not change', () => {
    it('still evaluates a volunteer when their attendance is finalised', async () => {
      const tag = Math.random().toString(36).slice(2);
      const eventId = `event-${tag}`;
      const slotId = `slot-${tag}`;
      const appId = `app-${tag}`;
      const studentId = (await db.prepare('SELECT id FROM users WHERE email = ?')
        .get('leo.chen@example.com')).id;
      const start = new Date(Date.now() - 3 * 86400000);
      const end = new Date(start.getTime() + 4 * 3600000);

      await db.prepare(`INSERT INTO events (id, title, description, category, location,
        organizer_id, status, created_at, application_deadline)
        VALUES (?, ?, 'd', 'Other', 'Park', ?, 'open', ?, ?)`)
        .run(eventId, `Keep ${tag}`, organizerId, start.toISOString(), start.toISOString());
      await db.prepare(`INSERT INTO slots (id, event_id, name, description,
        start_datetime, end_datetime, max_spots) VALUES (?, ?, 'Shift', 'd', ?, ?, 4)`)
        .run(slotId, eventId, start.toISOString(), end.toISOString());
      await db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
        VALUES (?, ?, ?, ?, 'accepted', ?)`)
        .run(appId, studentId, eventId, slotId, start.toISOString());

      await db.prepare('DELETE FROM user_badges WHERE user_id = ?').run(studentId);
      const res = await srv.call('POST', `/api/events/${eventId}/attendance`,
        { attendanceMap: { [appId]: true } }, organizer);
      expect(res.status).toBe(200);

      expect(await badgeNames(studentId), 'finalisation stopped evaluating').not.toEqual([]);
    });
  });
});
