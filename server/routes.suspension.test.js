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
 * **an existing session reaches no data**. Setting the status alone would block
 * the next sign-in and leave every already-issued cookie working for up to seven
 * days, which on a safety suspension is the entire window that mattered.
 *
 * That guarantee used to be delivered by invalidating sessions. It is now
 * delivered by `authenticateToken` re-reading `account_status` from the database
 * on every request and refusing everything outside the four routes in
 * `suspendedAccess.js` — which is stronger, because it does not depend on a
 * cookie expiring, and it leaves the session alive so the suspension screen can
 * explain itself on the device the person is already holding.
 */

let srv;
let db;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});
afterAll(async () => { await srv.close(); });

/**
 * Puts every seeded account back to active, so ordering between tests cannot matter.
 *
 * `suspended_until` and `suspension_lifted_at` are cleared too. A leftover FUTURE
 * deadline is not inert: the next suspension in another test would inherit it and
 * end on a date that test never chose, which is a cross-test dependency that
 * presents as a flake rather than a failure.
 */
function resetAccounts() {
  db.prepare(`
    UPDATE users
    SET account_status = 'active', suspended_at = NULL, suspension_reason = NULL,
        suspended_by = NULL, suspended_until = NULL, suspension_lifted_at = NULL
    WHERE account_status = 'suspended' OR suspended_until IS NOT NULL
  `).run();
}

const GOOD_REASON = 'Repeatedly contacted students outside event scope.';

