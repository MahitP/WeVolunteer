import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * What a STUDENT who helps run a club may read about the people applying.
 *
 * The Student Organizer Agreement (§3, "What you can see") promises applicants
 * that a Student Organizer sees their grade and school "where they chose to
 * share it", and the Privacy Policy says other signed-in students see only what
 * the profile visibility setting allows. The owner's ruling 17 says the same
 * thing about grade in private mode: hidden from other students.
 *
 * The applicant list did not ask. Every reader the organization scope admitted
 * — a Student Organizer, a student club manager — was served the school, the
 * grade, the bio and the whole service record of every applicant, private or
 * not, while the same reader opening that applicant's profile was refused all
 * of it. The list was the effective policy and the profile's refusal cosmetic:
 * the shape `profileSerializer.js` describes as the recurring bug, a second
 * endpoint returning the same rows that nobody thought of as a profile.
 *
 * The rule now, for a reader whose access comes from helping run the club:
 *   - bio, school and grade follow `profile_visibility`, exactly as the
 *     directory decides it ('friends' opens to an accepted friend);
 *   - the service figures follow `hours_visibility`, and the row says WHY they
 *     are absent rather than reading as a volunteer with no record.
 *
 * An adult organizer (`applicant.review`) is unchanged: the Organizer Agreement
 * §2 gives them the grade and whatever the applicant put on their profile.
 */

const OWNER = 'jordan.whitfield@example.org';  // adult organizer; manages the club
const HELPER = 'leo.chen@example.com';         // student; Student Organizer
const MANAGER = 'ethan.miller@example.com';    // student; club manager

const SERVICE_FIELDS = [
  'volunteeredHours', 'completedEvents', 'lastVolunteeredDate',
  'eventsSignedUp', 'eventsAttended', 'eventsAbsent', 'eventsAwaitingRecord',
];

