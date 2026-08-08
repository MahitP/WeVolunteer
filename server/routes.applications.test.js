import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

// One server for the whole file: startTestServer() dynamically imports the
// module-cached db.js, so a second call would silently reuse the first
// database. Every describe below shares this srv.
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('applications: withdrawal and re-application', () => {
  let studentToken, eventId, slotId;

  beforeAll(async () => {
    studentToken = await srv.login('leo.chen28@gmail.com');
    // Create a fresh open event with a future deadline rather than depending on
    // a seeded fixture — the seeded softball event has a fixed 2026-07-24
    // deadline that expires with the wall clock, which used to make this suite
    // fail once that date passed.
    const orgToken = await srv.login('jkatzenback@vikings.org');
    const start = new Date(Date.now() + 30 * 864e5).toISOString();
    const end = new Date(Date.now() + 30 * 864e5 + 108e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Withdrawal Test', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(),
      slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 3 }]
    }, orgToken);
    eventId = mk.body.id;
    slotId = (await srv.call('GET', '/api/events', undefined, studentToken)).body
      .find(e => e.id === eventId).slots[0].id;
  });

  const apply = () => srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, studentToken);
  const myApp = async () => {
    const apps = (await srv.call('GET', '/api/applications', undefined, studentToken)).body;
    return apps.find(a => a.slotId === slotId);
  };

  it('accepts the withdrawn status the client actually sends', async () => {
    await apply();
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'withdrawn' }, studentToken);
    expect(res.status).toBe(200);
  });

  it('records it as withdrawn, not rejected', async () => {
    expect((await myApp()).status).toBe('withdrawn');
  });

  it('lets the student re-apply to the same shift', async () => {
    const res = await apply();
    expect(res.status).toBe(201);
    expect((await myApp()).status).toBe('pending');
  });

  it('still blocks a duplicate application while one is live', async () => {
    const res = await apply();
    expect(res.status).toBe(400);
  });

  it('does not let a student withdraw someone elses application', async () => {
    const other = await srv.login('priya.patel.nhs@outlook.com');
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'withdrawn' }, other);
    expect(res.status).toBe(403);
  });

  it('does not let a student self-accept', async () => {
    const app = await myApp();
    const res = await srv.call('PATCH', `/api/applications/${app.id}`, { status: 'accepted' }, studentToken);
    expect(res.status).toBe(403);
  });
});

