import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Badges: what earns one, what takes one away, and who may do either by hand.
 *
 * ── Why this file exists ──
 *
 * There were ZERO tests over badges or milestones. The feature shipped with two
 * competing achievement systems rendering on the same profile page, a criteria
 * type (`early_adopter`) whose evaluation branch was empty so the seeded "Early
 * Supporter" badge was unearnable by any code path, an `events_attended` counter
 * that counted SHIFTS, an unvalidated `criteria_type` on the admin create route
 * (a typo produced a badge nobody could ever earn), no revocation of any kind,
 * and a manual award that wrote no audit row. Every one of those is the sort of
 * defect a green suite cannot see, because nothing was asserting anything.
 *
 * The cases below are grouped by the defect they pin, and each group names it.
 */

let srv;
let db;
let badgeService;
let BADGE_CRITERIA_TYPES;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ badgeService, BADGE_CRITERIA_TYPES } = await import('./services/badgeService.js'));
});
afterAll(async () => { await srv.close(); });

const ORGANIZER = 'user-org-1';

let seq = 0;

/** A badge definition nobody else's fixtures can collide with. */
async function makeBadge(over = {}) {
  const n = ++seq;
  const id = `badge-fixture-${n}`;
  await db.prepare(`
    INSERT INTO badges (id, name, description, icon, category, criteria_type, criteria_value, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    over.name ?? `Fixture badge ${n}`,
    over.description ?? 'A badge used by the test suite.',
    over.icon ?? '🏅',
    over.category ?? 'Fixture',
    over.criteria_type ?? 'hours',
    over.criteria_value ?? 5,
    over.active === undefined ? 1 : over.active,
    new Date().toISOString()
  );
  return id;
}

/**
 * A volunteer with a service record entirely under this file's control.
 *
 * The demo seed already credits hours to several students, so asserting "5 hours
 * earns this badge" against a seeded account would be asserting against a
 * fixture that moves.
 */
async function makeAccount(suffix, role = 'student', createdAt = new Date().toISOString()) {
  const id = `user-badge-${suffix}`;
  await db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, created_at)
    SELECT ?, ?, ?, ?, password_hash, '11', ?, 1, ?
    FROM users WHERE id = 'user-student-1'
  `).run(id, `Badge Tester ${suffix}`, `badge.${suffix}@example.com`, `badge${suffix}`, role, createdAt);
  return id;
}

const makeVolunteer = async (suffix, createdAt) => await makeAccount(suffix, 'student', createdAt);

/** An event with `slots` shifts on it, hosted by the seeded organizer. */
/**
 * @param {string} [endsAt] when the shifts finished, ISO. Defaults to now.
 *   Reliability is recency-weighted, so a fixture that stamps every slot with
 *   the same instant cannot express "recently" at all — which is why the
 *   attendance-rate tests below pass one.
 */
async function makeEvent(suffix, slots = 1, status = 'open', organizerId = ORGANIZER, endsAt = null) {
  const eventId = `event-badge-${suffix}`;
  const now = new Date().toISOString();
  const when = endsAt ?? now;
  await db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, created_at)
    VALUES (?, ?, 'Fixture', 'Other', 'Somewhere', ?, ?, ?, ?)
  `).run(eventId, `Badge fixture ${suffix}`, now, organizerId, status, now);

  const slotIds = [];
  for (let i = 0; i < slots; i += 1) {
    const slotId = `${eventId}-slot-${i}`;
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, ?, 'Fixture', ?, ?, 10)
    `).run(slotId, eventId, `Shift ${i + 1}`, when, when);
    slotIds.push(slotId);
  }
  return { eventId, slotIds };
}

/**
 * Writes the attendance row that IS the credit — hours are derived from it.
 *
 * Also writes the accepted application behind it. In production an attendance
 * row cannot exist without one: `finalizeAttendance` and `recordCheckins` are
 * both keyed by application id. A fixture with attendance and no application
 * described a state the product cannot reach, and it hid the fact that
 * reliability is a question about COMMITMENTS — which is what an accepted
 * application is — rather than about attendance rows.
 */
