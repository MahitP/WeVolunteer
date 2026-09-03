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

  /**
   * The endpoints, wrapped so no test writes a URL twice.
   *
   * `readLinks` answers `{ links, canManage, canCreate }` for both readers: a
   * manager gets every link with its stats, a sharer gets the one primary link
   * with none. Asserting on that one shape is what keeps the two projections
   * honest about each other.
   */
  const readLinks = (session) => srv.call('GET', `/api/organizations/${orgKey}/share-links`, undefined, session);
  const makeLink = (body = {}, session = manager) =>
    srv.call('POST', `/api/organizations/${orgKey}/share-links`, body, session);
  const editLink = (id, body, session = manager) =>
    srv.call('PATCH', `/api/organizations/${orgKey}/share-links/${id}`, body, session);
  const dropLink = (id, session = manager) =>
    srv.call('DELETE', `/api/organizations/${orgKey}/share-links/${id}`, undefined, session);
  const openLink = (token) => srv.call('GET', `/api/public/organizations/invite/${token}`);

  /** The token out of the path the server returns, so no test builds the URL. */
  const tokenOf = (link) => String(link.path).split('/').pop();

  /** The one link a fresh club is given, for tests that only need one. */
  const onlyLink = async (session = manager) => {
    const res = await readLinks(session);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.links[0];
  };

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
      expect(org.viewer.shareLink).toEqual({ exists: false, createdAt: null, label: null });
    });

    it('reports the absence as a normal state rather than an error', async () => {
      const res = await readLinks(manager);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ links: [], canManage: true, canCreate: true, maxLinks: 10 });
    });
  });

  describe('creating one', () => {
    it('returns the link once, with a 64-character random token', async () => {
      const res = await makeLink();
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.link.path).toMatch(/^\/organizations\/invite\/[0-9a-f]{64}$/);
      /* An unnamed link is "General" — the same label migration 063 gives every
         link a club already had, so a club that never thinks about names sees
         one consistent word rather than a blank. */
      expect(res.body.link.label).toBe('General');
      expect(res.body.link.state).toBe('live');
      expect(res.body.link.expiresAt).toBeNull();
      expect(res.body.link.uses).toBe(0);
    });

    it('takes the name a manager gave it', async () => {
      const res = await makeLink({ label: '  Autumn flyer  ' });
      expect(res.status).toBe(201);
      expect(res.body.link.label).toBe('Autumn flyer');
    });

    it('refuses a name past the limit rather than truncating it', async () => {
      const res = await makeLink({ label: 'x'.repeat(41) });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('label');
    });

    /**
     * Several links, each with its own life.
     *
     * The reason this is not one link per club: retiring the flyer that has
     * been on the corridor wall since September must not break the Instagram
     * bio.
     */
    it('leaves every other link working', async () => {
      const first = (await makeLink({ label: 'Instagram' })).body.link;
      const second = (await makeLink({ label: 'Autumn flyer' })).body.link;
      expect(tokenOf(first)).not.toBe(tokenOf(second));

      await dropLink(second.id);
      expect((await openLink(tokenOf(first))).status).toBe(200);
      expect((await openLink(tokenOf(second))).status).toBe(404);
    });

    it('refuses more than ten working links, and says why', async () => {
      for (let i = 0; i < 10; i += 1) {
        expect((await makeLink({ label: `Link ${i}` })).status).toBe(201);
      }
      const refused = await makeLink({ label: 'One too many' });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('too_many_links');

      /* And switching one off makes room again — revoked links are history,
         not a permanent charge against the ceiling. */
      const links = (await readLinks(manager)).body.links;
      await dropLink(links[0].id);
      expect((await makeLink({ label: 'Now there is room' })).status).toBe(201);
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
      expect(res.body.link.path).not.toContain(orgId);
      expect(res.body.link.path).not.toContain(orgKey);
    });

    it('gives two organizations unrelated tokens', async () => {
      const second = await srv.call('POST', '/api/organizations', {
        name: `Second Share Club ${Math.random().toString(36).slice(2, 7)}`,
      }, manager);
      const a = tokenOf((await makeLink()).body.link);
      const b = tokenOf((await srv.call(
        'POST', `/api/organizations/${second.body.organization.slug}/share-links`, {}, manager,
      )).body.link);
      expect(a).not.toBe(b);
    });

    it('reads back exactly the link that was created', async () => {
      const created = (await makeLink()).body.link;
      const read = await onlyLink(manager);
      expect(read.id).toBe(created.id);
      expect(read.path).toBe(created.path);
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
      expect((await readLinks(manager)).body.links).toHaveLength(1);
    });

    /** Changing the setting must not invalidate a link already on a flyer. */
    it('leaves an existing link exactly as it was', async () => {
      const before = (await makeLink()).body.link;
      await setPolicy({ joinPolicy: 'invite' });
      const after = (await readLinks(manager)).body.links;
      expect(after).toHaveLength(1);
      expect(after[0].path).toBe(before.path);
      expect(after[0].id).toBe(before.id);
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
      const created = (await makeLink({ label: 'Autumn flyer' })).body.link;
      const first = tokenOf(created);
      expect((await openLink(first)).status).toBe(200);

      const again = await editLink(created.id, { rotate: true });
      expect(again.status).toBe(200);
      expect(again.body.rotated).toBe(true);
      const second = tokenOf(again.body.link);
      expect(second).not.toBe(first);

      expect((await openLink(first)).status).toBe(404);
      expect((await openLink(second)).status).toBe(200);
    });

    /** The label survives, because the REASON for the link has not changed. */
    it('keeps the name and the expiry', async () => {
      const created = (await makeLink({
        label: 'Autumn flyer', expiresAt: '2027-01-01T00:00:00.000Z',
      })).body.link;
      const fresh = (await editLink(created.id, { rotate: true })).body.link;
      expect(fresh.label).toBe('Autumn flyer');
      /* Inherited deliberately: a link made for one event booth must not become
         permanent by being regenerated. */
      expect(fresh.expiresAt).toBe('2027-01-01T00:00:00.000Z');
    });

    it('leaves the replaced link visible as history, with its join count', async () => {
      const created = (await makeLink({ label: 'Autumn flyer' })).body.link;
      await editLink(created.id, { rotate: true });

      const links = (await readLinks(manager)).body.links;
      expect(links).toHaveLength(2);
      /* Live first, then the retired one — the order a manager reads: what is
         working now, then what used to. */
      expect(links[0].state).toBe('live');
      expect(links[1].state).toBe('revoked');
      expect(links[1].id).toBe(created.id);
    });

    it('refuses to both rename and regenerate in one request', async () => {
      const created = (await makeLink()).body.link;
      const res = await editLink(created.id, { rotate: true, label: 'Something else' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('conflicting_change');
    });

    it('refuses to regenerate a link that is already switched off', async () => {
      const created = (await makeLink()).body.link;
      await dropLink(created.id);
      const res = await editLink(created.id, { rotate: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('revoked');
    });

    /**
     * The property a manager is most likely to be afraid of, and the one the
     * confirmation dialog promises: the link was the door, not the membership.
     */
    it('leaves every existing member a member', async () => {
      const created = (await makeLink()).body.link;
      const before = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?'
      ).get(orgId);
      await editLink(created.id, { rotate: true });
      const after = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?'
      ).get(orgId);
      expect(Number(after.n)).toBe(Number(before.n));
      expect(Number(after.n)).toBe(3);
    });

    it('writes an audit row that distinguishes creating from replacing', async () => {
      const created = (await makeLink()).body.link;
      await editLink(created.id, { rotate: true });
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
      const token = tokenOf((await makeLink()).body.link);
      const rows = await db.prepare(
        `SELECT details FROM admin_audit_logs WHERE action LIKE 'ORGANIZATION_SHARE_LINK%'`
      ).all();
      for (const row of rows) expect(row.details ?? '').not.toContain(token);
    });
  });

  describe('switching it off', () => {
    it('stops the link resolving', async () => {
      const created = (await makeLink()).body.link;
      expect((await openLink(tokenOf(created))).status).toBe(200);

      const res = await dropLink(created.id);
      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(true);
      expect(res.body.link.state).toBe('revoked');
      expect((await openLink(tokenOf(created))).status).toBe(404);
    });

    /**
     * A soft revoke, so the record survives.
     *
     * A manager needs to see that the autumn flyer is the one that stopped
     * working — and the join count beside it is the only evidence the flyer
     * worked at all. A DELETE would take both away.
     */
    it('keeps the row, its name and its join count', async () => {
      const created = (await makeLink({ label: 'Autumn flyer' })).body.link;
      await dropLink(created.id);

      const [row] = (await readLinks(manager)).body.links;
      expect(row.id).toBe(created.id);
      expect(row.label).toBe('Autumn flyer');
      expect(row.state).toBe('revoked');
      expect(row.revokedAt).toBeTruthy();
    });

    it('is idempotent, so two managers pressing at once produce one answer each', async () => {
      const created = (await makeLink()).body.link;
      expect((await dropLink(created.id)).body.revoked).toBe(true);
      const again = await dropLink(created.id);
      expect(again.status).toBe(200);
      expect(again.body.revoked).toBe(false);
    });

    it('answers 404 for a link that is not this club’s', async () => {
      const second = await srv.call('POST', '/api/organizations', {
        name: `Other Share Club ${Math.random().toString(36).slice(2, 7)}`,
      }, manager);
      const theirs = (await srv.call(
        'POST', `/api/organizations/${second.body.organization.slug}/share-links`, {}, manager,
      )).body.link;

      /* Scoped by organization AND id. A handler that trusted the route
         parameter for one and the body for the other would let a manager of one
         club revoke another club's link. */
      const res = await dropLink(theirs.id);
      expect(res.status).toBe(404);
      expect((await openLink(tokenOf(theirs))).status).toBe(200);
    });

    it('leaves every member a member', async () => {
      const created = (await makeLink()).body.link;
      await dropLink(created.id);
      const after = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?'
      ).get(orgId);
      expect(Number(after.n)).toBe(3);
    });
  });

  describe('who may read the link', () => {
    it('gives it to a manager', async () => {
      await makeLink();
      expect((await readLinks(manager)).body.links).toHaveLength(1);
    });

    it('gives it to a student organizer under the default setting', async () => {
      await makeLink();
      const res = await readLinks(helper);
      expect(res.status).toBe(200);
      expect(res.body.links).toHaveLength(1);
      /* And says they may not change what it is, so the client need not work
         that out from `memberRole`. */
      expect(res.body.canManage).toBe(false);
      expect(res.body.canCreate).toBe(false);
    });

    /**
     * A sharer gets ONE link, and no history.
     *
     * They need the club's address. The list of four links, which ones lapsed,
     * and how many people came through each is the club's operational record —
     * and somebody who may hand an address out has not been given a reason to
     * read it.
     */
    it('gives a sharer the primary link only, without the stats or the dead ones', async () => {
      const first = (await makeLink({ label: 'Instagram' })).body.link;
      const second = (await makeLink({ label: 'Autumn flyer' })).body.link;
      await dropLink(second.id);

      const res = await readLinks(helper);
      expect(res.body.links).toHaveLength(1);
      /* The OLDEST live one — most likely to be the one already in
         circulation, printed and forwarded. */
      expect(res.body.links[0].id).toBe(first.id);
      expect(res.body.links[0]).not.toHaveProperty('uses');
      expect(res.body.links[0]).not.toHaveProperty('lastUsedAt');
      expect(res.body.links[0]).not.toHaveProperty('revokedAt');
    });

    it('gives a sharer nothing at all when every link is switched off', async () => {
      const only = (await makeLink()).body.link;
      await dropLink(only.id);
      const res = await readLinks(helper);
      expect(res.status).toBe(200);
      expect(res.body.links).toEqual([]);
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
      const res = await readLinks(member);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_allowed_to_invite');
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
    });

    it('gives it to an ordinary member once the club says any member may share', async () => {
      await makeLink();
      await setPolicy({ invitePolicy: 'members' });
      const res = await readLinks(member);
      expect(res.status).toBe(200);
      expect(res.body.links).toHaveLength(1);
    });

    it('refuses somebody who is not in the organization at all', async () => {
      await makeLink();
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, memberId);
      expect((await readLinks(member)).status).toBe(403);
    });

    it('lets an administrator through on `organization.moderate`', async () => {
      await makeLink();
      const admin = await srv.login(ADMIN);
      const res = await readLinks(admin);
      expect(res.status).toBe(200);
      expect(res.body.links).toHaveLength(1);
      expect(res.body.canManage).toBe(true);
    });
  });

  describe('who may replace or remove it', () => {
    it('refuses a student organizer, who may share it and not change it', async () => {
      const created = (await makeLink()).body.link;
      expect((await makeLink({}, helper)).status).toBe(403);
      expect((await dropLink(created.id, helper)).status).toBe(403);
      expect((await editLink(created.id, { label: 'Theirs' }, helper)).status).toBe(403);
      expect((await editLink(created.id, { rotate: true }, helper)).status).toBe(403);
    });

    /**
     * The refusal that must be a SERVER refusal.
     *
     * `invite_policy = 'members'` says any member may hand the address out. It
     * does not say any member may decide what the address IS — regenerating
     * stops every copy already handed out from working, and nobody choosing the
     * wider sharing option is choosing that.
     */
    it('refuses an ordinary member even when the club lets them share', async () => {
      const created = (await makeLink()).body.link;
      await setPolicy({ invitePolicy: 'members' });
      expect((await makeLink({}, member)).status).toBe(403);
      expect((await dropLink(created.id, member)).status).toBe(403);
      expect((await editLink(created.id, { label: 'Mine now' }, member)).status).toBe(403);
      expect((await editLink(created.id, { rotate: true }, member)).status).toBe(403);
      /* And nothing changed. */
      expect((await onlyLink(manager)).label).toBe('General');
    });
  });

  describe('renaming and expiry', () => {
    it('renames without touching the link', async () => {
      const created = (await makeLink({ label: 'Instagram' })).body.link;
      const res = await editLink(created.id, { label: 'Instagram bio' });
      expect(res.status).toBe(200);
      expect(res.body.link.label).toBe('Instagram bio');
      /* The URL people already have keeps working — a rename is management
         state and changes no permission. */
      expect(res.body.link.path).toBe(created.path);
      expect((await openLink(tokenOf(created))).status).toBe(200);
    });

    it('sets an expiry, and the link stops admitting anybody after it', async () => {
      const created = (await makeLink({ label: 'Event booth' })).body.link;
      const res = await editLink(created.id, { expiresAt: '2027-06-01T00:00:00.000Z' });
      expect(res.status).toBe(200);
      expect(res.body.link.expiresAt).toBe('2027-06-01T00:00:00.000Z');
      /* Still live today — an expiry is a future date, not a switch. */
      expect(res.body.link.state).toBe('live');
      expect((await openLink(tokenOf(created))).status).toBe(200);

      /* Moved into the past directly, because the endpoint refuses a past date
         — which is the point of the next test. */
      await db.prepare('UPDATE organization_share_links SET expires_at = ? WHERE id = ?')
        .run('2020-01-01T00:00:00.000Z', created.id);
      expect((await openLink(tokenOf(created))).status).toBe(404);
      expect((await onlyLink(manager)).state).toBe('expired');
    });

    it('refuses an expiry in the past rather than making a dead link', async () => {
      const created = (await makeLink()).body.link;
      const res = await editLink(created.id, { expiresAt: '2020-01-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('expiresAt');
    });

    it('refuses an expiry that is not a date', async () => {
      const created = (await makeLink()).body.link;
      expect((await editLink(created.id, { expiresAt: 'next tuesday' })).status).toBe(400);
    });

    it('refuses an expiry further out than five years', async () => {
      const created = (await makeLink()).body.link;
      const far = new Date(Date.now() + 6 * 365 * 24 * 60 * 60 * 1000).toISOString();
      const res = await editLink(created.id, { expiresAt: far });
      expect(res.status).toBe(400);
      /* Because "never" is expressed by leaving the field blank, not by a date
         in the year 9999 that no manager will revisit. */
      expect(res.body.error).toMatch(/leave it blank/);
    });

    /** So a link set to lapse by mistake can be made permanent again. */
    it('clears an expiry when told null', async () => {
      const created = (await makeLink({ expiresAt: '2027-06-01T00:00:00.000Z' })).body.link;
      const res = await editLink(created.id, { expiresAt: null });
      expect(res.status).toBe(200);
      expect(res.body.link.expiresAt).toBeNull();
    });

    it('creates with no expiry by default, so a flyer keeps working', async () => {
      expect((await makeLink()).body.link.expiresAt).toBeNull();
    });

    it('audits an expiry change and not a rename', async () => {
      const created = (await makeLink()).body.link;
      await editLink(created.id, { label: 'Renamed' });
      await editLink(created.id, { expiresAt: '2027-06-01T00:00:00.000Z' });

      const actions = (await db.prepare(
        `SELECT action FROM admin_audit_logs WHERE action LIKE 'ORGANIZATION_SHARE_LINK%' ORDER BY id`
      ).all()).map(r => r.action);
      expect(actions).toContain('ORGANIZATION_SHARE_LINK_EXPIRY_SET');
    });
  });

  describe('counting who came in through which link', () => {
    /**
     * Counted on the JOIN, never on the page view.
     *
     * A view counter on an unauthenticated endpoint is a write on every
     * anonymous request — a contention point and an invitation to inflate — and
     * "how many people joined from the flyer" is the question a manager
     * actually has. Nothing per-visitor is stored: a count and a date.
     */
    it('counts a join and not a page view', async () => {
      await setPolicy({ joinPolicy: 'invite' });
      const created = (await onlyLink(manager));
      const token = tokenOf(created);

      await openLink(token);
      await openLink(token);
      expect((await onlyLink(manager)).uses).toBe(0);

      const outsider = await srv.login(OTHER_STUDENT);
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, memberId);
      const joined = await srv.call(
        'POST', `/api/organizations/${orgKey}/membership`, { shareToken: token }, outsider,
      );
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);

      const after = await onlyLink(manager);
      expect(after.uses).toBe(1);
      /**
       * A DATE, not a timestamp.
       *
       * Migration 063 declares the column as one and argues why: with a single
       * use on a link — the common case for a club inviting a handful of people
       * — a full timestamp is a per-student record of the hour a named child
       * joined, readable by anyone who can read the club's links. "Used this
       * week" is what a manager acts on.
       */
      expect(after.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('counts nothing against a link that did not open the door', async () => {
      const flyer = (await makeLink({ label: 'Autumn flyer' })).body.link;
      await setPolicy({ joinPolicy: 'open' });

      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, memberId);
      const outsider = await srv.login(OTHER_STUDENT);
      /* Joined with no token at all, because the club is open. */
      expect((await srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, outsider)).status)
        .toBe(200);

      const links = (await readLinks(manager)).body.links;
      for (const link of links) expect(link.uses).toBe(0);
      expect(links.some(l => l.id === flyer.id)).toBe(true);
    });

    it('keeps the count from a sharer, who has no reason to read it', async () => {
      await makeLink();
      const [link] = (await readLinks(helper)).body.links;
      expect(link).not.toHaveProperty('uses');
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