describe('applications: bulk organizer actions', () => {
  let orgToken;

  // Builds a fresh Auto Select event with one slot of the given capacity, has
  // `applicants` seeded students apply, and returns their pending application
  // ids. Auto Select (auto_approve) so a demotion exercises waitlist promotion.
  let eventOffset = 30; // Increment this so seeded events don't overlap
  const seedEvent = async (maxSpots, applicants) => {
    orgToken = await srv.login('jkatzenback@vikings.org');
    eventOffset += 1;
    const future = new Date(Date.now() + eventOffset * 864e5).toISOString();
    const futureEnd = new Date(Date.now() + eventOffset * 864e5 + 108e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Bulk Test', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + (eventOffset - 10) * 864e5).toISOString(), autoApprove: true,
      slots: [{ name: 'Shift', description: 'd', startDatetime: future, endDatetime: futureEnd, maxSpots }]
    }, orgToken);
    const evId = mk.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === evId).slots[0];
    const ids = [];
    for (const email of applicants) {
      const tok = await srv.login(email);
      await srv.call('POST', `/api/events/${evId}/apply`, { slotId: slot.id }, tok);
    }
    const apps = (await srv.call('GET', '/api/applications', undefined, orgToken)).body.filter(a => a.eventId === evId);
    for (const a of apps) ids.push(a.id);
    return { evId, slotId: slot.id, ids };
  };

  const statusById = async (evId, id) => {
    const apps = (await srv.call('GET', '/api/applications', undefined, orgToken)).body;
    return apps.find(a => a.id === id && a.eventId === evId)?.status;
  };

  it('bulk-accepts every named application', async () => {
    const { evId, ids } = await seedEvent(5, ['leo.chen28@gmail.com', 'priya.patel.nhs@outlook.com', 'emiller2027@gmail.com']);
    const res = await srv.call('PATCH', '/api/applications/bulk', { applicationIds: ids, status: 'accepted' }, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3);
    for (const id of ids) expect(await statusById(evId, id)).toBe('accepted');
  });

  it('hits the bulk handler, not the :id route (registration order)', async () => {
    // The :id route would return "Application not found" for id="bulk"; the bulk
    // handler validates the body instead. A 400 about applicationIds proves the
    // bulk route matched first.
    const res = await srv.call('PATCH', '/api/applications/bulk', { status: 'accepted' }, orgToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/applicationIds/);
  });

  it('refuses a student', async () => {
    const { ids } = await seedEvent(5, ['leo.chen28@gmail.com']);
    const studentToken = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('PATCH', '/api/applications/bulk', { applicationIds: ids, status: 'accepted' }, studentToken);
    expect(res.status).toBe(403);
  });

  it('rejects an invalid status', async () => {
    const { ids } = await seedEvent(5, ['leo.chen28@gmail.com']);
    const res = await srv.call('PATCH', '/api/applications/bulk', { applicationIds: ids, status: 'withdrawn' }, orgToken);
    expect(res.status).toBe(400);
  });

  it('applies nothing if any named application is invalid (atomic)', async () => {
    const mine = await seedEvent(5, ['leo.chen28@gmail.com']);
    // One good id plus one that does not exist: the whole batch must be refused,
    // and the good application must be left untouched rather than half-applied.
    const res = await srv.call('PATCH', '/api/applications/bulk',
      { applicationIds: [...mine.ids, 'app-does-not-exist'], status: 'accepted' }, orgToken);
    expect(res.status).toBe(404);
    expect(await statusById(mine.evId, mine.ids[0])).toBe('pending');
  });

  it('refuses a batch containing an application on an event the caller does not host', async () => {
    // Build a real event under a DIFFERENT organizer. rmiller starts unverified
    // and cannot create events, so approve them first as the admin.
    const adminTok = await srv.login('admin@example.gov');
    await srv.call('POST', '/api/admin/organizers/user-org-pending/approve', undefined, adminTok);
    const otherOrg = await srv.login('rmiller@sbpl.info');
    /**
     * Approval is no longer sufficient on its own (v1.2c).
     *
     * An admin approving an organizer says "we believe this person is who they
     * say they are"; it does not record the organizer's own undertaking about
     * handling students' contact details. Until the Organizer Agreement is
     * accepted, `event.create` is withheld — see server/organizerAgreement.js.
     *
     * Accepted through the real endpoint rather than by inserting a row, so this
     * setup exercises the same path a real organizer takes.
     */
    await srv.call('POST', '/api/legal/organizer-agreement/accept', { acknowledged: true }, otherOrg);
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Foreign', description: 'd', category: 'Other', location: 'Elsewhere',
      applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(),
      slots: [{ name: 'S', description: 'd', startDatetime: future, endDatetime: new Date(Date.now() + 30 * 864e5 + 108e5).toISOString(), maxSpots: 3 }]
    }, otherOrg);
    const foreignEv = mk.body.id;
    const foreignSlot = (await srv.call('GET', '/api/events', undefined, otherOrg)).body.find(e => e.id === foreignEv).slots[0].id;
    const stu = await srv.login('colin.carbin29@outlook.com');
    await srv.call('POST', `/api/events/${foreignEv}/apply`, { slotId: foreignSlot }, stu);
    const foreignApp = (await srv.call('GET', '/api/applications', undefined, otherOrg)).body
      .find(a => a.eventId === foreignEv);

    // jkatzenback tries to accept an application on rmiller's event.
    const mine = await seedEvent(5, ['leo.chen28@gmail.com']);
    const res = await srv.call('PATCH', '/api/applications/bulk',
      { applicationIds: [...mine.ids, foreignApp.id], status: 'accepted' }, orgToken);
    expect(res.status).toBe(403);
    // Neither the caller's own app nor the foreign one was touched.
    expect(await statusById(mine.evId, mine.ids[0])).toBe('pending');
    const foreignAfter = (await srv.call('GET', '/api/applications', undefined, otherOrg)).body
      .find(a => a.id === foreignApp.id);
    expect(foreignAfter.status).toBe('pending');
  });

  it('never exceeds slot capacity when accepting more than there is room for', async () => {
    const { evId, slotId, ids } = await seedEvent(2, ['leo.chen28@gmail.com', 'priya.patel.nhs@outlook.com', 'emiller2027@gmail.com', 'colin.carbin29@outlook.com']);
    const res = await srv.call('PATCH', '/api/applications/bulk', { applicationIds: ids, status: 'accepted' }, orgToken);
    expect(res.status).toBe(200);
    const accepted = (await srv.call('GET', '/api/applications', undefined, orgToken)).body
      .filter(a => a.eventId === evId && a.slotId === slotId && a.status === 'accepted');
    expect(accepted.length).toBe(2);
    expect(res.body.updated).toBe(2);
    expect(res.body.skipped.length).toBe(2);
  });
});

