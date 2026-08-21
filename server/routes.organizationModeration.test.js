import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The moderation surface: who is banned, and lifting a ban without an appeal.
 *
 * ── What these add to the ban system that already existed ──
 *
 * Banning worked and was enforced on the join route. Two things were missing,
 * and both are about the ban being REVERSIBLE and VISIBLE:
 *
 *   • A club could not see who it had banned. The record existed in
 *     `organization_bans` and nothing read it back, so the only way to answer
 *     "who is excluded from this club" was to open the database.
 *   • The only route out was an appeal. A manager who banned the wrong person
 *     had to wait for that person to write a formal statement asking to be let
 *     back in before the mistake could be undone.
 *
 * ── The authorization property under test ──
 *
 * Every case that matters here is a scoping one. `organization.manage.own` says
 * "may manage AN organization"; `canManage` says WHICH. A manager of one club
 * holding the capability must be refused another club's moderation data and
 * another club's unban button — and a student must never reach either, least of
 * all to lift a ban on themselves.
 */

const OWNER = 'jordan.whitfield@example.org';   // manager of the organization
const STUDENT = 'leo.chen@example.com';         // the banned person
const OUTSIDER = 'robin.ellery@example.org';    // an organizer running a different club

describe('organization moderation', () => {
  let srv; let db;
  let manager; let student; let outsider;
  let managerId; let studentId; let outsiderId;
  let orgKey; let orgId;
  let otherKey;

  beforeAll(async () => {
    /* Several cases below ban and appeal against the same club; the limiter has
       its own file. Same rationale as routes.organizationAppeals.test.js. */
    process.env.APPEAL_WINDOW_LIMIT = '999';

    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    manager = await srv.login(OWNER);
    student = await srv.login(STUDENT);
    outsider = await srv.login(OUTSIDER);

    const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;
    managerId = await idOf(manager);
    studentId = await idOf(student);
    outsiderId = await idOf(outsider);

    const { acceptOrganizerAgreement } = await import('./organizerAgreement.js');
    for (const id of [managerId, outsiderId]) {
      try { await acceptOrganizerAgreement(db, { userId: id }); } catch { /* already signed */ }
    }

    const mk = async (name, session) => {
      const r = await srv.call('POST', '/api/organizations', {
        name: `${name} ${Math.random().toString(36).slice(2, 7)}`,
        description: 'An organization used by the moderation tests.',
      }, session);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return { key: r.body.organization.slug, id: r.body.organization.id };
    };
    ({ key: orgKey, id: orgId } = await mk('Moderation Org', manager));
    ({ key: otherKey } = await mk('Unrelated Org', outsider));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const join = async (userId, role = 'member') =>
    await db.prepare(`INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
                VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role, joined_at = excluded.joined_at`).run(orgId, userId, role, new Date().toISOString());

  const ban = (reason = 'Missed three shifts without telling anyone.') =>
    srv.call('DELETE', `/api/organizations/${orgKey}/members/${studentId}`, { mode: 'ban', reason }, manager);

  const bans = (key, session) => srv.call('GET', `/api/organizations/${key}/bans`, undefined, session);
  const lift = (key, userId, session) =>
    srv.call('POST', `/api/organizations/${key}/bans/${userId}/lift`, {}, session);

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
    await db.prepare("UPDATE appeals SET status = 'resolved' WHERE user_id = ? AND status IN ('open','reviewing')")
      .run(studentId);
    await join(managerId, 'manager');
    await join(studentId);
  });

  describe('the list of who is banned', () => {
    it('shows a banned member with the reason, the date and who issued it', async () => {
      await ban('Repeatedly abusive in the comments.');
      const res = await bans(orgKey, manager);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.bans).toHaveLength(1);
      const [row] = res.body.bans;
      expect(row.user.id).toBe(studentId);
      expect(row.reason).toBe('Repeatedly abusive in the comments.');
      expect(row.bannedAt).toBeTruthy();
      expect(row.bannedBy?.id).toBe(managerId);
      expect(row.appeal).toBeNull();
    });

    it('discloses only the allowlisted profile fields about the banned person', async () => {
      /**
       * `profileSummary` is the shared allowlist. Asserting the SHAPE rather
       * than a specific absent column is what makes this survive a new column
       * on `users`: the next one added is invisible here unless somebody names
       * it in the serializer, which is the whole point of that file.
       */
      await ban();
      const [row] = (await bans(orgKey, manager)).body.bans;
      expect(Object.keys(row.user).sort()).toEqual(
        ['avatar', 'avatarColor', 'distinction', 'id', 'kind', 'location', 'name', 'profilePictureUrl', 'role', 'username'].sort(),
      );
      expect(row.user).not.toHaveProperty('email');
    });

    it('drops somebody off the list once the ban is lifted', async () => {
      await ban();
      expect((await bans(orgKey, manager)).body.bans).toHaveLength(1);

      const lifted = await lift(orgKey, studentId, manager);
      expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
      expect((await bans(orgKey, manager)).body.bans).toHaveLength(0);
    });

    it('reports a pending appeal beside the ban it contests', async () => {
      await ban();
      const filed = await srv.call('POST', '/api/appeals', {
        subject: 'organization_ban',
        organizationId: orgId,
        statement: 'Two of those shifts were cancelled and nobody told me.',
      }, student);
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);

      const [row] = (await bans(orgKey, manager)).body.bans;
      expect(row.appeal?.pending).toBe(true);
      expect(row.appeal?.status).toBe('open');
    });
  });

  describe('lifting a ban with no appeal involved', () => {
    it('lets the person join again afterwards', async () => {
      /* The behaviour that makes the unban real rather than cosmetic: the join
         route is where a ban is enforced, so that is where it must stop. */
      await ban();
      const refused = await srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, student);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('banned');

      await lift(orgKey, studentId, manager);

      const allowed = await srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, student);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    });

    it('keeps the ban on the record rather than deleting it', async () => {
      await ban();
      await lift(orgKey, studentId, manager);

      const row = await db.prepare(
        'SELECT lifted_at, lifted_by, reason FROM organization_bans WHERE organization_id = ? AND user_id = ?',
      ).get(orgId, studentId);
      expect(row).toBeTruthy();
      expect(row.lifted_at).toBeTruthy();
      expect(row.lifted_by).toBe(managerId);
      /* "Banned, then unbanned" is the fact; the reason must survive it. */
      expect(row.reason).toBeTruthy();
    });

    it('does NOT put the person back in the club', async () => {
      /**
       * Lifting means "you may join again", not "you are back in". Re-adding
       * somebody to a club without their asking is the mirror of the original
       * problem, so membership stays gone until they choose it.
       */
      await ban();
      await lift(orgKey, studentId, manager);
      const member = await db.prepare(
        'SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ?',
      ).get(orgId, studentId);
      expect(member).toBeUndefined();
    });

    it('answers 404 when there is no active ban to lift', async () => {
      const res = await lift(orgKey, studentId, manager);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_banned');
    });

    it('cannot be applied twice, so the record of who lifted it cannot be rewritten', async () => {
      await ban();
      expect((await lift(orgKey, studentId, manager)).status).toBe(200);
      const second = await lift(orgKey, studentId, manager);
      expect(second.status).toBe(404);
    });

    it('writes an audit entry naming the manager and the organization', async () => {
      await ban();
      await lift(orgKey, studentId, manager);

      const entry = await db.prepare(`
        SELECT admin_id, action, target_user_id, details FROM admin_audit_logs
         WHERE action = 'ORGANIZATION_BAN_LIFTED' AND target_user_id = ?
         ORDER BY created_at DESC LIMIT 1
      `).get(studentId);

      expect(entry).toBeTruthy();
      expect(entry.admin_id).toBe(managerId);
      expect(entry.details).toContain(orgId);
    });

    it('records the ban itself in the audit log too', async () => {
      /* The gap this closes: banning told the subject and left no record the
         club or an administrator could read back. */
      await ban('Turned up to a shift drunk.');
      const entry = await db.prepare(`
        SELECT admin_id, details FROM admin_audit_logs
         WHERE action = 'ORGANIZATION_BANNED' AND target_user_id = ?
         ORDER BY created_at DESC LIMIT 1
      `).get(studentId);

      expect(entry).toBeTruthy();
      expect(entry.admin_id).toBe(managerId);
      expect(entry.details).toContain('Turned up to a shift drunk.');
    });
  });

  /**
   * The half that must hold regardless of what any screen renders.
   *
   * Each of these posts straight at the API with a session that should not be
   * able to reach it, because "the button is hidden" is not an access control.
   */
  describe('authorization, checked at the endpoint', () => {
    it('refuses a student the list of banned members', async () => {
      await ban();
      const res = await bans(orgKey, student);
      expect(res.status).toBe(403);
    });

    it('refuses a student who tries to lift their OWN ban', async () => {
      /* The single most important case in this file. */
      await ban();
      const res = await lift(orgKey, studentId, student);
      expect(res.status).toBe(403);

      const still = await db.prepare(
        'SELECT lifted_at FROM organization_bans WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL',
      ).get(orgId, studentId);
      expect(still, 'the ban must still be standing').toBeTruthy();
    });

    it('refuses a manager of a DIFFERENT organization', async () => {
      /**
       * `outsider` genuinely holds `organization.manage.own` and manages a club
       * of their own, so the capability gate passes and only the per-organization
       * scope check can be what refuses them.
       */
      await ban();
      expect((await bans(orgKey, outsider)).status).toBe(403);
      expect((await lift(orgKey, studentId, outsider)).status).toBe(403);
    });

    it('does not let a manager reach another club through their own key', async () => {
      /* The mirror: a valid session and a valid organization, but not theirs. */
      const res = await bans(otherKey, manager);
      expect(res.status).toBe(403);
    });

    it('refuses an unauthenticated caller outright', async () => {
      const res = await srv.call('GET', `/api/organizations/${orgKey}/bans`);
      expect(res.status).toBe(401);
    });
  });

  /**
   * What the banned person's own page is told.
   *
   * This is what lets the client stop offering Join to somebody the server will
   * refuse. It is a display aid, not the control — the join route is still the
   * only thing enforcing the ban.
   */
  describe('the viewer’s own ban state', () => {
    const viewOrg = (session) => srv.call('GET', `/api/organizations/${orgKey}`, undefined, session);

    it('is null for somebody who is not banned', async () => {
      const res = await viewOrg(student);
      expect(res.status).toBe(200);
      expect(res.body.viewer.ban).toBeNull();
    });

    it('tells a banned person they are banned, and why', async () => {
      await ban('Repeatedly abusive in the comments.');
      const res = await viewOrg(student);
      expect(res.body.viewer.ban?.reason).toBe('Repeatedly abusive in the comments.');
      expect(res.body.viewer.ban?.bannedAt).toBeTruthy();
      expect(res.body.viewer.ban?.appeal).toBeNull();
    });

    it('does not name the manager who issued it to the person banned', async () => {
      /* Managers see the issuer in the moderation list. The subject does not:
         it is the club's decision, and the route for contesting it is the
         appeal rather than the individual. */
      await ban();
      const res = await viewOrg(student);
      expect(res.body.viewer.ban).not.toHaveProperty('bannedBy');
    });

    it('reports an appeal as pending once one is filed', async () => {
      await ban();
      await srv.call('POST', '/api/appeals', {
        subject: 'organization_ban',
        organizationId: orgId,
        statement: 'Two of those shifts were cancelled and nobody told me.',
      }, student);

      const res = await viewOrg(student);
      expect(res.body.viewer.ban?.appeal?.pending).toBe(true);
    });

    it('goes back to null once the ban is lifted', async () => {
      await ban();
      await lift(orgKey, studentId, manager);
      const res = await viewOrg(student);
      expect(res.body.viewer.ban).toBeNull();
    });
  });
});
