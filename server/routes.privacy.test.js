import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';

// One server for the whole file (Tasks 5 and 6 append more describes below).
let srv;
beforeAll(async () => {
  // The provider-only export path below has no password to verify with.
  process.env.OAUTH_ALLOW_MOCK = 'true';
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
  delete process.env.OAUTH_ALLOW_MOCK;
});

describe('privacy: student profile PII scoping (grade/school/bio/email)', () => {
  let leoToken, hostingOrgToken, unrelatedOrgToken, adminToken;
  let freshStudentId, freshStudentToken;

  beforeAll(async () => {
    leoToken = await srv.login('leo.chen@example.com');
    hostingOrgToken = await srv.login('jordan.whitfield@example.org'); // hosts event-softball
    unrelatedOrgToken = await srv.login('robin.ellery@example.org'); // hosts nothing

    /**
     * The agreement is accepted so this fixture tests what it says it tests.
     *
     * These cases are about FIELD scoping — which columns an organizer who does
     * not host the student's event may see — and the seeded `rellery` is a
     * pending organizer. Since v1.3, `directory.read` is one of the capabilities
     * withheld until the Organizer Agreement is accepted (see
     * ORGANIZER_GATED_CAPABILITIES), and `GET /api/users/:id/profile` now
     * enforces it, so an un-agreed organizer is refused the request outright.
     *
     * That refusal is correct and is deliberately NOT what these tests assert:
     * an adult who has not undertaken the terms for handling students' details
     * should not be reading student profiles at all. Accepting the agreement
     * here restores the intended fixture — an organizer who legitimately holds
     * the capability and simply hosts nothing this student applied to — so the
     * assertions below stay about the fields rather than about the gate.
     */
    await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, unrelatedOrgToken);
    adminToken = await srv.login('admin@example.gov');

    // A fresh student who applies to a freshly created event hosted by
    // jwhitfield, so we have a real, unambiguous "hosting organizer"
    // relationship to test against, independent of the pre-existing seeded
    // Priya<->jwhitfield link. A future slot also gives us a non-vacuous
    // upcomingCount to assert on.
    const signupRes = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email: 'privacy.fresh.student@example.org', password: 'Password123',
      name: 'Privacy Fresh Student', role: 'student', grade: '9',
      school: 'Test High School',
      username: 'privacy_fresh_stu'
    });
    expect(signupRes.status).toBe(201);
    freshStudentId = signupRes.body.user.id;
    // Signups start unconfirmed, and an unconfirmed account is confined to the
    // allowlist — confirm before using it to exercise anything else.
    freshStudentToken = await srv.confirmEmail(freshStudentId);

    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const futureEnd = new Date(future.getTime() + 3 * 3600 * 1000);
    const createRes = await srv.call('POST', '/api/events', {
      title: 'Privacy Test Event',
      description: 'Created to test PII gating on the volunteer profile endpoint.',
      category: 'Other',
      location: '99 Privacy Way, Example Valley',
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

  it('reveals grade/school/bio/email to the seeded hosting-organizer await relationship(Priya <-> jwhitfield)', async () => {
    const res = await srv.call('GET', '/api/users/user-student-2/profile', undefined, hostingOrgToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.grade).toBe('11');
    expect(res.body.volunteer.school).toBeTruthy();
    expect(res.body.volunteer.email).toBe('priya.patel@example.com');
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
    leoToken = await srv.login('leo.chen@example.com');
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
    const { db: rawDb } = await import('./db.js');
    try {
      await rawDb.prepare("UPDATE users SET leaderboard_opt_in = 1 WHERE id = 'user-student-3'").run();
    } finally {
    }

    const res = await srv.call('GET', '/api/leaderboard', undefined, leoToken);
    expect(res.status).toBe(200);
    const ids = res.body.map(r => r.id);
    expect(ids).toContain('user-student-3');

    // Reset so this test doesn't leak state into the others below.
    const { db: rawDb2 } = await import('./db.js');
    try {
      await rawDb2.prepare("UPDATE users SET leaderboard_opt_in = 0 WHERE id = 'user-student-3'").run();
    } finally {
    }
  });

  it('never returns school or grade on leaderboard rows', async () => {
    const { db: rawDb } = await import('./db.js');
    try {
      await rawDb.prepare("UPDATE users SET leaderboard_opt_in = 1 WHERE id = 'user-student-3'").run();
    } finally {
    }

    const res = await srv.call('GET', '/api/leaderboard', undefined, leoToken);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expect(row).not.toHaveProperty('school');
      expect(row).not.toHaveProperty('grade');
    }

    const { db: rawDb2 } = await import('./db.js');
    try {
      await rawDb2.prepare("UPDATE users SET leaderboard_opt_in = 0 WHERE id = 'user-student-3'").run();
    } finally {
    }
  });

  it('round-trips the opt-in through PATCH /api/auth/profile (the write-path guard)', async () => {
    const priyaToken = await srv.login('priya.patel@example.com');

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
  let leoToken, priyaToken, hostingOrgToken, adminToken;

  // Seeded event-softball has app-sb-6 (Leo, accepted) and app-sb-10 (Priya,
  // pending — not accepted). The seed script leaves `instructions` null, so
  // we set real text directly in the DB (the same pattern the leaderboard
  // tests above use) rather than re-litigating the seed data itself.
  const SOFTBALL_INSTRUCTIONS = 'Enter through the west gate and check in at the snack shack table.';

  beforeAll(async () => {
    leoToken = await srv.login('leo.chen@example.com');
    priyaToken = await srv.login('priya.patel@example.com');
    hostingOrgToken = await srv.login('jordan.whitfield@example.org');
    adminToken = await srv.login('admin@example.gov');

    const { db: rawDb } = await import('./db.js');
    try {
      await rawDb.prepare("UPDATE events SET instructions = ? WHERE id = 'event-softball'").run(SOFTBALL_INSTRUCTIONS);
    } finally {
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
  let leoToken, priyaToken, hostingOrgToken, adminToken;

  beforeAll(async () => {
    leoToken = await srv.login('leo.chen@example.com');
    priyaToken = await srv.login('priya.patel@example.com');
    hostingOrgToken = await srv.login('jordan.whitfield@example.org');
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

/**
 * Requesting a full personal-data archive (v1.2b Task 6).
 *
 * ── Why this endpoint gained a gate it never had ──
 *
 * It was the one sensitive endpoint in the v1.2b enumeration with no step-up at
 * all: an authenticated request and a rate limit, and a complete copy of
 * everything the account holds lands in a downloadable file. That is bulk PII
 * egress about a minor, and it is exactly what somebody holding a borrowed or
 * stolen session would take — quietly, in one request, without changing anything
 * the account holder would later notice. Deletion, password and email all
 * demanded a credential; the one action that copies everything out demanded
 * nothing.
 */
describe('privacy: data export', () => {
  let studentToken, studentId;

  const requestExport = (token, challengeId) =>
    srv.call('POST', '/api/privacy/export', undefined, token, challengeId ? srv.reauthHeader(challengeId) : {});

  /** Lets the next request through the "already in progress" check. */
  const finishRunningJobs = async (userId) => {
    const { db } = await import('./db.js');
    await db.prepare(`
      UPDATE data_export_jobs SET status = 'completed', completed_at = ?
      WHERE user_id = ? AND status IN ('pending', 'processing')
    `).run(new Date().toISOString(), userId);
  };

  const challengeRow = async (id) => {
    const { db } = await import('./db.js');
    return await db.prepare('SELECT * FROM reauth_challenges WHERE id = ?').get(id);
  };

  beforeAll(async () => {
    const signupRes = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email: 'export.student@example.org', password: 'Password123',
      name: 'Export Student', role: 'student', grade: '9',
      school: 'Test High School',
      username: 'export_student_123'
    });
    studentId = signupRes.body.user.id;
    studentToken = await srv.confirmEmail(studentId);
  });

  it('refuses a request presenting no verification at all', async () => {
    const res = await requestExport(studentToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('data.export');

    // And queued nothing — the refusal is before any work.
    const statusRes = await srv.call('GET', '/api/privacy/export/status', undefined, studentToken);
    expect(statusRes.body.status).toBe('none');
  });

  it('refuses a grant obtained for a different action', async () => {
    // A live, correctly granted, correctly session-bound challenge — for
    // something else. One verification must not unlock every sensitive action.
    const forPassword = await srv.stepUp(studentToken, 'password.change', { password: 'Password123' });

    const res = await requestExport(studentToken, forPassword);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('data.export');
  });

  it('allows a user to request a data export and creates a pending job', async () => {
    const challengeId = await srv.stepUp(studentToken, 'data.export', { password: 'Password123' });

    const res = await requestExport(studentToken, challengeId);
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();

    const statusRes = await srv.call('GET', '/api/privacy/export/status', undefined, studentToken);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('pending');

    // The grant was spent with the job, not merely checked on the way in.
    expect((await challengeRow(challengeId)).consumed_at).not.toBeNull();
  });

  it('rejects concurrent export requests without spending the grant', async () => {
    /**
     * Why the consume is in the handler and not the middleware.
     *
     * "You already have an export running" is a refusal of the request, so it
     * must not cost the user the verification they just performed — otherwise
     * they re-verify for an export that never started. The 409 is deliberately
     * checked before the grant is spent.
     */
    const challengeId = await srv.stepUp(studentToken, 'data.export', { password: 'Password123' });

    const res = await requestExport(studentToken, challengeId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);
    expect((await challengeRow(challengeId)).consumed_at).toBeNull();

    // Unspent, so the same verification still works once the first one finishes.
    await finishRunningJobs(studentId);
    expect((await requestExport(studentToken, challengeId)).status).toBe(202);
  });

  it('spends the grant exactly once', async () => {
    await finishRunningJobs(studentId);
    const challengeId = await srv.stepUp(studentToken, 'data.export', { password: 'Password123' });

    expect((await requestExport(studentToken, challengeId)).status).toBe(202);

    // A grant that survived its own use would be an unlimited supply of archives
    // for the rest of its five minutes.
    await finishRunningJobs(studentId);
    const replay = await requestExport(studentToken, challengeId);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('reauth_required');
  });

  it('400s if download is requested before it is completed', async () => {
    await finishRunningJobs(studentId);
    const challengeId = await srv.stepUp(studentToken, 'data.export', { password: 'Password123' });
    expect((await requestExport(studentToken, challengeId)).status).toBe(202);

    const statusRes = await srv.call('GET', '/api/privacy/export/status', undefined, studentToken);
    const jobId = statusRes.body.id;

    // Downloading is gated on `data.download` since the v1.2b audit (F-1), so
    // this presents a grant bound to the job — otherwise the 400 "not ready"
    // branch is never reached and the assertion would be measuring the gate.
    const downloadHeader = await srv.verified(studentToken, 'data.download', {
      password: 'Password123', params: { jobId }
    });
    const res = await srv.call('GET', `/api/privacy/export/download/${jobId}`, undefined, studentToken, downloadHeader);
    expect(res.status).toBe(400);
  });

  /**
   * A provider-only account can exercise its own data-access right.
   *
   * The new gate must not become the reason somebody cannot get a copy of their
   * own records: an account with no password satisfies it by re-authenticating at
   * its provider, exactly as it does for deletion and the rest.
   */
  it('lets a provider-only account export via OAuth re-consent', async () => {
    const username = `exportprov_${Math.random().toString(36).slice(2, 7)}`;
    const email = `${username}@example.org`;
    const sub = `sub-${username}`;

    const urlRes = await srv.call('POST', '/api/oauth/google/url', {
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'Export Provider', username, role: 'student', grade: '10', skills: [] }
    });
    expect(urlRes.status).toBe(200);
    const state = new URL(urlRes.body.url).searchParams.get('state');
    const nonceCookie = (urlRes.headers.get('set-cookie') || '').match(/(wev_oauth_state_[a-f0-9]{8}=[^;]+)/)?.[1];

    const cbRes = await fetch(`${srv.base}/api/oauth/google/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: nonceCookie },
      body: JSON.stringify({
        code: JSON.stringify({ email, sub, name: 'Export Provider', emailVerified: true }),
        state
      })
    });
    expect(cbRes.status).toBe(200);
    const cookie = (cbRes.headers.get('set-cookie') || '').match(/wev_session=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();

    const challengeId = await srv.stepUpOAuth(cookie, 'data.export', { sub });
    const res = await requestExport(cookie, challengeId);
    expect(res.status).toBe(202);
  });
});
