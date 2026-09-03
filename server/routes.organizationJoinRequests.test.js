import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Requests to join a club, and the manager who answers them.
 *
 * ── The three properties worth more than the happy path ──
 *
 * 1. **There is at most one live request per person per club, and the DATABASE
 *    says so.** `idx_org_join_requests_live` is a partial unique index, so two
 *    simultaneous presses produce one row rather than two — after which
 *    accepting one would leave the other pending for ever. The concurrency case
 *    at the bottom drives it in parallel rather than asserting the index exists.
 * 2. **Exactly one of two managers pressing Accept wins.** The decision is a
 *    conditional `UPDATE … WHERE status = 'pending'`, so the loser is told the
 *    truth instead of writing over the winner.
 * 3. **A request discloses what the roster already discloses, and no more.** The
 *    queue is a list of named students, so what it does NOT carry is asserted.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';
const OTHER_ORGANIZER = 'robin.ellery@example.org';  // an organizer who runs a different club

describe('requests to join an organization', () => {
  let srv;
  let db;
  let manager;
  let student;
  let other;
  let comanager;
  let managerId;
  let studentId;
  let otherId;
  let comanagerId;
  let orgKey;
  let orgId;
  let otherOrgKey;
  let otherOrgId;

  const join = async (userId, role = 'member', organizationId = orgId) => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role
    `).run(organizationId, userId, role, new Date().toISOString());
  };

  const ask = (session = student, key = orgKey) =>
    srv.call('POST', `/api/organizations/${key}/join-requests`, {}, session);
  const withdraw = (session = student) =>
    srv.call('DELETE', `/api/organizations/${orgKey}/join-requests/mine`, undefined, session);
  const queue = (session = manager, key = orgKey) =>
    srv.call('GET', `/api/organizations/${key}/join-requests`, undefined, session);
  const decide = (requestId, decision, session = manager, key = orgKey) =>
    srv.call('POST', `/api/organizations/${key}/join-requests/${requestId}/decision`, { decision }, session);

  const page = async (session = student) =>
    (await srv.call('GET', `/api/organizations/${orgKey}`, undefined, session)).body;

  const isMember = async (userId) => Boolean(await db.prepare(
    'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(orgId, userId));

  const statusesFor = async (userId) => (await db.prepare(
    'SELECT status FROM organization_join_requests WHERE organization_id = ? AND user_id = ? ORDER BY created_at'
  ).all(orgId, userId)).map(r => r.status);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    student = await srv.login(STUDENT);
    other = await srv.login(OTHER_STUDENT);
    comanager = await srv.login(OTHER_ORGANIZER);

    managerId = (await srv.call('GET', '/api/auth/me', undefined, manager)).body.id;
    studentId = (await srv.call('GET', '/api/auth/me', undefined, student)).body.id;
    otherId = (await srv.call('GET', '/api/auth/me', undefined, other)).body.id;
    comanagerId = (await srv.call('GET', '/api/auth/me', undefined, comanager)).body.id;

    /**
     * The second organizer has to have signed the Organizer Agreement.
     *
     * `organizerAgreement.js` withholds every capability that reaches a student
     * until it is accepted — including `organization.manage.own` — so without
     * this Robin is refused at `requireCap` and the concurrency cases below
     * would measure a 403 race instead of a decision race. The seeded fixture
     * leaves them unsigned on purpose (they exist to be an unapproved
     * organizer), which is why this is done here and not in the seed.
     */
    const { acceptOrganizerAgreement } = await import('./organizerAgreement.js');
    for (const id of [managerId, comanagerId]) {
      try { await acceptOrganizerAgreement(db, { userId: id }); } catch { /* already signed */ }
    }

    const created = await srv.call('POST', '/api/organizations', {
      name: `Approving Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club that approves its members.',
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;

    const second = await srv.call('POST', '/api/organizations', {
      name: `Other Approving Club ${Math.random().toString(36).slice(2, 7)}`,
    }, manager);
    otherOrgKey = second.body.organization.slug;
    otherOrgId = second.body.organization.id;
    await db.prepare(`UPDATE organizations SET join_policy = 'request' WHERE id IN (?, ?)`)
      .run(orgId, otherOrgId);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_join_requests WHERE organization_id IN (?, ?)').run(orgId, otherOrgId);
    await db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_members WHERE organization_id IN (?, ?)').run(orgId, otherOrgId);
    await join(managerId, 'manager');
    await join(managerId, 'manager', otherOrgId);
    await db.prepare(`UPDATE organizations SET join_policy = 'request', status = 'active' WHERE id IN (?, ?)`)
      .run(orgId, otherOrgId);
  });

  describe('a student asking', () => {
    it('files a request and is told it is pending', async () => {
      const res = await ask();
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ pending: true, created: true });
      expect(await statusesFor(studentId)).toEqual(['pending']);
      expect(await isMember(studentId)).toBe(false);
    });

    it('can see on the page that it is waiting', async () => {
      await ask();
      const p = await page();
      expect(p.viewer.affordance).toBe('pending');
      expect(p.viewer.joinRequest.submittedAt).toBeTruthy();
    });

    /**
     * A second press is the same success, not an error and not a second row.
     * Enforced by the partial unique index, reported as idempotent by the route.
     */
    it('does not file a duplicate', async () => {
      const first = await ask();
      const second = await ask();
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ pending: true, created: false });
      expect(second.body.submittedAt).toBe(first.body.submittedAt);
      expect(await statusesFor(studentId)).toEqual(['pending']);
    });

    it('can take it back, and ask again afterwards', async () => {
      await ask();
      const gone = await withdraw();
      expect(gone.status).toBe(200);
      expect(gone.body).toEqual({ pending: false, withdrawn: true });
      expect((await page()).viewer.affordance).toBe('request');

      const again = await ask();
      expect(again.status).toBe(201);
      expect(await statusesFor(studentId)).toEqual(['withdrawn', 'pending']);
    });

    it('takes nothing back when there is nothing to take back', async () => {
      const res = await withdraw();
      expect(res.status).toBe(200);
      expect(res.body.withdrawn).toBe(false);
    });

    it('cannot ask a club that lets anybody in', async () => {
      await db.prepare(`UPDATE organizations SET join_policy = 'open' WHERE id = ?`).run(orgId);
      const res = await ask();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('not_by_request');
      expect(res.body.affordance).toBe('join');
    });

    /**
     * An invite-only club has said the way in is its link. A request would be a
     * second door the setting was chosen to close.
     */
    it('cannot ask an invitation-only club', async () => {
      await db.prepare(`UPDATE organizations SET join_policy = 'invite' WHERE id = ?`).run(orgId);
      const res = await ask();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('not_by_request');
      expect(res.body.affordance).toBe('invite_required');
    });

    it('cannot ask a club it is already in', async () => {
      await join(studentId, 'member');
      const res = await ask();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('already_member');
    });

    /**
     * The ban is enforced on BOTH ways in. A ban that stopped only the join
     * route would be a ban a client could route around by asking instead.
     */
    it('cannot ask while banned, and is told why', async () => {
      await db.prepare(`
        INSERT INTO organization_bans (id, organization_id, user_id, banned_by, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`ban-${Date.now()}`, orgId, studentId, managerId, 'Testing the ban', new Date().toISOString());

      const res = await ask();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('banned');
      expect(res.body.reason).toBe('Testing the ban');
      expect(await statusesFor(studentId)).toEqual([]);
    });
  });

  describe('the manager’s queue', () => {
    it('lists who is waiting, oldest first', async () => {
      await ask(student);
      await ask(other);
      const res = await queue();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.requests.map(r => r.requestId.startsWith('orq-'))).toEqual([true, true]);
      /* `id` is the USER, so one row component serves the queue and the roster. */
      expect(res.body.requests.map(r => r.id)).toEqual([studentId, otherId]);
      expect(res.body.requests.map(r => r.name)).toEqual(['Leo Chen', 'Priya Patel']);
      expect(res.body.pendingRequests).toBe(2);
    });

    /**
     * The queue is a list of named students, so what it does NOT carry matters
     * as much as what it does. `profileSummary` is the same strict subset the
     * roster and directory search publish — no grade, no school, no email
     * address, and no free-text message, because a request carries none.
     */
    it('discloses only what the roster already discloses', async () => {
      await ask(student);
      const [row] = (await queue()).body.requests;
      expect(Object.keys(row).sort()).toEqual([
        'avatar', 'avatarColor', 'distinction', 'id', 'kind', 'location',
        'name', 'profilePictureUrl', 'requestId', 'role', 'submittedAt', 'username',
      ]);
      const body = JSON.stringify((await queue()).body);
      expect(body).not.toContain('leo.chen@example.com');
      expect(body).not.toMatch(/"grade"|"school"|"dateOfBirth"|"message"/);
    });

    it('shows the count on the page so the badge and the list agree', async () => {
      await ask(student);
      expect((await page(manager)).viewer.pendingRequests).toBe(1);
    });

    it('tells a member nothing about the queue', async () => {
      await join(otherId, 'member');
      await ask(student);
      const p = await page(other);
      expect(p.viewer.pendingRequests).toBeNull();
      expect((await queue(other)).status).toBe(403);
    });

    /**
     * Reviewing is `canManage`, not `canHelpRun`. Deciding who is admitted is a
     * standing decision about membership, and the response is a list of named
     * students a Student Organizer has no need for.
     */
    it('refuses a student organizer', async () => {
      await join(otherId, 'student_organizer');
      await ask(student);
      /* Refused at the CAPABILITY layer: the rank grants the four helper
         capabilities and never `organization.manage.own`, so a student who helps
         run a club never reaches the ownership check at all. That is the first
         of the two layers `organizationRoles.js` describes, and it is the one
         that holds even if a handler forgets the second. */
      expect((await queue(other)).status).toBe(403);
    });

    /**
     * And the ownership layer, which is the one a capability cannot express.
     *
     * Robin is an organizer — they hold `organization.manage.own` — and they run
     * a DIFFERENT club. `canManage` is what refuses them here, and without it the
     * capability alone would let any organizer read any club's queue of named
     * students.
     */
    it('refuses an organizer who manages a different organization', async () => {
      await ask(student);
      const res = await queue(comanager);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_manager');
      /* And no part of the queue came back with the refusal. */
      expect(JSON.stringify(res.body)).not.toContain('Leo Chen');
    });

    it('leaves a deleted requester out rather than listing a ghost', async () => {
      await ask(student);
      await db.prepare(`UPDATE users SET account_status = 'deleted' WHERE id = ?`).run(studentId);
      try {
        expect((await queue()).body.requests).toEqual([]);
      } finally {
        await db.prepare(`UPDATE users SET account_status = 'active' WHERE id = ?`).run(studentId);
      }
    });
  });

  describe('deciding', () => {
    let requestId;

    beforeEach(async () => {
      await ask(student);
      requestId = (await queue()).body.requests[0].requestId;
    });

    it('admits the student on accept', async () => {
      const res = await decide(requestId, 'accept');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.decision).toBe('accept');
      expect(res.body.pendingRequests).toBe(0);
      expect(await isMember(studentId)).toBe(true);
      expect(await statusesFor(studentId)).toEqual(['accepted']);
      expect((await page()).viewer.affordance).toBe('member');
    });

    it('records who decided it and when', async () => {
      await decide(requestId, 'accept');
      const row = await db.prepare(
        'SELECT decided_by AS "decidedBy", decided_at AS "decidedAt" FROM organization_join_requests WHERE id = ?'
      ).get(requestId);
      expect(row.decidedBy).toBe(managerId);
      expect(row.decidedAt).toBeTruthy();
    });

    it('does not admit the student on reject, and lets them ask again', async () => {
      const res = await decide(requestId, 'reject');
      expect(res.status).toBe(200);
      expect(await isMember(studentId)).toBe(false);
      expect(await statusesFor(studentId)).toEqual(['rejected']);
      /* Declining is reversible by asking again — the partial unique index is
         scoped to `pending`, which is what makes that possible. */
      expect((await page()).viewer.affordance).toBe('request');
      expect((await ask()).status).toBe(201);
    });

    /**
     * Asserted on the TITLE, not on `notifications.kind`.
     *
     * `kind` holds the notification CATEGORY (`APPLICATION`, `ACCOUNT`), not the
     * event name — `getInAppContent` sets it from `EVENT_CATEGORIES`. A test that
     * looked for the event name there would pass the moment somebody typed the
     * category by hand, and fail for a correct notification.
     */
    const noticesFor = async (userId) => (await db.prepare(
      'SELECT kind, title, body, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40'
    ).all(userId));

    it('tells the student they are in', async () => {
      await decide(requestId, 'accept');
      const notices = await noticesFor(studentId);
      const mine = notices.find(n => /You are now a member of/.test(n.title));
      expect(mine, JSON.stringify(notices)).toBeTruthy();
      expect(mine.kind).toBe('ACCOUNT');
      expect(mine.title).toContain('Approving Club');
    });

    it('tells the student when they are declined, without a reason about them', async () => {
      await decide(requestId, 'reject');
      /* `LIMIT 8` on `noticesFor` is not enough here: the seeded fixture leaves
         this student several notices, and an earlier case in this block has
         already added an acceptance. Filtered rather than positional. */
      const notices = await noticesFor(studentId);
      const mine = notices.find(n => /did not accept your request/.test(n.title));
      expect(mine, JSON.stringify(notices)).toBeTruthy();
      /* No reason travels, deliberately: the alternative is a manager writing a
         judgement about a named minor into a message that is also emailed. */
      expect(mine.body).toContain('ask again later');
      expect(mine.body).not.toMatch(/Reason:/);
    });

    it('tells the managers when a request arrives, naming only the person', async () => {
      const notices = await noticesFor(managerId);
      const mine = notices.find(n => /asked to join/.test(n.title));
      expect(mine, JSON.stringify(notices)).toBeTruthy();
      expect(mine.kind).toBe('APPLICATION');
      expect(mine.body).toContain('Leo Chen');
      /* And nothing else about them — this body is copied into email. */
      expect(mine.body).not.toContain('leo.chen@example.com');
      expect(mine.body).not.toMatch(/Example Valley|grade|Grade/);
    });

    it('records the decision in the audit trail against the student', async () => {
      await decide(requestId, 'accept');
      const row = await db.prepare(`
        SELECT admin_id AS "adminId", target_user_id AS "targetUserId", details
          FROM admin_audit_logs
         WHERE action = 'ORGANIZATION_REQUEST_ACCEPTED'
         ORDER BY id DESC LIMIT 1
      `).get();
      expect(row.adminId).toBe(managerId);
      expect(row.targetUserId).toBe(studentId);
      expect(row.details).toContain('Approving Club');
    });

    it('refuses a decision that is neither accept nor reject', async () => {
      for (const decision of ['maybe', '', null, 'ACCEPT', 1]) {
        const res = await decide(requestId, decision);
        expect(res.status, `decision=${decision}`).toBe(400);
      }
      expect(await statusesFor(studentId)).toEqual(['pending']);
    });

    it('answers 409 when somebody has already decided it', async () => {
      await decide(requestId, 'accept');
      const again = await decide(requestId, 'reject');
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_decided');
      /* And the first decision stands. */
      expect(await statusesFor(studentId)).toEqual(['accepted']);
      expect(await isMember(studentId)).toBe(true);
    });

    it('answers 404 for a request that does not exist', async () => {
      const res = await decide('orq-00000000-0000-0000-0000-000000000000', 'accept');
      expect(res.status).toBe(404);
    });

    /**
     * The cross-organization case. Request ids are random UUIDs, so this is not
     * a guessing defence — it is what stops a manager of one club deciding
     * another club's request by pasting the id into a route scoped to theirs.
     */
    it("refuses another organization's request id", async () => {
      const res = await decide(requestId, 'accept', manager, otherOrgKey);
      expect(res.status).toBe(404);
      expect(await statusesFor(studentId)).toEqual(['pending']);
      expect(await isMember(studentId)).toBe(false);
    });

    it('refuses somebody who does not manage the organization', async () => {
      await join(otherId, 'student_organizer');
      expect((await decide(requestId, 'accept', other)).status).toBe(403);
      expect(await isMember(studentId)).toBe(false);
    });
  });

  describe('the states a request can be overtaken by', () => {
    /**
     * A club switched from `request` to `open` while somebody was waiting.
     *
     * The request stops mattering: the student can now simply join, and their
     * pending row is retired in the same transaction as the membership so the
     * two cannot disagree. `withdrawn` rather than `accepted`, because no
     * manager decided it — `decided_by` staying NULL is what says so.
     */
    it('retires a pending request when the student joins another way', async () => {
      await ask();
      await db.prepare(`UPDATE organizations SET join_policy = 'open' WHERE id = ?`).run(orgId);

      const joined = await srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, student);
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);

      expect(await statusesFor(studentId)).toEqual(['withdrawn']);
      const row = await db.prepare(
        'SELECT decided_by AS "decidedBy" FROM organization_join_requests WHERE organization_id = ? AND user_id = ?'
      ).get(orgId, studentId);
      expect(row.decidedBy).toBeNull();
      expect((await queue()).body.pendingRequests).toBe(0);
    });

    it('leaves pending requests decidable when the club switches to open', async () => {
      await ask();
      const requestId = (await queue()).body.requests[0].requestId;
      await db.prepare(`UPDATE organizations SET join_policy = 'open' WHERE id = ?`).run(orgId);
      /* Accepting is still meaningful and still admits them — the manager is
         answering something the student actually sent. */
      expect((await decide(requestId, 'accept')).status).toBe(200);
      expect(await isMember(studentId)).toBe(true);
    });
  });

  describe('concurrency', () => {
    /**
     * Two presses at once produce ONE request.
     *
     * Driven in parallel rather than asserted from the index's existence,
     * because what is being checked is that the conflict is absorbed and
     * reported as the same success — a route that let the unique error escape
     * would answer 500 to the second press of an ordinary button.
     *
     * ── The PostgreSQL-only failure these caught ──
     *
     * `requestToJoin` originally let the insert throw and caught
     * `isUniqueViolation`. That is correct on SQLite and a trap on PostgreSQL,
     * where a constraint violation aborts the whole surrounding transaction — so
     * the re-read that followed it failed with "current transaction is aborted",
     * inside the transaction that also notifies the managers. It showed up as
     * ONE flaky failure in a full PostgreSQL run and passed every time this file
     * was run alone, because a conflict only happens when two presses genuinely
     * overlap. Run these with `TEST_POSTGRES_URL` set; on SQLite they are green
     * either way, which is exactly why the PostgreSQL suite exists.
     */
    it('files one request for two simultaneous asks', async () => {
      const [a, b] = await Promise.all([ask(), ask()]);
      expect([a.status, b.status].every(s => s === 200 || s === 201)).toBe(true);
      expect(await statusesFor(studentId)).toEqual(['pending']);
    });

    it('files one request for five simultaneous asks', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => ask()));
      for (const res of results) expect([200, 201]).toContain(res.status);
      expect(await statusesFor(studentId)).toEqual(['pending']);
    });

    /**
     * Two managers, one request, one winner.
     *
     * The queue is a shared list and there is nothing to stop them both pressing
     * Accept. The conditional update means exactly one changes a row; the other
     * is told the request was already decided, which is true and is what they
     * need to know in order to refresh.
     */
    it('lets exactly one of two concurrent accepts win', async () => {
      /* A second ORGANIZER, promoted to manager of this club. A student given the
         `manager` rank would be refused at `requireCap` before the race could
         happen, so the test would prove nothing about concurrency. */
      await join(comanagerId, 'manager');
      await ask(student);
      const requestId = (await queue()).body.requests[0].requestId;

      const [a, b] = await Promise.all([
        decide(requestId, 'accept', manager),
        decide(requestId, 'accept', comanager),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(await statusesFor(studentId)).toEqual(['accepted']);
      expect(await isMember(studentId)).toBe(true);

      /* One membership row, not two — the insert is ON CONFLICT DO NOTHING, so
         even a loser that got that far could not double-add anybody. */
      const rows = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(orgId, studentId);
      expect(Number(rows.n)).toBe(1);
    });

    it('lets exactly one of an accept and a reject win', async () => {
      await join(comanagerId, 'manager');
      await ask(student);
      const requestId = (await queue()).body.requests[0].requestId;

      const [a, b] = await Promise.all([
        decide(requestId, 'accept', manager),
        decide(requestId, 'reject', comanager),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const statuses = await statusesFor(studentId);
      expect(statuses).toHaveLength(1);
      expect(['accepted', 'rejected']).toContain(statuses[0]);
      /* Membership must agree with whichever decision took. */
      expect(await isMember(studentId)).toBe(statuses[0] === 'accepted');
    });
  });
});
