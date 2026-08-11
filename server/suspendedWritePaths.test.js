import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * What a suspended session may WRITE — which is nothing.
 *
 * ── Why this is a separate file from `suspendedSession.test.js` ──
 *
 * That file proves the reads are confined. Reads are the obvious half and the
 * less dangerous one: a suspended person seeing an event listing is a privacy
 * question, whereas a suspended person WRITING is a moderation-evasion or
 * privilege-escalation question. The two worth naming individually are both here:
 *
 *   - `POST /api/auth/accept-invitation` — if reachable, somebody suspended for
 *     harassment could accept a pending administrator invitation and end the
 *     suspension by outranking it. That is cross-feature privilege escalation:
 *     neither the invitation system nor the suspension gate is wrong on its own.
 *
 *   - `DELETE /api/auth/account` — if reachable, a person under active
 *     moderation could erase themselves mid-investigation, taking the account
 *     the report is about with them.
 *
 * Both are refused by `suspendedAccess.js` being an exact-match allowlist rather
 * than a prefix or a deny-list. This file is the proof, because "we used an
 * allowlist" is an argument and a test is evidence.
 */
describe('a suspended session cannot write anything', () => {
  let srv, db, suspended, admin;

  const suspend = (id) => db.prepare(`
    UPDATE users SET account_status = 'suspended', suspended_at = ?, suspended_until = NULL,
                     suspension_reason = 'Messaging a student after being asked to stop',
                     suspension_lifted_at = NULL
     WHERE id = ?
  `).run('2026-08-01T09:00:00.000Z', id);

  const unsuspend = (id) => db.prepare(`
    UPDATE users SET account_status = 'active', suspended_at = NULL, suspended_until = NULL,
                     suspension_reason = NULL WHERE id = ?
  `).run(id);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    admin = await srv.login('admin@example.gov');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    unsuspend('user-student-2');
    suspended = await srv.login('priya.patel@example.com');
    suspend('user-student-2');
  });

  /* ── The two that matter most ─────────────────────────────────────────── */

  /**
   * Cross-feature privilege escalation, and the reason Phase 3 asks for
   * combinations rather than single capabilities.
   *
   * The invitation system is correct: a token plus a verified matching address is
   * administrator authority. The suspension gate is correct: it refuses
   * everything outside four routes. Neither considers the other, so the question
   * is whether the composition holds — a suspended person who happens to hold a
   * live invitation must not be able to outrank their own suspension.
   */
  it('cannot accept an administrator invitation', async () => {
    const res = await srv.call('POST', '/api/auth/accept-invitation',
      { token: 'anything-at-all' }, suspended);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_suspended');

    /* And the role is untouched, whatever the token was. */
    expect(db.prepare('SELECT role FROM users WHERE id = ?').get('user-student-2').role)
      .toBe('student');
  });

  /**
   * Moderation evasion. Deleting the account mid-investigation takes the subject
   * of an open report with it — and account deletion is soft, so the row would
   * be marked deleted and the person could no longer be reached about it.
   */
  it('cannot delete its own account while under moderation', async () => {
    const res = await srv.call('DELETE', '/api/auth/account', {}, suspended);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_suspended');

    const row = db.prepare(
      'SELECT account_status, deleted_at FROM users WHERE id = ?'
    ).get('user-student-2');
    expect(row.account_status).toBe('suspended');
    expect(row.deleted_at).toBeNull();
  });

  /* ── Identity, which a suspended person must not be able to move ───────── */

  /**
   * Changing the address would let somebody appeal from a mailbox the
   * suspension notice never reached, and would break the binding the appeal
   * token and the invitation flow both rely on.
   */
  it.each([
    ['change its email address', 'POST', '/api/auth/change-email', { newEmail: 'new@example.invalid' }],
    ['change its password', 'POST', '/api/auth/change-password', { newPassword: 'Whatever123!' }],
    ['change its username', 'POST', '/api/auth/change-username', { username: 'freshstart' }],
    ['edit its profile', 'PATCH', '/api/auth/profile', { bio: 'nothing to see here' }],
  ])('cannot %s', async (_label, method, path, body) => {
    const res = await srv.call(method, path, body, suspended);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_suspended');
  });

  /* ── Participation, which a suspension exists to stop ──────────────────── */

  it.each([
    ['apply to an event', 'POST', '/api/applications', { eventId: 'event-1', slotId: 'slot-1' }],
    ['withdraw an application', 'PATCH', '/api/applications/app-1', { status: 'withdrawn' }],
    ['create an event', 'POST', '/api/events', { title: 'x' }],
    ['post a comment', 'POST', '/api/comments', { eventId: 'event-1', body: 'hello' }],
    ['send a message', 'POST', '/api/messages', { conversationId: 'conv-1', body: 'hello' }],
    ['mark notifications read', 'PATCH', '/api/notifications', { read: true }],
  ])('cannot %s', async (_label, method, path, body) => {
    const res = await srv.call(method, path, body, suspended);
    /* 403 with the suspension code, or 404 if the route does not exist at all —
       never a 2xx. A route that answers 404 here is one this test will notice if
       it is ever added without the gate applying to it. */
    expect(res.status, `${method} ${path} was not refused`).not.toBeLessThan(400);
    if (res.status === 403) expect(res.body.code).toBe('account_suspended');
  });

  /* ── Administrative surfaces ───────────────────────────────────────────── */

  /**
   * A suspended ADMINISTRATOR is a suspended account first. Worth its own case
   * because the capability check would pass: the refusal has to come from the
   * suspension gate running before it.
   */
  it('cannot use administrative writes even holding the capability', async () => {
    suspend('user-admin');
    try {
      const res = await srv.call('POST', '/api/admin/users/user-student-1/suspend',
        { reason: 'Retaliating while suspended myself' }, admin);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('account_suspended');

      expect(db.prepare('SELECT account_status FROM users WHERE id = ?').get('user-student-1')
        .account_status).toBe('active');
    } finally {
      unsuspend('user-admin');
    }
  });

  /* ── What the restricted session may still do ──────────────────────────── */

  /**
   * The four allowlisted routes, asserted positively.
   *
   * Without this the file could pass by refusing everything, including the appeal
   * — which would make the suspension screen a dead end and break the one
   * process the Community Guidelines promise a suspended student.
   */
  it('can still submit an appeal, which is the one write it needs', async () => {
    const res = await srv.call('POST', '/api/appeals', {
      subject: 'suspension',
      statement: 'I was replying to a question they asked me in the group chat first, and I stopped when asked.',
    }, suspended);

    expect(res.status).toBeLessThan(400);
  });

  it('can still read its own appeals and sign out', async () => {
    expect((await srv.call('GET', '/api/appeals/mine', undefined, suspended)).status).toBe(200);
    expect((await srv.call('POST', '/api/auth/logout', {}, suspended)).status).toBe(200);
  });

  /* ── The allowlist's shape, which is what makes all of the above hold ──── */

  /**
   * A near-miss must not be admitted. These are the spellings a prefix match or
   * a trailing-slash-tolerant matcher would let through, and each one would open
   * a route the cases above prove must stay shut.
   */
  it.each([
    '/api/auth/me/../events',
    '/api/auth/logout/../../events',
    '/api/appeals/mine/../../events',
  ])('does not admit %s by path trickery', async (path) => {
    const res = await srv.call('GET', path, undefined, suspended);
    /* Express normalises these before routing, so the effective path is
       `/api/events` and the gate sees it as such. Either a suspension refusal or
       a 404 is correct; a 200 would mean the allowlist was consulted against the
       raw string. */
    expect(res.status).not.toBe(200);
  });
});
