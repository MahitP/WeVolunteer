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
      INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
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
      db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
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
      db.prepare("UPDATE organization_members SET member_role = 'member' WHERE organization_id = ? AND user_id = ?")
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
      const user = db.prepare('SELECT id, account_status FROM users WHERE id = ?').get(studentId);
      expect(user).toBeTruthy();
      expect(user.account_status).not.toBe('deleted');
    });

    it('leaves every credited hour exactly where it was', async () => {
      /**
       * The property that matters. Membership and service are unrelated facts,
       * and a manager tidying a member list must not be able to edit somebody's
       * transcript as a side effect.
       */
      const before = db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(studentId);

      await remove(studentId);

      const after = db.prepare(
        'SELECT COUNT(*) AS rows, COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ?'
      ).get(studentId);
      expect(after).toEqual(before);
    });

    it('leaves their applications and event history alone', async () => {
      const before = db.prepare('SELECT COUNT(*) AS c FROM applications WHERE user_id = ?').get(studentId).c;
      await remove(studentId);
      expect(db.prepare('SELECT COUNT(*) AS c FROM applications WHERE user_id = ?').get(studentId).c).toBe(before);
    });

    it('leaves their certificates alone', async () => {
      const before = db.prepare('SELECT COUNT(*) AS c FROM certificates WHERE user_id = ?').get(studentId).c;
      await remove(studentId);
      expect(db.prepare('SELECT COUNT(*) AS c FROM certificates WHERE user_id = ?').get(studentId).c).toBe(before);
    });

    it('leaves memberships of OTHER organizations alone', async () => {
      const elsewhere = await srv.call('POST', '/api/organizations', {
        name: `Elsewhere ${Math.random().toString(36).slice(2, 7)}`,
        description: 'Another organization the volunteer belongs to.',
      }, manager);
      const elsewhereId = elsewhere.body.organization.id;
      db.prepare(`
        INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(elsewhereId, studentId, new Date().toISOString());

      await remove(studentId);

      const stillThere = db.prepare(
        'SELECT COUNT(*) AS c FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(elsewhereId, studentId).c;
      expect(stillThere).toBe(1);
    });
  });
});
