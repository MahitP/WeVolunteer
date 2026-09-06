import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Inviting one named person into a club, over HTTP.
 *
 * ── The four things this file has to establish ──
 *
 * 1. **An invitation is worth nothing on its own.** There is no token: the row
 *    names a user, and the only thing that can accept it is a session belonging
 *    to that user. So the interesting assertions are the ones where somebody
 *    ELSE tries to use it.
 * 2. **You cannot invite an email address.** Not because the endpoint refuses
 *    one, but because it takes a user id and there is no address anywhere in
 *    the surface — which is what stops it being the platform's only write
 *    oracle over a privileged field.
 * 3. **Accepting is joining.** There is deliberately no accept endpoint; the
 *    Accept press goes through `…/membership`, so the membership rules, the ban
 *    check and the transaction are the ones that already exist.
 * 4. **Declining is final for the inviter, not for the invitee.** A member
 *    cannot ask again after a no — that is harassment with a queue behind it —
 *    and the person who declined can still walk in through a link.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';
const THIRD_STUDENT = 'ethan.miller@example.com';
const ADMIN = 'admin@example.gov';

describe('inviting somebody to an organization', () => {
  let srv; let db;
  let manager; let helper; let invitee; let bystander;
  let managerId; let helperId; let inviteeId; let bystanderId;
  let orgKey; let orgId;

  const join = async (userId, role = 'member') => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role
    `).run(orgId, userId, role, new Date().toISOString());
  };

  const invite = (body, session = manager) =>
    srv.call('POST', `/api/organizations/${orgKey}/invitations`, body, session);
  const listInvitations = (session = manager) =>
    srv.call('GET', `/api/organizations/${orgKey}/invitations`, undefined, session);
  const withdraw = (id, session = manager) =>
    srv.call('DELETE', `/api/organizations/${orgKey}/invitations/${id}`, undefined, session);
  const decline = (session = invitee) =>
    srv.call('DELETE', `/api/organizations/${orgKey}/invitations/mine`, undefined, session);
  const page = async (session) =>
    (await srv.call('GET', `/api/organizations/${orgKey}`, undefined, session)).body;
  const acceptByJoining = (session = invitee) =>
    srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, session);

  const isMember = async (userId) => Boolean(await db.prepare(
    'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(orgId, userId));

  const policy = async (joinPolicy) => {
    await db.prepare('UPDATE organizations SET join_policy = ? WHERE id = ?').run(joinPolicy, orgId);
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    helper = await srv.login(STUDENT);
    invitee = await srv.login(OTHER_STUDENT);
    bystander = await srv.login(THIRD_STUDENT);

    managerId = (await srv.call('GET', '/api/auth/me', undefined, manager)).body.id;
    helperId = (await srv.call('GET', '/api/auth/me', undefined, helper)).body.id;
    inviteeId = (await srv.call('GET', '/api/auth/me', undefined, invitee)).body.id;
    bystanderId = (await srv.call('GET', '/api/auth/me', undefined, bystander)).body.id;

    const created = await srv.call('POST', '/api/organizations', {
      name: `Invitation Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club used by the invitation tests.',
      tags: ['Coordination'],
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_invitations WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_join_requests WHERE organization_id = ?').run(orgId);
    await join(managerId, 'manager');
    await join(helperId, 'student_organizer');
    await db.prepare(
      `UPDATE organizations SET join_policy = 'invite', status = 'active' WHERE id = ?`
    ).run(orgId);
  });

  describe('sending one', () => {
    it('invites a person by id and reports who was invited', async () => {
      const res = await invite({ userId: inviteeId });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      /* The same shape the list endpoint returns — `invitationId` for the
         invitation, `id` for the person, because `profileSummary` owns `id`.
         One shape means the client renders a newly-sent invitation with the
         component it already uses for the list. */
      expect(res.body.invitation.invitationId).toMatch(/^oinv-/);
      expect(res.body.invitation.id).toBe(inviteeId);
      expect(res.body.invitation.expiresAt).toBeTruthy();

      /* Field for field the same as the list, so the client renders a
         newly-sent invitation with the component it already uses. A shorter
         SELECT behind this would publish a person with no avatar and look like
         a rendering bug. */
      expect(Object.keys(res.body.invitation).sort()).toEqual([
        'avatar', 'avatarColor', 'createdAt', 'distinction', 'expiresAt', 'id',
        'invitationId', 'kind', 'location', 'message', 'name', 'profilePictureUrl', 'role', 'username',
      ]);
    });

    /**
     * There is no token in the answer, in the row, or anywhere else.
     *
     * `admin_invitations` hashes one and refuses to return it, because a holder
     * of the plaintext could redeem from an address they control. This design
     * removes the credential instead: the authority is the identity of the
     * person invited, so a token would be a redundant secret that can leak.
     */
    it('mints no credential of any kind', async () => {
      const res = await invite({ userId: inviteeId });
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{32}/);

      const row = await db.prepare(
        'SELECT * FROM organization_invitations WHERE organization_id = ?'
      ).get(orgId);
      expect(Object.keys(row)).not.toContain('token');
      expect(Object.keys(row)).not.toContain('token_hash');
    });

    /**
     * No email address anywhere in the surface.
     *
     * `profileSerializer.js` puts `email` in `PRIVILEGED_FIELDS` and directory
     * search cannot match on it. An address field here would be the first place
     * a semi-trusted actor could act on an address they were never shown — and
     * the population is minors.
     */
    it('takes no email address, and discloses none', async () => {
      const byEmail = await invite({ email: OTHER_STUDENT });
      expect(byEmail.status).toBe(400);
      expect(byEmail.body.field).toBe('userId');

      const ok = await invite({ userId: inviteeId });
      expect(JSON.stringify(ok.body)).not.toContain('@example.com');
      expect(JSON.stringify((await listInvitations()).body)).not.toContain('@example.com');
    });

    it('carries the note, trimmed, and stores no note as null', async () => {
      const withNote = await invite({ userId: inviteeId, message: '  We could use your help.  ' });
      expect(withNote.body.invitation.message).toBe('We could use your help.');

      await db.prepare('DELETE FROM organization_invitations WHERE organization_id = ?').run(orgId);
      const without = await invite({ userId: inviteeId, message: '   ' });
      expect(without.body.invitation.message).toBeNull();
    });

    it('refuses a note past the limit rather than truncating it', async () => {
      const res = await invite({ userId: inviteeId, message: 'x'.repeat(301) });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('message');
      expect((await listInvitations()).body.invitations).toHaveLength(0);
    });

    it('asks for somebody when given nobody', async () => {
      for (const body of [{}, { userId: '' }, { userId: '   ' }]) {
        const res = await invite(body);
        expect(res.status).toBe(400);
        expect(res.body.field).toBe('userId');
      }
    });

    it('answers 404 for a user id that names nobody', async () => {
      const res = await invite({ userId: 'user-does-not-exist' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('no_such_user');
    });

    it('refuses somebody already in the club', async () => {
      await join(inviteeId, 'member');
      const res = await invite({ userId: inviteeId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('already_member');
    });

    /**
     * A ban is not routed around by an invitation.
     *
     * Lifting a ban is its own deliberate act with its own audit row. An
     * invitation that bypassed it would be a second door into a club that
     * closed the first.
     */
    it('refuses somebody banned from the club, and says to lift the ban', async () => {
      await join(inviteeId, 'member');
      await srv.call('DELETE', `/api/organizations/${orgKey}/members/${inviteeId}`,
        { mode: 'ban', reason: 'Testing the ban path' }, manager);

      const res = await invite({ userId: inviteeId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('banned');
      expect((await listInvitations()).body.invitations).toHaveLength(0);
    });

    it('refuses a second pending invitation to the same person', async () => {
      expect((await invite({ userId: inviteeId })).status).toBe(201);
      const again = await invite({ userId: inviteeId });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('pending');
      expect((await listInvitations()).body.invitations).toHaveLength(1);
    });

    /**
     * Two managers pressing at the same instant produce one invitation.
     *
     * The partial unique index is the guarantee, and `ON CONFLICT … DO NOTHING`
     * against the same predicate is what makes it identical on both engines —
     * on PostgreSQL a caught unique violation would abort the surrounding
     * transaction and take the audit row with it.
     */
    it('settles a race with the database rather than with a pre-check', async () => {
      const [a, b] = await Promise.all([invite({ userId: inviteeId }), invite({ userId: inviteeId })]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const rows = await db.prepare(
        "SELECT COUNT(*) AS n FROM organization_invitations WHERE organization_id = ? AND status = 'pending'"
      ).get(orgId);
      expect(Number(rows.n)).toBe(1);
    });

    it('refuses on an archived organization', async () => {
      await db.prepare(`UPDATE organizations SET status = 'archived' WHERE id = ?`).run(orgId);
      const res = await invite({ userId: inviteeId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('archived');
    });

    it('refuses to invite yourself, and says why', async () => {
      const res = await invite({ userId: managerId });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('self');
      /* Not "You are already in this organization" — a manager who mis-clicked
         their own row was told something about their own membership while
         trying to invite somebody else. */
      expect(res.body.error).toBe('You cannot invite yourself.');
    });

    it('writes an audit row that names the club and the person, and never the note', async () => {
      await invite({ userId: inviteeId, message: 'a private note to one person' });
      const rows = await db.prepare(
        `SELECT details FROM admin_audit_logs WHERE action = 'ORGANIZATION_INVITATION_SENT'`
      ).all();
      expect(rows.length).toBeGreaterThan(0);
      const details = rows.map(r => r.details ?? '').join('\n');
      expect(details).toContain(`@${orgKey}`);
      /* The note was written to one person; the trail is read by administrators
         who are not in this club. */
      expect(details).not.toContain('a private note to one person');
    });

    it('notifies the person invited, without naming who invited them', async () => {
      /**
       * Scoped to the notification THIS case created, by diffing the ids around
       * the invite.
       *
       * The read here was `ORDER BY id DESC` with `rows[0]`. Notification ids
       * are `notif-${randomUUID()}` — text, and random — so that sorted UUIDs
       * lexicographically and returned an arbitrary row, not the newest one.
       *
       * That mattered because notifications ACCUMULATE across this file: by the
       * time this case runs the invitee holds ten of them, nine invitations and
       * one "You were banned from Invitation Club …" left by an earlier case. So
       * the assertion drew one row out of ten at random and failed roughly one
       * run in ten. It failed exactly that way in a full-suite run, and passed
       * six times out of six in isolation, which is what a random-id flake looks
       * like from the outside and why it survived this long.
       *
       * Neither obvious repair is enough. `ORDER BY created_at DESC` ties for
       * rows written in the same millisecond. Filtering by `kind` does not
       * narrow it either — the invitation kind is the `APPLICATION` category,
       * which the nine earlier invitations also carry.
       *
       * Diffing the ids is exact: whatever this invite wrote is the row that was
       * not there a moment ago.
       */
      const before = new Set(
        (await db.prepare('SELECT id FROM notifications WHERE user_id = ?').all(inviteeId))
          .map((r) => r.id)
      );
      await invite({ userId: inviteeId, message: 'we would love to have you' });
      const rows = (await db.prepare(
        'SELECT id, title, body FROM notifications WHERE user_id = ?'
      ).all(inviteeId)).filter((r) => !before.has(r.id));

      expect(rows.length, 'the invite wrote no notification for the invitee').toBe(1);
      const text = `${rows[0].title} ${rows[0].body}`;
      expect(text).toMatch(/invited/i);
      /* The club invites, not the individual member who pressed the button.
         Naming them would make declining an answer to a classmate. */
      expect(text).not.toContain('Jordan Whitfield');
      /* And the note stays on the page rather than being copied into an email. */
      expect(text).not.toContain('we would love to have you');
    });
  });

  describe('who may send one', () => {
    /**
     * `canManage`, and deliberately not `invite_policy`.
     *
     * That setting says who may hand the club's ADDRESS out — an act with a
     * human in the middle, aimed at somebody they are already talking to.
     * Inviting a named individual reaches into another person's notifications
     * and names them in the club's records, which is a decision about the
     * roster.
     */
    it('refuses a student organizer', async () => {
      const res = await invite({ userId: inviteeId }, helper);
      expect(res.status).toBe(403);
      expect((await listInvitations()).body.invitations).toHaveLength(0);
    });

    it('refuses an ordinary member even when the club lets any member share the link', async () => {
      await join(bystanderId, 'member');
      await srv.call('PATCH', `/api/organizations/${orgKey}`, { invitePolicy: 'members' }, manager);

      const res = await invite({ userId: inviteeId }, bystander);
      expect(res.status).toBe(403);
      expect((await listInvitations()).body.invitations).toHaveLength(0);
    });

    it('refuses somebody outside the club entirely', async () => {
      expect((await invite({ userId: inviteeId }, bystander)).status).toBe(403);
    });

    it('lets an administrator through on organization.moderate', async () => {
      const admin = await srv.login(ADMIN);
      expect((await invite({ userId: inviteeId }, admin)).status).toBe(201);
    });
  });

  describe('the outstanding list', () => {
    it('discloses only what the roster discloses, plus the note', async () => {
      await invite({ userId: inviteeId, message: 'come along' });
      const [row] = (await listInvitations()).body.invitations;
      expect(Object.keys(row).sort()).toEqual([
        'avatar', 'avatarColor', 'createdAt', 'distinction', 'expiresAt', 'id',
        'invitationId', 'kind', 'location', 'message', 'name', 'profilePictureUrl', 'role', 'username',
      ]);
      const body = JSON.stringify((await listInvitations()).body);
      expect(body).not.toMatch(/"grade"|"school"|"dateOfBirth"|"email"/);
    });

    it('is a manager’s list and nobody else’s', async () => {
      await invite({ userId: inviteeId });
      expect((await listInvitations(helper)).status).toBe(403);
      expect((await listInvitations(bystander)).status).toBe(403);
      /* Not even the person invited: their own page tells them, without the
         club's other outstanding invitations. */
      expect((await listInvitations(invitee)).status).toBe(403);
    });

    it('shows the count on the page so the badge and the list agree', async () => {
      await invite({ userId: inviteeId });
      expect((await page(manager)).viewer.pendingInvitations).toBe(1);
      /* And null for somebody who may not read the list at all. */
      await join(bystanderId, 'member');
      expect((await page(bystander)).viewer.pendingInvitations).toBeNull();
    });

    /**
     * A lapsed invitation stops being reported as outstanding.
     *
     * Lazily, on the read — enforcement does not depend on it (`invitationStands`
     * refuses a lapsed row whether or not this has run), which is what makes it
     * safe to be lazy rather than a scheduled job.
     */
    it('retires an invitation that has lapsed', async () => {
      await invite({ userId: inviteeId });
      await db.prepare(
        'UPDATE organization_invitations SET expires_at = ? WHERE organization_id = ?'
      ).run('2020-01-01T00:00:00.000Z', orgId);

      expect((await listInvitations()).body.invitations).toHaveLength(0);
      const row = await db.prepare(
        'SELECT status FROM organization_invitations WHERE organization_id = ?'
      ).get(orgId);
      expect(row.status).toBe('expired');
    });

    it('drops an invitation whose recipient deleted their account', async () => {
      await invite({ userId: inviteeId });
      await db.prepare(`UPDATE users SET account_status = 'deleted' WHERE id = ?`).run(inviteeId);
      expect((await listInvitations()).body.invitations).toHaveLength(0);
      await db.prepare(`UPDATE users SET account_status = 'active' WHERE id = ?`).run(inviteeId);
    });
  });

  describe('what the invited person sees', () => {
    it('is told they were invited, with the note and the date', async () => {
      await invite({ userId: inviteeId, message: 'we meet on Thursdays' });
      const viewer = (await page(invitee)).viewer;
      expect(viewer.invitation.message).toBe('we meet on Thursdays');
      expect(viewer.invitation.expiresAt).toBeTruthy();
    });

    /**
     * Who invited them is deliberately absent.
     *
     * The club invites, not the individual member. Naming them makes a decline
     * an answer to a classmate rather than to a club — which is exactly the
     * pressure a thirteen-year-old should not be under.
     */
    it('is not told which member pressed the button', async () => {
      await invite({ userId: inviteeId });
      const viewer = (await page(invitee)).viewer;
      expect(Object.keys(viewer.invitation).sort()).toEqual(['expiresAt', 'id', 'message']);
      expect(JSON.stringify(viewer.invitation)).not.toContain(managerId);
    });

    /**
     * The invitation is what makes the club joinable, and the server says so.
     *
     * An invitation-only club reports `invite_required` to everybody else. A
     * client that had to work this out for itself would be a second copy of the
     * membership policy.
     */
    it('is offered a Join that the server will honour', async () => {
      const before = (await page(invitee)).viewer;
      expect(before.affordance).toBe('invite_required');
      expect(before.invitation).toBeUndefined();

      await invite({ userId: inviteeId });
      const after = (await page(invitee)).viewer;
      expect(after.affordance).toBe('join');
    });

    it('tells nobody else about it', async () => {
      await invite({ userId: inviteeId });
      await join(bystanderId, 'member');
      expect((await page(bystander)).viewer.invitation).toBeUndefined();
      expect((await page(helper)).viewer.invitation).toBeUndefined();
    });
  });

  /**
   * An invitation admits on a club that would otherwise make you ask.
   *
   * This is the case the feature was inert for: the invitee was told to send a
   * request, their Accept press was answered `request_required`, and the
   * invitation sat pending against the club's outstanding list until it lapsed.
   */
  describe('on a club that approves its members', () => {
    it('lets an invited person in without asking as well', async () => {
      await policy('request');
      await invite({ userId: inviteeId });

      const viewer = (await page(invitee)).viewer;
      expect(viewer.affordance).toBe('join');
      expect(viewer.invitation).toBeTruthy();

      const joined = await acceptByJoining();
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(await isMember(inviteeId)).toBe(true);
    });

    /**
     * And a LINK still does not, which is the other half.
     *
     * A share link is an address somebody passed on and says nothing about who
     * holds it. A request-to-join club's whole point is that a human approves
     * each member, so a link that bypassed the approval would make the setting
     * decorative.
     */
    it('still refuses somebody holding only a link', async () => {
      await policy('request');
      const link = (await srv.call('POST', `/api/organizations/${orgKey}/share-links`, {}, manager))
        .body.link;
      const token = String(link.path).split('/').pop();

      const res = await srv.call('POST', `/api/organizations/${orgKey}/membership`,
        { shareToken: token }, invitee);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('request_required');
      expect(await isMember(inviteeId)).toBe(false);
    });

    it('retires the invitation when a manager accepts their request instead', async () => {
      await policy('request');
      await invite({ userId: inviteeId });
      /* They asked as well — which the affordance no longer offers them, but a
         request filed before the invitation arrived is a real state. */
      await srv.call('POST', `/api/organizations/${orgKey}/join-requests`, {}, invitee);
      const requestId = (await srv.call('GET', `/api/organizations/${orgKey}/join-requests`,
        undefined, manager)).body.requests[0].requestId;

      const decided = await srv.call(
        'POST', `/api/organizations/${orgKey}/join-requests/${requestId}/decision`,
        { decision: 'accept' }, manager,
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);

      /* The invitation stops being outstanding, exactly as it would if they had
         joined through the ordinary route. Left pending it would count against
         the club's list for ever and block re-invitation for a fortnight. */
      const row = await db.prepare(
        'SELECT status FROM organization_invitations WHERE organization_id = ?'
      ).get(orgId);
      expect(row.status).toBe('accepted');
      expect((await listInvitations()).body.invitations).toHaveLength(0);
    });

    /**
     * And accepting a request re-checks the ban, which it did not.
     *
     * Joining and requesting both re-read it at the moment of the act; the
     * manager's Accept did not, and banning does not retire a pending request.
     */
    it('refuses to accept a request from somebody since banned', async () => {
      await policy('request');
      await srv.call('POST', `/api/organizations/${orgKey}/join-requests`, {}, invitee);
      const requestId = (await srv.call('GET', `/api/organizations/${orgKey}/join-requests`,
        undefined, manager)).body.requests[0].requestId;

      await db.prepare(`
        INSERT INTO organization_bans (id, organization_id, user_id, reason, banned_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`ban-${Math.random().toString(36).slice(2)}`, orgId, inviteeId,
        'Banned while the request was waiting', managerId, new Date().toISOString());

      const decided = await srv.call(
        'POST', `/api/organizations/${orgKey}/join-requests/${requestId}/decision`,
        { decision: 'accept' }, manager,
      );
      expect(decided.status).toBe(409);
      expect(decided.body.code).toBe('banned');
      expect(await isMember(inviteeId)).toBe(false);

      /* And the request is still PENDING, so a manager who lifts the ban can
         still accept it — rather than a row marked accepted with no membership
         behind it, which is what checking after the status write would have
         committed. */
      const row = await db.prepare(
        'SELECT status FROM organization_join_requests WHERE id = ?'
      ).get(requestId);
      expect(row.status).toBe('pending');
    });

    it('still lets a manager decline a banned person’s request', async () => {
      await policy('request');
      await srv.call('POST', `/api/organizations/${orgKey}/join-requests`, {}, invitee);
      const requestId = (await srv.call('GET', `/api/organizations/${orgKey}/join-requests`,
        undefined, manager)).body.requests[0].requestId;
      await db.prepare(`
        INSERT INTO organization_bans (id, organization_id, user_id, reason, banned_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`ban-${Math.random().toString(36).slice(2)}`, orgId, inviteeId,
        'Banned while the request was waiting', managerId, new Date().toISOString());

      const declined = await srv.call(
        'POST', `/api/organizations/${orgKey}/join-requests/${requestId}/decision`,
        { decision: 'reject' }, manager,
      );
      expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    });
  });

  describe('accepting', () => {
    /**
     * Accepting IS joining, through the route that already holds every rule.
     *
     * A second endpoint that also created memberships would be a second
     * implementation of the capability check, the ban check, the affordance and
     * the transaction — and the one that drifts is always the newer one.
     */
    it('admits the invited person through the ordinary membership route', async () => {
      await invite({ userId: inviteeId });
      const res = await acceptByJoining();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await isMember(inviteeId)).toBe(true);
    });

    it('retires the invitation in the same act', async () => {
      await invite({ userId: inviteeId });
      await acceptByJoining();
      const row = await db.prepare(
        'SELECT status FROM organization_invitations WHERE organization_id = ?'
      ).get(orgId);
      expect(row.status).toBe('accepted');
      /* And stops counting against the club's outstanding list. */
      expect((await listInvitations()).body.invitations).toHaveLength(0);
    });

    it('admits at the lowest rank, granting no capability', async () => {
      const before = (await db.prepare(
        'SELECT capability FROM user_capabilities WHERE user_id = ? ORDER BY capability'
      ).all(inviteeId)).map(r => r.capability);

      await invite({ userId: inviteeId });
      await acceptByJoining();

      const rank = await db.prepare(
        'SELECT member_role AS r FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(orgId, inviteeId);
      expect(rank.r).toBe('member');
      /* `syncOrganizerCapabilities` grants four helper capabilities to anybody
         holding `manager` or `student_organizer` ANYWHERE, so admitting at the
         wrong rank would be a platform-wide privilege escalation. */
      const after = (await db.prepare(
        'SELECT capability FROM user_capabilities WHERE user_id = ? ORDER BY capability'
      ).all(inviteeId)).map(r => r.capability);
      expect(after).toEqual(before);
    });

    /** Somebody else's invitation admits nobody. */
    it('does not admit a different person', async () => {
      await invite({ userId: inviteeId });
      const res = await srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, bystander);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('invite_required');
      expect(await isMember(bystanderId)).toBe(false);
    });

    it('stops admitting once withdrawn', async () => {
      const { invitationId } = (await invite({ userId: inviteeId })).body.invitation.id
        ? { invitationId: (await listInvitations()).body.invitations[0].invitationId }
        : {};
      await withdraw(invitationId);

      const res = await acceptByJoining();
      expect(res.status).toBe(403);
      expect(await isMember(inviteeId)).toBe(false);
    });

    it('stops admitting once it has lapsed', async () => {
      await invite({ userId: inviteeId });
      await db.prepare(
        'UPDATE organization_invitations SET expires_at = ? WHERE organization_id = ?'
      ).run('2020-01-01T00:00:00.000Z', orgId);

      const res = await acceptByJoining();
      expect(res.status).toBe(403);
      expect(await isMember(inviteeId)).toBe(false);
    });

    it('does not admit somebody who has since been banned', async () => {
      await invite({ userId: inviteeId });
      await db.prepare(`
        INSERT INTO organization_bans (id, organization_id, user_id, reason, banned_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`ban-${Math.random().toString(36).slice(2)}`, orgId, inviteeId,
        'Banned after the invitation', managerId, new Date().toISOString());

      const res = await acceptByJoining();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('banned');
      expect(await isMember(inviteeId)).toBe(false);
    });
  });

  describe('declining', () => {
    it('is the invited person’s own answer', async () => {
      await invite({ userId: inviteeId });
      const res = await decline();
      expect(res.status).toBe(200);
      expect(res.body.declined).toBe(true);

      const row = await db.prepare(
        'SELECT status FROM organization_invitations WHERE organization_id = ?'
      ).get(orgId);
      expect(row.status).toBe('declined');
    });

    it('cannot be done on somebody else’s behalf', async () => {
      await invite({ userId: inviteeId });
      /* `…/invitations/mine` resolves the row by `invited_user_id = the caller`,
         so there is no id to paste and nothing to scope wrong. */
      expect((await decline(bystander)).status).toBe(404);
      expect((await decline(manager)).status).toBe(404);

      const row = await db.prepare(
        'SELECT status FROM organization_invitations WHERE organization_id = ?'
      ).get(orgId);
      expect(row.status).toBe('pending');
    });

    it('takes the Join away with it', async () => {
      await invite({ userId: inviteeId });
      await decline();
      expect((await page(invitee)).viewer.affordance).toBe('invite_required');
      expect((await acceptByJoining()).status).toBe(403);
    });

    /**
     * A no stops the asking.
     *
     * The partial unique index stops a second PENDING invitation; without this
     * rule a member could decline-invite-decline-invite indefinitely, which is
     * harassment with a queue behind it. `canManage` does not bypass it either —
     * bypassing is the vector.
     */
    it('cannot be followed by another invitation', async () => {
      await invite({ userId: inviteeId });
      await decline();

      const again = await invite({ userId: inviteeId });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('declined');
      /* And the refusal says what is still possible, so a manager is not left
         thinking the person is shut out. */
      expect(again.body.error).toMatch(/invitation link/);
    });

    /** The door is still open — it is the tap on the shoulder that stops. */
    it('leaves the club joinable by link', async () => {
      await invite({ userId: inviteeId });
      await decline();

      const link = (await srv.call('POST', `/api/organizations/${orgKey}/share-links`, {}, manager))
        .body.link;
      const token = String(link.path).split('/').pop();
      const res = await srv.call('POST', `/api/organizations/${orgKey}/membership`,
        { shareToken: token }, invitee);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await isMember(inviteeId)).toBe(true);
    });

    it('leaves a request-to-join club open to a request', async () => {
      await invite({ userId: inviteeId });
      await decline();
      await policy('request');

      const res = await srv.call('POST', `/api/organizations/${orgKey}/join-requests`, {}, invitee);
      expect(res.status).toBe(201);
    });

    it('tells the club nothing beyond the row disappearing', async () => {
      await invite({ userId: inviteeId });
      const before = await db.prepare(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?'
      ).get(managerId);
      await decline();
      const after = await db.prepare(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?'
      ).get(managerId);
      /* A decline is a private answer. A queue of "so-and-so said no" is how a
         club's managers end up discussing it with them. */
      expect(Number(after.n)).toBe(Number(before.n));
      expect((await listInvitations()).body.invitations).toHaveLength(0);
    });
  });

  describe('withdrawing', () => {
    const idOf = async () => (await listInvitations()).body.invitations[0].invitationId;

    it('removes it, and the Join with it', async () => {
      await invite({ userId: inviteeId });
      const res = await withdraw(await idOf());
      expect(res.status).toBe(200);
      expect((await page(invitee)).viewer.invitation).toBeUndefined();
      expect((await page(invitee)).viewer.affordance).toBe('invite_required');
    });

    it('tells the invited person nothing', async () => {
      await invite({ userId: inviteeId });
      const before = await db.prepare(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?'
      ).get(inviteeId);
      await withdraw(await idOf());
      const after = await db.prepare(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?'
      ).get(inviteeId);
      /* An invitation they never opened, withdrawn, is a non-event — and
         telling them would mean a student's first news of a club is that it
         changed its mind about them. */
      expect(Number(after.n)).toBe(Number(before.n));
    });

    it('reports a second attempt rather than silently succeeding', async () => {
      await invite({ userId: inviteeId });
      const id = await idOf();
      expect((await withdraw(id)).status).toBe(200);
      const again = await withdraw(id);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_resolved');
    });

    it('answers 404 for an invitation that is not this club’s', async () => {
      await invite({ userId: inviteeId });
      const res = await withdraw('oinv-someone-elses');
      expect(res.status).toBe(404);
    });

    it('is a manager’s act, not a member’s', async () => {
      await invite({ userId: inviteeId });
      const id = await idOf();
      expect((await withdraw(id, helper)).status).toBe(403);
      expect((await withdraw(id, invitee)).status).toBe(403);
    });

    it('lets the club invite again afterwards, unlike a decline', async () => {
      await invite({ userId: inviteeId });
      await withdraw(await idOf());
      /* Withdrawing is the club changing its own mind, so it costs the club
         nothing. Declining is the person's answer, and that one sticks. */
      expect((await invite({ userId: inviteeId })).status).toBe(201);
    });

    it('writes an audit row without naming the invited person’s note', async () => {
      await invite({ userId: inviteeId, message: 'a note' });
      await withdraw(await idOf());
      const rows = await db.prepare(
        `SELECT details FROM admin_audit_logs WHERE action = 'ORGANIZATION_INVITATION_REVOKED'`
      ).all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map(r => r.details ?? '').join('\n')).not.toContain('a note');
    });
  });
});
