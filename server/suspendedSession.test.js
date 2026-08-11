import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';
import { SUSPENDED_ALLOWED, suspendedMayReach } from './suspendedAccess.js';

/**
 * A suspended account now gets a session. This file is why that is safe.
 *
 * ── What changed ──
 *
 * Until now a suspended account was refused at sign-in and refused again by
 * `authenticateToken`, so there was no authenticated surface at all. The whole
 * product answer to "why can I not get in" was a sentence on a login form
 * pointing at an email address, and everything else the person had been told
 * lived in a single notice sent at the moment of suspension. Lose it, or never
 * receive it, and there was nowhere to look.
 *
 * The session exists so the decision can be read, appealed and left. Everything
 * else it must not reach, and "everything else" is the part worth testing.
 */
describe('a suspended session', () => {
  let srv, db, suspended, active, admin;

  const suspend = (id, { until = null, reason = 'Messaging a student after being asked to stop' } = {}) => {
    db.prepare(`
      UPDATE users SET account_status = 'suspended', suspended_at = ?, suspended_until = ?,
                       suspension_reason = ?, suspension_lifted_at = NULL
       WHERE id = ?
    `).run('2026-08-01T09:00:00.000Z', until, reason, id);
  };

  const unsuspend = (id) => {
    db.prepare(`
      UPDATE users SET account_status = 'active', suspended_at = NULL, suspended_until = NULL,
                       suspension_reason = NULL WHERE id = ?
    `).run(id);
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    active = await srv.login('leo.chen@example.com');
    admin = await srv.login('admin@example.gov');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    unsuspend('user-student-2');
    suspended = await srv.login('priya.patel@example.com');
    suspend('user-student-2');
  });

  /* ── The disclosure ───────────────────────────────────────────────────── */

  it('can read its own suspension, with the reason and the dates', async () => {
    const res = await srv.call('GET', '/api/auth/me', undefined, suspended);
    expect(res.status).toBe(200);
    expect(res.body.suspension).toMatchObject({
      reason: 'Messaging a student after being asked to stop',
      since: '2026-08-01T09:00:00.000Z',
      until: null,
      indefinite: true,
    });
  });

  /**
   * The end date is the field the old design could not disclose. The objection
   * recorded on the login handler was that it "must not be readable by anyone
   * who types their address into a form" — a session that has already proved it
   * is this account is not that, which is what makes it sayable here.
   */
  it('names the end date of a timed suspension', async () => {
    suspend('user-student-2', { until: '2099-01-01T00:00:00.000Z' });
    const res = await srv.call('GET', '/api/auth/me', undefined, suspended);
    expect(res.body.suspension.until).toBe('2099-01-01T00:00:00.000Z');
    expect(res.body.suspension.indefinite).toBe(false);
  });

  /** Nobody else carries the field, so the client reads one shape always. */
  it('is null for an account that is not suspended', async () => {
    const res = await srv.call('GET', '/api/auth/me', undefined, active);
    expect(res.status).toBe(200);
    expect(res.body.suspension).toBeNull();
  });

  /* ── The boundary ─────────────────────────────────────────────────────── */

  /**
   * The assertion the whole change rests on. A suspension that still let
   * somebody browse events or read messages is not a suspension.
   */
  it.each([
    ['GET', '/api/events'],
    ['GET', '/api/applications'],
    ['GET', '/api/messages/conversations'],
    ['GET', '/api/notifications'],
    ['GET', '/api/stats/volunteer'],
    ['GET', '/api/users/user-admin/profile'],
    ['POST', '/api/events'],
  ])('is refused %s %s', async (method, path) => {
    const res = await srv.call(method, path, method === 'POST' ? {} : undefined, suspended);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('account_suspended');
  });

  /**
   * A suspended administrator is a suspended account first.
   *
   * The gate runs in `authenticateToken`, before any capability middleware, so
   * the refusal does not depend on what the account may otherwise do. Worth
   * pinning explicitly: the failure mode is somebody moving the gate below the
   * capability check, where an admin route would answer before it.
   */
  it('does not let a suspended administrator use administrative routes', async () => {
    suspend('user-admin');
    try {
      const res = await srv.call('GET', '/api/admin/reports', undefined, admin);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('account_suspended');
    } finally {
      unsuspend('user-admin');
    }
  });

  /* ── The four things it may do ────────────────────────────────────────── */

  it('may sign out', async () => {
    const res = await srv.call('POST', '/api/auth/logout', {}, suspended);
    expect(res.status).toBe(200);
  });

  it('may read its own appeals', async () => {
    const res = await srv.call('GET', '/api/appeals/mine', undefined, suspended);
    expect(res.status).toBe(200);
  });

  /* ── The allowlist itself ─────────────────────────────────────────────── */

  /**
   * Pinned as a literal set, deliberately, and not derived from the routers.
   *
   * Deriving it would make the list agree with whatever the code does, which is
   * the opposite of what an allowlist is for. Adding a route a suspended account
   * may reach should be a visible line in a diff that a reviewer has to agree
   * with — the same reasoning `sensitiveActions.test.js` gives for hand-writing
   * its sorted list.
   */
  it('reaches exactly four routes, and adding a fifth is a deliberate act', () => {
    expect(SUSPENDED_ALLOWED.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/appeals/mine',
      'GET /api/auth/me',
      'POST /api/appeals',
      'POST /api/auth/logout',
    ]);
  });

  /**
   * Exact match, never a prefix.
   *
   * A prefix entry for `/api/appeals` would have silently included
   * `/api/appeals/token/:token` and every admin appeal route mounted beneath it.
   * That is how an allowlist stops being a limit.
   */
  it('matches paths exactly, so no route inherits access by living under one', () => {
    expect(suspendedMayReach('GET', '/api/appeals/mine')).toBe(true);
    expect(suspendedMayReach('GET', '/api/appeals/mine/extra')).toBe(false);
    expect(suspendedMayReach('GET', '/api/appeals')).toBe(false);
    expect(suspendedMayReach('GET', '/api/admin/appeals')).toBe(false);
    // Method is part of the match: reading the appeal list is not writing one.
    expect(suspendedMayReach('POST', '/api/appeals/mine')).toBe(false);
    expect(suspendedMayReach('DELETE', '/api/auth/me')).toBe(false);
  });

  it('ignores a query string when deciding', async () => {
    const res = await srv.call('GET', '/api/auth/me?cache=0', undefined, suspended);
    expect(res.status).toBe(200);
  });

  /* ── A session that was already open ──────────────────────────────────── */

  /**
   * Suspension does not sign anybody out.
   *
   * This is the behaviour the whole feature exists for. Enforcement is decided
   * per request from the DATABASE — `authenticateToken` re-reads the row every
   * time — so killing the session buys no security and costs the person the only
   * thing this screen was built to give them: an explanation.
   *
   * With sessions destroyed, a suspended student's next click is "Session
   * expired, please sign in again". They then re-enter a password to discover
   * they are locked out, which is the silent-ejection experience the suspension
   * wall replaced, with an extra step bolted on.
   */
  it('does not sign out a session that was already open', async () => {
    /* Reset explicitly. An earlier case in this file may have left this account
       suspended, in which case the suspend below answers 409, changes nothing,
       and the assertions pass without exercising anything. */
    unsuspend('user-student-3');
    const live = await srv.login('ethan.miller@example.com');
    expect((await srv.call('GET', '/api/auth/me', undefined, live)).status).toBe(200);

    await srv.call('POST', '/api/admin/users/user-student-3/suspend',
      { reason: 'Messaging a student after being asked to stop' }, admin);

    const me = await srv.call('GET', '/api/auth/me', undefined, live);
    expect(
      me.status,
      'the existing session must survive so the wall can explain itself; a 401 '
      + 'here means the person is ejected and has to sign in to find out why'
    ).toBe(200);
    expect(me.body.suspension).toMatchObject({ indefinite: true });

    /* And it reaches nothing, which is what makes keeping it safe. */
    const blocked = await srv.call('GET', '/api/events', undefined, live);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('account_suspended');
  });

  /**
   * Every device, immediately, without needing the sessions invalidated.
   *
   * The gate reads the row rather than the token, so a second browser that never
   * saw the suspension happen is refused on its very next request.
   */
  it('applies to every open session at once, not just the active one', async () => {
    unsuspend('user-student-3');
    const phone = await srv.login('ethan.miller@example.com');
    const laptop = await srv.login('ethan.miller@example.com');

    await srv.call('POST', '/api/admin/users/user-student-3/suspend',
      { reason: 'Messaging a student after being asked to stop' }, admin);

    for (const [label, token] of [['phone', phone], ['laptop', laptop]]) {
      const res = await srv.call('GET', '/api/events', undefined, token);
      expect(res.status, `${label} still had access`).toBe(403);
      expect(res.body.code).toBe('account_suspended');
    }
  });

  /** And access returns on the same session when the suspension is lifted. */
  it('restores the same session on unsuspension, with no new sign-in', async () => {
    unsuspend('user-student-3');
    const live = await srv.login('ethan.miller@example.com');
    await srv.call('POST', '/api/admin/users/user-student-3/suspend',
      { reason: 'Messaging a student after being asked to stop' }, admin);
    expect((await srv.call('GET', '/api/events', undefined, live)).status).toBe(403);

    await srv.call('POST', '/api/admin/users/user-student-3/unsuspend',
      { reason: 'Resolved after review' }, admin);

    const res = await srv.call('GET', '/api/events', undefined, live);
    expect(res.status).toBe(200);
    const me = await srv.call('GET', '/api/auth/me', undefined, live);
    expect(me.body.suspension).toBeNull();
  });

  /* ── Expiry still releases ────────────────────────────────────────────── */

  /**
   * The data is authoritative and the sweep is only a tidier — a suspension
   * whose deadline has passed stops applying at that instant, with no background
   * job involved. That has to remain true through the new gate.
   */
  it('stops applying the moment a timed suspension has passed', async () => {
    suspend('user-student-2', { until: '2000-01-01T00:00:00.000Z' });
    const res = await srv.call('GET', '/api/notifications', undefined, suspended);
    expect(res.status).not.toBe(403);
    const me = await srv.call('GET', '/api/auth/me', undefined, suspended);
    expect(me.body.suspension).toBeNull();
  });
});