async function credit(userId, eventId, slotId, hours, present = 1) {
  await db.prepare(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    VALUES (?, ?, ?, ?, 'accepted', ?)
    ON CONFLICT DO NOTHING
  `).run(`app-${slotId}-${userId}`, userId, eventId, slotId, new Date(0).toISOString());

  await db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slot_id, user_id) DO UPDATE SET present = excluded.present, hours_awarded = excluded.hours_awarded
  `).run(eventId, slotId, userId, present ? 1 : 0, hours);
}

const holds = async (userId, badgeId) =>
  !!await db.prepare('SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?').get(userId, badgeId);

// ── The criteria vocabulary ────────────────────────────────────────────────

describe('the criteria vocabulary has one definition', () => {
  it('exports the set the service actually implements', () => {
    expect(Array.isArray(BADGE_CRITERIA_TYPES)).toBe(true);
    expect(BADGE_CRITERIA_TYPES).toEqual(expect.arrayContaining([
      'hours', 'events_attended', 'events_created', 'attendance_rate', 'early_adopter', 'manual'
    ]));
  });

  it('every seeded catalogue entry names a type the service implements', async () => {
    // The seeded catalogue is the one set of definitions no administrator chose,
    // so an unimplemented type there is a badge the product itself made unearnable.
    const unknown = (await db.prepare('SELECT DISTINCT criteria_type FROM badges').all())
      .map(r => r.criteria_type)
      .filter(t => !BADGE_CRITERIA_TYPES.includes(t));
    expect(unknown).toEqual([]);
  });
});

// ── Defect: awarding, and the UNIQUE(user_id, badge_id) constraint ─────────

describe('awarding at a threshold', () => {
  it('awards once the credited hours reach the threshold, and not before', async () => {
    const user = await makeVolunteer('threshold');
    const badge = await makeBadge({ criteria_type: 'hours', criteria_value: 5 });
    const { eventId, slotIds } = await makeEvent('threshold', 2);

    await credit(user, eventId, slotIds[0], 4);
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge), '4 hours must not earn a 5-hour badge').toBe(false);

    await credit(user, eventId, slotIds[1], 1);
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(true);
  });

  it('counts only hours actually credited — an absence is worth nothing', async () => {
    const user = await makeVolunteer('absent');
    const badge = await makeBadge({ criteria_type: 'hours', criteria_value: 3 });
    const { eventId, slotIds } = await makeEvent('absent', 1);

    await credit(user, eventId, slotIds[0], 8, /* present */ 0);
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(false);
  });

  it('never awards the same badge twice, however many times it is evaluated', async () => {
    const user = await makeVolunteer('idempotent');
    const badge = await makeBadge({ criteria_type: 'hours', criteria_value: 1 });
    const { eventId, slotIds } = await makeEvent('idempotent', 1);
    await credit(user, eventId, slotIds[0], 6);

    await badgeService.evaluateBadges(user);
    await badgeService.evaluateBadges(user);
    await badgeService.evaluateBadges(user);

    const count = (await db.prepare('SELECT COUNT(*) as c FROM user_badges WHERE user_id = ? AND badge_id = ?')
      .get(user, badge)).c;
    expect(count).toBe(1);
  });

  it('leaves an inactive badge unawarded', async () => {
    const user = await makeVolunteer('inactive');
    const badge = await makeBadge({ criteria_type: 'hours', criteria_value: 1, active: 0 });
    const { eventId, slotIds } = await makeEvent('inactive', 1);
    await credit(user, eventId, slotIds[0], 9);

    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(false);
  });
});

// ── Defect: events_attended counted SHIFTS, not events ─────────────────────

