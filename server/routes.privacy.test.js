import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './testServer.js';

// One server for the whole file (Tasks 5 and 6 append more describes below).
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('privacy: student profile PII scoping (grade/school/bio/email)', () => {
  let leoToken, _priyaToken, hostingOrgToken, unrelatedOrgToken, adminToken;
  let freshStudentId, freshStudentToken;

  beforeAll(async () => {
    leoToken = await srv.login('leo.chen28@gmail.com');
    _priyaToken = await srv.login('priya.patel.nhs@outlook.com');
    hostingOrgToken = await srv.login('jkatzenback@vikings.org'); // hosts event-softball
    unrelatedOrgToken = await srv.login('rmiller@sbpl.info'); // pending, hosts nothing
    adminToken = await srv.login('admin@example.gov');

    // A fresh student who applies to a freshly created event hosted by
    // jkatzenback, so we have a real, unambiguous "hosting organizer"
    // relationship to test against, independent of the pre-existing seeded
    // Priya<->jkatzenback link. A future slot also gives us a non-vacuous
    // upcomingCount to assert on.
    const signupRes = await srv.call('POST', '/api/auth/signup', {
      email: 'privacy.fresh.student@example.org', password: 'password123',
      name: 'Privacy Fresh Student', role: 'student', grade: '9',
      school: 'Test High School',
      username: 'privacy_fresh_stu'
    });
    expect(signupRes.status).toBe(201);
    freshStudentId = signupRes.body.user.id;
    freshStudentToken = signupRes.cookie;

    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const futureEnd = new Date(future.getTime() + 3 * 3600 * 1000);
    const createRes = await srv.call('POST', '/api/events', {
      title: 'Privacy Test Event',
      description: 'Created to test PII gating on the volunteer profile endpoint.',
      category: 'Other',
      location: '99 Privacy Way, South Brunswick',
      applicationDeadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      slots: [{
        name: 'Shift', description: 'Test shift',
        startDatetime: future.toISOString(), endDatetime: futureEnd.toISOString(),
        maxSpots: 5
      }]
    }, hostingOrgToken);
    expect(createRes.status).toBe(201);
    const eventId = createRes.body.id;

    const eventsRes = await srv.call('GET', '/api/events', undefined, freshStudentToken);
    const testEvent = eventsRes.body.find(e => e.id === eventId);
    expect(testEvent).toBeTruthy();
    const slotId = testEvent.slots[0].id;

    const applyRes = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, freshStudentToken);
    expect(applyRes.status).toBe(201);

    const apps = (await srv.call('GET', '/api/applications', undefined, hostingOrgToken)).body;
    const freshApp = apps.find(a => a.slotId === slotId && a.userId === freshStudentId);
    expect(freshApp).toBeTruthy();
    const acceptRes = await srv.call('PATCH', `/api/applications/${freshApp.id}`, { status: 'accepted' }, hostingOrgToken);
    expect(acceptRes.status).toBe(200);
  });

  it('hides grade/school/bio/email from another (unrelated) student', async () => {
    const res = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, leoToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.grade).toBeNull();
    expect(res.body.volunteer.school).toBeNull();
    expect(res.body.volunteer.bio).toBeNull();
    expect(res.body.volunteer.email).toBeNull();
  });

  it('hides grade/school/bio/email from an organizer who does not host any event the student applied to', async () => {
    const res = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, unrelatedOrgToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.grade).toBeNull();
    expect(res.body.volunteer.school).toBeNull();
    expect(res.body.volunteer.bio).toBeNull();
    expect(res.body.volunteer.email).toBeNull();
  });

  it('reveals grade/school/bio/email to an organizer who hosts an event the student applied to', async () => {
    const res = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, hostingOrgToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.grade).toBe('9');
    expect(res.body.volunteer.school).toBe('Test High School');
    expect(res.body.volunteer.email).toBe('privacy.fresh.student@example.org');
  });

  it('reveals grade/school/bio/email to the seeded hosting-organizer relationship (Priya <-> jkatzenback)', async () => {
    const res = await srv.call('GET', '/api/users/user-student-2/profile', undefined, hostingOrgToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.grade).toBe('11');
    expect(res.body.volunteer.school).toBeTruthy();
    expect(res.body.volunteer.email).toBe('priya.patel.nhs@outlook.com');
  });

  it('reveals grade/school/bio/email to an admin viewing any student', async () => {
    const res = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.grade).toBe('9');
    expect(res.body.volunteer.school).toBe('Test High School');
    expect(res.body.volunteer.email).toBe('privacy.fresh.student@example.org');
  });

  it('reveals grade/school/bio/email to the student viewing their own profile', async () => {
    const res = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, freshStudentToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.grade).toBe('9');
    expect(res.body.volunteer.school).toBe('Test High School');
    expect(res.body.volunteer.email).toBe('privacy.fresh.student@example.org');
  });

  it('gives an unrelated viewer upcomingCount 0, but a hosting organizer, admin, and self the real count', async () => {
    const unrelated = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, unrelatedOrgToken);
    expect(unrelated.status).toBe(200);
    expect(unrelated.body.stats.upcomingCount).toBe(0);

    const hosting = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, hostingOrgToken);
    expect(hosting.status).toBe(200);
    expect(hosting.body.stats.upcomingCount).toBeGreaterThan(0);

    const admin = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, adminToken);
    expect(admin.status).toBe(200);
    expect(admin.body.stats.upcomingCount).toBeGreaterThan(0);

    const self = await srv.call('GET', `/api/users/${freshStudentId}/profile`, undefined, freshStudentToken);
    expect(self.status).toBe(200);
    expect(self.body.stats.upcomingCount).toBeGreaterThan(0);
  });

  it('keeps aggregate stats and service history visible to an unrelated student viewer (not PII)', async () => {
    const res = await srv.call('GET', '/api/users/user-student-2/profile', undefined, leoToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.name).toBe('Priya Patel');
    expect(typeof res.body.stats.hours).toBe('number');
    expect(Array.isArray(res.body.completed)).toBe(true);
  });
});

