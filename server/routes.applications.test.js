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
  const seedEvent = async (maxSpots, applicants) => {
    orgToken = await srv.login('jkatzenback@vikings.org');
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const futureEnd = new Date(Date.now() + 30 * 864e5 + 108e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Bulk Test', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(), autoApprove: true,
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
});