describe('applications: an organizer cannot reactivate a withdrawn application (P1-D)', () => {
  let orgToken, studentToken, evId, appId;

  // A student applies, is accepted, then withdraws — the setup an organizer
  // must not be able to silently reverse.
  const seedWithdrawn = async () => {
    orgToken = await srv.login('jkatzenback@vikings.org');
    studentToken = await srv.login('leo.chen28@gmail.com');
    const future = new Date(Date.now() + 40 * 864e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Withdraw Test', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 30 * 864e5).toISOString(),
      slots: [{ name: 'Shift', description: 'd', startDatetime: future, endDatetime: new Date(Date.now() + 40 * 864e5 + 108e5).toISOString(), maxSpots: 3 }]
    }, orgToken);
    evId = mk.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === evId).slots[0];
    await srv.call('POST', `/api/events/${evId}/apply`, { slotId: slot.id }, studentToken);
    appId = (await srv.call('GET', '/api/applications', undefined, orgToken)).body.find(a => a.eventId === evId).id;
    await srv.call('PATCH', `/api/applications/${appId}`, { status: 'accepted' }, orgToken);
    await srv.call('PATCH', `/api/applications/${appId}`, { status: 'withdrawn' }, studentToken);
  };

  const currentStatus = async () =>
    (await srv.call('GET', '/api/applications', undefined, orgToken)).body.find(a => a.id === appId)?.status;

  it('refuses a single accept of a withdrawn application', async () => {
    await seedWithdrawn();
    expect(await currentStatus()).toBe('withdrawn');
    const res = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'accepted' }, orgToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('withdrawn');
    expect(await currentStatus()).toBe('withdrawn');
  });

  it('refuses a single waitlist of a withdrawn application', async () => {
    await seedWithdrawn();
    const res = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'waitlisted' }, orgToken);
    expect(res.status).toBe(409);
    expect(await currentStatus()).toBe('withdrawn');
  });

  it('refuses a bulk action that includes a withdrawn application, and touches nothing', async () => {
    await seedWithdrawn();
    // Add a second, live application to the same batch to prove atomicity.
    const other = await srv.login('priya.patel.nhs@outlook.com');
    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === evId).slots[0];
    await srv.call('POST', `/api/events/${evId}/apply`, { slotId: slot.id }, other);
    const liveApp = (await srv.call('GET', '/api/applications', undefined, orgToken)).body
      .find(a => a.eventId === evId && a.status === 'pending');

    const res = await srv.call('PATCH', '/api/applications/bulk',
      { applicationIds: [appId, liveApp.id], status: 'accepted' }, orgToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('withdrawn');
    // Neither the withdrawn one nor the live one changed.
    expect(await currentStatus()).toBe('withdrawn');
    const liveAfter = (await srv.call('GET', '/api/applications', undefined, orgToken)).body.find(a => a.id === liveApp.id);
    expect(liveAfter.status).toBe('pending');
  });

  it('still lets the student re-apply themselves', async () => {
    await seedWithdrawn();
    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === evId).slots[0];
    const res = await srv.call('POST', `/api/events/${evId}/apply`, { slotId: slot.id }, studentToken);
    expect(res.status).toBe(201);
    expect(await currentStatus()).toBe('pending');
  });

  describe('Schedule Conflicts', () => {
    it('prevents applying for an overlapping shift', async () => {
      const stToken = await srv.login('leo.chen28@gmail.com');
      const oToken = await srv.login('jkatzenback@vikings.org');

      // Create first event
      const res1 = await srv.call('POST', '/api/events', {
        title: 'Morning Shift', description: 'desc', category: 'Other', location: 'Hall',
        applicationDeadline: new Date(Date.now() + 2 * 864e5).toISOString(),
        slots: [{ name: 'Slot A', description: 'desc', startDatetime: new Date(Date.now() + 5 * 864e5).toISOString(), endDatetime: new Date(Date.now() + 5 * 864e5 + 7200e3).toISOString(), maxSpots: 5 }]
      }, oToken);
      const ev1 = res1.body.id;
      const slot1 = (await srv.call('GET', '/api/events', undefined, oToken)).body.find(e => e.id === ev1).slots[0];

      // Apply and get accepted
      await srv.call('POST', `/api/events/${ev1}/apply`, { slotId: slot1.id }, stToken);
      const app1 = (await srv.call('GET', '/api/applications', undefined, oToken)).body.find(a => a.eventId === ev1).id;
      await srv.call('PATCH', `/api/applications/${app1}`, { status: 'accepted' }, oToken);

      // Create overlapping event
      const res2 = await srv.call('POST', '/api/events', {
        title: 'Overlapping Shift', description: 'desc', category: 'Other', location: 'Hall',
        applicationDeadline: new Date(Date.now() + 2 * 864e5).toISOString(),
        slots: [{ name: 'Slot B', description: 'desc', startDatetime: new Date(Date.now() + 5 * 864e5 + 3600e3).toISOString(), endDatetime: new Date(Date.now() + 5 * 864e5 + 10800e3).toISOString(), maxSpots: 5 }]
      }, oToken);
      const ev2 = res2.body.id;
      const slot2 = (await srv.call('GET', '/api/events', undefined, oToken)).body.find(e => e.id === ev2).slots[0];

      // Attempt to apply
      const conflictRes = await srv.call('POST', `/api/events/${ev2}/apply`, { slotId: slot2.id }, stToken);
      expect(conflictRes.status).toBe(409);
      expect(conflictRes.body.error).toBe('Schedule conflict detected');
      expect(conflictRes.body.conflict).toBeDefined();
    });

    it('allows applying for an overlapping shift if overrideConflict is true', async () => {
      const stToken = await srv.login('leo.chen28@gmail.com');
      const oToken = await srv.login('jkatzenback@vikings.org');

      // Create first event
      const res1 = await srv.call('POST', '/api/events', {
        title: 'Morning Shift 2', description: 'desc', category: 'Other', location: 'Hall',
        applicationDeadline: new Date(Date.now() + 2 * 864e5).toISOString(),
        slots: [{ name: 'Slot A2', description: 'desc', startDatetime: new Date(Date.now() + 5 * 864e5).toISOString(), endDatetime: new Date(Date.now() + 5 * 864e5 + 7200e3).toISOString(), maxSpots: 5 }]
      }, oToken);
      const ev1 = res1.body.id;
      const slot1 = (await srv.call('GET', '/api/events', undefined, oToken)).body.find(e => e.id === ev1).slots[0];

      // Apply
      await srv.call('POST', `/api/events/${ev1}/apply`, { slotId: slot1.id }, stToken);

      // Create overlapping event
      const res2 = await srv.call('POST', '/api/events', {
        title: 'Overlapping Shift 2', description: 'desc', category: 'Other', location: 'Hall',
        applicationDeadline: new Date(Date.now() + 2 * 864e5).toISOString(),
        slots: [{ name: 'Slot B2', description: 'desc', startDatetime: new Date(Date.now() + 5 * 864e5 + 3600e3).toISOString(), endDatetime: new Date(Date.now() + 5 * 864e5 + 10800e3).toISOString(), maxSpots: 5 }]
      }, oToken);
      const ev2 = res2.body.id;
      const slot2 = (await srv.call('GET', '/api/events', undefined, oToken)).body.find(e => e.id === ev2).slots[0];

      // Override the conflict
      const overrideRes = await srv.call('POST', `/api/events/${ev2}/apply`, { slotId: slot2.id, overrideConflict: true }, stToken);
      expect(overrideRes.status).toBe(201);
      
      // Verify conflict logged in GET /applications
      const allApps = (await srv.call('GET', '/api/applications', undefined, oToken)).body;
      const conflictApp = allApps.find(a => a.eventId === ev2 && a.hasConflict === true);
      expect(conflictApp).toBeDefined();
    });
  });
});