describe('events_attended counts events, not shifts', () => {
  it('two shifts at one event are one event', async () => {
    const user = await makeVolunteer('shifts');
    const oneEvent = await makeBadge({ criteria_type: 'events_attended', criteria_value: 1 });
    const twoEvents = await makeBadge({ criteria_type: 'events_attended', criteria_value: 2 });
    const { eventId, slotIds } = await makeEvent('shifts', 2);

    await credit(user, eventId, slotIds[0], 2);
    await credit(user, eventId, slotIds[1], 2);
    await badgeService.evaluateBadges(user);

    expect(await holds(user, oneEvent), 'one event attended').toBe(true);
    expect(
      await holds(user, twoEvents),
      'two shifts at ONE event are not two events — this is the COUNT(at.id) bug'
    ).toBe(false);

    const second = await makeEvent('shifts-2', 1);
    await credit(user, second.eventId, second.slotIds[0], 2);
    await badgeService.evaluateBadges(user);
    expect(await holds(user, twoEvents)).toBe(true);
  });

  it('agrees with the eventsCompleted figure the profile route derives', async () => {
    const token = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', '/api/users/user-badge-shifts/profile', undefined, token);
    expect(res.status).toBe(200);
    // Two events, three shifts. The badge service and the profile route must not
    // disagree about which number "events attended" means.
    expect(res.body.stats.eventsCompleted).toBe(2);
    expect(res.body.stats.shiftsCompleted).toBe(3);
    expect((await badgeService.collectStats('user-badge-shifts')).eventsAttended).toBe(2);
  });
});

// ── Defect: `early_adopter` was an empty switch branch ─────────────────────

describe('early_adopter is earnable', () => {
  it('awards a badge to an account inside the early cohort', async () => {
    const user = await makeVolunteer('early');
    const badge = await makeBadge({ criteria_type: 'early_adopter', criteria_value: 100000 });
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(true);
  });

  it('fails closed on the seeded criteria_value of 0 rather than awarding everybody', async () => {
    const user = await makeVolunteer('early-zero');
    const badge = await makeBadge({ criteria_type: 'early_adopter', criteria_value: 0 });
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(false);
  });

  it('excludes an account that joined after the cohort closed', async () => {
    const user = await makeVolunteer('late', '2999-01-01T00:00:00.000Z');
    const badge = await makeBadge({ criteria_type: 'early_adopter', criteria_value: 2 });
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(false);
  });
});

// ── attendance_rate and events_created ─────────────────────────────────────

