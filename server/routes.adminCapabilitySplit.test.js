import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Content-level cover for the `audit.read` split (M1c).
 *
 * ── The defect this file exists to prevent ──
 *
 * `audit.read` was doing three unrelated jobs. Two of them had nothing to do
 * with the audit trail:
 *
 *   1. `GET /api/admin/system/status`      — a mail-and-queue health panel
 *   2. `GET /api/applications`             — the UNSCOPED branch
 *   3. `GET /api/users/:id/profile`        — contact PII on a student profile
 *
 * Moving the capability to SUPER_ONLY without splitting 2 and 3 off first would
 * have taken all three away from administrators. The approved plan said it would
 * take away only #1 — that assessment was wrong, and it was verified wrong
 * before the change shipped.
 *
 * ── Why these are CONTENT assertions, and why that is the whole point ──
 *
 * `GET /api/applications` is a capability cascade that terminates in an explicit
 * `rows = []` rather than a bare `else`. That terminator is correct — "no
 * recognised capability" must mean "see nothing", never "see everything" — but
 * it means an administrator who loses the gating capability does not get a 403.
 * They get **HTTP 200 with an empty array**.
 *
 * `authz.matrix.test.js` asserts `admin: 'allow'` for that route, and `allow` is
 * a STATUS assertion. A 200 with zero rows satisfies it. So the regression would
 * pass the matrix, pass lint, pass the build, and be visible only to an
 * administrator wondering where every application went.
 *
 * Every assertion below is therefore about the BODY. A status-only version of
 * this file would be green against the exact bug it is written to catch.
 */
describe('the audit.read capability split keeps administrators whole', () => {
  let srv, admin, student, studentId;

  beforeAll(async () => {
    srv = await startTestServer();
    admin = await srv.login('admin@example.gov');
    student = await srv.login('leo.chen@example.com');
    const { db } = await import('./db.js');
    studentId = db.prepare('SELECT id FROM users WHERE email = ?')
      .get('leo.chen@example.com').id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /**
   * `application.read_all`, previously the `audit.read` branch.
   *
   * The length assertion is the load-bearing one. Dropping it to a status check
   * makes this test pass against the regression.
   */
  it('still returns a NON-EMPTY application list to an administrator', async () => {
    const res = await srv.call('GET', '/api/applications', undefined, admin);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(
      res.body.length,
      'an administrator holds application.read_all and must see every application — '
      + 'a 200 with an empty array is what the regression looks like, and the '
      + 'authorization matrix cannot tell the two apart'
    ).toBeGreaterThan(0);
  });

  /**
   * The same route, from the other side: the unscoped branch has to be genuinely
   * unscoped. An administrator seeing only their own applications would also be a
   * non-empty 200, so length alone is not sufficient.
   */
  it('gives the administrator a wider view than the student has', async () => {
    const asAdmin = await srv.call('GET', '/api/applications', undefined, admin);
    const asStudent = await srv.call('GET', '/api/applications', undefined, student);
    expect(asAdmin.status).toBe(200);
    expect(asStudent.status).toBe(200);
    expect(
      asAdmin.body.length,
      'the administrator branch is the UNSCOPED one; if it ever returns no more '
      + 'than the student sees, the cascade has fallen through to a scoped branch'
    ).toBeGreaterThan(asStudent.body.length);
  });

  /** `user.contact.read`, previously the `audit.read` branch. */
  it('still shows contact details on a student profile to an administrator', async () => {
    const res = await srv.call('GET', `/api/users/${studentId}/profile`, undefined, admin);
    expect(res.status).toBe(200);
    expect(
      res.body.volunteer.email,
      'an administrator holds user.contact.read; a null email here means the '
      + 'profile silently degraded to the withheld-contact shape, which is a 200'
    ).toBeTruthy();
    // `school` rides the same gate, so it catches the case where only `email`
    // was re-wired and the other withheld fields were missed.
    expect(res.body.volunteer.school).toBeTruthy();
  });

  /**
   * `analytics.school`, re-gated off `audit.read` in the same commit as the move.
   *
   * Split across two commits, there would have been a window in which nobody on
   * call could see mail or queue health.
   */
  it('still lets an administrator reach system status', async () => {
    const res = await srv.call('GET', '/api/admin/system/status', undefined, admin);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('smtpConfigured');
  });

  /**
   * The negative half. Without this, the three assertions above are equally
   * satisfied by simply never having moved `audit.read` at all.
   */
  it('does NOT give an administrator the audit trail', async () => {
    const res = await srv.call('GET', '/api/admin/audit-logs', undefined, admin);
    expect(res.status).toBe(403);
  });
});
