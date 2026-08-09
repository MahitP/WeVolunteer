import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A deleted account must not answer as a live one.
 *
 * ── Why this class of bug exists at all ──
 *
 * Deletion on this platform is a tombstone, not a row removal. The account is
 * anonymised in place — name, email, username, avatar, bio and school are
 * rewritten, `account_status` becomes 'deleted', `token_version` is bumped — and
 * the row survives so that the append-only audit trail and every foreign key
 * pointing at it still resolve. `server/routes/accountRoutes.js` does exactly
 * that, and it deliberately does NOT touch `role`.
 *
 * That last detail is what makes these bugs possible. Every query that selects a
 * user by role alone still matches tombstones, because the role is still there.
 * `authenticateToken` refuses a deleted account, so nothing can act *as* one —
 * but that only covers requests the account makes. It does nothing for requests
 * other people make *about* it, which is what all four cases below are.
 *
 * Found while auditing the removal of the demo administrator from the pilot
 * database. That row is `account_status = 'deleted'` with `role = 'admin'`
 * retained, and it made the organizer-profile endpoint answer 200.
 *
 * ── Why the role is not simply cleared instead ──
 *
 * Because it would move the leak rather than close it, and into a worse place:
 * the reports CSV export and the student headcount both select `role='student'`
 * with no status filter, so demoting a tombstone to 'student' files it into
 * statistics it is currently excluded from. The filter belongs at the read.
 *
 * Every negative assertion here is paired with a positive control on a live
 * account. A 404 test with no 200 beside it cannot distinguish "correctly
 * refused" from "endpoint is broken for everyone".
 */

let srv, db;

const OWNER_EMAIL = 'dsanger@outlook.com';
const LIVE_STUDENT = 'user-student-1';
const DEAD_STUDENT = 'user-student-3';
const LIVE_ORGANIZER = 'user-org-1';
const DEAD_ORGANIZER = 'user-org-pending';

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));

  /**
   * Tombstones written directly, the way `accountRoutes.js` writes them.
   *
   * Deliberately not driven through the delete endpoint: that endpoint requires
   * a step-up grant and deletes only the caller's own account, so it cannot
   * produce a deleted organizer at all. Writing the columns is the only way to
   * construct the state, and it is the state — not the route that reaches it —
   * that these endpoints have to handle.
   */
  const tombstone = db.prepare(`
    UPDATE users
       SET account_status = 'deleted',
           deleted_at = ?,
           name = ?,
           email = ?,
           username = ?,
           token_version = token_version + 1
     WHERE id = ?
  `);
  const now = new Date().toISOString();
  tombstone.run(now, 'Deleted U.', `deleted_${DEAD_STUDENT}@system.local`, `deleted_${DEAD_STUDENT}`, DEAD_STUDENT);
  tombstone.run(now, 'Deleted O.', `deleted_${DEAD_ORGANIZER}@system.local`, `deleted_${DEAD_ORGANIZER}`, DEAD_ORGANIZER);
});

afterAll(async () => { await srv?.close(); });

describe('deleted accounts are not readable as profiles', () => {
  it('keeps its role, which is what makes the rest of this file necessary', () => {
    const row = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(DEAD_ORGANIZER);
    // If a future change starts clearing `role` on deletion, these endpoints
    // stop being reachable by role and this fixture stops testing anything.
    // Asserting it here means that change fails loudly instead of silently
    // hollowing out the four tests below.
    expect(row.account_status).toBe('deleted');
    expect(row.role).toBe('organizer');
  });

  it('404s the volunteer profile of a deleted student', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('GET', `/api/users/${DEAD_STUDENT}/profile`, undefined, token);
    expect(res.status).toBe(404);
  });

  it('still serves the volunteer profile of a live student', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('GET', `/api/users/${LIVE_STUDENT}/profile`, undefined, token);
    expect(res.status).toBe(200);
  });

  it('404s the organizer profile of a deleted organizer', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('GET', `/api/organizers/${DEAD_ORGANIZER}/profile`, undefined, token);
    expect(res.status).toBe(404);
  });

  it('still serves the organizer profile of a live organizer', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('GET', `/api/organizers/${LIVE_ORGANIZER}/profile`, undefined, token);
    expect(res.status).toBe(200);
  });
});

