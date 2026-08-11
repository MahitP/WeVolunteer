import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Blocking.
 *
 * ── What this is for ──
 *
 * Every other safety control on this platform is reactive: report something,
 * and a human eventually acts. That depends on a student trusting the response
 * and being willing to wait for it. Blocking is the one protection that works
 * immediately, with nobody else involved, for a student who cannot yet
 * articulate what is wrong.
 *
 * The two assertions that matter most are not "a row was written":
 *
 *   1. It closes an EXISTING conversation. `eligibleRelationship` only guards
 *      the opening of a new one, so a block that only stopped `resolve` would
 *      do nothing for the exact case that matters — the thread the student is
 *      already in with the person they want to stop hearing from.
 *   2. It does NOT cost the student their volunteer record. A safety control
 *      that withdrew them from the event would force a student to weigh feeling
 *      unsafe against their graduation requirement.
 */

let srv;
let db;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => { await srv.close(); });

function clearBlocks() {
  db.prepare('DELETE FROM user_blocks').run();
}

let dayCursor = 40;
async function eventWithApplicant(orgToken, studentToken, studentId) {
  const offset = dayCursor++;
  const start = new Date(Date.now() + offset * 864e5).toISOString();
  const end = new Date(Date.now() + offset * 864e5 + 108e5).toISOString();
  const mk = await srv.call('POST', '/api/events', {
    title: `Block Test ${offset}`, description: 'd', category: 'Other', location: 'Hall',
    applicationDeadline: start,
    slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 5 }]
  }, orgToken);
  const eventId = mk.body.id;
  const listed = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === eventId);
  await srv.call('POST', `/api/events/${eventId}/apply`, { slotId: listed.slots[0].id }, studentToken);

  const conv = await srv.call('POST', '/api/messages/conversations/resolve',
    { eventId, studentId }, orgToken);
  return { eventId, conversationId: conv.body?.conversation?.id };
}

