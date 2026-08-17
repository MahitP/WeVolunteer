import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A manager removing somebody from an organization.
 *
 * ── What removal means, and what it must never mean ──
 *
 * It ends a membership. It does not end an account, and it does not touch a
 * single hour anybody served. A volunteer who worked forty hours under this
 * organization's banner still worked them — the service record and the member
 * list are unrelated facts that happen to share a page, and a manager tidying
 * one has no business editing the other.
 *
 * ── The last manager ──
 *
 * Three routes can strip a manager: leaving, demoting, and now removing. All
 * three refuse the last one. Without the third, a manager could remove their
 * co-manager and then leave — defeating the invariant in two requests instead
 * of one, and leaving an organization nobody can edit, unarchive, or attach an
 * event to.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';

describe('removing an organization member', () => {
  let srv;
  let db;
  let manager;
  let student;
  let other;
  let managerId;
  let studentId;
  let otherId;
  let orgKey;
  let orgId;

  const membersOf = () => db.prepare(
    'SELECT user_id AS userId, member_role AS role FROM organization_members WHERE organization_id = ?'
  ).all(orgId);

  const isMember = (userId) => membersOf().some(m => m.userId === userId);

  const remove = (userId, session = manager) =>
    srv.call('DELETE', `/api/organizations/${orgKey}/members/${userId}`, undefined, session);

  const join = (userId, role = 'member') => {
    db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role, joined_at = excluded.joined_at
    `).run(orgId, userId, role, new Date().toISOString());
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    student = await srv.login(STUDENT);
    other = await srv.login(OTHER_STUDENT);

    managerId = (await srv.call('GET', '/api/auth/me', undefined, manager)).body.id;
    studentId = (await srv.call('GET', '/api/auth/me', undefined, student)).body.id;
    otherId = (await srv.call('GET', '/api/auth/me', undefined, other)).body.id;

    const created = await srv.call('POST', '/api/organizations', {
      name: `Member Test Org ${Math.random().toString(36).slice(2, 7)}`,
      description: 'An organization used by the member-removal tests.',
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(() => {
    db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(orgId);
    join(managerId, 'manager');
    join(studentId, 'member');
  });

  describe('a manager', () => {
    it('can remove a member', async () => {
      const res = await remove(studentId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(isMember(studentId)).toBe(false);
    });

    it('reports the new member count', async () => {
      const res = await remove(studentId);
      expect(res.body.memberCount).toBe(1);
      expect(res.body.isMember).toBe(false);
    });

    it('can remove a co-manager while another manager remains', async () => {
      join(otherId, 'manager');
      const res = await remove(otherId);
      expect(res.status).toBe(200);
      expect(isMember(otherId)).toBe(false);
    });

    it('404s for somebody who is not a member', async () => {
      const res = await remove(otherId);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_member');
    });
  });

  describe('the last manager', () => {
    it('cannot be removed', async () => {
      const res = await remove(managerId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_manager');
      expect(isMember(managerId)).toBe(true);
    });

    it('cannot be reached by removing the co-manager first and then themselves', async () => {
      /**
       * The two-request version of the same defect, and the reason this guard
       * exists on a third route. Without it a manager empties the organization
       * of managers one request at a time and every individual step returns
       * 200.
       */
      join(otherId, 'manager');

      expect((await remove(otherId)).status).toBe(200);
      const second = await remove(managerId);

      expect(second.status).toBe(409);
      expect(membersOf().filter(m => m.role === 'manager')).toHaveLength(1);
    });

    it('can still be removed once somebody else is promoted', async () => {
      join(otherId, 'member');
      const promote = await srv.call('PATCH', `/api/organizations/${orgKey}/members/${otherId}`,
        { memberRole: 'manager' }, manager);
      expect(promote.status).toBe(200);

      const res = await remove(managerId);
      expect(res.status).toBe(200);
      expect(membersOf().filter(m => m.role === 'manager')).toHaveLength(1);
    });
  });

  describe('authorization', () => {
    it('refuses a plain member removing somebody', async () => {
      const res = await remove(managerId, student);
      expect([403, 404]).toContain(res.status);
      expect(isMember(managerId)).toBe(true);
    });

    it('refuses a member removing themselves through the manager route', async () => {
      /* Leaving is a different route with a different capability. This one is
         a management action and stays behind the management gate. */
      const res = await remove(studentId, student);
      expect([403, 404]).toContain(res.status);
    });

    it('refuses an organizer who does not manage THIS organization', async () => {
      /**
       * The check the capability gate cannot make.
       *
       * `organization.manage.own` says "this account may manage organizations
       * it belongs to" — it says nothing about WHICH. A student is refused at
       * the middleware and so proves nothing about `canManage`; this caller
       * holds the capability and is refused by the per-organization check
       * alone.
       */
      join(otherId, 'member');
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, managerId);
      join(studentId, 'manager');

      const res = await remove(otherId, manager);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_manager');
      expect(isMember(otherId), 'the member must still be there').toBe(true);
    });

    it('refuses a member of this organization who is not a manager', async () => {
      /* Belonging is not managing. Same route, same organization, wrong role. */
      join(otherId, 'member');
      await db.prepare("UPDATE organization_members SET member_role = 'member' WHERE organization_id = ? AND user_id = ?")
        .run(orgId, managerId);

      const res = await remove(otherId, manager);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_manager');
      expect(isMember(otherId)).toBe(true);
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await srv.call('DELETE', `/api/organizations/${orgKey}/members/${studentId}`);
      expect(res.status).toBe(401);
    });
  });

  describe('what removal must never touch', () => {
    it('leaves the account itself alone', async () => {
      await remove(studentId);
      const user = await db.prepare('SELECT id, account_status FROM users WHERE id = ?').get(studentId);
      expect(user).toBeTruthy();
      expect(user.account_status).not.toBe('deleted');
    });

    it('leaves every credited hour exactly where it was', async () => {
      /**
       * The property that matters. Membership and service are unrelated facts,
       * and a manager tidying a member list must not be able to edit somebody's
       * transcript as a side effect.
       */
      const before = await db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(studentId);

      await remove(studentId);

      const after = await db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(studentId);
      expect(after).toEqual(before);
    });

    it('leaves their applications and event history alone', async () => {
      const before = (await db.prepare('SELECT COUNT(*) AS c FROM applications WHERE user_id = ?').get(studentId)).c;
      await remove(studentId);
      expect((await db.prepare('SELECT COUNT(*) AS c FROM applications WHERE user_id = ?').get(studentId)).c).toBe(before);
    });

    it('leaves their certificates alone', async () => {
      const before = (await db.prepare('SELECT COUNT(*) AS c FROM certificates WHERE user_id = ?').get(studentId)).c;
      await remove(studentId);
      expect((await db.prepare('SELECT COUNT(*) AS c FROM certificates WHERE user_id = ?').get(studentId)).c).toBe(before);
    });

    it('leaves memberships of OTHER organizations alone', async () => {
      const elsewhere = await srv.call('POST', '/api/organizations', {
        name: `Elsewhere ${Math.random().toString(36).slice(2, 7)}`,
        description: 'Another organization the volunteer belongs to.',
      }, manager);
      const elsewhereId = elsewhere.body.organization.id;
      await db.prepare(`
        INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
        VALUES (?, ?, 'member', ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role, joined_at = excluded.joined_at
      `).run(elsewhereId, studentId, new Date().toISOString());

      await remove(studentId);

      const stillThere = (await db.prepare(
        'SELECT COUNT(*) AS c FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(elsewhereId, studentId)).c;
      expect(stillThere).toBe(1);
    });
  });

  describe('kicking versus banning', () => {
    /**
     * Two different acts. A kick ends a membership and they can come back; a
     * ban is a standing decision that they cannot. The tests that matter are
     * the ones that hold that difference apart — a kick that silently banned,
     * or a ban a client could bypass by posting to the join route, would each
     * be worse than the feature not existing.
     */
    const removeWith = (userId, body, session = manager) =>
      srv.call('DELETE', `/api/organizations/${orgKey}/members/${userId}`, body, session);

    const activeBan = (userId) => db.prepare(
      'SELECT reason, banned_by FROM organization_bans WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL'
    ).get(orgId, userId);

    beforeEach(() => {
      db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
    });

    it('kicks by default when no mode is given', async () => {
      /* An older client, or an omitted field, must get the REVERSIBLE action.
         The permanent one has to be asked for by name. */
      const res = await removeWith(studentId, undefined);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.banned).toBe(false);
      expect(activeBan(studentId)).toBeUndefined();
    });

    it('lets a kicked member join again', async () => {
      await removeWith(studentId, { mode: 'kick' });

      const rejoin = await srv.call('POST', `/api/organizations/${orgKey}/membership`, undefined, student);
      expect(rejoin.status, JSON.stringify(rejoin.body)).toBe(200);
      expect(isMember(studentId)).toBe(true);
    });

    it('accepts a kick with no reason', async () => {
      /* Demanding a justification for routine roster work trains people to type
         "n/a", which is worse than an honest blank. */
      const res = await removeWith(studentId, { mode: 'kick', reason: '' });
      expect(res.status).toBe(200);
    });

    it('records a ban with its reason and who made it', async () => {
      const res = await removeWith(studentId, { mode: 'ban', reason: 'Repeatedly no-showed shifts.' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.banned).toBe(true);
      expect(activeBan(studentId)).toMatchObject({
        reason: 'Repeatedly no-showed shifts.',
        banned_by: managerId,
      });
    });

    it('REFUSES a ban with no reason', async () => {
      /**
       * Enforced here as well as in the UI and the column. A person told they
       * are banned and not told why has nothing to appeal against, and the
       * reason is what an administrator hearing that appeal reads.
       */
      const res = await removeWith(studentId, { mode: 'ban', reason: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('reason_required');
      expect(isMember(studentId), 'a refused ban must not remove them either').toBe(true);
      expect(activeBan(studentId)).toBeUndefined();
    });

    it('stops a banned person rejoining through the ordinary join route', async () => {
      /**
       * The whole of what a ban means. The client hiding a Join button is a
       * courtesy; a banned person posting straight to this endpoint is exactly
       * the case the record exists for.
       */
      await removeWith(studentId, { mode: 'ban', reason: 'Repeated no-shows.' });

      const rejoin = await srv.call('POST', `/api/organizations/${orgKey}/membership`, undefined, student);

      expect(rejoin.status).toBe(403);
      expect(rejoin.body.code).toBe('banned');
      expect(isMember(studentId)).toBe(false);
    });

    it('tells the banned person why, in the refusal', async () => {
      await removeWith(studentId, { mode: 'ban', reason: 'Repeated no-shows.' });
      const rejoin = await srv.call('POST', `/api/organizations/${orgKey}/membership`, undefined, student);
      expect(rejoin.body.reason).toBe('Repeated no-shows.');
    });

    it('lets them back in once the ban is lifted', async () => {
      /* Lifting sets `lifted_at` rather than deleting the row — the fact that
         somebody was banned and then unbanned is what an appeal produces. */
      await removeWith(studentId, { mode: 'ban', reason: 'Repeated no-shows.' });
      await db.prepare('UPDATE organization_bans SET lifted_at = ? WHERE organization_id = ? AND user_id = ?')
        .run(new Date().toISOString(), orgId, studentId);

      const rejoin = await srv.call('POST', `/api/organizations/${orgKey}/membership`, undefined, student);
      expect(rejoin.status).toBe(200);
    });

    it('keeps the lifted ban on the record', async () => {
      await removeWith(studentId, { mode: 'ban', reason: 'Repeated no-shows.' });
      await db.prepare('UPDATE organization_bans SET lifted_at = ? WHERE organization_id = ? AND user_id = ?')
        .run(new Date().toISOString(), orgId, studentId);

      const rows = (await db.prepare(
        'SELECT COUNT(*) AS c FROM organization_bans WHERE organization_id = ? AND user_id = ?'
      ).get(orgId, studentId)).c;
      expect(rows, 'lifting must not erase the decision').toBe(1);
    });

    it('refuses a ban from somebody who does not manage this organization', async () => {
      /* The caller HOLDS the capability and has had its membership removed, so
         only `canManage` can be doing the refusing. */
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, managerId);

      const res = await removeWith(studentId, { mode: 'ban', reason: 'Not mine to ban.' });

      expect(res.status).toBe(403);
      expect(activeBan(studentId)).toBeUndefined();
      join(managerId, 'manager');
    });

    it('refuses a ban from a plain member', async () => {
      const res = await removeWith(managerId, { mode: 'ban', reason: 'Trying it on.' }, student);
      expect([403, 404]).toContain(res.status);
      expect(activeBan(managerId)).toBeUndefined();
    });

    it('will not let a manager ban themselves', async () => {
      /* It would lock them out of an organization they manage and leave nobody
         able to lift it. Leaving is a different route.

         A co-manager first, so the last-manager rule — which fires earlier and
         would refuse this for an entirely different reason — is not what the
         assertion is measuring. */
      join(otherId, 'manager');

      const res = await removeWith(managerId, { mode: 'ban', reason: 'Oops.' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('cannot_ban_self');
    });

    it('notifies the person, saying which it was', async () => {
      await removeWith(studentId, { mode: 'ban', reason: 'Repeated no-shows.' });

      const note = await db.prepare(
        'SELECT title, body FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(studentId);

      expect(note?.title).toMatch(/banned/i);
      expect(note.body).toContain('Repeated no-shows.');
      expect(note.body).toMatch(/cannot rejoin/i);
    });

    it('tells a kicked person they can come back', async () => {
      await removeWith(studentId, { mode: 'kick' });

      const note = await db.prepare(
        'SELECT title, body FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(studentId);

      expect(note?.title).toMatch(/removed/i);
      expect(note.body).toMatch(/can still join/i);
    });

    it('cannot be undone by promoting the banned person instead', async () => {
      /**
       * The obvious way round a ban that is enforced only on the join route: a
       * manager (or a compromised one) sets the banned person's role directly
       * and hopes the row comes back.
       *
       * It cannot, because that route is an UPDATE and a removed member has no
       * row to update. Asserted rather than assumed, since a future edit to
       * `INSERT OR REPLACE` there would quietly reinstate anybody.
       */
      await removeWith(studentId, { mode: 'ban', reason: 'Repeated no-shows.' });

      const promote = await srv.call(
        'PATCH', `/api/organizations/${orgKey}/members/${studentId}`,
        { memberRole: 'manager' }, manager,
      );

      expect(promote.status, 'a banned person must not be reinstated by a role change').toBe(404);
      expect(isMember(studentId)).toBe(false);
    });

    it('never revokes an hour, whichever it was', async () => {
      /* The property every removal path in this product shares. */
      const before = await db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(studentId);

      await removeWith(studentId, { mode: 'ban', reason: 'Repeated no-shows.' });

      expect(await db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(studentId)).toEqual(before);
    });
  });

  describe('appealing a ban', () => {
    /**
     * The notification a banned person receives carries a "Make an appeal"
     * button. These are the tests that the button leads somewhere real, and
     * that the query string behind it cannot be edited into an appeal about
     * somebody else's ban.
     */
    const STATEMENT = 'I was told I missed three shifts but two of them were cancelled by the organizer.';

    const appeal = (body, session = student) => srv.call('POST', '/api/appeals', body, session);

    /* Live appeals only. Resolved rows from earlier tests stay on the record —
       nothing deletes an appeal — so a bare COUNT would keep counting them. */
    const openAppeals = (userId) => db.prepare(
      "SELECT COUNT(*) AS c FROM appeals WHERE user_id = ? AND status IN ('open', 'reviewing')"
    ).get(userId).c;

    beforeEach(() => {
      db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
      /* Closed, not deleted. A trigger refuses the delete outright — "an appeal
         is never deleted: it is the record of a person contesting an enforcement
         action" — and that rule is right, so the fixture works with it. Only
         `open` and `reviewing` appeals block a new one, so resolving them leaves
         each test a clean slate without erasing anything. */
      db.prepare("UPDATE appeals SET status = 'resolved' WHERE user_id = ?").run(studentId);
      db.prepare("UPDATE appeals SET status = 'resolved' WHERE user_id = ?").run(otherId);
    });

    it('accepts an appeal from the person actually banned', async () => {
      await srv.call('DELETE', `/api/organizations/${orgKey}/members/${studentId}`,
        { mode: 'ban', reason: 'Missed three shifts.' }, manager);

      const res = await appeal({ subject: 'organization_ban', organizationId: orgId, statement: STATEMENT });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = await db.prepare('SELECT subject, subject_ref, status FROM appeals WHERE id = ?').get(res.body.appealId);
      expect(row).toMatchObject({ subject: 'organization_ban', subject_ref: orgId, status: 'open' });
    });

    it('REFUSES an appeal about an organization that never banned them', async () => {
      /**
       * `organizationId` arrives from a query string the appellant can edit.
       * Without the check, anyone could open an appeal naming a club they have
       * never been near, and a reviewer would read that club's name as the
       * context for a case that has nothing to do with it.
       */
      const res = await appeal({ subject: 'organization_ban', organizationId: orgId, statement: STATEMENT });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('subject_not_found');
      expect(openAppeals(studentId)).toBe(0);
    });

    it('refuses an appeal about somebody ELSE\'s ban', async () => {
      await srv.call('DELETE', `/api/organizations/${orgKey}/members/${studentId}`,
        { mode: 'ban', reason: 'Missed three shifts.' }, manager);

      /* `other` was never banned; the ban that exists belongs to `student`. */
      const res = await appeal({ subject: 'organization_ban', organizationId: orgId, statement: STATEMENT }, other);

      expect(res.status).toBe(404);
    });

    it('refuses once the ban has been lifted', async () => {
      /* There is no longer a decision to appeal against. Saying so beats
         queueing a case a reviewer can only close. */
      await srv.call('DELETE', `/api/organizations/${orgKey}/members/${studentId}`,
        { mode: 'ban', reason: 'Missed three shifts.' }, manager);
      await db.prepare('UPDATE organization_bans SET lifted_at = ? WHERE organization_id = ? AND user_id = ?')
        .run(new Date().toISOString(), orgId, studentId);

      const res = await appeal({ subject: 'organization_ban', organizationId: orgId, statement: STATEMENT });
      expect(res.status).toBe(404);
    });

    it('refuses an appeal naming no organization at all', async () => {
      await srv.call('DELETE', `/api/organizations/${orgKey}/members/${studentId}`,
        { mode: 'ban', reason: 'Missed three shifts.' }, manager);

      const res = await appeal({ subject: 'organization_ban', statement: STATEMENT });
      expect(res.status).toBe(404);
    });

    it('does not open a second appeal for the same ban', async () => {
      await srv.call('DELETE', `/api/organizations/${orgKey}/members/${studentId}`,
        { mode: 'ban', reason: 'Missed three shifts.' }, manager);

      const first = await appeal({ subject: 'organization_ban', organizationId: orgId, statement: STATEMENT });
      const second = await appeal({ subject: 'organization_ban', organizationId: orgId, statement: STATEMENT });

      /* Tapping the notification twice is not an error, and telling them it
         failed would make them write the whole thing again. */
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBe(true);
      expect(second.body.appealId).toBe(first.body.appealId);
      expect(openAppeals(studentId)).toBe(1);
    });
  });
});