describe('the remaining automatic criteria', () => {
  it('needs a floor of completed commitments before an attendance rate means anything', async () => {
    /**
     * Counted in EVENTS, not shifts.
     *
     * This fixture used to credit five slots of ONE day-long event and expect
     * the badge, which measured reliability in shifts. That is the denominator
     * Auto Select never used: turning up once to an event with five slots is a
     * single demonstration that somebody turns up, and counting it as five is
     * how a volunteer earns a reliability badge from one afternoon. The
     * canonical model collapses an event with `MAX(present)`, so the fixture
     * now spans separate events — which is what "five sign-ups" has to mean
     * for the badge to say anything.
     */
    const user = await makeVolunteer('rate');
    const badge = await makeBadge({ criteria_type: 'attendance_rate', criteria_value: 90 });
    /* A loop rather than `Array.from(…, () => makeEvent(…))`: the mapper would
       collect five promises rather than five events once `makeEvent` writes
       through an async handle, and `events[0].eventId` would be undefined. */
    const events = [];
    for (let i = 0; i < 5; i += 1) events.push(await makeEvent(`rate-${i}`, 1));

    // Perfect record, but only two commitments: 100% of nothing much.
    await credit(user, events[0].eventId, events[0].slotIds[0], 1);
    await credit(user, events[1].eventId, events[1].slotIds[0], 1);
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(false);

    await credit(user, events[2].eventId, events[2].slotIds[0], 1);
    await credit(user, events[3].eventId, events[3].slotIds[0], 1);
    await credit(user, events[4].eventId, events[4].slotIds[0], 1);
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(true);
  });

  /**
   * The two cases that separate the canonical model from a raw ratio.
   *
   * Both are histories where the plain percentage and the recency-weighted
   * score point in OPPOSITE directions, so a badge computed either way gives a
   * different answer. They are the reason the model exists.
   */
  describe('recency, not just a ratio', () => {
    /** `n` completed commitments for `user`, oldest first, `misses` at the END (most recent). */
    const buildHistory = async (user, prefix, { attended, recentMisses }) => {
      const total = attended + recentMisses;
      for (let i = 0; i < total; i += 1) {
        /* Oldest first: index 0 is furthest back. */
        const daysAgo = (total - i) * 7;
        const endsAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
        const { eventId, slotIds } = await makeEvent(`${prefix}-${i}`, 1, 'open', ORGANIZER, endsAt);
        const present = i < attended ? 1 : 0;
        await credit(user, eventId, slotIds[0], 1, present);
      }
    };

    it('refuses a volunteer whose raw ratio clears 90% but whose recent record does not', async () => {
      /**
       * 40 attended, then 4 straight misses. Raw: 40/44 = 90.9%, which a plain
       * percentage awards. But the last four commitments were all missed, and
       * an organizer choosing who to give a place to this week is not helped by
       * a badge earned two years ago.
       */
      const user = await makeVolunteer('recent-decline');
      const badge = await makeBadge({ criteria_type: 'attendance_rate', criteria_value: 90 });
      await buildHistory(user, 'decline', { attended: 40, recentMisses: 4 });

      const stats = await badgeService.collectStats(user);
      expect(stats.reliability.attended / stats.reliability.recorded,
        'the fixture must clear 90% on a raw ratio, or this proves nothing')
        .toBeGreaterThan(0.9);

      await badgeService.evaluateBadges(user);
      expect(await holds(user, badge), `score=${stats.reliability.score}`).toBe(false);
    });

    it('awards a volunteer who recovered, whose raw ratio is well under 90%', async () => {
      /**
       * 6 misses, then 20 consecutive attendances. Raw: 20/26 = 76.9%, which a
       * plain percentage refuses for ever — there is no number of good months
       * that lifts it quickly. Recovery has to be something a volunteer can do.
       */
      const user = await makeVolunteer('recovered');
      const badge = await makeBadge({ criteria_type: 'attendance_rate', criteria_value: 90 });

      for (let i = 0; i < 26; i += 1) {
        const daysAgo = (26 - i) * 7;
        const endsAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
        const { eventId, slotIds } = await makeEvent(`recover-${i}`, 1, 'open', ORGANIZER, endsAt);
        await credit(user, eventId, slotIds[0], 1, i < 6 ? 0 : 1);
      }

      const stats = await badgeService.collectStats(user);
      expect(stats.reliability.attended / stats.reliability.recorded,
        'the fixture must FAIL a raw ratio, or this proves nothing')
        .toBeLessThan(0.9);

      await badgeService.evaluateBadges(user);
      expect(await holds(user, badge), `score=${stats.reliability.score}`).toBe(true);
    });
  });

  it('does not award a reliability badge for one event with many shifts', async () => {
    /* The other half of the grain rule, asserted directly: five slots of one
       event is one commitment, and one commitment is not evidence of a habit. */
    const user = await makeVolunteer('one-event-many-shifts');
    const badge = await makeBadge({ criteria_type: 'attendance_rate', criteria_value: 90 });
    const { eventId, slotIds } = await makeEvent('one-event-many-shifts', 6);

    for (const slotId of slotIds) await credit(user, eventId, slotId, 1);
    await badgeService.evaluateBadges(user);

    expect(await holds(user, badge)).toBe(false);
  });

  it('counts a live event towards events_created, not only a completed one', async () => {
    // The original query was `status IN ('published', 'completed')`, and
    // 'published' is not a value the events CHECK constraint permits — so the
    // "Organizer" badge could only ever be earned by an event that had already
    // finished. A fresh organizer with exactly one open event is what tells the
    // two queries apart; the seeded organizer already has completed events.
    const organizer = await makeAccount('organizer', 'organizer');
    const organizerBadge = await makeBadge({ criteria_type: 'events_created', criteria_value: 1 });

    await badgeService.evaluateBadges(organizer);
    expect(await holds(organizer, organizerBadge), 'no events yet').toBe(false);

    await makeEvent('created-open', 1, 'open', organizer);
    await badgeService.evaluateBadges(organizer);
    expect(await holds(organizer, organizerBadge)).toBe(true);
  });

  it('does not count a cancelled event towards events_created', async () => {
    const organizer = await makeAccount('organizer-cancelled', 'organizer');
    const organizerBadge = await makeBadge({ criteria_type: 'events_created', criteria_value: 1 });
    await makeEvent('created-cancelled', 1, 'cancelled', organizer);
    await badgeService.evaluateBadges(organizer);
    expect(await holds(organizer, organizerBadge)).toBe(false);
  });
});

