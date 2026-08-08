import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Approving an organizer touches exactly one pending organizer.
 *
 * ── The defect ──
 *
 * `POST /api/admin/organizers/:id/approve` was
 *
 *     UPDATE users SET verified = 1 WHERE id = ?
 *
 * with no role filter, no pending filter, no existence check and no
 * transaction — twenty lines above a `deny` route that is carefully scoped and
 * documents why.
 *
 * `verified` is not cosmetic. It gates event creation and drives the "Approved
 * by school staff" badge on a public profile. So the flag could be set on any
 * account at all, and a student pre-approved this way became a trusted organizer
 * the moment their role changed — with nothing recording that anyone had decided
 * it.
 *
 * The quieter half: a wrong id still answered `{ success: true }`, still wrote an
 * `APPROVE_ORGANIZER` audit row and still dispatched an approval notification. A
 * trail that records approvals which never happened is worse than no trail,
 * because it is consulted with confidence.
 */
describe('POST /api/admin/organizers/:id/approve', () => {
  let srv, db, admin;

  const PENDING = 'user-org-pending';
  const STUDENT = 'user-student-1';

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    admin = await srv.login('admin@example.gov');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const verifiedOf = (id) =>
    db.prepare('SELECT verified FROM users WHERE id = ?').get(id)?.verified;

  const auditCount = (id) => db.prepare(
    "SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action = 'APPROVE_ORGANIZER' AND target_user_id = ?"
  ).get(id).n;

  /* ── What it must not reach ────────────────────────────────────────────── */

  /**
   * A student is not a pending organizer, and approving one would hand them the
   * flag that lets them post events and wear the school's badge.
   */
  it('refuses to verify a student, and writes nothing', async () => {
    const before = verifiedOf(STUDENT);

    const res = await srv.call('POST', `/api/admin/organizers/${STUDENT}/approve`, {}, admin);

    expect(res.status).toBe(404);
    expect(verifiedOf(STUDENT), 'a student was marked verified').toBe(before);
    expect(auditCount(STUDENT), 'an approval was recorded for a student').toBe(0);
  });

  /**
   * An id that matches nothing must not produce a success, an audit row, or a
   * notification. This is the case that made the trail lie.
   */
  it('refuses an id that matches nobody, and records no approval', async () => {
    const res = await srv.call('POST', '/api/admin/organizers/user-does-not-exist/approve', {}, admin);

    expect(res.status).toBe(404);
    expect(auditCount('user-does-not-exist')).toBe(0);
  });

  /**
   * An organizer who is already approved is a 404 too — "there is no pending
   * request here" is the true answer, and it matches `deny`.
   *
   * Asserted on the audit count rather than only the status: a second success
   * would append a second approval to the record of an account that was approved
   * once, which is the kind of thing somebody later reads as two decisions.
   */
  it('refuses to approve an organizer twice', async () => {
    const first = await srv.call('POST', `/api/admin/organizers/${PENDING}/approve`, {}, admin);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(verifiedOf(PENDING)).toBe(1);
    expect(auditCount(PENDING)).toBe(1);

    const second = await srv.call('POST', `/api/admin/organizers/${PENDING}/approve`, {}, admin);
    expect(second.status).toBe(404);
    expect(auditCount(PENDING), 'a second approval was recorded').toBe(1);
  });

  /* ── What it must still do ─────────────────────────────────────────────── */

  /**
   * The legitimate path, asserted after the refusals so the fix cannot be
   * "refuse everything" — which would pass every case above and leave no way to
   * approve an organizer at all, and therefore no way for anybody to post an
   * event.
   *
   * Uses a freshly-created pending organizer, since the seeded one is consumed
   * by the double-approval case above.
   */
  it('approves a genuinely pending organizer and records it once', async () => {
    const id = 'org-pending-probe';
    db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, created_at)
      VALUES (?, 'Probe Organizer', 'probe-org@example.invalid', 'probeorg', 'x', 'Adult', 'organizer', 0, ?)
    `).run(id, new Date().toISOString());

    const res = await srv.call('POST', `/api/admin/organizers/${id}/approve`, {}, admin);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(verifiedOf(id)).toBe(1);
    expect(auditCount(id)).toBe(1);
  });
});
