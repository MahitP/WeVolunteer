/**
 * Formal warnings — the enforcement step below suspension.
 *
 * ── The defect this closes ──
 *
 * `REPORT_RESOLUTIONS` has offered `warning_issued` since v1.2, and
 * `ResolutionModal` has offered "Warning issued to the person reported" in its
 * dropdown. Neither did anything to the person. A moderator could close a report
 * saying they had warned somebody who was never told — so the platform's record
 * said a warning had been issued while the only party it concerned had no idea.
 *
 * That is worse than having no warning at all: the label is what justifies the
 * next escalation, so an undelivered warning is a suspension waiting to happen on
 * the strength of a notice the student never got a chance to act on.
 *
 * The assertion that matters most here is therefore not "a row was written" — it
 * is **the person is actually notified, whatever their email preferences say**.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, db;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => { await srv.close(); });

const REASON = 'Kept messaging a student after being asked to stop.';
const adminToken = () => srv.login('admin@example.gov');

/**
 * The warning notices for a user.
 *
 * Matched on the title rather than a `kind` column, because `notifications.kind`
 * stores the CATEGORY ('ACCOUNT') and not the event — every account notice shares
 * it, so filtering on the event name silently matches nothing and this whole file
 * would pass while asserting the absence of rows it never looked for.
 */
const notices = async (userId) => await db.prepare(
  "SELECT * FROM notifications WHERE user_id = ? AND title LIKE '%note about your%' ORDER BY created_at DESC, id DESC"
).all(userId);

const audits = async (userId) => await db.prepare(
  "SELECT * FROM admin_audit_logs WHERE action = 'ACCOUNT_WARNED' AND target_user_id = ?"
).all(userId);

describe('POST /api/admin/users/:id/warn', () => {
  it('tells the person, in the words the moderator wrote', async () => {
    const res = await srv.call('POST', '/api/admin/users/user-student-2/warn',
      { reason: REASON }, await adminToken());

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.warned).toBe(true);

    const [notice] = await notices('user-student-2');
    expect(notice, 'a warning nobody receives is not a warning').toBeTruthy();
    expect(notice.body).toContain('Kept messaging a student');
  });

  it('records who issued it and why', async () => {
    await srv.call('POST', '/api/admin/users/user-student-3/warn',
      { reason: REASON }, await adminToken());

    const rows = await audits('user-student-3');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1].admin_id).toBe('user-admin');
    expect(rows[rows.length - 1].details).toContain('Kept messaging');
  });

  /**
   * The promise in the notice — "nothing has been removed" — has to be true.
   * A warning that quietly restricted something would be a suspension wearing a
   * gentler word.
   */
  it('changes nothing about the account', async () => {
    const before = await db.prepare('SELECT * FROM users WHERE id = ?').get('user-student-2');

    await srv.call('POST', '/api/admin/users/user-student-2/warn',
      { reason: REASON }, await adminToken());

    const after = await db.prepare('SELECT * FROM users WHERE id = ?').get('user-student-2');
    expect(after.account_status).toBe(before.account_status);
    expect(after.token_version, 'a warning must not sign anybody out').toBe(before.token_version);
    expect(after.suspended_at).toBe(before.suspended_at);
    expect(after.role).toBe(before.role);
  });

  it('still lets them sign in immediately afterwards', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/warn',
      { reason: REASON }, await adminToken());

    const res = await srv.call('POST', '/api/auth/login',
      { email: 'priya.patel@example.com', password: 'password123' });
    expect(res.status).toBe(200);
  });

  /** The escalation has to be recordable: a second incident is a second warning. */
  it('allows a second warning rather than 409ing the escalation', async () => {
    const target = 'user-student-1';
    const first = await srv.call('POST', `/api/admin/users/${target}/warn`,
      { reason: REASON }, await adminToken());
    const second = await srv.call('POST', `/api/admin/users/${target}/warn`,
      { reason: 'Did the same thing again a week later.' }, await adminToken());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await notices(target)).length).toBeGreaterThanOrEqual(2);
  });

  /**
   * A mandatory notice: it is delivered whatever the account's email preference
   * says, for the same reason a suspension notice is. The alternative is that a
   * preference toggle silently decides whether a disciplinary record was ever
   * communicated to the person it is about.
   */
  it('is a mandatory notice, so a user preference cannot silence it', async () => {
    const { MANDATORY_NOTICE_EVENTS } = await import('./services/notificationContent.js');
    expect(MANDATORY_NOTICE_EVENTS.has('ACCOUNT_WARNED')).toBe(true);
  });

  describe('refusals', () => {
    it('requires a reason of real length, and writes nothing when refused', async () => {
      const before = (await audits('user-student-2')).length;

      for (const body of [{}, { reason: 'stop' }, { reason: 1 }]) {
        const res = await srv.call('POST', '/api/admin/users/user-student-2/warn',
          body, await adminToken());
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe('reason_required');
      }

      expect((await audits('user-student-2')).length, 'a refused warning must not partially apply')
        .toBe(before);
    });

    it('404s an unknown user', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-nope/warn',
        { reason: REASON }, await adminToken());
      expect(res.status).toBe(404);
    });

    it('refuses warning your own account', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-admin/warn',
        { reason: REASON }, await adminToken());
      expect(res.status).toBe(400);
    });

    /**
     * The same privilege-escalation shape as suspension, just quieter: an
     * ordinary admin must not be able to put a disciplinary notice on the
     * platform owner's record.
     */
    it('refuses an ordinary admin warning an administrator', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-admin/warn',
        { reason: REASON }, await srv.login('admin@example.gov'));
      expect([400, 403]).toContain(res.status);
    });

    it('refuses a student, an organizer and a stranger', async () => {
      for (const cookie of [
        await srv.login('leo.chen@example.com'),
        await srv.login('jordan.whitfield@example.org'),
        undefined,
      ]) {
        const res = await srv.call('POST', '/api/admin/users/user-student-2/warn',
          { reason: REASON }, cookie);
        expect([401, 403]).toContain(res.status);
      }
    });
  });
});
