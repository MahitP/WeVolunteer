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
function makeBadge(over = {}) {
  const n = ++seq;
  const id = `badge-fixture-${n}`;
  db.prepare(`
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
function makeAccount(suffix, role = 'student', createdAt = new Date().toISOString()) {
  const id = `user-badge-${suffix}`;
  db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, created_at)
    SELECT ?, ?, ?, ?, password_hash, '11', ?, 1, ?
    FROM users WHERE id = 'user-student-1'
  `).run(id, `Badge Tester ${suffix}`, `badge.${suffix}@example.com`, `badge${suffix}`, role, createdAt);
  return id;
}

const makeVolunteer = (suffix, createdAt) => makeAccount(suffix, 'student', createdAt);

/** An event with `slots` shifts on it, hosted by the seeded organizer. */
/**
 * @param {string} [endsAt] when the shifts finished, ISO. Defaults to now.
 *   Reliability is recency-weighted, so a fixture that stamps every slot with
 *   the same instant cannot express "recently" at all — which is why the
 *   attendance-rate tests below pass one.
 */
function makeEvent(suffix, slots = 1, status = 'open', organizerId = ORGANIZER, endsAt = null) {
  const eventId = `event-badge-${suffix}`;
  const now = new Date().toISOString();
  const when = endsAt ?? now;
  db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, created_at)
    VALUES (?, ?, 'Fixture', 'Other', 'Somewhere', ?, ?, ?, ?)
  `).run(eventId, `Badge fixture ${suffix}`, now, organizerId, status, now);

  const slotIds = [];
  for (let i = 0; i < slots; i += 1) {
    const slotId = `${eventId}-slot-${i}`;
    db.prepare(`
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
function credit(userId, eventId, slotId, hours, present = 1) {
  db.prepare(`
    INSERT OR IGNORE INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    VALUES (?, ?, ?, ?, 'accepted', ?)
  `).run(`app-${slotId}-${userId}`, userId, eventId, slotId, new Date(0).toISOString());

  db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slot_id, user_id) DO UPDATE SET present = excluded.present, hours_awarded = excluded.hours_awarded
  `).run(eventId, slotId, userId, present ? 1 : 0, hours);
}

const holds = (userId, badgeId) =>
  !!db.prepare('SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?').get(userId, badgeId);

// ── The criteria vocabulary ────────────────────────────────────────────────

describe('the criteria vocabulary has one definition', () => {
  it('exports the set the service actually implements', () => {
    expect(Array.isArray(BADGE_CRITERIA_TYPES)).toBe(true);
    expect(BADGE_CRITERIA_TYPES).toEqual(expect.arrayContaining([
      'hours', 'events_attended', 'events_created', 'attendance_rate', 'early_adopter', 'manual'
    ]));
  });

  it('every seeded catalogue entry names a type the service implements', () => {
    // The seeded catalogue is the one set of definitions no administrator chose,
    // so an unimplemented type there is a badge the product itself made unearnable.
    const unknown = db.prepare('SELECT DISTINCT criteria_type FROM badges').all()
      .map(r => r.criteria_type)
      .filter(t => !BADGE_CRITERIA_TYPES.includes(t));
    expect(unknown).toEqual([]);
  });
});

// ── Defect: awarding, and the UNIQUE(user_id, badge_id) constraint ─────────

describe('awarding at a threshold', () => {
  it('awards once the credited hours reach the threshold, and not before', () => {
    const user = makeVolunteer('threshold');
    const badge = makeBadge({ criteria_type: 'hours', criteria_value: 5 });
    const { eventId, slotIds } = makeEvent('threshold', 2);

    credit(user, eventId, slotIds[0], 4);
    badgeService.evaluateBadges(user);
    expect(holds(user, badge), '4 hours must not earn a 5-hour badge').toBe(false);

    credit(user, eventId, slotIds[1], 1);
    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(true);
  });

  it('counts only hours actually credited — an absence is worth nothing', () => {
    const user = makeVolunteer('absent');
    const badge = makeBadge({ criteria_type: 'hours', criteria_value: 3 });
    const { eventId, slotIds } = makeEvent('absent', 1);

    credit(user, eventId, slotIds[0], 8, /* present */ 0);
    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(false);
  });

  it('never awards the same badge twice, however many times it is evaluated', () => {
    const user = makeVolunteer('idempotent');
    const badge = makeBadge({ criteria_type: 'hours', criteria_value: 1 });
    const { eventId, slotIds } = makeEvent('idempotent', 1);
    credit(user, eventId, slotIds[0], 6);

    badgeService.evaluateBadges(user);
    badgeService.evaluateBadges(user);
    badgeService.evaluateBadges(user);

    const count = db.prepare('SELECT COUNT(*) as c FROM user_badges WHERE user_id = ? AND badge_id = ?')
      .get(user, badge).c;
    expect(count).toBe(1);
  });

  it('leaves an inactive badge unawarded', () => {
    const user = makeVolunteer('inactive');
    const badge = makeBadge({ criteria_type: 'hours', criteria_value: 1, active: 0 });
    const { eventId, slotIds } = makeEvent('inactive', 1);
    credit(user, eventId, slotIds[0], 9);

    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(false);
  });
});

// ── Defect: events_attended counted SHIFTS, not events ─────────────────────

describe('events_attended counts events, not shifts', () => {
  it('two shifts at one event are one event', () => {
    const user = makeVolunteer('shifts');
    const oneEvent = makeBadge({ criteria_type: 'events_attended', criteria_value: 1 });
    const twoEvents = makeBadge({ criteria_type: 'events_attended', criteria_value: 2 });
    const { eventId, slotIds } = makeEvent('shifts', 2);

    credit(user, eventId, slotIds[0], 2);
    credit(user, eventId, slotIds[1], 2);
    badgeService.evaluateBadges(user);

    expect(holds(user, oneEvent), 'one event attended').toBe(true);
    expect(
      holds(user, twoEvents),
      'two shifts at ONE event are not two events — this is the COUNT(at.id) bug'
    ).toBe(false);

    const second = makeEvent('shifts-2', 1);
    credit(user, second.eventId, second.slotIds[0], 2);
    badgeService.evaluateBadges(user);
    expect(holds(user, twoEvents)).toBe(true);
  });

  it('agrees with the eventsCompleted figure the profile route derives', async () => {
    const token = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', '/api/users/user-badge-shifts/profile', undefined, token);
    expect(res.status).toBe(200);
    // Two events, three shifts. The badge service and the profile route must not
    // disagree about which number "events attended" means.
    expect(res.body.stats.eventsCompleted).toBe(2);
    expect(res.body.stats.shiftsCompleted).toBe(3);
    expect(badgeService.collectStats('user-badge-shifts').eventsAttended).toBe(2);
  });
});

// ── Defect: `early_adopter` was an empty switch branch ─────────────────────

describe('early_adopter is earnable', () => {
  it('awards a badge to an account inside the early cohort', () => {
    const user = makeVolunteer('early');
    const badge = makeBadge({ criteria_type: 'early_adopter', criteria_value: 100000 });
    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(true);
  });

  it('fails closed on the seeded criteria_value of 0 rather than awarding everybody', () => {
    const user = makeVolunteer('early-zero');
    const badge = makeBadge({ criteria_type: 'early_adopter', criteria_value: 0 });
    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(false);
  });

  it('excludes an account that joined after the cohort closed', () => {
    const user = makeVolunteer('late', '2999-01-01T00:00:00.000Z');
    const badge = makeBadge({ criteria_type: 'early_adopter', criteria_value: 2 });
    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(false);
  });
});

// ── attendance_rate and events_created ─────────────────────────────────────

describe('the remaining automatic criteria', () => {
  it('needs a floor of completed commitments before an attendance rate means anything', () => {
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
    const user = makeVolunteer('rate');
    const badge = makeBadge({ criteria_type: 'attendance_rate', criteria_value: 90 });
    const events = Array.from({ length: 5 }, (_, i) => makeEvent(`rate-${i}`, 1));

    // Perfect record, but only two commitments: 100% of nothing much.
    credit(user, events[0].eventId, events[0].slotIds[0], 1);
    credit(user, events[1].eventId, events[1].slotIds[0], 1);
    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(false);

    credit(user, events[2].eventId, events[2].slotIds[0], 1);
    credit(user, events[3].eventId, events[3].slotIds[0], 1);
    credit(user, events[4].eventId, events[4].slotIds[0], 1);
    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(true);
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
    const buildHistory = (user, prefix, { attended, recentMisses }) => {
      const total = attended + recentMisses;
      for (let i = 0; i < total; i += 1) {
        /* Oldest first: index 0 is furthest back. */
        const daysAgo = (total - i) * 7;
        const endsAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
        const { eventId, slotIds } = makeEvent(`${prefix}-${i}`, 1, 'open', ORGANIZER, endsAt);
        const present = i < attended ? 1 : 0;
        credit(user, eventId, slotIds[0], 1, present);
      }
    };

    it('refuses a volunteer whose raw ratio clears 90% but whose recent record does not', () => {
      /**
       * 40 attended, then 4 straight misses. Raw: 40/44 = 90.9%, which a plain
       * percentage awards. But the last four commitments were all missed, and
       * an organizer choosing who to give a place to this week is not helped by
       * a badge earned two years ago.
       */
      const user = makeVolunteer('recent-decline');
      const badge = makeBadge({ criteria_type: 'attendance_rate', criteria_value: 90 });
      buildHistory(user, 'decline', { attended: 40, recentMisses: 4 });

      const stats = badgeService.collectStats(user);
      expect(stats.reliability.attended / stats.reliability.recorded,
        'the fixture must clear 90% on a raw ratio, or this proves nothing')
        .toBeGreaterThan(0.9);

      badgeService.evaluateBadges(user);
      expect(holds(user, badge), `score=${stats.reliability.score}`).toBe(false);
    });

    it('awards a volunteer who recovered, whose raw ratio is well under 90%', () => {
      /**
       * 6 misses, then 20 consecutive attendances. Raw: 20/26 = 76.9%, which a
       * plain percentage refuses for ever — there is no number of good months
       * that lifts it quickly. Recovery has to be something a volunteer can do.
       */
      const user = makeVolunteer('recovered');
      const badge = makeBadge({ criteria_type: 'attendance_rate', criteria_value: 90 });

      for (let i = 0; i < 26; i += 1) {
        const daysAgo = (26 - i) * 7;
        const endsAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
        const { eventId, slotIds } = makeEvent(`recover-${i}`, 1, 'open', ORGANIZER, endsAt);
        credit(user, eventId, slotIds[0], 1, i < 6 ? 0 : 1);
      }

      const stats = badgeService.collectStats(user);
      expect(stats.reliability.attended / stats.reliability.recorded,
        'the fixture must FAIL a raw ratio, or this proves nothing')
        .toBeLessThan(0.9);

      badgeService.evaluateBadges(user);
      expect(holds(user, badge), `score=${stats.reliability.score}`).toBe(true);
    });
  });

  it('does not award a reliability badge for one event with many shifts', () => {
    /* The other half of the grain rule, asserted directly: five slots of one
       event is one commitment, and one commitment is not evidence of a habit. */
    const user = makeVolunteer('one-event-many-shifts');
    const badge = makeBadge({ criteria_type: 'attendance_rate', criteria_value: 90 });
    const { eventId, slotIds } = makeEvent('one-event-many-shifts', 6);

    for (const slotId of slotIds) credit(user, eventId, slotId, 1);
    badgeService.evaluateBadges(user);

    expect(holds(user, badge)).toBe(false);
  });

  it('counts a live event towards events_created, not only a completed one', () => {
    // The original query was `status IN ('published', 'completed')`, and
    // 'published' is not a value the events CHECK constraint permits — so the
    // "Organizer" badge could only ever be earned by an event that had already
    // finished. A fresh organizer with exactly one open event is what tells the
    // two queries apart; the seeded organizer already has completed events.
    const organizer = makeAccount('organizer', 'organizer');
    const organizerBadge = makeBadge({ criteria_type: 'events_created', criteria_value: 1 });

    badgeService.evaluateBadges(organizer);
    expect(holds(organizer, organizerBadge), 'no events yet').toBe(false);

    makeEvent('created-open', 1, 'open', organizer);
    badgeService.evaluateBadges(organizer);
    expect(holds(organizer, organizerBadge)).toBe(true);
  });

  it('does not count a cancelled event towards events_created', () => {
    const organizer = makeAccount('organizer-cancelled', 'organizer');
    const organizerBadge = makeBadge({ criteria_type: 'events_created', criteria_value: 1 });
    makeEvent('created-cancelled', 1, 'cancelled', organizer);
    badgeService.evaluateBadges(organizer);
    expect(holds(organizer, organizerBadge)).toBe(false);
  });
});

// ── Defect: no revocation, of any kind ─────────────────────────────────────

describe('revocation', () => {
  it('withdraws an automatic badge when the hours behind it are revoked', () => {
    const user = makeVolunteer('revoked');
    const badge = makeBadge({ criteria_type: 'hours', criteria_value: 4 });
    const { eventId, slotIds } = makeEvent('revoked', 1);

    credit(user, eventId, slotIds[0], 5);
    badgeService.evaluateBadges(user);
    expect(holds(user, badge)).toBe(true);

    // What `outcome.revoked` in attendanceRoutes does: the credit is taken back.
    credit(user, eventId, slotIds[0], 0, /* present */ 0);
    badgeService.evaluateBadges(user);
    expect(holds(user, badge), 'a badge must not outlive the service it was awarded for').toBe(false);
  });

  it('never withdraws a badge a human awarded by hand', () => {
    const user = makeVolunteer('manual-keep');
    const badge = makeBadge({ criteria_type: 'hours', criteria_value: 500 });
    db.prepare(`
      INSERT INTO user_badges (id, user_id, badge_id, earned_at, awarded_by)
      VALUES (?, ?, ?, ?, 'user-admin')
    `).run('ub-manual-keep', user, badge, new Date().toISOString());

    badgeService.evaluateBadges(user);
    expect(
      holds(user, badge),
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
    badge = makeBadge({ criteria_type: 'manual', criteria_value: 0 });
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
    expect(holds('user-student-2', badge)).toBe(true);

    const revoked = await srv.call('DELETE', `/api/admin/users/user-student-2/badges/${badge}`,
      undefined, admin);
    expect(revoked.status).toBe(200);
    expect(holds('user-student-2', badge)).toBe(false);
  });
});

describe('admin badge routes: behaviour', () => {
  let admin;

  beforeAll(async () => { admin = await srv.login('admin@example.gov'); });

  const auditRows = (action, targetUserId) => db.prepare(
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
    expect(db.prepare('SELECT COUNT(*) as c FROM badges WHERE name = ?').get('Typo badge').c).toBe(0);
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
    const badge = makeBadge({ criteria_type: 'manual', criteria_value: 0, name: 'Audited award' });
    const before = auditRows('BADGE_AWARDED', 'user-student-3').length;

    const res = await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-student-3', badgeId: badge }, admin);
    expect(res.status).toBe(200);

    const after = auditRows('BADGE_AWARDED', 'user-student-3');
    expect(after.length).toBe(before + 1);
    expect(after[0].admin_id).toBe('user-admin');
    expect(after[0].details).toContain('Audited award');
  });

  it('records the revocation too, with the reason given', async () => {
    const badge = makeBadge({ criteria_type: 'manual', criteria_value: 0, name: 'Audited revocation' });
    await srv.call('POST', '/api/admin/badges/award', { userId: 'user-student-3', badgeId: badge }, admin);

    const res = await srv.call('DELETE', `/api/admin/users/user-student-3/badges/${badge}`,
      { reason: 'Awarded to the wrong student' }, admin);
    expect(res.status).toBe(200);

    const rows = auditRows('BADGE_REVOKED', 'user-student-3');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].details).toContain('Audited revocation');
    expect(rows[0].details).toContain('Awarded to the wrong student');
  });

  it('refuses to award a badge the volunteer already holds', async () => {
    const badge = makeBadge({ criteria_type: 'manual', criteria_value: 0 });
    const first = await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-diana', badgeId: badge }, admin);
    expect(first.status).toBe(200);

    const second = await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-diana', badgeId: badge }, admin);
    expect(second.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) as c FROM user_badges WHERE user_id = ? AND badge_id = ?')
      .get('user-diana', badge).c).toBe(1);
  });

  it('404s rather than 500s on an unknown user or badge', async () => {
    const badge = makeBadge({ criteria_type: 'manual', criteria_value: 0 });
    expect((await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-does-not-exist', badgeId: badge }, admin)).status).toBe(404);
    expect((await srv.call('POST', '/api/admin/badges/award',
      { userId: 'user-diana', badgeId: 'badge-does-not-exist' }, admin)).status).toBe(404);
  });

  it('404s when revoking a badge the volunteer does not hold, and writes no audit row', async () => {
    const badge = makeBadge({ criteria_type: 'manual', criteria_value: 0, name: 'Never awarded' });
    const before = auditRows('BADGE_REVOKED', 'user-matthew').length;

    const res = await srv.call('DELETE', `/api/admin/users/user-matthew/badges/${badge}`, undefined, admin);
    expect(res.status).toBe(404);
    expect(auditRows('BADGE_REVOKED', 'user-matthew').length).toBe(before);
  });
});

// ── Defect: badgeService inserted into `notifications` directly ────────────

describe('the award notification goes through notificationService', () => {
  const notifications = (userId) => db.prepare(
    "SELECT * FROM notifications WHERE user_id = ? AND title LIKE '%badge%' ORDER BY created_at DESC"
  ).all(userId);

  it('links somewhere that exists, and carries a dedupe key and a category', () => {
    const user = makeVolunteer('notify');
    makeBadge({ criteria_type: 'hours', criteria_value: 1, name: 'Notified badge' });
    const { eventId, slotIds } = makeEvent('notify', 1);
    credit(user, eventId, slotIds[0], 3);

    badgeService.evaluateBadges(user);

    const rows = notifications(user);
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

  it('honours the volunteer\'s notification preference, which a direct INSERT bypassed', () => {
    const user = makeVolunteer('optout');
    db.prepare(`
      INSERT INTO notification_preferences (user_id, category, channel, enabled)
      VALUES (?, 'VOLUNTEER', 'inapp', 0)
      ON CONFLICT(user_id, category, channel) DO UPDATE SET enabled = 0
    `).run(user);

    makeBadge({ criteria_type: 'hours', criteria_value: 1, name: 'Unwanted badge' });
    const { eventId, slotIds } = makeEvent('optout', 1);
    credit(user, eventId, slotIds[0], 3);

    badgeService.evaluateBadges(user);

    expect(notifications(user)).toEqual([]);
    // The badge itself is still earned — the preference is about being told.
    expect(db.prepare('SELECT COUNT(*) as c FROM user_badges WHERE user_id = ?').get(user).c)
      .toBeGreaterThan(0);
  });
});

// ── The architecture boundary ──────────────────────────────────────────────

/**
 * The threshold reaches the client, so the client does not keep its own copy.
 *
 * `VolunteerDashboard.jsx` and `VolunteerProfile.jsx` each held
 * `const HOUR_GOAL = 25` — a third and fourth copy of the district's Silver
 * Award threshold, in a different language from the server that decides whether
 * the milestone is earned. Nothing could compare them, so the progress meter
 * could read "8 hours to go" beside a milestone already rendered as achieved.
 *
 * Both numbers now come from `server/milestones.js` over two transports, and
 * these are the assertions that keep them arriving.
 */
describe('the milestone thresholds are served, not duplicated client-side', () => {
  it('carries metric and threshold on every milestone in a profile', async () => {
    const { SERVICE_HOUR_GOAL } = await import('./milestones.js');
    const token = await srv.login('leo.chen@example.com');
    /* The seeded student, by the id db.js gives them. */
    const res = await srv.call('GET', '/api/users/user-student-1/profile', undefined, token);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.milestones)).toBe(true);
    for (const m of res.body.milestones) {
      expect(['hours', 'events'], `${m.id} has metric ${m.metric}`).toContain(m.metric);
      expect(typeof m.threshold, `${m.id} carries no threshold`).toBe('number');
      expect(typeof m.earned).toBe('boolean');
    }

    /* The Silver tier is the one the meter is drawn against, so its threshold is
       the number the client must not be inventing. */
    const silver = res.body.milestones.find(m => m.id === 'silver');
    expect(silver.threshold).toBe(SERVICE_HOUR_GOAL);
  });

  it('sends the progress-meter goal on the session payload and the stats endpoint', async () => {
    const { SERVICE_HOUR_GOAL } = await import('./milestones.js');
    const token = await srv.login('leo.chen@example.com');

    /* On the session payload, because the dashboard draws the meter on its first
       frame from `currentUser` and cannot wait for a second request to learn its
       own maximum. */
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body.serviceHourGoal).toBe(SERVICE_HOUR_GOAL);

    const stats = await srv.call('GET', '/api/stats/volunteer', undefined, token);
    expect(stats.status).toBe(200);
    expect(stats.body.serviceHourGoal).toBe(SERVICE_HOUR_GOAL);
  });
});

describe('milestones and badges do not describe the same achievement twice', () => {
  it('the shipped catalogue defines no hours or events_attended threshold', async () => {
    // Milestones own every threshold derivable from the service ledger; badges
    // own what is conferred. Two systems claiming the same 25 hours under two
    // different names ("Silver Award" and "Community Champion") on one page is
    // the defect this boundary exists to prevent. An administrator may still
    // define such a badge deliberately — the fixtures above do — but the
    // product ships none.
    const { CONFERRED_CATALOGUE } = await import('./scripts/seed_badges.js');
    const overlapping = CONFERRED_CATALOGUE
      .filter(b => b.criteria_type === 'hours' || b.criteria_type === 'events_attended')
      .map(b => b.name);
    expect(overlapping).toEqual([]);
  });

  /**
   * The reconciliation has ALREADY happened by the time anything reads the
   * database.
   *
   * This is the assertion that makes the boundary real rather than available.
   * The reconciliation used to be a hand-run CLI wired into no npm script, so
   * migration 024's four duplicate hour badges sat in every database that nobody
   * remembered to run it against — which was all of them, including the database
   * this test boots. `initDatabase` calls it now, beside `syncLegalDocuments` and
   * for the same reason.
   *
   * Asserted as "a fresh run changes nothing", which is the same statement as
   * "boot already did it" and additionally proves idempotency. The previous
   * version of this case asserted the opposite — that the FIRST run in the test
   * changed something — and that expectation is exactly what a correction moving
   * to init has to break.
   */
  it('has already reconciled the catalogue at boot, and never deletes an earned award', async () => {
    const { reconcileBadgeCatalogue } = await import('./scripts/seed_badges.js');

    const atBoot = reconcileBadgeCatalogue(db);
    expect(atBoot.created, 'boot should have created the catalogue').toBe(0);
    expect(atBoot.updated, 'boot should have brought definitions into line').toBe(0);
    expect(atBoot.retired, 'boot should have retired the duplicate hour badges').toBe(0);

    /**
     * The collision itself, checked by name rather than inferred from a counter.
     *
     * Scoped to the SHIPPED names, not to every `hours` badge in the table: the
     * fixtures earlier in this file deliberately define hour-threshold badges to
     * exercise the evaluator, because an administrator is still allowed to
     * create one. What the product must not SHIP is one that restates a
     * milestone, and these four are the ones migration 024 seeded.
     *
     * Retired, not deleted. A definition somebody earned under has to keep
     * existing for their award to mean anything, so `active = 0` is the whole
     * mechanism — and asserting the row is still there is asserting that.
     */
    const { RETIRED_NAMES } = await import('./scripts/seed_badges.js');
    const seededBy024 = ['First Step', 'Helping Hand', 'Community Champion', 'Volunteer Legend'];
    for (const name of seededBy024) {
      const row = db.prepare('SELECT name, active FROM badges WHERE name = ?').get(name);
      expect(row, `${name} was deleted rather than retired`).toBeTruthy();
      expect(row.active, `${name} still competes with a milestone`).toBe(0);
    }
    for (const name of RETIRED_NAMES) {
      const row = db.prepare('SELECT active FROM badges WHERE name = ?').get(name);
      if (row) expect(row.active, `${name} should be deactivated`).toBe(0);
    }

    const user = makeVolunteer('reconcile');
    const held = db.prepare("SELECT id FROM badges WHERE active = 0 LIMIT 1").get();
    db.prepare('INSERT INTO user_badges (id, user_id, badge_id, earned_at) VALUES (?, ?, ?, ?)')
      .run('ub-reconcile', user, held.id, new Date().toISOString());

    const second = reconcileBadgeCatalogue(db);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.retired).toBe(0);

    // Retiring a definition must never destroy the record of an award made
    // under it — that record is somebody's history.
    expect(holds(user, held.id)).toBe(true);

    for (const b of (await import('./scripts/seed_badges.js')).CONFERRED_CATALOGUE) {
      const row = db.prepare('SELECT * FROM badges WHERE name = ?').get(b.name);
      expect(row, `${b.name} is missing from the catalogue after reconciliation`).toBeTruthy();
      expect(row.active).toBe(1);
      expect(row.criteria_type).toBe(b.criteria_type);
      expect(row.criteria_value).toBe(b.criteria_value);
    }
  });
});
