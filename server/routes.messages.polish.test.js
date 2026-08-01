import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('messaging UX polish', () => {
  let orgToken, studentToken;
  let evId, slotId, studentId, orgId;
  let conversationId;

  beforeAll(async () => {
    orgToken = await srv.login('jkatzenback@vikings.org');
    studentToken = await srv.login('leo.chen28@gmail.com');
    studentId = (await srv.call('GET', '/api/users/me', undefined, studentToken)).body.id;
    orgId = (await srv.call('GET', '/api/users/me', undefined, orgToken)).body.id;

    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'UX Polish Event', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(),
      slots: [{ name: 'Shift', description: 'd', startDatetime: future, endDatetime: new Date(Date.now() + 30 * 864e5 + 108e5).toISOString(), maxSpots: 5 }]
    }, orgToken);
    
    evId = mk.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === evId).slots[0];
    
    await srv.call('POST', `/api/events/${evId}/apply`, { slotId: slot.id }, studentToken);
  });

  it('opens conversation', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: evId, studentId }, studentToken);
    expect(res.status).toBe(200);
    conversationId = res.body.conversation.id;
  });

  it('rate limits sender if sending > 20 messages per minute', async () => {
    // Send 20 messages successfully
    for (let i = 0; i < 20; i++) {
      const res = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`, { body: `Spam ${i}` }, studentToken);
      expect(res.status).toBe(201);
    }

    // 21st message should fail with 429
    const limitRes = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`, { body: 'One too many' }, studentToken);
    
    expect(limitRes.status).toBe(429);
    expect(limitRes.body.error).toMatch(/too quickly/i);
  });

  it('read receipts: other user reads message and updates lastReadAt', async () => {
    // Organizer reads the conversation
    const readRes = await srv.call('POST', `/api/messages/conversations/${conversationId}/read`, {}, orgToken);
    expect(readRes.status).toBe(200);

    // Now student fetches conversation list, should see organizer read it
    const listRes = await srv.call('GET', '/api/messages/conversations', undefined, studentToken);

    expect(listRes.status).toBe(200);
    const convo = listRes.body.conversations.find(c => c.id === conversationId);
    expect(convo.otherParticipant).toBeDefined();
    expect(convo.otherParticipant.lastReadAt).toBeDefined();
    expect(convo.otherParticipant.lastReadAt).not.toBeNull();
  });
});

/**
 * GET /api/messages/users/search is result scoping (Task 7d): the query that
 * runs is chosen by `can(req.principal, ...)` instead of a role string, but
 * WHICH rows come back still has to match pre-conversion behaviour exactly —
 * the authz matrix only asserts status codes, so a scoping regression here
 * (like the Task 7b `applicant.review`/`application.withdraw` cascade bug)
 * would be invisible to it. These assert the actual payload per role.
 */