// ── Defect: no revocation, of any kind ─────────────────────────────────────

describe('revocation', () => {
  it('withdraws an automatic badge when the hours behind it are revoked', async () => {
    const user = await makeVolunteer('revoked');
    const badge = await makeBadge({ criteria_type: 'hours', criteria_value: 4 });
    const { eventId, slotIds } = await makeEvent('revoked', 1);

    await credit(user, eventId, slotIds[0], 5);
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge)).toBe(true);

    // What `outcome.revoked` in attendanceRoutes does: the credit is taken back.
    await credit(user, eventId, slotIds[0], 0, /* present */ 0);
    await badgeService.evaluateBadges(user);
    expect(await holds(user, badge), 'a badge must not outlive the service it was awarded for').toBe(false);
  });

  it('never withdraws a badge a human awarded by hand', async () => {
    const user = await makeVolunteer('manual-keep');
    const badge = await makeBadge({ criteria_type: 'hours', criteria_value: 500 });
    await db.prepare(`
      INSERT INTO user_badges (id, user_id, badge_id, earned_at, awarded_by)
      VALUES (?, ?, ?, ?, 'user-admin')
    `).run('ub-manual-keep', user, badge, new Date().toISOString());

    await badgeService.evaluateBadges(user);
    expect(
      await holds(user, badge),
      'a manual award is a decision, not a query result — a sweep must not undo it'
    ).toBe(true);
  });
});

// ── The administrative routes ──────────────────────────────────────────────

describe('admin badge routes: authorization', () => {
  let admin;
  let organizer;
  let student;
  let badge;

  beforeAll(async () => {
    admin = await srv.login('admin@example.gov');
    organizer = await srv.login('jordan.whitfield@example.org');
    student = await srv.login('leo.chen@example.com');
    badge = await makeBadge({ criteria_type: 'manual', criteria_value: 0 });
  });

  const definition = () => ({
    name: `Auth probe ${Math.random().toString(36).slice(2, 8)}`,
    description: 'Created by an authorization probe.',
    icon: '🔒',
    category: 'Fixture',
    criteria_type: 'manual',
    criteria_value: 0,
    active: true
  });

  for (const [method, path, body] of [
    ['GET', '/api/admin/badges', undefined],
    ['POST', '/api/admin/badges', null],
    ['POST', '/api/admin/badges/award', { userId: 'user-student-2', badgeId: 'irrelevant' }],
    ['DELETE', '/api/admin/users/user-student-2/badges/irrelevant', undefined]
  ]) {
    it(`${method} ${path} refuses an unauthenticated caller`, async () => {
      const res = await srv.call(method, path, body === null ? definition() : body);
      expect(res.status).toBe(401);
    });

    it(`${method} ${path} refuses a signed-in volunteer`, async () => {
      const res = await srv.call(method, path, body === null ? definition() : body, student);
      expect(res.status).toBe(403);
    });

    it(`${method} ${path} refuses an organizer, who does not moderate the platform`, async () => {
      const res = await srv.call(method, path, body === null ? definition() : body, organizer);
      expect(res.status).toBe(403);
    });
  }

  it('serves the full catalogue to an administrator', async () => {
    const res = await srv.call('GET', '/api/admin/badges', undefined, admin);
    expect(res.status).toBe(200);
    expect(res.body.badges.length).toBeGreaterThan(0);
  });

  it('awards and revokes for an administrator', async () => {
    const awarded = await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-student-2', badgeId: badge }, admin);
    expect(awarded.status).toBe(200);
    expect(await holds('user-student-2', badge)).toBe(true);

    const revoked = await srv.call('DELETE', `/api/admin/users/user-student-2/badges/${badge}`,
      undefined, admin);
    expect(revoked.status).toBe(200);
    expect(await holds('user-student-2', badge)).toBe(false);
  });
});

