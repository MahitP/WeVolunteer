import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The organization invitation link, over HTTP.
 *
 * ── The three questions this file answers ──
 *
 * 1. **Who may read the link.** The club's `invite_policy`, turned into a yes or
 *    a no by `canInvite`, and enforced on the server — not by the share button
 *    being absent. A member of an `invite_policy = 'helpers'` club posting
 *    straight to the endpoint is the case that matters.
 * 2. **Who may replace it.** Always a manager, because regenerating stops every
 *    copy already handed out from working. A student organizer may pass the link
 *    on and may not change what it is.
 * 3. **What the public endpoint discloses, and what it refuses to.** It is the
 *    only unauthenticated read of real data this feature adds, so the projection
 *    is asserted field by field — including the fields that must be ABSENT,
 *    which is the half a happy-path test never covers.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';
const ADMIN = 'admin@example.gov';

describe('the organization invitation link', () => {
  let srv;
  let db;
  let manager;
  let helper;
  let member;
  let managerId;
  let helperId;
  let memberId;
  let orgKey;
  let orgId;

  const join = async (userId, role = 'member') => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id)
        DO UPDATE SET member_role = excluded.member_role
    `).run(orgId, userId, role, new Date().toISOString());
  };

  const setPolicy = async (fields) => {
    const res = await srv.call('PATCH', `/api/organizations/${orgKey}`, fields, manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.organization;
  };

  const readLink = (session) => srv.call('GET', `/api/organizations/${orgKey}/share-link`, undefined, session);
  const makeLink = (session = manager) => srv.call('POST', `/api/organizations/${orgKey}/share-link`, {}, session);
  const dropLink = (session = manager) => srv.call('DELETE', `/api/organizations/${orgKey}/share-link`, undefined, session);
  const openLink = (token) => srv.call('GET', `/api/public/organizations/invite/${token}`);

  /** The token out of the path the server returns, so no test builds the URL. */
  const tokenOf = (body) => String(body.path).split('/').pop();

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    helper = await srv.login(STUDENT);
    member = await srv.login(OTHER_STUDENT);

    managerId = (await srv.call('GET', '/api/auth/me', undefined, manager)).body.id;
    helperId = (await srv.call('GET', '/api/auth/me', undefined, helper)).body.id;
    memberId = (await srv.call('GET', '/api/auth/me', undefined, member)).body.id;

    const created = await srv.call('POST', '/api/organizations', {
      name: `Share Link Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club used by the invitation-link tests.',
      tags: ['Coordination'],
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_share_links WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
    await join(managerId, 'manager');
    await join(helperId, 'student_organizer');
    await join(memberId, 'member');
    await db.prepare(
      `UPDATE organizations SET join_policy = 'open', invite_policy = 'helpers', status = 'active' WHERE id = ?`
    ).run(orgId);
  });

  describe('a new organization', () => {
    it('starts with no link and no policy anybody has to think about', async () => {
      const org = (await srv.call('GET', `/api/organizations/${orgKey}`, undefined, manager)).body;
      expect(org.organization.joinPolicy).toBe('open');
      expect(org.organization.invitePolicy).toBe('helpers');
      expect(org.viewer.shareLink).toEqual({ exists: false, createdAt: null, rotations: 0 });
    });

    it('reports the absence as a normal state rather than an error', async () => {
      const res = await readLink(manager);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ exists: false, canCreate: true });
    });
  });

  describe('creating one', () => {
    it('returns the link once, with a 64-character random token', async () => {
      const res = await makeLink();
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.rotated).toBe(false);
      expect(res.body.path).toMatch(/^\/organizations\/invite\/[0-9a-f]{64}$/);
    });

    /**
     * The URL names no club.
     *
     * A link that carried the slug or the id would say which organization it
     * belongs to before the server resolved it — so a leaked link would disclose
     * its subject, and the id would be a second handle on the record. The token
     * is the whole path.
     */
    it('puts neither the organization id nor its slug in the URL', async () => {
      const res = await makeLink();
      expect(res.body.path).not.toContain(orgId);
      expect(res.body.path).not.toContain(orgKey);
    });

    it('gives two organizations unrelated tokens', async () => {
      const second = await srv.call('POST', '/api/organizations', {
        name: `Second Share Club ${Math.random().toString(36).slice(2, 7)}`,
      }, manager);
      const a = tokenOf((await makeLink()).body);
      const b = tokenOf((await srv.call(
        'POST', `/api/organizations/${second.body.organization.slug}/share-link`, {}, manager,
      )).body);
      expect(a).not.toBe(b);
    });

    it('is idempotent in the sense that matters: reading it back gives the same link', async () => {
      const created = await makeLink();
      const read = await readLink(manager);
      expect(read.body.exists).toBe(true);
      expect(read.body.path).toBe(created.body.path);
      expect(read.body.rotations).toBe(0);
    });

    it('refuses on an archived organization', async () => {
      await db.prepare(`UPDATE organizations SET status = 'archived' WHERE id = ?`).run(orgId);
      const res = await makeLink();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('archived');
    });
  });

  describe('switching the club to invitation-only', () => {
    /**
     * A club whose policy needs a link and has none is a club nobody can join.
     * Minting it in the same transaction as the setting is what stops the most
     * likely path through the settings screen producing that.
     */
    it('mints a link in the same request', async () => {
      const org = await setPolicy({ joinPolicy: 'invite' });
      expect(org.joinPolicy).toBe('invite');
      const res = await readLink(manager);
      expect(res.body.exists).toBe(true);
    });

    /** Changing the setting must not invalidate a link already on a flyer. */
    it('leaves an existing link exactly as it was', async () => {
      const before = (await makeLink()).body.path;
      await setPolicy({ joinPolicy: 'invite' });
      expect((await readLink(manager)).body.path).toBe(before);
      expect((await readLink(manager)).body.rotations).toBe(0);
    });

    it('records the change in the audit trail', async () => {
      await setPolicy({ joinPolicy: 'request' });
      const rows = await db.prepare(
        `SELECT action, details FROM admin_audit_logs WHERE action = 'ORGANIZATION_MEMBERSHIP_POLICY_CHANGED'`
      ).all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.at(-1).details).toContain('open to request');
    });
  });

  describe('regenerating one', () => {
    it('replaces the token and stops the old link working', async () => {
      const first = tokenOf((await makeLink()).body);
      expect((await openLink(first)).status).toBe(200);

      const again = await makeLink();
      expect(again.status).toBe(200);
      expect(again.body.rotated).toBe(true);
      const second = tokenOf(again.body);
      expect(second).not.toBe(first);

      expect((await openLink(first)).status).toBe(404);
      expect((await openLink(second)).status).toBe(200);
    });

    it('counts the rotations, which is the one thing a manager cannot see from the link', async () => {
      await makeLink();
      await makeLink();
      await makeLink();
      expect((await readLink(manager)).body.rotations).toBe(2);
    });

    /**
     * The property a manager is most likely to be afraid of, and the one the
     * confirmation dialog promises: the link was the door, not the membership.
     */
    it('leaves every existing member a member', async () => {
      await makeLink();
      const before = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?'
      ).get(orgId);
      await makeLink();
      const after = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?'
      ).get(orgId);
      expect(Number(after.n)).toBe(Number(before.n));
      expect(Number(after.n)).toBe(3);
    });

    it('writes an audit row that distinguishes creating from replacing', async () => {
      await makeLink();
      await makeLink();
      const actions = (await db.prepare(
        `SELECT action FROM admin_audit_logs WHERE action LIKE 'ORGANIZATION_SHARE_LINK%' ORDER BY id`
      ).all()).map(r => r.action);
      expect(actions).toContain('ORGANIZATION_SHARE_LINK_CREATED');
      expect(actions).toContain('ORGANIZATION_SHARE_LINK_ROTATED');
    });

    /**
     * The trail is read by administrators who are not in this club. A credential
     * written into it would be a credential in a table with a different audience
     * and a different retention rule.
     */
    it('never writes the token into the audit trail', async () => {
      const token = tokenOf((await makeLink()).body);
      const rows = await db.prepare(
        `SELECT details FROM admin_audit_logs WHERE action LIKE 'ORGANIZATION_SHARE_LINK%'`
      ).all();
      for (const row of rows) expect(row.details ?? '').not.toContain(token);
    });
  });

  describe('switching it off', () => {
    it('stops the link resolving', async () => {
      const token = tokenOf((await makeLink()).body);
      expect((await openLink(token)).status).toBe(200);

      const res = await dropLink();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ exists: false, revoked: true });
      expect((await openLink(token)).status).toBe(404);
    });

    it('is harmless when there was nothing to switch off', async () => {
      const res = await dropLink();
      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(false);
    });

    it('leaves every member a member', async () => {
      await makeLink();
      await dropLink();
      const after = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?'
      ).get(orgId);
      expect(Number(after.n)).toBe(3);
    });
  });

  describe('who may read the link', () => {
    it('gives it to a manager', async () => {
      await makeLink();
      expect((await readLink(manager)).body.exists).toBe(true);
    });

    it('gives it to a student organizer under the default setting', async () => {
      await makeLink();
      const res = await readLink(helper);
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(true);
      /* And says they may not replace it, so the client need not work that out. */
      expect(res.body.canCreate).toBe(false);
    });

    /**
     * The refusal that must be a SERVER refusal.
     *
     * The share control is hidden from this member by `viewer.canInvite`, which
     * is a courtesy. This is the boundary: posting straight to the endpoint has
     * to fail, or `invite_policy` is decoration.
     */
    it('refuses an ordinary member under the default setting', async () => {
      await makeLink();
      const res = await readLink(member);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_allowed_to_invite');
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
    });

    it('gives it to an ordinary member once the club says any member may share', async () => {
      await makeLink();
      await setPolicy({ invitePolicy: 'members' });
      const res = await readLink(member);
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(true);
    });

    it('refuses somebody who is not in the organization at all', async () => {
      await makeLink();
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, memberId);
      expect((await readLink(member)).status).toBe(403);
    });

    it('lets an administrator through on `organization.moderate`', async () => {
      await makeLink();
      const admin = await srv.login(ADMIN);
      const res = await readLink(admin);
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(true);
    });
  });

  describe('who may replace or remove it', () => {
    it('refuses a student organizer, who may share it and not change it', async () => {
      await makeLink();
      expect((await makeLink(helper)).status).toBe(403);
      expect((await dropLink(helper)).status).toBe(403);
    });

    it('refuses an ordinary member even when the club lets them share', async () => {
      await makeLink();
      await setPolicy({ invitePolicy: 'members' });
      expect((await makeLink(member)).status).toBe(403);
      expect((await dropLink(member)).status).toBe(403);
    });
  });

  describe('the page payload', () => {
    it('reports that a link exists without carrying it', async () => {
      await makeLink();
      const page = (await srv.call('GET', `/api/organizations/${orgKey}`, undefined, manager)).body;
      expect(page.viewer.shareLink.exists).toBe(true);
      expect(page.viewer.canInvite).toBe(true);
      /* The whole payload, not just the shareLink block: this is the assertion
         that would catch a token arriving through some other field. */
      expect(JSON.stringify(page)).not.toMatch(/[0-9a-f]{64}/);
    });

    it('tells a member who may not share that there is nothing for them here', async () => {
      await makeLink();
      const page = (await srv.call('GET', `/api/organizations/${orgKey}`, undefined, member)).body;
      expect(page.viewer.canInvite).toBe(false);
      expect(page.viewer.shareLink).toBeNull();
    });
  });
});