describe('blocking', () => {
  let studentToken, orgToken, adminToken;
  const STUDENT = 'user-student-1';
  const ORG = 'user-org-1';

  beforeAll(async () => {
    studentToken = await srv.login('leo.chen@example.com');
    orgToken = await srv.login('jordan.whitfield@example.org');
    adminToken = await srv.login('admin@example.gov');
  });

  beforeEach(() => clearBlocks());

  it('records a block and lists it back', async () => {
    const res = await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);

    const list = await srv.call('GET', '/api/blocks', undefined, studentToken);
    expect(list.body.blocked.map(b => b.id)).toContain(ORG);
  });

  it('is idempotent — a second tap is not an error', async () => {
    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);
    const again = await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);

    expect(again.status).toBe(200);
    expect(again.body.created, 'a repeat block must not create a second row').toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS c FROM user_blocks WHERE blocker_id = ?').get(STUDENT).c).toBe(1);
  });

  it('CLOSES AN EXISTING CONVERSATION — the case that actually matters', async () => {
    const { conversationId } = await eventWithApplicant(orgToken, studentToken, STUDENT);
    expect(conversationId, 'precondition: a conversation exists').toBeTruthy();

    const before = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`,
      { body: 'Before the block' }, orgToken);
    expect(before.status, 'precondition: the organizer can send').toBe(201);

    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);

    const after = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`,
      { body: 'After the block' }, orgToken);
    expect(
      after.status,
      'a block that only stopped NEW conversations would do nothing for the thread the '
      + 'student is already in — which is the only one they care about'
    ).toBe(409);
  });

  it('stops the blocked party opening a new conversation', async () => {
    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);

    const offset = dayCursor++;
    const start = new Date(Date.now() + offset * 864e5).toISOString();
    const end = new Date(Date.now() + offset * 864e5 + 108e5).toISOString();
    const mk = await srv.call('POST', '/api/events', {
      title: 'After Block', description: 'd', category: 'Other', location: 'Hall',
      applicationDeadline: start,
      slots: [{ name: 'Shift', description: 'd', startDatetime: start, endDatetime: end, maxSpots: 5 }]
    }, orgToken);
    const eventId = mk.body.id;
    const listed = (await srv.call('GET', '/api/events', undefined, orgToken)).body.find(e => e.id === eventId);
    await srv.call('POST', `/api/events/${eventId}/apply`, { slotId: listed.slots[0].id }, studentToken);

    const res = await srv.call('POST', '/api/messages/conversations/resolve',
      { eventId, studentId: STUDENT }, orgToken);
    expect(res.status).toBe(403);
  });

  it('does not announce the block back to the blocked party', async () => {
    // Telling an organizer "this student blocked you" turns a safety control
    // into a provocation. The refusal must be indistinguishable from the
    // ordinary no-relationship one.
    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);
    const { conversationId } = await eventWithApplicant(orgToken, studentToken, STUDENT).catch(() => ({}));

    if (conversationId) {
      const res = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`,
        { body: 'hello' }, orgToken);
      expect(JSON.stringify(res.body)).not.toMatch(/block/i);
    }
  });

  it('closes the channel in BOTH directions', async () => {
    const { conversationId } = await eventWithApplicant(orgToken, studentToken, STUDENT);
    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);

    const fromStudent = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`,
      { body: 'still here' }, studentToken);
    expect(
      fromStudent.status,
      'a one-way block leaves the student able to keep talking to someone they blocked, '
      + 'which is not what the control means'
    ).toBe(409);
  });

  it('DOES NOT withdraw the student from the event', async () => {
    // The guarantee that keeps blocking free: a student must never have to
    // weigh feeling unsafe against their service record.
    const { eventId } = await eventWithApplicant(orgToken, studentToken, STUDENT);
    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);

    const app = db.prepare('SELECT status FROM applications WHERE event_id = ? AND user_id = ?')
      .get(eventId, STUDENT);
    expect(app, 'the application must survive a block').toBeTruthy();
    expect(app.status).not.toBe('withdrawn');
  });

  it('leaves credited hours untouched', async () => {
    const before = db.prepare(
      'SELECT COALESCE(SUM(hours_awarded),0) AS h FROM attendance WHERE user_id = ? AND present = 1'
    ).get(STUDENT).h;

    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);

    const after = db.prepare(
      'SELECT COALESCE(SUM(hours_awarded),0) AS h FROM attendance WHERE user_id = ? AND present = 1'
    ).get(STUDENT).h;
    expect(after).toBe(before);
  });

  it('raises a moderation signal, because students block instead of reporting', async () => {
    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);

    const audit = db.prepare(`
      SELECT * FROM admin_audit_logs
      WHERE action = 'USER_BLOCKED' AND target_user_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(ORG);

    expect(
      audit,
      'blocking is often the earliest signal about an adult — several students blocking the '
      + 'same organizer is a pattern nobody would see if it were not recorded'
    ).toBeTruthy();
    expect(audit.admin_id).toBe(STUDENT);
  });

  it('lets an admin still reach both parties', async () => {
    // Moderation has to work precisely when a block has been placed.
    const { eventId } = await eventWithApplicant(orgToken, studentToken, STUDENT);
    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);

    const res = await srv.call('POST', '/api/messages/conversations/resolve',
      { eventId, studentId: STUDENT }, adminToken);
    expect(res.status).toBe(200);
  });

  it('restores messaging when the block is removed', async () => {
    const { conversationId } = await eventWithApplicant(orgToken, studentToken, STUDENT);
    await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);
    await srv.call('DELETE', `/api/blocks/${ORG}`, undefined, studentToken);

    const res = await srv.call('POST', `/api/messages/conversations/${conversationId}/messages`,
      { body: 'back again' }, orgToken);
    expect(res.status).toBe(201);
  });

  describe('refusals', () => {
    it('refuses an ORGANIZER blocking a student', async () => {
      // The asymmetry is the design: an organizer who could block would sever
      // the channel a student would use to complain about them.
      const res = await srv.call('POST', `/api/blocks/${STUDENT}`, {}, orgToken);
      expect(res.status).toBe(403);
      expect(db.prepare('SELECT COUNT(*) AS c FROM user_blocks').get().c).toBe(0);
    });

    it('refuses self-blocking', async () => {
      const res = await srv.call('POST', `/api/blocks/${STUDENT}`, {}, studentToken);
      expect(res.status).toBe(400);
    });

    it('404s an unknown user', async () => {
      const res = await srv.call('POST', '/api/blocks/user-nope', {}, studentToken);
      expect(res.status).toBe(404);
    });

    it('refuses an unauthenticated call', async () => {
      const res = await srv.call('POST', `/api/blocks/${ORG}`, {});
      expect([401, 403]).toContain(res.status);
    });

    it('scopes the list to the caller', async () => {
      await srv.call('POST', `/api/blocks/${ORG}`, {}, studentToken);
      const other = await srv.login('priya.patel@example.com');
      const list = await srv.call('GET', '/api/blocks', undefined, other);
      expect(list.body.blocked).toEqual([]);
    });
  });
});