describe('leaderboard privacy', () => {
  let leoToken;
  const SEEDED_STUDENT_IDS = ['user-student-1', 'user-student-2', 'user-student-3'];

  beforeAll(async () => {
    leoToken = await srv.login('leo.chen28@gmail.com');
  });

  it('is empty of seeded students while everyone defaults to leaderboard_opt_in = 0', async () => {
    const res = await srv.call('GET', '/api/leaderboard', undefined, leoToken);
    expect(res.status).toBe(200);
    const ids = res.body.map(r => r.id);
    for (const seededId of SEEDED_STUDENT_IDS) {
      expect(ids).not.toContain(seededId);
    }
  });

  it('shows a student once leaderboard_opt_in is set to 1 directly in the DB', async () => {
    const rawDb = new DatabaseSync(process.env.WEV_DB_PATH);
    try {
      rawDb.prepare("UPDATE users SET leaderboard_opt_in = 1 WHERE id = 'user-student-3'").run();
    } finally {
      rawDb.close();
    }

    const res = await srv.call('GET', '/api/leaderboard', undefined, leoToken);
    expect(res.status).toBe(200);
    const ids = res.body.map(r => r.id);
    expect(ids).toContain('user-student-3');

    // Reset so this test doesn't leak state into the others below.
    const rawDb2 = new DatabaseSync(process.env.WEV_DB_PATH);
    try {
      rawDb2.prepare("UPDATE users SET leaderboard_opt_in = 0 WHERE id = 'user-student-3'").run();
    } finally {
      rawDb2.close();
    }
  });

  it('never returns school or grade on leaderboard rows', async () => {
    const rawDb = new DatabaseSync(process.env.WEV_DB_PATH);
    try {
      rawDb.prepare("UPDATE users SET leaderboard_opt_in = 1 WHERE id = 'user-student-3'").run();
    } finally {
      rawDb.close();
    }

    const res = await srv.call('GET', '/api/leaderboard', undefined, leoToken);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expect(row).not.toHaveProperty('school');
      expect(row).not.toHaveProperty('grade');
    }

    const rawDb2 = new DatabaseSync(process.env.WEV_DB_PATH);
    try {
      rawDb2.prepare("UPDATE users SET leaderboard_opt_in = 0 WHERE id = 'user-student-3'").run();
    } finally {
      rawDb2.close();
    }
  });

  it('round-trips the opt-in through PATCH /api/auth/profile (the write-path guard)', async () => {
    const _priyaToken = await srv.login('priya.patel.nhs@outlook.com');

    // Opt in.
    const optInRes = await srv.call('PATCH', '/api/auth/profile', { leaderboardOptIn: true }, priyaToken);
    expect(optInRes.status).toBe(200);
    expect(optInRes.body.user.leaderboardOptIn).toBe(true);

    const boardAfterOptIn = await srv.call('GET', '/api/leaderboard', undefined, leoToken);
    expect(boardAfterOptIn.status).toBe(200);
    expect(boardAfterOptIn.body.map(r => r.id)).toContain('user-student-2');

    // Opt back out.
    const optOutRes = await srv.call('PATCH', '/api/auth/profile', { leaderboardOptIn: false }, priyaToken);
    expect(optOutRes.status).toBe(200);
    expect(optOutRes.body.user.leaderboardOptIn).toBe(false);

    const boardAfterOptOut = await srv.call('GET', '/api/leaderboard', undefined, leoToken);
    expect(boardAfterOptOut.status).toBe(200);
    expect(boardAfterOptOut.body.map(r => r.id)).not.toContain('user-student-2');
  });
});