// Payload-level coverage for GET /api/applications' capability-scoping
// cascade. The matrix test only ever asserts a status code, which is exactly
// what let a real content bug through: an earlier ordering of this cascade
// tested the narrowest capability first, so super_admin's '*' wildcard
// matched it and the platform owner saw only "their own" (near-empty)
// applications instead of everything, same as admin. A status-code check
// can't see that — only comparing response bodies can.
describe('applications: GET /api/applications payload scoping by capability', () => {
  it('unscopes admin and super_admin equally, scopes a student to their own rows, and denies partner entirely', async () => {
    const adminToken = await srv.login('admin@example.gov');
    const studentToken = await srv.login('leo.chen28@gmail.com');
    const orgToken = await srv.login('jkatzenback@vikings.org');

    const { db } = await import('./db.js');
    const student = db.prepare('SELECT id FROM users WHERE email = ?').get('leo.chen28@gmail.com');

    // Give the student at least one application to see, independent of
    // whatever earlier describes in this file already created.
    const start = new Date(Date.now() + 60 * 864e5).toISOString();
    const end = new Date(Date.now() + 60 * 864e5 + 108e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Payload Scoping Test', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 50 * 864e5).toISOString(),
      slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 3 }]
    }, orgToken);
    const eventId = mk.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, studentToken)).body
      .find(e => e.id === eventId).slots[0];
    await srv.call('POST', `/api/events/${eventId}/apply`, { slotId: slot.id }, studentToken);

    // super_admin and partner have no seeded fixture: promote throwaway
    // accounts, the same way authz.matrix.test.js does.
    const superSigned = await srv.signupConfirmed({
      name: 'Payload Super', username: 'payload_super_admin', email: 'payload-super@test.local',
      password: 'Password123', grade: 'Adult', role: 'student'
    });
    db.prepare('UPDATE users SET role = ?, verified = 1 WHERE id = ?').run('super_admin', superSigned.user.id);
    const superToken = superSigned.cookie;

    const partnerSigned = await srv.signupConfirmed({
      name: 'Payload Partner', username: 'payload_partner', email: 'payload-partner@test.local',
      password: 'Password123', grade: 'Adult', role: 'student'
    });
    db.prepare('UPDATE users SET role = ?, verified = 1 WHERE id = ?').run('partner', partnerSigned.user.id);
    const partnerToken = partnerSigned.cookie;

    const adminRes = await srv.call('GET', '/api/applications', undefined, adminToken);
    const superRes = await srv.call('GET', '/api/applications', undefined, superToken);
    const studentRes = await srv.call('GET', '/api/applications', undefined, studentToken);
    const partnerRes = await srv.call('GET', '/api/applications', undefined, partnerToken);

    expect(adminRes.status).toBe(200);
    expect(superRes.status).toBe(200);
    expect(studentRes.status).toBe(200);
    expect(partnerRes.status).toBe(200);

    // admin and super_admin both see the whole, unscoped table — the
    // wildcard must resolve to the SAME (broadest) branch as admin, not the
    // narrower "own rows" branch a naive most-narrow-first cascade gives it.
    expect(adminRes.body.length).toBeGreaterThan(0);
    expect(superRes.body.length).toBe(adminRes.body.length);

    // The student sees only their own applications — never the whole table.
    expect(studentRes.body.length).toBeGreaterThan(0);
    for (const app of studentRes.body) {
      expect(app.userId).toBe(student.id);
    }
    expect(studentRes.body.length).toBeLessThan(adminRes.body.length);

    // partner is denied entirely — an explicit empty result, not the
    // every-application data leak it used to fall into (deliberate
    // correction, v1.2a).
    expect(partnerRes.body).toEqual([]);
  });
});