describe('admin badge routes: behaviour', () => {
  let admin;

  beforeAll(async () => { admin = await srv.login('admin@example.gov'); });

  const auditRows = async (action, targetUserId) => await db.prepare(
    'SELECT * FROM admin_audit_logs WHERE action = ? AND target_user_id = ? ORDER BY created_at DESC'
  ).all(action, targetUserId);

  // ── Defect: criteria_type was unvalidated ──
  it('refuses a criteria_type the service does not implement', async () => {
    const res = await srv.call('POST', '/api/admin/badges', {
      name: 'Typo badge',
      description: 'Nobody could ever earn this.',
      icon: '💀',
      category: 'Fixture',
      criteria_type: 'hourz',
      criteria_value: 10,
      active: true
    }, admin);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/criteria/i);
    // The refusal names the vocabulary, so the fix is obvious from the response.
    expect(res.body.error).toMatch(/hours/);
    expect((await db.prepare('SELECT COUNT(*) as c FROM badges WHERE name = ?').get('Typo badge')).c).toBe(0);
  });

  it('accepts every criteria type the service implements', async () => {
    for (const type of BADGE_CRITERIA_TYPES) {
      const res = await srv.call('POST', '/api/admin/badges', {
        name: `Vocabulary probe ${type}`,
        description: 'Checks that the validator and the evaluator agree.',
        icon: '🧪',
        category: 'Fixture',
        criteria_type: type,
        criteria_value: 1,
        active: false
      }, admin);
      expect(res.status, `${type} is implemented but the route refused it`).toBe(200);
    }
  });

  it('refuses a non-numeric criteria_value', async () => {
    const res = await srv.call('POST', '/api/admin/badges', {
      name: 'Bad value badge',
      description: 'The threshold is not a number.',
      icon: '❓',
      category: 'Fixture',
      criteria_type: 'hours',
      criteria_value: 'ten',
      active: true
    }, admin);
    expect(res.status).toBe(400);
  });

  // ── Defect: a manual award wrote no audit row ──
  it('records the manual award in the administrative audit trail', async () => {
    const badge = await makeBadge({ criteria_type: 'manual', criteria_value: 0, name: 'Audited award' });
    const before = (await auditRows('BADGE_AWARDED', 'user-student-3')).length;

    const res = await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-student-3', badgeId: badge }, admin);
    expect(res.status).toBe(200);

    const after = await auditRows('BADGE_AWARDED', 'user-student-3');
    expect(after.length).toBe(before + 1);
    expect(after[0].admin_id).toBe('user-admin');
    expect(after[0].details).toContain('Audited award');
  });

  it('records the revocation too, with the reason given', async () => {
    const badge = await makeBadge({ criteria_type: 'manual', criteria_value: 0, name: 'Audited revocation' });
    await srv.call('POST', '/api/admin/badges/award', { userId: 'user-student-3', badgeId: badge }, admin);

    const res = await srv.call('DELETE', `/api/admin/users/user-student-3/badges/${badge}`,
      { reason: 'Awarded to the wrong student' }, admin);
    expect(res.status).toBe(200);

    const rows = await auditRows('BADGE_REVOKED', 'user-student-3');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].details).toContain('Audited revocation');
    expect(rows[0].details).toContain('Awarded to the wrong student');
  });

  it('refuses to award a badge the volunteer already holds', async () => {
    const badge = await makeBadge({ criteria_type: 'manual', criteria_value: 0 });
    const first = await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-diana', badgeId: badge }, admin);
    expect(first.status).toBe(200);

    const second = await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-diana', badgeId: badge }, admin);
    expect(second.status).toBe(409);
    expect((await db.prepare('SELECT COUNT(*) as c FROM user_badges WHERE user_id = ? AND badge_id = ?')
      .get('user-diana', badge)).c).toBe(1);
  });

  it('404s rather than 500s on an unknown user or badge', async () => {
    const badge = await makeBadge({ criteria_type: 'manual', criteria_value: 0 });
    expect((await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-does-not-exist', badgeId: badge }, admin)).status).toBe(404);
    expect((await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-diana', badgeId: 'badge-does-not-exist' }, admin)).status).toBe(404);
  });

  it('404s when revoking a badge the volunteer does not hold, and writes no audit row', async () => {
    const badge = await makeBadge({ criteria_type: 'manual', criteria_value: 0, name: 'Never awarded' });
    const before = (await auditRows('BADGE_REVOKED', 'user-matthew')).length;

    const res = await srv.call('DELETE', `/api/admin/users/user-matthew/badges/${badge}`, undefined, admin);
    expect(res.status).toBe(404);
    expect((await auditRows('BADGE_REVOKED', 'user-matthew')).length).toBe(before);
  });
});

// ── Defect: badgeService inserted into `notifications` directly ────────────

describe('the award notification goes through notificationService', () => {
  const notifications = async (userId) => await db.prepare(
    "SELECT * FROM notifications WHERE user_id = ? AND title LIKE '%badge%' ORDER BY created_at DESC"
  ).all(userId);

  it('links somewhere that exists, and carries a dedupe key and a category', async () => {
    const user = await makeVolunteer('notify');
    await makeBadge({ criteria_type: 'hours', criteria_value: 1, name: 'Notified badge' });
    const { eventId, slotIds } = await makeEvent('notify', 1);
    await credit(user, eventId, slotIds[0], 3);

    await badgeService.evaluateBadges(user);

    const rows = await notifications(user);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    // `/profile?tab=badges` was the old link. VolunteerProfile has no `tab`
    // query handling, so it landed on the profile with the query string ignored.
    expect(row.link).toBe('/profile');
    expect(row.kind).toBe('VOLUNTEER');
    // Written by _insertInApp, which the direct INSERT bypassed entirely.
    expect(row.dedupe_key).toBeTruthy();
    expect(row.priority).toBeTruthy();
  });

  it('honours the volunteer\'s notification preference, which a direct INSERT bypassed', async () => {
    const user = await makeVolunteer('optout');
    await db.prepare(`
      INSERT INTO notification_preferences (user_id, category, channel, enabled)
      VALUES (?, 'VOLUNTEER', 'inapp', 0)
      ON CONFLICT(user_id, category, channel) DO UPDATE SET enabled = 0
    `).run(user);

    await makeBadge({ criteria_type: 'hours', criteria_value: 1, name: 'Unwanted badge' });
    const { eventId, slotIds } = await makeEvent('optout', 1);
    await credit(user, eventId, slotIds[0], 3);

    await badgeService.evaluateBadges(user);

    expect(await notifications(user)).toEqual([]);
    // The badge itself is still earned — the preference is about being told.
    expect((await db.prepare('SELECT COUNT(*) as c FROM user_badges WHERE user_id = ?').get(user)).c)
      .toBeGreaterThan(0);
  });
});

// ── The architecture boundary ──────────────────────────────────────────────

/**
 * Milestones and badges may describe the same fact, for different readers.
 *
 * ── The boundary this replaces, and why it moved ──
 *
 * The rule used to be that milestones own every threshold derivable from the
 * service record and badges own what a milestone cannot express, so the shipped
 * catalogue defined NO hour badge and this test asserted the empty list.
 *
 * That rule conflated two things a volunteer experiences differently:
 *
 *   · a MILESTONE is a rung on the ladder on their OWN dashboard — derived on
 *     read, undated, and it silently un-earns if hours are corrected downward;
 *   · a BADGE is a dated, conferred credential that appears where OTHER PEOPLE
 *     look, and survives in `user_badges` as a record of when it happened.
 *
 * A school report and a certificate can both mention one exam. What must never
 * happen is the two DISAGREEING, so the replacement rule is not "no overlap" —
 * it is that neither restates a number. Both derive from
 * `SUM(hours_awarded) WHERE present = 1`, and every hour badge threshold comes
 * from the published tier list rather than being written out beside it.
 */
describe('milestones and badges never restate a number', () => {
  it('generates every hour badge from the published tier list', async () => {
    const { CONFERRED_CATALOGUE, HOUR_BADGE_TIERS } = await import('./scripts/seed_badges.js');
    const thresholds = CONFERRED_CATALOGUE
      .filter(b => b.criteria_type === 'hours')
      .map(b => b.criteria_value);

    /* Equality both ways: a tier missing from the catalogue is a badge nobody
       can earn, and a catalogue entry missing from the tiers is a threshold
       somebody typed by hand. */
    expect(thresholds).toEqual([...HOUR_BADGE_TIERS]);
  });

  it('generates every streak badge from the published tier list', async () => {
    const { CONFERRED_CATALOGUE, STREAK_BADGE_TIERS } = await import('./scripts/seed_badges.js');
    const thresholds = CONFERRED_CATALOGUE
      .filter(b => b.criteria_type === 'streak_months')
      .map(b => b.criteria_value);

    expect(thresholds).toEqual([...STREAK_BADGE_TIERS]);
  });

  it('starts streak badges above one month', async () => {
    /* A one-month streak is one month with a flame next to it, and the streak
       definition itself is documented as non-punitive. */
    const { STREAK_BADGE_TIERS } = await import('./scripts/seed_badges.js');
    expect(Math.min(...STREAK_BADGE_TIERS)).toBeGreaterThan(1);
  });

  it('still defines no events_attended badge, which milestones own alone', async () => {
    /* The half of the old rule that survives. "5 events" is a milestone and
       nothing else; there is no reader for whom a dated version of it says
       something the milestone does not. */
    const { CONFERRED_CATALOGUE } = await import('./scripts/seed_badges.js');
    expect(CONFERRED_CATALOGUE.filter(b => b.criteria_type === 'events_attended')).toEqual([]);
  });

  it('keeps every catalogue threshold a whole number', async () => {
    /* `criteria_value` is an INTEGER column. A fractional threshold would be
       silently truncated on the way in and compared against the truncation. */
    const { CONFERRED_CATALOGUE } = await import('./scripts/seed_badges.js');
    for (const b of CONFERRED_CATALOGUE) {
      expect(Number.isInteger(b.criteria_value), `${b.name} has a non-integer threshold`).toBe(true);
    }
  });
});

/**
 * ── Bounds on the text fields, checked on the server ──
 *
 * The form's `maxLength` was the only limit, which made the real ceiling
 * `express.json`'s 100 kB. Not a vulnerability — every render site is a React
 * text child and no export interprets these — but a 4,000-character badge name
 * breaks the definitions table for every administrator afterwards, and the
 * `icon` column is documented as "one emoji" with nothing enforcing it.
 */
describe('badge definition bounds', () => {
  let admin;
  beforeAll(async () => { admin = await srv.login('admin@example.gov'); });

  const valid = () => ({
    name: `Bounded ${++seq}`, description: 'A badge.', icon: '🏅',
    category: 'Service', criteria_type: 'manual', criteria_value: '',
  });

  it('refuses an over-long name, description or category, naming the field', async () => {
    for (const [field, max] of Object.entries({ name: 80, description: 400, category: 40 })) {
      const res = await srv.call('POST', '/api/admin/badges',
        { ...valid(), [field]: 'x'.repeat(max + 1) }, admin);
      expect(res.status, field).toBe(400);
      expect(res.body.field, field).toBe(field);
    }
  });

  it('accepts an emoji icon, including a multi-code-point one', async () => {
    /* The reason the cap counts CODE POINTS. `'🏅'.length` is 2 and a ZWJ
       sequence is longer still, so a UTF-16 cap of 2 would reject exactly the
       values this column exists for. */
    for (const icon of ['🏅', '🔥', '👩‍🚀']) {
      const res = await srv.call('POST', '/api/admin/badges', { ...valid(), icon }, admin);
      expect(res.status, icon).toBe(200);
    }
  });

  it('refuses a word in the icon field', async () => {
    const res = await srv.call('POST', '/api/admin/badges', { ...valid(), icon: 'trophy-icon' }, admin);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('icon');
  });
});