describe('deleted accounts are not administratively actionable', () => {
  it('does not return a deleted account from the admin lookup', async () => {
    const ownerToken = await srv.loginAsOwner(OWNER_EMAIL);
    const dead = db.prepare('SELECT email FROM users WHERE id = ?').get(DEAD_STUDENT);

    const res = await srv.call(
      'GET', `/api/admin/users/lookup?email=${encodeURIComponent(dead.email)}`, undefined, ownerToken
    );
    expect(res.status).toBe(404);
  });

  it('still returns a live account from the admin lookup', async () => {
    const ownerToken = await srv.loginAsOwner(OWNER_EMAIL);
    const live = db.prepare('SELECT email FROM users WHERE id = ?').get(LIVE_STUDENT);

    const res = await srv.call(
      'GET', `/api/admin/users/lookup?email=${encodeURIComponent(live.email)}`, undefined, ownerToken
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(LIVE_STUDENT);
  });

  /**
   * The refusal has to happen before the step-up grant is spent.
   *
   * A grant is bound to one action with one set of arguments, from one sign-in,
   * for five minutes, once. A request that delivers nothing must not consume one
   * — the caller would have to complete another full re-authentication to retry
   * against a different account. So this asserts both halves: the promotion is
   * refused, and the account is not promoted.
   */
  it('refuses to promote a deleted account', async () => {
    const ownerToken = await srv.loginAsOwner(OWNER_EMAIL);

    const cookie = `wev_session=${ownerToken}`;

    const cRes = await fetch(srv.base + '/api/auth/reauth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'admin.promote', params: { targetUserId: DEAD_STUDENT } })
    });
    const { challengeId } = await cRes.json();
    expect(challengeId, 'no challenge was issued, so the promotion below proves nothing').toBeTruthy();

    const pRes = await fetch(srv.base + '/api/auth/reauth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ challengeId, password: 'password123' })
    });
    // Without this the request below would be refused by requireAAL2 for want of
    // a grant, and a 401 would look like the deleted-account refusal under test.
    expect(pRes.status, 'step-up did not complete').toBe(200);

    const res = await fetch(srv.base + `/api/admin/users/${DEAD_STUDENT}/promote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Reauth-Challenge': challengeId
      },
      body: JSON.stringify({ reason: 'should never happen' })
    });

    expect(res.status).toBe(404);

    const after = db.prepare('SELECT role FROM users WHERE id = ?').get(DEAD_STUDENT);
    expect(after.role).toBe('student');
  });
});

/**
 * Counts and exports describe people, not rows.
 *
 * The same tombstone-keeps-its-role property that made the profile endpoints
 * answer 200 also made every `role = 'student'` aggregate include deleted
 * accounts and the reserved `system-cli` actor. Two consequences, and the second
 * is the one that would have gone unnoticed:
 *
 * - the CSV export handed whoever asked for a list of volunteers a set of rows
 *   named `deleted_user-…@system.local`;
 * - `participationRate` divides real volunteers by `totals.students`, so an
 *   inflated denominator UNDERSTATES participation — a wrong number on the page
 *   that exists to report that number, with nothing about it looking wrong.
 */
describe('deleted accounts are excluded from counts and exports', () => {
  it('keeps a deleted student out of the CSV export, and a live one in', async () => {
    const ownerToken = await srv.loginAsOwner(OWNER_EMAIL);

    // Raw fetch, not srv.call: the response is text/csv and the helper parses
    // JSON, so the body comes back null and every assertion below would be
    // comparing against the string "null".
    const res = await fetch(srv.base + '/api/admin/reports/export', {
      headers: { Cookie: `wev_session=${ownerToken}` }
    });

    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.length, 'the export was empty').toBeGreaterThan(0);

    // Positive control first: if the export were simply empty or broken, the
    // absence assertion below would pass for the wrong reason.
    const live = db.prepare('SELECT email FROM users WHERE id = ?').get(LIVE_STUDENT);
    expect(csv).toContain(live.email);

    const dead = db.prepare('SELECT email FROM users WHERE id = ?').get(DEAD_STUDENT);
    expect(csv, 'a deleted account was exported').not.toContain(dead.email);
    expect(csv, 'the reserved CLI actor was exported').not.toContain('system-cli@wevolunteer.invalid');
  });

  it('does not count deleted students in the platform totals', async () => {
    const ownerToken = await srv.loginAsOwner(OWNER_EMAIL);
    const res = await srv.call('GET', '/api/admin/stats', undefined, ownerToken);
    expect(res.status).toBe(200);

    const liveStudents = db.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'student' AND account_status <> 'deleted'"
    ).get().c;
    const allStudentRows = db.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'student'"
    ).get().c;

    // The fixture must actually contain a deleted student, or this asserts nothing.
    expect(allStudentRows, 'no tombstone in the fixture — this test is vacuous')
      .toBeGreaterThan(liveStudents);

    // `totals` is spread into the response, so the counts sit at the top level.
    expect(res.body.students).toBe(liveStudents);
  });
});