/**
 * Admin-tier oversight of application status (v1.2a).
 *
 * Both admin-tier roles were locked out of PATCH /api/applications/:id, and the
 * authorization matrix recorded super_admin as allowed and PASSED — because the
 * row used a fake application id with no `status`, so the request 400'd at
 * validation before the db read and before the ownership check ever ran.
 *
 *   - super_admin satisfied `applicant.review` through the '*' wildcard, entered
 *     the organizer branch, and was then denied by
 *     `app.organizer_id !== req.principal.userId` on every event it did not host
 *     — i.e. on every event, since the platform owner hosts nothing.
 *   - admin held neither `applicant.review` nor `application.withdraw`, so it
 *     fell through the whole cascade to the final explicit 403.
 *
 * The events here are hosted by the organizer fixture, and neither admin
 * account hosts anything, so "an application they do not host" is exactly what
 * is being exercised. A status-code-only assertion would not be enough: the
 * point is that the change actually lands, so each case reads the row back.
 */
describe('applications: admin-tier oversight of PATCH /api/applications/:id', () => {
  let orgToken, studentToken, adminToken, superToken, partnerToken;
  let appId, studentId;

  beforeAll(async () => {
    orgToken = await srv.login('jkatzenback@vikings.org');
    studentToken = await srv.login('leo.chen28@gmail.com');
    adminToken = await srv.login('admin@example.gov');

    const { db } = await import('./db.js');
    studentId = db.prepare('SELECT id FROM users WHERE email = ?').get('leo.chen28@gmail.com').id;

    const superSigned = await srv.signupConfirmed({
      name: 'Oversight Super', username: 'oversight_super', email: 'oversight-super@test.local',
      password: 'Password123', grade: 'Adult', role: 'student'
    });
    db.prepare('UPDATE users SET role = ?, verified = 1 WHERE id = ?').run('super_admin', superSigned.user.id);
    /* Promoted by SQL, so `login()`'s two-factor enrolment never ran and
       `requireCap` would refuse this account before any capability is read. */
    const { enrolTwoFactor } = await import('./testServer.js');
    await enrolTwoFactor(db, 'oversight-super@test.local');
    superToken = superSigned.cookie;

    const partnerSigned = await srv.signupConfirmed({
      name: 'Oversight Partner', username: 'oversight_partner', email: 'oversight-partner@test.local',
      password: 'Password123', grade: 'Adult', role: 'student'
    });
    db.prepare('UPDATE users SET role = ?, verified = 1 WHERE id = ?').run('partner', partnerSigned.user.id);
    partnerToken = partnerSigned.cookie;

    // An event hosted by the organizer fixture, with one pending application.
    const start = new Date(Date.now() + 90 * 864e5).toISOString();
    const end = new Date(Date.now() + 90 * 864e5 + 108e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Oversight Test', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 80 * 864e5).toISOString(),
      slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 3 }]
    }, orgToken);
    const slot = (await srv.call('GET', '/api/events', undefined, studentToken)).body
      .find(e => e.id === mk.body.id).slots[0];
    await srv.call('POST', `/api/events/${mk.body.id}/apply`, { slotId: slot.id }, studentToken);

    appId = db.prepare('SELECT id FROM applications WHERE user_id = ? AND slot_id = ?')
      .get(studentId, slot.id).id;
  });

  const statusOf = async () => {
    const { db } = await import('./db.js');
    return db.prepare('SELECT status FROM applications WHERE id = ?').get(appId).status;
  };

  it('lets an admin waitlist an application on an event it does not host', async () => {
    const res = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'waitlisted' }, adminToken);
    expect(res.status).toBe(200);
    expect(await statusOf()).toBe('waitlisted');
  });

  it('lets a super_admin accept the same application', async () => {
    const res = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'accepted' }, superToken);
    expect(res.status).toBe(200);
    expect(await statusOf()).toBe('accepted');
  });

  it('still lets the hosting organizer manage it', async () => {
    // Rejected, not waitlisted: the row is 'accepted' at this point, and
    // accepted -> waitlisted frees a spot, which promoteFromWaitlist then
    // refills with the only queued application — this same row, straight back
    // to 'accepted'. That is existing, correct behaviour; it just makes
    // 'waitlisted' the wrong assertion to hang an authorization test on.
    const res = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'rejected' }, orgToken);
    expect(res.status).toBe(200);
    expect(await statusOf()).toBe('rejected');
  });

  it('denies a student setting a management status, and a partner entirely', async () => {
    const before = await statusOf();

    // The student owns this application, but `application.withdraw` only ever
    // permits withdrawal — never accept/waitlist/reject on their own row.
    const studentRes = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'accepted' }, studentToken);
    expect(studentRes.status).toBe(403);

    // partner holds none of the three capabilities the route's gate names, so
    // it is refused at the middleware, before the handler runs.
    const partnerRes = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'accepted' }, partnerToken);
    expect(partnerRes.status).toBe(403);

    expect(await statusOf(), 'a denied request must not change the row').toBe(before);
  });

  it('lets an admin act through the bulk route on an event it does not host', async () => {
    const res = await srv.call('PATCH', '/api/applications/bulk',
      { applicationIds: [appId], status: 'waitlisted' }, adminToken);
    expect(res.status).toBe(200);
    expect(await statusOf()).toBe('waitlisted');
  });

  it('denies a student and a partner on the bulk route', async () => {
    const before = await statusOf();
    for (const token of [studentToken, partnerToken]) {
      const res = await srv.call('PATCH', '/api/applications/bulk',
        { applicationIds: [appId], status: 'accepted' }, token);
      expect(res.status).toBe(403);
    }
    expect(await statusOf()).toBe(before);
  });
});