describe('applicant particulars, read by students who help run a club', () => {
  let srv; let db;
  let owner; let helper; let manager;
  let helperId; let managerId;
  let orgKey;
  let eventId;
  const applicant = {};   // label -> { id, cookie }

  const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;

  const seat = async (organizationId, userId, role = 'member') => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role
    `).run(organizationId, userId, role, new Date().toISOString());
  };

  /**
   * A fresh student with every particular filled in, so an absent field can
   * only mean "withheld" and never "never entered".
   */
  const makeApplicant = async (label, settings) => {
    const { cookie, user } = await srv.signupConfirmed({
      email: `applicant.${label}@example.org`, password: 'Password123',
      name: `Applicant ${label}`, username: `applicant_${label}`,
      role: 'student', grade: '9', school: `${label} High School`,
    });
    const set = await srv.call('PATCH', '/api/auth/profile',
      { bio: `The ${label} applicant's bio.`, ...settings }, cookie);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    applicant[label] = { id: user.id, cookie };
  };

  const listAs = async (session) => {
    const res = await srv.call('GET', '/api/applications', undefined, session);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.filter(a => a.eventId === eventId);
  };
  const rowFor = (rows, label) => rows.find(a => a.userId === applicant[label].id)?.volunteer;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    owner = await srv.login(OWNER);
    helper = await srv.login(HELPER);
    manager = await srv.login(MANAGER);
    helperId = await idOf(helper);
    managerId = await idOf(manager);
    const ownerId = await idOf(owner);

    const made = await srv.call('POST', '/api/organizations', {
      name: `Applicant Privacy Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'An organization used by the applicant-privacy tests.',
    }, owner);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const orgId = made.body.organization.id;
    orgKey = made.body.organization.slug;

    await seat(orgId, ownerId, 'manager');
    await seat(orgId, helperId, 'member');
    await seat(orgId, managerId, 'member');
    /* Through the real route, so the capability lifecycle runs; then the
       agreement, which is what releases the capabilities promotion grants. */
    for (const [userId, memberRole] of [[helperId, 'student_organizer'], [managerId, 'manager']]) {
      const res = await srv.call('PATCH', `/api/organizations/${orgKey}/members/${userId}`, { memberRole }, owner);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    for (const session of [helper, manager]) {
      const res = await srv.call('POST', '/api/legal/student-organizer-agreement/accept', { acknowledged: true }, session);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    /* The Student Organizer HOSTS the event; the manager reaches it as a
       manager of its club; the adult organizer reaches it the same way. */
    const created = await srv.call('POST', '/api/events', {
      title: 'Applicant privacy fixture',
      description: 'An event used by the applicant-privacy tests.',
      category: 'Other', location: 'Somewhere',
      organizationId: orgId,
      applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
      slots: [{
        name: 'Shift', description: '',
        startDatetime: new Date(Date.now() + 6 * 86400000).toISOString(),
        endDatetime: new Date(Date.now() + 6 * 86400000 + 3600000).toISOString(),
        maxSpots: 10, hoursAwarded: 1,
      }],
    }, helper);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    eventId = created.body.id;
    const slotId = (await db.prepare('SELECT id FROM slots WHERE event_id = ?').get(eventId)).id;

    await makeApplicant('private', { profileVisibility: 'private', hoursVisibility: 'private' });
    await makeApplicant('public', { profileVisibility: 'public', hoursVisibility: 'public' });
    await makeApplicant('friend', { profileVisibility: 'friends', hoursVisibility: 'public' });
    await makeApplicant('stranger', { profileVisibility: 'friends', hoursVisibility: 'public' });

    /* An accepted friendship with the Student Organizer, through the real
       routes: one side asks, the other adds back. */
    const asked = await srv.call('POST', `/api/users/${helperId}/friend`, undefined, applicant.friend.cookie);
    expect(asked.status, JSON.stringify(asked.body)).toBeLessThan(300);
    const added = await srv.call('POST', `/api/users/${applicant.friend.id}/friend`, undefined, helper);
    expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);

    for (const { id, cookie } of Object.values(applicant)) {
      const applied = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, cookie);
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      const appId = (await db.prepare('SELECT id FROM applications WHERE user_id = ? AND event_id = ?')
        .get(id, eventId)).id;
      const accepted = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'accepted' }, helper);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    }
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  describe('GET /api/applications', () => {
    for (const [who, session] of [['a Student Organizer', () => helper], ['a student club manager', () => manager]]) {
      it(`withholds a private applicant's bio, school and grade from ${who}`, async () => {
        const v = rowFor(await listAs(session()), 'private');
        expect(v).toBeTruthy();
        expect(v).not.toHaveProperty('bio');
        expect(v).not.toHaveProperty('school');
        expect(v).not.toHaveProperty('grade');
        // The baseline survives: they still have to know who applied.
        expect(v.name).toBe('Applicant private');
      });

      it(`withholds a private service record from ${who}, and says so`, async () => {
        const v = rowFor(await listAs(session()), 'private');
        for (const field of SERVICE_FIELDS) expect(v, field).not.toHaveProperty(field);
        /* Not a volunteer with no record — a volunteer who keeps it private.
           The row has to be able to tell those apart. */
        expect(v.serviceVisibility?.hours).toBe('private');
      });

      it(`shows ${who} everything a public applicant shares`, async () => {
        const v = rowFor(await listAs(session()), 'public');
        expect(v.bio).toBe("The public applicant's bio.");
        expect(v.school).toBe('public High School');
        expect(v.grade).toBe('9');
        for (const field of SERVICE_FIELDS) expect(v, field).toHaveProperty(field);
        expect(v.serviceVisibility?.hours).toBe('visible');
      });
    }

    it('opens a friends-only profile to an accepted friend, and to nobody else', async () => {
      const rows = await listAs(helper);
      expect(rowFor(rows, 'friend').school).toBe('friend High School');
      expect(rowFor(rows, 'friend').grade).toBe('9');
      expect(rowFor(rows, 'stranger')).not.toHaveProperty('school');
      expect(rowFor(rows, 'stranger')).not.toHaveProperty('grade');

      // The manager is nobody's friend here.
      expect(rowFor(await listAs(manager), 'friend')).not.toHaveProperty('school');
    });

    it('leaves an adult organizer with everything, as the Organizer Agreement describes', async () => {
      const v = rowFor(await listAs(owner), 'private');
      expect(v.bio).toBe("The private applicant's bio.");
      expect(v.school).toBe('private High School');
      expect(v.grade).toBe('9');
      for (const field of SERVICE_FIELDS) expect(v, field).toHaveProperty(field);
      expect(v.serviceVisibility?.hours).toBe('visible');
    });
  });

  describe('the other surfaces that hand event staff the same rows', () => {
    const volunteerIn = (applications, label) =>
      applications.find(a => a.userId === applicant[label].id)?.volunteer;

    it('GET /api/events/:id withholds a private grade and school from student staff', async () => {
      for (const session of [helper, manager]) {
        const res = await srv.call('GET', `/api/events/${eventId}`, undefined, session);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const v = volunteerIn(res.body.applications, 'private');
        expect(v).not.toHaveProperty('grade');
        expect(v).not.toHaveProperty('school');
        expect(volunteerIn(res.body.applications, 'public').school).toBe('public High School');
      }
      const adult = await srv.call('GET', `/api/events/${eventId}`, undefined, owner);
      expect(volunteerIn(adult.body.applications, 'private').grade).toBe('9');
      expect(volunteerIn(adult.body.applications, 'private').school).toBe('private High School');
    });

    it('GET /api/events/:id/attendees withholds a private grade and school from student staff', async () => {
      const res = await srv.call('GET', `/api/events/${eventId}/attendees`, undefined, helper);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = res.body.attendees.find(a => a.id === applicant.private.id);
      expect(row).not.toHaveProperty('grade');
      expect(row).not.toHaveProperty('school');
      expect(res.body.attendees.find(a => a.id === applicant.public.id).school).toBe('public High School');

      const adult = await srv.call('GET', `/api/events/${eventId}/attendees`, undefined, owner);
      expect(adult.body.attendees.find(a => a.id === applicant.private.id).school).toBe('private High School');
    });

    it('the roster export leaves a private grade and school blank for student staff', async () => {
      /* `srv.call` parses JSON only, so the CSV is read from the response
         directly, on the same session cookie. */
      const rosterAs = async (session) => {
        const res = await fetch(`${srv.base}/api/events/${eventId}/roster.csv`,
          { headers: { Cookie: `wev_session=${session}` } });
        expect(res.status).toBe(200);
        return res.text();
      };
      const lineFor = (csv, name) => csv.split('\n').find(l => l.includes(name));

      const csv = await rosterAs(helper);
      expect(lineFor(csv, 'Applicant private')).toBeTruthy();
      expect(lineFor(csv, 'Applicant private')).not.toContain('private High School');
      expect(lineFor(csv, 'Applicant public')).toContain('public High School');

      expect(lineFor(await rosterAs(owner), 'Applicant private')).toContain('private High School');
    });
  });
});