describe('messages/users/search result scoping (Task 7d)', () => {
  let studentToken, orgToken, adminToken, partnerToken;

  beforeAll(async () => {
    studentToken = await srv.login('leo.chen28@gmail.com'); // applied to event-softball (user-org-1)
    orgToken = await srv.login('jkatzenback@vikings.org');  // hosts event-softball
    adminToken = await srv.login('admin@example.gov');

    const partnerSigned = await srv.signupConfirmed({
      name: 'Search Partner', username: 'search_partner_7d', email: 'search-partner-7d@test.local',
      password: 'Password123', grade: 'Adult', role: 'student'
    });
    const { db } = await import('./db.js');
    db.prepare("UPDATE users SET role = 'partner' WHERE email = ?").run('search-partner-7d@test.local');
    partnerToken = partnerSigned.cookie;
  });

  it('lets a student find the organizer of an event they applied to', async () => {
    const res = await srv.call('GET', '/api/messages/users/search?q=katzenback', undefined, studentToken);
    expect(res.status).toBe(200);
    expect(res.body.users.map(u => u.id)).toContain('user-org-1');
  });

  it('does not let a student find another student via this search', async () => {
    const res = await srv.call('GET', '/api/messages/users/search?q=chen', undefined, studentToken);
    expect(res.status).toBe(200);
    // Leo Chen (self) never has an event where they are the organizer, so
    // searching their own name from the student branch (which only ever
    // queries organizers) must not return themselves or anyone else.
    expect(res.body.users.map(u => u.id)).not.toContain('user-student-1');
  });

  it('lets the hosting organizer find an applicant to their event', async () => {
    const res = await srv.call('GET', '/api/messages/users/search?q=leo', undefined, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.users.map(u => u.id)).toContain('user-student-1');
  });

  it('lets an admin reach the staff-style query, not the empty/denied branch', async () => {
    // Admin lacks `applicant.review` (that capability is organizer-only in
    // authz.js) but must still land in the staff branch via `event.moderate`
    // — the same branch organizer reaches — because the original
    // `role === 'organizer' || role === 'admin'` check put both there.
    //
    // Admin has no `event.create` capability (confirmed in eventRoutes.js's
    // own matrix row), so an event "hosted by" the admin fixture is inserted
    // directly, the same way other suites (e.g. routes.recommendations.test.js)
    // build fixtures outside the capability system rather than through it.
    const { db } = await import('./db.js');
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get().id;
    const now = new Date();
    const future = new Date(now.getTime() + 40 * 864e5).toISOString();
    const futureEnd = new Date(now.getTime() + 40 * 864e5 + 108e5).toISOString();
    const deadline = new Date(now.getTime() + 35 * 864e5).toISOString();

    db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, created_at)
      VALUES ('event-admin-search-7d', 'Admin-hosted event for search scoping', 'd', 'Other', 'Hall', ?, ?, 'open', ?)
    `).run(deadline, adminId, now.toISOString());
    db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES ('slot-admin-search-7d', 'event-admin-search-7d', 'Shift', 'd', ?, ?, 5)
    `).run(future, futureEnd);

    const applyRes = await srv.call('POST', '/api/events/event-admin-search-7d/apply', { slotId: 'slot-admin-search-7d' }, studentToken);
    expect(applyRes.status).toBe(201);

    const res = await srv.call('GET', '/api/messages/users/search?q=chen', undefined, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.users.map(u => u.id)).toContain('user-student-1');
  });

  it('gives a partner an explicit empty result rather than falling through to an unscoped search', async () => {
    const res = await srv.call('GET', '/api/messages/users/search?q=leo', undefined, partnerToken);
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });
});

/**
 * POST /api/messages/conversations/resolve, all five roles (messaging.js fix,
 * v1.2a follow-up).
 *
 * Before this fix, server/messaging.js's eligibleRelationship() gated this
 * route with raw `actor.role === 'student' / 'organizer' / 'admin'` checks and
 * an unconditional `else { 403 }` — so super_admin and partner both fell into
 * that else and were denied outright, the exact "add a role, silently deny it
 * everywhere" defect the rest of the v1.2a spine exists to eliminate. This
 * describe block is the regression test for the capability-based rewrite:
 * student/organizer/admin keep their existing behaviour, super_admin gains
 * admin-equivalent access, and partner stays denied.
 */
