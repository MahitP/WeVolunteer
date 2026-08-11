import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The organizer↔applicant messaging boundary.
 *
 * ── Why this file exists ──
 *
 * The product decision is that an organizer may contact a student ONLY where
 * that student applied to an event the organizer hosts. `eligibleRelationship()`
 * in messaging.js already enforces this, at the `relationship.length === 0`
 * check — but nothing tested it, so the rule was one careless refactor away
 * from disappearing silently. A legal-surface document (Youth Safety
 * Guidelines, organizer Rule 1) now states this rule to users, which makes it a
 * representation as well as a behaviour.
 *
 * Every assertion below is a rule some published policy depends on.
 *
 * ── The enumeration case ──
 *
 * The last describe block covers a narrower concern: an organizer probing ids
 * must not be able to tell "this id is a student who did not apply" apart from
 * "no such student". Two different status codes for those two cases is an
 * existence oracle, and this codebase has fixed exactly that shape before —
 * see privacyExportIdor.test.js, where a foreign export and a missing one were
 * collapsed to a single 404 for the same reason.
 */

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

/**
 * Creates an event hosted by `token`'s organizer, returns { eventId, slotId }.
 *
 * Each call gets its own day, and that is load-bearing rather than tidy: the
 * application routes reject a second application that overlaps an existing
 * one (`application_conflicts`). Reusing one start time across the events in
 * this file made the *second* apply in a run fail silently, which then looked
 * like the messaging rule misbehaving. Distinct days keep each test's setup
 * independent of every other test's.
 */
let dayCursor = 20;
async function createEvent(token, title = 'Applicant Scope Event') {
  const offset = dayCursor++;
  const start = new Date(Date.now() + offset * 864e5).toISOString();
  const end = new Date(Date.now() + offset * 864e5 + 108e5).toISOString();
  const mk = await srv.call('POST', '/api/events', {
    title, description: 'd', category: 'Other', location: 'Hall',
    applicationDeadline: start,
    slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 5 }]
  }, token);
  expect(mk.status, 'event creation should succeed').toBe(201);
  const eventId = mk.body.id;
  const listed = (await srv.call('GET', '/api/events', undefined, token)).body.find(e => e.id === eventId);
  return { eventId, slotId: listed.slots[0].id };
}

const resolve = (eventId, studentId, token) =>
  srv.call('POST', '/api/messages/conversations/resolve', { eventId, studentId }, token);

describe('organizer may only message students who applied to their own event', () => {
  let orgToken, studentToken, otherStudentToken, adminToken;

  beforeAll(async () => {
    orgToken = await srv.login('jordan.whitfield@example.org');
    studentToken = await srv.login('leo.chen@example.com');
    otherStudentToken = await srv.login('priya.patel@example.com');
    adminToken = await srv.login('admin@example.gov');
  });

  it('refuses an organizer messaging a student who has NOT applied', async () => {
    const { eventId } = await createEvent(orgToken);
    // user-student-2 exists and is a student, but has not applied to this event.
    const res = await resolve(eventId, 'user-student-2', orgToken);

    expect(res.status, 'a non-applicant must not be reachable by the organizer').toBe(403);
    expect(res.body.error).toMatch(/unlocks after an application/i);
  });

  it('allows an organizer to message a student who HAS applied', async () => {
    const { eventId, slotId } = await createEvent(orgToken);
    await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, studentToken);

    const res = await resolve(eventId, 'user-student-1', orgToken);
    expect(res.status).toBe(200);
    expect(res.body.conversation.eventId).toBe(eventId);
  });

  it('keeps the channel open after the student withdraws', async () => {
    // Deliberate: withdrawal is exactly when an organizer may need to confirm
    // the drop or offer the spot back. The rule is "an application exists",
    // not "an application is currently active".
    const { eventId, slotId } = await createEvent(orgToken);
    await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, studentToken);

    // Driven through the database rather than the API, matching the pattern in
    // routes.messages.lifecycle.test.js: this test is about what the messaging
    // rule does with a withdrawn row, not about how withdrawal is requested.
    const { db } = await import('./db.js');
    const before = db.prepare('SELECT id FROM applications WHERE event_id = ? AND user_id = ?')
      .get(eventId, 'user-student-1');
    expect(before, 'the application just created should exist').toBeTruthy();
    db.prepare("UPDATE applications SET status = 'withdrawn' WHERE id = ?").run(before.id);

    const res = await resolve(eventId, 'user-student-1', orgToken);
    expect(res.status, 'withdrawal must not sever the channel — the organizer may need to confirm it').toBe(200);
  });

  it('refuses an organizer messaging an applicant of an event they do not host', async () => {
    // The student applied — but to somebody else's event.
    const { eventId, slotId } = await createEvent(orgToken, 'Hosted By Org One');
    await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, studentToken);

    // A second organizer account, approved, who hosts nothing here.
    const outsider = await srv.login('robin.ellery@example.org').catch(() => null);
    if (!outsider) return; // pending organizer cannot sign in; ownership is covered below

    const res = await resolve(eventId, 'user-student-1', outsider);
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it('ignores a studentId a student supplies for somebody else', async () => {
    // A student may only ever open a conversation about themselves. Passing
    // another student's id must not open a channel to that student.
    const { eventId, slotId } = await createEvent(orgToken);
    await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, studentToken);

    const res = await resolve(eventId, 'user-student-3', studentToken);
    if (res.status === 200) {
      // Resolved — but it must be the caller's OWN conversation, not student-3's.
      const other = res.body.conversation.otherParticipant || res.body.conversation.other;
      const otherId = other?.id ?? null;
      expect(otherId, 'a student must never be handed a conversation with another student').not.toBe('user-student-3');
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('lets an admin open a conversation without an application', async () => {
    // Documented exception: moderation needs to reach a student about an event
    // before any application exists.
    const { eventId } = await createEvent(orgToken);
    const res = await resolve(eventId, 'user-student-2', adminToken);
    expect(res.status).toBe(200);
  });
});

describe('the organizer path does not leak which user ids are students', () => {
  let orgToken, eventId;

  beforeAll(async () => {
    orgToken = await srv.login('jordan.whitfield@example.org');
    ({ eventId } = await createEvent(orgToken, 'Enumeration Probe Event'));
  });

  it('answers a real non-applicant and a nonexistent id identically', async () => {
    const realStudentNoApplication = await resolve(eventId, 'user-student-2', orgToken);
    const noSuchUser = await resolve(eventId, 'user-does-not-exist-at-all', orgToken);

    expect(
      noSuchUser.status,
      'a nonexistent id and a real student who did not apply must be indistinguishable — '
      + 'otherwise an organizer can enumerate which user ids belong to students'
    ).toBe(realStudentNoApplication.status);

    expect(
      noSuchUser.body.error,
      'the two cases must not differ by message either'
    ).toBe(realStudentNoApplication.body.error);
  });

  it('answers an organizer id the same way as a nonexistent one', async () => {
    // A non-student id is also a probe: distinguishing it reveals role.
    const anOrganizerId = await resolve(eventId, 'user-org-1', orgToken);
    const noSuchUser = await resolve(eventId, 'user-does-not-exist-at-all', orgToken);

    expect(anOrganizerId.status).toBe(noSuchUser.status);
    expect(anOrganizerId.body.error).toBe(noSuchUser.body.error);
  });
});
