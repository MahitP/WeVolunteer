import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Account suspension.
 *
 * ── What this is protecting ──
 *
 * Until now `user.suspend` was a registered capability with no route behind it,
 * and `account_status = 'suspended'` was a value the sign-in path refused but
 * nothing ever wrote. An administrator holding a credible report about an adult
 * messaging a minor could resolve the report and delete a comment; they could
 * not remove the person. These tests exist so that stays fixed.
 *
 * The assertion that matters most is not "the status column changed" — it is
 * **an existing session dies**. Setting the status alone would block the next
 * sign-in and leave every already-issued cookie working for up to seven days,
 * which on a safety suspension is the entire window that mattered.
 */

let srv;
let db;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => { await srv.close(); });

/** Puts every seeded account back to active, so ordering between tests cannot matter. */
function resetAccounts() {
  db.prepare(`
    UPDATE users
    SET account_status = 'active', suspended_at = NULL, suspension_reason = NULL, suspended_by = NULL
    WHERE account_status = 'suspended'
  `).run();
}

const GOOD_REASON = 'Repeatedly contacted students outside event scope.';

describe('POST /api/admin/users/:id/suspend', () => {
  let adminToken, studentToken, organizerToken;

  beforeAll(async () => {
    adminToken = await srv.login('admin@example.gov');
    studentToken = await srv.login('leo.chen28@gmail.com');
    organizerToken = await srv.login('jkatzenback@vikings.org');
  });

  beforeEach(() => resetAccounts());

  it('suspends an account and records who did it and why', async () => {
    const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');

    const row = db.prepare(
      'SELECT account_status, suspension_reason, suspended_by, suspended_at FROM users WHERE id = ?'
    ).get('user-student-2');

    expect(row.account_status).toBe('suspended');
    expect(row.suspension_reason).toBe(GOOD_REASON);
    expect(row.suspended_by).toBe('user-admin');
    expect(row.suspended_at).toBeTruthy();
  });

  it('ENDS AN EXISTING SESSION — the half that actually protects anyone', async () => {
    // A live, working session before suspension.
    const victimToken = await srv.login('priya.patel.nhs@outlook.com');
    const before = await srv.call('GET', '/api/auth/me', undefined, victimToken);
    expect(before.status, 'precondition: the session works').toBe(200);

    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    const after = await srv.call('GET', '/api/auth/me', undefined, victimToken);
    expect(
      after.status,
      'the cookie issued before suspension must stop working immediately. If this is 200, '
      + 'suspension only blocks the next sign-in and a suspended user keeps full access for '
      + 'up to seven days — which is the whole window a safety suspension exists to close.'
    ).not.toBe(200);
    expect([401, 403]).toContain(after.status);
  });

  it('bumps token_version so every device is signed out, not just one', async () => {
    const before = db.prepare('SELECT token_version FROM users WHERE id = ?').get('user-student-3');
    await srv.call('POST', '/api/admin/users/user-student-3/suspend',
      { reason: GOOD_REASON }, adminToken);
    const after = db.prepare('SELECT token_version FROM users WHERE id = ?').get('user-student-3');

    expect(after.token_version).toBe(before.token_version + 1);
  });

  it('refuses sign-in while suspended', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    // Asserted against the endpoint rather than srv.login(), which returns the
    // cookie (undefined/null on failure) instead of throwing.
    const res = await srv.call('POST', '/api/auth/login', {
      email: 'priya.patel.nhs@outlook.com', password: 'password123'
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('suspended');
    expect(res.cookie, 'a refused sign-in must not hand out a session').toBeFalsy();
  });

  it('writes an audit row naming the actor and the target', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    const audit = db.prepare(`
      SELECT * FROM admin_audit_logs
      WHERE action = 'ACCOUNT_SUSPENDED' AND target_user_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get('user-student-2');

    expect(audit, 'a suspension with no audit row is an unattributable exercise of power').toBeTruthy();
    expect(audit.admin_id).toBe('user-admin');
    expect(audit.details).toContain('Repeatedly contacted');
  });

  describe('refusals', () => {
    it('requires a reason of real length', async () => {
      const empty = await srv.call('POST', '/api/admin/users/user-student-2/suspend', {}, adminToken);
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe('reason_required');

      const terse = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: 'spam' }, adminToken);
      expect(terse.status).toBe(400);

      const still = db.prepare('SELECT account_status FROM users WHERE id = ?').get('user-student-2');
      expect(still.account_status, 'a refused suspension must not partially apply').toBe('active');
    });

    it('refuses self-suspension', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-admin/suspend',
        { reason: GOOD_REASON }, adminToken);
      expect(res.status).toBe(400);
    });

    it('refuses a second suspension of an already-suspended account', async () => {
      await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: GOOD_REASON }, adminToken);
      const again = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: 'A different reason entirely.' }, adminToken);

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_suspended');

      // The original reason must survive — a repeat call must not overwrite the
      // record of why the account was suspended in the first place.
      const row = db.prepare('SELECT suspension_reason FROM users WHERE id = ?').get('user-student-2');
      expect(row.suspension_reason).toBe(GOOD_REASON);
    });

    it('404s an unknown user', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-nope/suspend',
        { reason: GOOD_REASON }, adminToken);
      expect(res.status).toBe(404);
    });

    it('refuses a student calling it', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: GOOD_REASON }, studentToken);
      expect(res.status).toBe(403);
    });

    it('refuses an organizer calling it', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: GOOD_REASON }, organizerToken);
      expect(res.status).toBe(403);
    });

    it('refuses an unauthenticated call', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: GOOD_REASON });
      expect([401, 403]).toContain(res.status);
    });

    it('refuses an admin suspending another administrator', async () => {
      // Privilege-escalation guard: user.suspend is an ordinary admin
      // capability, so without this an admin could remove the person who could
      // undo it.
      const second = db.prepare("SELECT id FROM users WHERE role = 'admin' AND id != 'user-admin'").get();
      if (!second) {
        db.prepare(`
          INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, created_at)
          VALUES ('user-admin-2','Second Admin','admin2@example.gov','sysadmin2','x','N/A','admin',1,?)
        `).run(new Date().toISOString());
      }
      const targetId = second?.id ?? 'user-admin-2';

      const res = await srv.call('POST', `/api/admin/users/${targetId}/suspend`,
        { reason: GOOD_REASON }, adminToken);
      expect(res.status).toBe(403);

      db.prepare("DELETE FROM users WHERE id = 'user-admin-2'").run();
    });

    it('refuses suspending a deleted account', async () => {
      db.prepare("UPDATE users SET account_status = 'deleted' WHERE id = 'user-student-3'").run();
      const res = await srv.call('POST', '/api/admin/users/user-student-3/suspend',
        { reason: GOOD_REASON }, adminToken);
      expect(res.status).toBe(409);
      db.prepare("UPDATE users SET account_status = 'active' WHERE id = 'user-student-3'").run();
    });
  });

  describe('organizers are suspended, never deleted', () => {
    it('preserves attendance and credited hours when an organizer is suspended', async () => {
      // The guarantee: /api/admin/organizers/:id/deny refuses approved
      // organizers precisely because ON DELETE CASCADE would take their events
      // — and their volunteers' attendance rows — with them. Suspension must
      // not reintroduce that by another door.
      const before = db.prepare(
        'SELECT COUNT(*) AS c FROM attendance WHERE event_id IN (SELECT id FROM events WHERE organizer_id = ?)'
      ).get('user-org-1').c;

      const res = await srv.call('POST', '/api/admin/users/user-org-1/suspend',
        { reason: 'Safety report under investigation, pending review.' }, adminToken);
      expect(res.status).toBe(200);

      const after = db.prepare(
        'SELECT COUNT(*) AS c FROM attendance WHERE event_id IN (SELECT id FROM events WHERE organizer_id = ?)'
      ).get('user-org-1').c;

      expect(after, 'suspending an organizer must not destroy volunteers\' service records').toBe(before);
      expect(db.prepare('SELECT id FROM users WHERE id = ?').get('user-org-1')).toBeTruthy();
    });

    it('reports how many active events the suspended organizer still hosts', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-org-1/suspend',
        { reason: 'Safety report under investigation, pending review.' }, adminToken);

      expect(res.status).toBe(200);
      expect(typeof res.body.activeEvents).toBe('number');
      // Reported rather than auto-cancelled: cancelling an event as a side
      // effect of moderation would strand accepted volunteers with no notice.
      if (res.body.activeEvents > 0) {
        expect(res.body.message).toMatch(/reassign or cancel/i);
      }
    });
  });
});

describe('POST /api/admin/users/:id/unsuspend', () => {
  let adminToken;

  beforeAll(async () => { adminToken = await srv.login('admin@example.gov'); });
  beforeEach(() => resetAccounts());

  it('restores the account and clears the suspension detail', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    const res = await srv.call('POST', '/api/admin/users/user-student-2/unsuspend', {}, adminToken);
    expect(res.status).toBe(200);

    const row = db.prepare(
      'SELECT account_status, suspension_reason, suspended_by, suspended_at FROM users WHERE id = ?'
    ).get('user-student-2');

    expect(row.account_status).toBe('active');
    expect(row.suspension_reason).toBeNull();
    expect(row.suspended_by).toBeNull();
    expect(row.suspended_at).toBeNull();
  });

  it('lets the reinstated user sign in again', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);
    await srv.call('POST', '/api/admin/users/user-student-2/unsuspend', {}, adminToken);

    const token = await srv.login('priya.patel.nhs@outlook.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
  });

  it('keeps the audit trail after reinstatement', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);
    await srv.call('POST', '/api/admin/users/user-student-2/unsuspend',
      { reason: 'Report not substantiated.' }, adminToken);

    const suspended = db.prepare(
      "SELECT COUNT(*) AS c FROM admin_audit_logs WHERE action = 'ACCOUNT_SUSPENDED' AND target_user_id = ?"
    ).get('user-student-2').c;
    const lifted = db.prepare(
      "SELECT COUNT(*) AS c FROM admin_audit_logs WHERE action = 'ACCOUNT_UNSUSPENDED' AND target_user_id = ?"
    ).get('user-student-2').c;

    expect(suspended, 'the suspension record must survive reinstatement').toBeGreaterThan(0);
    expect(lifted).toBeGreaterThan(0);
  });

  it('409s when the account is not suspended', async () => {
    const res = await srv.call('POST', '/api/admin/users/user-student-2/unsuspend', {}, adminToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_suspended');
  });

  it('refuses a student calling it', async () => {
    const studentToken = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('POST', '/api/admin/users/user-student-2/unsuspend', {}, studentToken);
    expect(res.status).toBe(403);
  });
});