describe('messages/conversations/resolve capability walkthrough (v1.2a messaging.js fix)', () => {
  let studentToken, orgToken, adminToken, partnerToken, superAdminToken;
  let studentId, hostedEventId, unhostedEventId;

  beforeAll(async () => {
    studentToken = await srv.login('leo.chen28@gmail.com');
    orgToken = await srv.login('jkatzenback@vikings.org');
    adminToken = await srv.login('admin@example.gov');

    const partnerSigned = await srv.signupConfirmed({
      name: 'Resolve Partner', username: 'resolve_partner_7e', email: 'resolve-partner-7e@test.local',
      password: 'Password123', grade: 'Adult', role: 'student'
    });
    const superAdminSigned = await srv.signupConfirmed({
      name: 'Resolve SuperAdmin', username: 'resolve_super_7e', email: 'resolve-superadmin-7e@test.local',
      password: 'Password123', grade: 'Adult', role: 'student'
    });
    const { db } = await import('./db.js');
    db.prepare("UPDATE users SET role = 'partner' WHERE email = ?").run('resolve-partner-7e@test.local');
    db.prepare("UPDATE users SET role = 'super_admin', verified = 1 WHERE email = ?").run('resolve-superadmin-7e@test.local');
    partnerToken = partnerSigned.cookie;
    superAdminToken = superAdminSigned.cookie;

    studentId = db.prepare("SELECT id FROM users WHERE email = 'leo.chen28@gmail.com'").get().id;
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@example.gov'").get().id;

    // An event the organizer fixture actually hosts, with a real application
    // from the student — exercises the organizer's ownership check and the
    // "an application must exist" rule for everyone except staff.
    const future = new Date(Date.now() + 25 * 864e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'Resolve Walkthrough Event', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: new Date(Date.now() + 20 * 864e5).toISOString(),
      slots: [{ name: 'Shift', description: 'd', startDatetime: future, endDatetime: new Date(Date.now() + 25 * 864e5 + 108e5).toISOString(), maxSpots: 5 }]
    }, orgToken);
    hostedEventId = mk.body.id;
    const slot = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === hostedEventId).slots[0];
    await srv.call('POST', `/api/events/${hostedEventId}/apply`, { slotId: slot.id }, studentToken);

    // A second event, hosted by someone else entirely (admin, who has no
    // event.create capability, so inserted directly — same pattern as the
    // admin-search-7d fixture above), with NO application from the student.
    // Only staff (admin/super_admin) should be able to reach a conversation
    // here at all: the organizer branch's ownership check must refuse it, and
    // the "must have applied" rule must refuse anyone but staff.
    unhostedEventId = 'event-resolve-unhosted-7e';
    const deadline = new Date(Date.now() + 30 * 864e5).toISOString();
    const futureStart = new Date(Date.now() + 35 * 864e5).toISOString();
    const futureEnd = new Date(Date.now() + 35 * 864e5 + 108e5).toISOString();
    db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, created_at)
      VALUES (?, 'Unhosted-by-organizer event', 'd', 'Other', 'Hall', ?, ?, 'open', ?)
    `).run(unhostedEventId, deadline, adminId, new Date().toISOString());
    db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES ('slot-resolve-unhosted-7e', ?, 'Shift', 'd', ?, ?, 5)
    `).run(unhostedEventId, futureStart, futureEnd);
  });

  it('student: opens a conversation about themselves once they have applied', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: hostedEventId, studentId }, studentToken);
    expect(res.status).toBe(200);
    expect(res.body.conversation.studentId).toBe(studentId);
  });

  it('organizer: opens a conversation with an applicant on the event they host', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: hostedEventId, studentId }, orgToken);
    expect(res.status).toBe(200);
    expect(res.body.conversation.studentId).toBe(studentId);
  });

  it('organizer: refused on an event they do not host (ownership check preserved)', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: unhostedEventId, studentId }, orgToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/do not host this event/);
  });

  it('admin: opens a conversation on an event they do not host, with no application on file (moderate bypass preserved)', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: unhostedEventId, studentId }, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.conversation.studentId).toBe(studentId);
  });

  it('super_admin: gains admin-equivalent access instead of being denied (the actual regression fix)', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: unhostedEventId, studentId }, superAdminToken);
    expect(res.status).toBe(200);
    expect(res.body.conversation.studentId).toBe(studentId);
  });

  it('partner: stays explicitly denied', async () => {
    const res = await srv.call('POST', '/api/messages/conversations/resolve', { eventId: hostedEventId, studentId }, partnerToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied/);
  });
});