// Task 6: GET /api/events requires auth and scopes `instructions` to accepted
// volunteers/staff; announcements are gated the same way `attendees` already is.
describe('privacy: event listing requires auth and scopes instructions', () => {
  let leoToken, _priyaToken, hostingOrgToken, adminToken;

  // Seeded event-softball has app-sb-6 (Leo, accepted) and app-sb-10 (Priya,
  // pending — not accepted). The seed script leaves `instructions` null, so
  // we set real text directly in the DB (the same pattern the leaderboard
  // tests above use) rather than re-litigating the seed data itself.
  const SOFTBALL_INSTRUCTIONS = 'Enter through the west gate and check in at the snack shack table.';

  beforeAll(async () => {
    leoToken = await srv.login('leo.chen28@gmail.com');
    _priyaToken = await srv.login('priya.patel.nhs@outlook.com');
    hostingOrgToken = await srv.login('jkatzenback@vikings.org');
    adminToken = await srv.login('admin@example.gov');

    const rawDb = new DatabaseSync(process.env.WEV_DB_PATH);
    try {
      rawDb.prepare("UPDATE events SET instructions = ? WHERE id = 'event-softball'").run(SOFTBALL_INSTRUCTIONS);
    } finally {
      rawDb.close();
    }
  });

  it('requires a token for GET /api/events', async () => {
    const res = await srv.call('GET', '/api/events');
    expect(res.status).toBe(401);
  });

  it('blanks instructions for a signed-in student who is not accepted (Priya, pending)', async () => {
    const res = await srv.call('GET', '/api/events', undefined, priyaToken);
    expect(res.status).toBe(200);
    const softball = res.body.find(e => e.id === 'event-softball');
    expect(softball).toBeTruthy();
    expect(softball.instructions).toBe('');
  });

  it('reveals real instructions to an accepted student (Leo)', async () => {
    const res = await srv.call('GET', '/api/events', undefined, leoToken);
    expect(res.status).toBe(200);
    const softball = res.body.find(e => e.id === 'event-softball');
    expect(softball.instructions).toBe(SOFTBALL_INSTRUCTIONS);
  });

  it('reveals real instructions to the hosting organizer', async () => {
    const res = await srv.call('GET', '/api/events', undefined, hostingOrgToken);
    expect(res.status).toBe(200);
    const softball = res.body.find(e => e.id === 'event-softball');
    expect(softball.instructions).toBe(SOFTBALL_INSTRUCTIONS);
  });

  it('reveals real instructions to an admin', async () => {
    const res = await srv.call('GET', '/api/events', undefined, adminToken);
    expect(res.status).toBe(200);
    const softball = res.body.find(e => e.id === 'event-softball');
    expect(softball.instructions).toBe(SOFTBALL_INSTRUCTIONS);
  });
});

describe('privacy: event announcements gated to accepted volunteers and staff', () => {
  let leoToken, _priyaToken, hostingOrgToken, adminToken;

  beforeAll(async () => {
    leoToken = await srv.login('leo.chen28@gmail.com');
    _priyaToken = await srv.login('priya.patel.nhs@outlook.com');
    hostingOrgToken = await srv.login('jkatzenback@vikings.org');
    adminToken = await srv.login('admin@example.gov');
  });

  it('returns an empty array to a not-accepted (pending) student', async () => {
    const res = await srv.call('GET', '/api/events/event-softball/announcements', undefined, priyaToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns the real announcements to an accepted student (Leo)', async () => {
    const res = await srv.call('GET', '/api/events/event-softball/announcements', undefined, leoToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.map(a => a.id)).toContain('ann-1');
  });

  it('returns the real announcements to the hosting organizer', async () => {
    const res = await srv.call('GET', '/api/events/event-softball/announcements', undefined, hostingOrgToken);
    expect(res.status).toBe(200);
    expect(res.body.map(a => a.id)).toContain('ann-1');
  });

  it('returns the real announcements to an admin', async () => {
    const res = await srv.call('GET', '/api/events/event-softball/announcements', undefined, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.map(a => a.id)).toContain('ann-1');
  });
});
