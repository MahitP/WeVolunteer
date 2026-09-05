import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('Admin CSV Export Route', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await fetch(srv.base + '/api/admin/reports/export');
    expect(res.status).toBe(401);
  });

  it('rejects student requests', async () => {
    const token = await srv.login('leo.chen@example.com');
    const res = await fetch(srv.base + '/api/admin/reports/export', {
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(403);
  });

  it('rejects organizer requests', async () => {
    const token = await srv.login('jordan.whitfield@example.org');
    const res = await fetch(srv.base + '/api/admin/reports/export', {
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(403);
  });

  /**
   * ── An ordinary administrator is refused now ──
   *
   * This case asserted a 200 for `admin@example.gov`, because the endpoint was
   * gated on `report.resolve`. That capability means "resolve the safety
   * reports people file", and the endpoint returns every active student's id,
   * NAME, EMAIL, school, join date and credited hours — so reviewing one report
   * about one person also granted a bulk download of every child's address, and
   * the path name made the mismatch look intentional.
   *
   * It is `roster.export` now: SUPER_ONLY, so it is also ungrantable, on the
   * same argument `audit.read` records. An administrator who needs figures
   * rather than people still has `/impact`, which is aggregate.
   */
  it('refuses an ordinary administrator', async () => {
    const token = await srv.login('admin@example.gov');
    const res = await fetch(srv.base + '/api/admin/reports/export', {
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(403);
  });

  it('returns a valid CSV file to the owner, and records the export', async () => {
    /* `loginAsOwner` promotes a seeded account to super_admin and enrols the
       second factor in the same step — `requireCap` refuses an owner with no
       second factor, which is correct and a confusing way to learn it. */
    const owner = await srv.loginAsOwner('admin@example.gov');
    const res = await fetch(srv.base + '/api/admin/reports/export', {
      headers: { Cookie: `wev_session=${owner}` }
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    /* Datestamped, so a copy found in a Downloads folder later can be dated.
       Matched loosely on the shape rather than on today's date, which would make
       this case fail at midnight. */
    expect(res.headers.get('content-disposition'))
      .toMatch(/attachment; filename="wevolunteer_students_\d{4}-\d{2}-\d{2}\.csv"/);

    const text = await res.text();
    const lines = text.trim().split('\n');
    /* No internal `id` column: it is useless outside this system and useful
       inside a leaked file, where a stable identifier is what lets two extracts
       be correlated into a longer record about a named child. */
    expect(lines[0]).toBe('Name,Email,School/Affiliation,Joined Date,Total Credited Hours');
    expect(text).toContain('Leo Chen');

    /**
     * The row is the point. A bulk PII egress that leaves no trace is the one
     * thing this endpoint must not be, and it left none at all before this —
     * so an incident review had no way to learn that a file containing every
     * student's address had been produced, or by whom.
     */
    const { db } = await import('./db.js');
    /* `insertionTiebreak`, not a literal `rowid`: that column exists only on
       SQLite, so this assertion passed on one engine and failed the whole case
       with `column "rowid" does not exist` on the other. The dialect layer owns
       the difference — see db/dialectSql.js. */
    const { insertionTiebreak } = await import('./db/dialectSql.js');
    const row = await db.prepare(
      'SELECT action, target_user_id, details FROM admin_audit_logs '
      + `WHERE action = 'ROSTER_EXPORTED' ORDER BY ${insertionTiebreak(db)} DESC LIMIT 1`
    ).get();
    expect(row, 'the export wrote no audit row').toBeTruthy();
    /* No target: the subject is every student at once, which is what makes the
       row worth having. The count is what a review needs. */
    expect(row.target_user_id).toBeFalsy();
    expect(row.details).toMatch(/\d+ student/);
  });
});

describe('Admin Audit Logging', () => {
  it('logs when an admin approves an organizer', async () => {
    // 1. Get an admin token
    const token = await srv.login('admin@example.gov');
    
    // 2. We need a pending organizer first. The seed data has 'user-org-pending'
    const res = await fetch(srv.base + '/api/admin/organizers/user-org-pending/approve', {
      method: 'POST',
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(200);

    // 3. Verify the audit log was created
    const { db } = await import('./db.js');
    const logs = await db.prepare("SELECT * FROM admin_audit_logs WHERE target_user_id = 'user-org-pending' AND action = 'APPROVE_ORGANIZER'").all();
    expect(logs.length).toBe(1);
    expect(logs[0].admin_id).toBe('user-admin');
    expect(logs[0].details).toBe('Approved pending organizer account');
  });

  it('logs when an admin denies an organizer', async () => {
    // We need to create a temporary pending organizer to deny
    const { body } = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email: 'badorg@example.com',
      password: 'Password123',
      name: 'Bad Org',
      role: 'organizer',
      grade: 'Adult',
      username: 'bad_org'
    });
    const user = body.user;
    
    const token = await srv.login('admin@example.gov');
    const res = await fetch(srv.base + `/api/admin/organizers/${user.id}/deny`, {
      method: 'POST',
      headers: { Cookie: `wev_session=${token}` }
    });
    expect(res.status).toBe(200);

    // Verify the audit log was created
    const { db } = await import('./db.js');
    const logs = await db.prepare("SELECT * FROM admin_audit_logs WHERE target_user_id = ? AND action = 'DENY_ORGANIZER'").all(user.id);
    expect(logs.length).toBe(1);
    expect(logs[0].admin_id).toBe('user-admin');
    expect(logs[0].details).toBe('Denied and deleted pending organizer account request');
  });
});