describe('POST /api/admin/users/:id/suspend', () => {
  let adminToken, studentToken, organizerToken;

  beforeAll(async () => {
    adminToken = await srv.login('admin@example.gov');
    studentToken = await srv.login('leo.chen@example.com');
    organizerToken = await srv.login('jordan.whitfield@example.org');
  });

  beforeEach(() => resetAccounts());

  it('suspends an account and records who did it and why', async () => {
    const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');

    const row = await db.prepare(
      'SELECT account_status, suspension_reason, suspended_by, suspended_at FROM users WHERE id = ?'
    ).get('user-student-2');

    expect(row.account_status).toBe('suspended');
    expect(row.suspension_reason).toBe(GOOD_REASON);
    expect(row.suspended_by).toBe('user-admin');
    expect(row.suspended_at).toBeTruthy();
  });

  /**
   * CONFINES an existing session, rather than ending it.
   *
   * This test used to assert the opposite, and its message said why: "if this is
   * 200, suspension only blocks the next sign-in and a suspended user keeps full
   * access for up to seven days". That was true when it was written — the only
   * thing stopping a live cookie was invalidating it.
   *
   * It is not how the protection works now. `authenticateToken` re-reads
   * `account_status` from the DATABASE on every request and refuses everything
   * outside the four routes in `suspendedAccess.js`, so the guarantee moved from
   * "the token stops working" to "the token reaches almost nothing" — which is
   * strictly stronger, because it does not depend on a cookie expiring.
   *
   * So the assertion moved with it. `/api/auth/me` answering 200 is now
   * deliberate: it is the request that carries the suspension notice to the wall.
   * What must not answer 200 is anything else, and that is what is checked here.
   */
  it('CONFINES an existing session — the half that actually protects anyone', async () => {
    const victimToken = await srv.login('priya.patel@example.com');
    expect(
      (await srv.call('GET', '/api/auth/me', undefined, victimToken)).status,
      'precondition: the session works'
    ).toBe(200);

    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    /* The part that protects anyone: a cookie minted before the suspension
       reaches no platform data afterwards. If THIS is 200, a suspended user
       keeps full access until their token expires. */
    for (const path of ['/api/events', '/api/applications', '/api/notifications']) {
      const res = await srv.call('GET', path, undefined, victimToken);
      expect(res.status, `${path} was still reachable on a pre-suspension cookie`).toBe(403);
      expect(res.body.code).toBe('account_suspended');
    }

    /* And the part that explains it: the same cookie can still read the notice. */
    const me = await srv.call('GET', '/api/auth/me', undefined, victimToken);
    expect(me.status).toBe(200);
    expect(me.body.suspension).toMatchObject({ indefinite: true });
  });

  /**
   * Does NOT bump `token_version`, and that is the change this asserts.
   *
   * Bumping signed every device out, so a suspended student's next click was
   * "Session expired, please sign in again" — they re-entered a password to
   * discover they were locked out. That is the silent ejection the suspension
   * wall exists to replace, with an extra step in front of it, handed to the
   * person least able to work out what happened.
   *
   * It bought nothing, because the gate reads the row rather than the token. The
   * test above is the evidence: every device is refused on its next request
   * whether or not its cookie was invalidated.
   */
  it('does not sign the account out, because the gate does not need it', async () => {
    const before = await db.prepare('SELECT token_version FROM users WHERE id = ?').get('user-student-3');
    await srv.call('POST', '/api/admin/users/user-student-3/suspend',
      { reason: GOOD_REASON }, adminToken);
    const after = await db.prepare('SELECT token_version FROM users WHERE id = ?').get('user-student-3');

    expect(after.token_version).toBe(before.token_version);
  });

  /**
   * Sign-in SUCCEEDS while suspended, and the session it hands out is worthless.
   *
   * This test used to assert a 403 with no cookie. The refusal moved below the
   * password check so the person can be shown what happened to them: being
   * locked out with the only explanation in an email they may never have
   * received is the part that failed them, and they are usually minors.
   *
   * What replaces "no session" as the guarantee is `suspendedAccess.js` — the
   * session reaches four routes and nothing else. `suspendedSession.test.js`
   * owns that boundary in full; this asserts the sign-in half of the contract.
   */
  it('signs in while suspended, and says so', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    // Asserted against the endpoint rather than srv.login(), which returns the
    // cookie (undefined/null on failure) instead of throwing.
    const res = await srv.call('POST', '/api/auth/login', {
      email: 'priya.patel@example.com', password: 'password123'
    });

    expect(res.status).toBe(200);
    expect(res.body.suspension, 'the reason has to reach the person').toMatchObject({
      reason: GOOD_REASON,
      indefinite: true,
    });
    expect(res.cookie, 'the session is what carries them to the suspension screen').toBeTruthy();

    // And it is good for nothing else.
    const blocked = await srv.call('GET', '/api/events', undefined, res.cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('account_suspended');
  });

  /**
   * The password is still the gate.
   *
   * Moving the suspension branch below `bcrypt.compare` means a wrong password
   * must reveal nothing — not that the account is suspended, and certainly not
   * why. This is the assertion that keeps the move from becoming a disclosure.
   */
  it('tells a wrong password nothing about the suspension', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    const res = await srv.call('POST', '/api/auth/login', {
      email: 'priya.patel@example.com', password: 'wrong-on-purpose'
    });

    expect(res.status).toBe(401);
    expect(res.body.suspension).toBeUndefined();
    expect(res.cookie).toBeFalsy();
    expect(JSON.stringify(res.body)).not.toContain(GOOD_REASON);
  });

  it('writes an audit row naming the actor and the target', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    const audit = await db.prepare(`
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

      const still = await db.prepare('SELECT account_status FROM users WHERE id = ?').get('user-student-2');
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
      const row = await db.prepare('SELECT suspension_reason FROM users WHERE id = ?').get('user-student-2');
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
      const second = await db.prepare("SELECT id FROM users WHERE role = 'admin' AND id != 'user-admin'").get();
      if (!second) {
        await db.prepare(`
          INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, created_at)
          VALUES ('user-admin-2','Second Admin','admin2@example.gov','sysadmin2','x','N/A','admin',1,?)
        `).run(new Date().toISOString());
      }
      const targetId = second?.id ?? 'user-admin-2';

      const res = await srv.call('POST', `/api/admin/users/${targetId}/suspend`,
        { reason: GOOD_REASON }, adminToken);
      expect(res.status).toBe(403);

      await db.prepare("DELETE FROM users WHERE id = 'user-admin-2'").run();
    });

    it('refuses suspending a deleted account', async () => {
      await db.prepare("UPDATE users SET account_status = 'deleted' WHERE id = 'user-student-3'").run();
      const res = await srv.call('POST', '/api/admin/users/user-student-3/suspend',
        { reason: GOOD_REASON }, adminToken);
      expect(res.status).toBe(409);
      await db.prepare("UPDATE users SET account_status = 'active' WHERE id = 'user-student-3'").run();
    });
  });

  describe('organizers are suspended, never deleted', () => {
    it('preserves attendance and credited hours when an organizer is suspended', async () => {
      // The guarantee: /api/admin/organizers/:id/deny refuses approved
      // organizers precisely because ON DELETE CASCADE would take their events
      // — and their volunteers' attendance rows — with them. Suspension must
      // not reintroduce that by another door.
      const before = (await db.prepare(
        'SELECT COUNT(*) AS c FROM attendance WHERE event_id IN (SELECT id FROM events WHERE organizer_id = ?)'
      ).get('user-org-1')).c;

      const res = await srv.call('POST', '/api/admin/users/user-org-1/suspend',
        { reason: 'Safety report under investigation, pending review.' }, adminToken);
      expect(res.status).toBe(200);

      const after = (await db.prepare(
        'SELECT COUNT(*) AS c FROM attendance WHERE event_id IN (SELECT id FROM events WHERE organizer_id = ?)'
      ).get('user-org-1')).c;

      expect(after, 'suspending an organizer must not destroy volunteers\' service records').toBe(before);
      expect(await db.prepare('SELECT id FROM users WHERE id = ?').get('user-org-1')).toBeTruthy();
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

    const row = await db.prepare(
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

    const token = await srv.login('priya.patel@example.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
  });

  it('keeps the audit trail after reinstatement', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);
    await srv.call('POST', '/api/admin/users/user-student-2/unsuspend',
      { reason: 'Report not substantiated.' }, adminToken);

    const suspended = (await db.prepare(
      "SELECT COUNT(*) AS c FROM admin_audit_logs WHERE action = 'ACCOUNT_SUSPENDED' AND target_user_id = ?"
    ).get('user-student-2')).c;
    const lifted = (await db.prepare(
      "SELECT COUNT(*) AS c FROM admin_audit_logs WHERE action = 'ACCOUNT_UNSUSPENDED' AND target_user_id = ?"
    ).get('user-student-2')).c;

    expect(suspended, 'the suspension record must survive reinstatement').toBeGreaterThan(0);
    expect(lifted).toBeGreaterThan(0);
  });

  it('409s when the account is not suspended', async () => {
    const res = await srv.call('POST', '/api/admin/users/user-student-2/unsuspend', {}, adminToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_suspended');
  });

  it('refuses a student calling it', async () => {
    const studentToken = await srv.login('leo.chen@example.com');
    const res = await srv.call('POST', '/api/admin/users/user-student-2/unsuspend', {}, studentToken);
    expect(res.status).toBe(403);
  });
});

/**
 * Suspensions that end on their own.
 *
 * ── Why the deadline is enforced from the data, not by a job ──
 *
 * Every suspension this platform could express used to be permanent until
 * somebody remembered to lift it. A week-long suspension had to be recorded as
 * indefinite, and the only thing between "one week" and "for ever" was memory.
 *
 * The requirement attached to fixing that was "do not create fake expiration
 * behaviour", so the deadline is authoritative in the ROW and both enforcement
 * points ask a question about time (`server/suspension.js`). That is what these
 * cases pin: a suspension whose deadline has passed stops applying immediately,
 * with no background work involved — which is the difference between a real
 * expiry and a scheduled job pretending to be one. The cases below never run the
 * sweep.
 */
describe('timed suspension', () => {
  let adminToken;

  beforeAll(async () => { adminToken = await srv.login('admin@example.gov'); });
  beforeEach(() => resetAccounts());

  const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString();

  /** Backdates a live suspension's deadline, i.e. simulates the clock passing it. */
  const expireNow = (userId) => db.prepare(
    'UPDATE users SET suspended_until = ? WHERE id = ?'
  ).run(new Date(Date.now() - 1000).toISOString(), userId);

  it('stores the end date and reports it back', async () => {
    const until = inDays(7);
    const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON, until }, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.suspendedUntil).toBe(until);
    expect((await db.prepare('SELECT suspended_until FROM users WHERE id = ?')
      .get('user-student-2')).suspended_until).toBe(until);
  });

  it('still blocks while the deadline is in the future', async () => {
    const until = inDays(7);
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON, until }, adminToken);

    const res = await srv.call('POST', '/api/auth/login',
      { email: 'priya.patel@example.com', password: 'password123' });

    // Signed in, still suspended, and told when it ends.
    expect(res.status).toBe(200);
    expect(res.body.suspension).toMatchObject({ until, indefinite: false });
    // "Blocks" is now about what the session reaches, not whether one exists.
    const blocked = await srv.call('GET', '/api/events', undefined, res.cookie);
    expect(blocked.status).toBe(403);
  });

  /** The whole point: access comes back on its own, with nothing having run. */
  it('lets the account sign in again once the deadline passes', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON, until: inDays(7) }, adminToken);
    expireNow('user-student-2');

    const res = await srv.call('POST', '/api/auth/login',
      { email: 'priya.patel@example.com', password: 'password123' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('normalises the row when the deadline has passed, keeping why it happened', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON, until: inDays(7) }, adminToken);
    expireNow('user-student-2');

    await srv.call('POST', '/api/auth/login',
      { email: 'priya.patel@example.com', password: 'password123' });

    const row = await db.prepare(`SELECT account_status, suspension_reason, suspension_lifted_at
                              FROM users WHERE id = ?`).get('user-student-2');
    expect(row.account_status).toBe('active');
    expect(row.suspension_lifted_at).toBeTruthy();
    /**
     * The reason SURVIVES an expiry, unlike a reinstatement by hand. A moderator
     * handling a repeat incident needs to know there was a first one, and the
     * audit row that would otherwise carry it is swept at 365 days.
     */
    expect(row.suspension_reason).toBe(GOOD_REASON);
  });

  it('an existing session is refused while suspended and works after expiry', async () => {
    const victim = await srv.login('ethan.miller@example.com');
    await srv.call('POST', '/api/admin/users/user-student-3/suspend',
      { reason: GOOD_REASON, until: inDays(3) }, adminToken);

    /* The cookie survives — suspension no longer invalidates sessions — so what
       is asserted is that it reaches no data while the suspension is in force. */
    const during = await srv.call('GET', '/api/events', undefined, victim);
    expect(during.status).toBe(403);
    expect(during.body.code).toBe('account_suspended');

    expireNow('user-student-3');
    const after = await srv.call('POST', '/api/auth/login',
      { email: 'ethan.miller@example.com', password: 'password123' });
    expect(after.status).toBe(200);
  });

  it('keeps indefinite as the default when no end date is given', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);

    expect((await db.prepare('SELECT suspended_until FROM users WHERE id = ?')
      .get('user-student-2')).suspended_until).toBe(null);

    const res = await srv.call('POST', '/api/auth/login',
      { email: 'priya.patel@example.com', password: 'password123' });

    /**
     * `indefinite` is reported as its own field rather than left to be inferred
     * from a null date. A client that reads "no end date" as "ends soon" is the
     * exact misreading this costs one boolean to prevent, and the person reading
     * it has more at stake than anyone.
     */
    expect(res.status).toBe(200);
    expect(res.body.suspension).toMatchObject({ until: null, indefinite: true });
  });

  /**
   * The sign-in refusal must NOT name the end date.
   *
   * That branch runs before the password is checked — it has to, or a suspended
   * person is sent round the password-reset loop for something a reset cannot fix —
   * so anybody who can guess an email address reaches this message. That the
   * account exists and is suspended is already disclosed and is an accepted product
   * decision (`GENERIC_LOGIN_ERRORS` reverses it). The DATE is not covered by that
   * decision: it is a detail of a moderation action against a named minor, and it
   * belongs in the notice sent to the account, not in a response to an unproven
   * request.
   *
   * This was briefly the opposite. It read the date back and asserted it was
   * present, which is how the disclosure was found.
   *
   * ── The guarantee got stronger, not weaker ──
   *
   * The suspension branch now runs BELOW the password check, so an unproven
   * caller no longer learns that the account is suspended at all — the response
   * is an ordinary 401. The old design leaked account state to anyone who could
   * guess an address, an accepted-but-real disclosure that `GENERIC_LOGIN_ERRORS`
   * did not even cover. This asserts the whole notice is absent now, not just
   * the date.
   */
  it('discloses nothing to a caller who has not proved the password', async () => {
    const until = inDays(7);
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON, until }, adminToken);

    const res = await srv.call('POST', '/api/auth/login',
      { email: 'priya.patel@example.com', password: 'wrong-on-purpose' });

    expect(res.status).toBe(401);
    expect(res.body.suspension, 'the notice must not leave the building here')
      .toBeUndefined();
    expect(JSON.stringify(res.body), 'no part of the date may appear in the message')
      .not.toContain(until.slice(0, 10));
    expect(JSON.stringify(res.body), 'nor the reason')
      .not.toContain(GOOD_REASON);
    expect(JSON.stringify(res.body).toLowerCase(), 'nor that the account is suspended at all')
      .not.toContain('suspend');
  });

  /**
   * The person IS told when it ends — in the mandatory notice, which goes to the
   * address on the account rather than to whoever typed it into a form.
   */
  it('names the end date in the notice sent to the person', async () => {
    const until = inDays(7);
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON, until }, adminToken);

    const notice = await db.prepare(`
      SELECT body FROM notifications
       WHERE user_id = 'user-student-2' AND title LIKE '%suspended%'
       ORDER BY rowid DESC LIMIT 1
    `).get();

    expect(notice, 'a suspension with no notice is a lockout with no explanation').toBeTruthy();
    expect(notice.body).toMatch(/This suspension ends on /);
  });

  describe('refusals', () => {
    it('refuses a deadline that has already passed', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: GOOD_REASON, until: inDays(-1) }, adminToken);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('until_in_past');
      expect((await db.prepare('SELECT account_status FROM users WHERE id = ?')
        .get('user-student-2')).account_status).toBe('active');
    });

    /**
     * A typo must not become the permanent suspension the moderator was avoiding.
     * `isSuspended` fails CLOSED on an unreadable date, so an unvalidated write
     * would silently produce exactly that.
     */
    it('refuses a deadline it cannot read, rather than storing it', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: GOOD_REASON, until: 'next tuesday' }, adminToken);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_until');
    });

    /** `{ until: 1 }` must not coerce to 1970 — the same rule resolutionNote learned. */
    it('refuses a non-string deadline instead of coercing it', async () => {
      const res = await srv.call('POST', '/api/admin/users/user-student-2/suspend',
        { reason: GOOD_REASON, until: 1 }, adminToken);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_until');
    });
  });

  /**
   * A future deadline left on a reinstated row is not inert: the next suspension
   * would inherit it and end on a date nobody chose. Same class of dormant-value
   * bug as the appeal tokens that stayed live through an unsuspend.
   */
  it('does not let a reinstated account inherit its old deadline', async () => {
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON, until: inDays(7) }, adminToken);
    await srv.call('POST', '/api/admin/users/user-student-2/unsuspend', {}, adminToken);

    expect((await db.prepare('SELECT suspended_until FROM users WHERE id = ?')
      .get('user-student-2')).suspended_until).toBe(null);

    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON }, adminToken);
    expect((await db.prepare('SELECT suspended_until FROM users WHERE id = ?')
      .get('user-student-2')).suspended_until, 'inherited a deadline nobody chose').toBe(null);
  });

  it('records the duration in the audit trail', async () => {
    const until = inDays(7);
    await srv.call('POST', '/api/admin/users/user-student-2/suspend',
      { reason: GOOD_REASON, until }, adminToken);

    const row = await db.prepare(`SELECT details FROM admin_audit_logs
                             WHERE action = 'ACCOUNT_SUSPENDED' AND target_user_id = ?
                             ORDER BY rowid DESC LIMIT 1`).get('user-student-2');
    expect(row.details).toContain(until);
  });
});
