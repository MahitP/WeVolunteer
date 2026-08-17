import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * An organization speaking to its members, and them answering.
 *
 * ── The two things most worth guarding ──
 *
 * Posting AS an organization is a byline. `organization.manage.own` says only
 * that an account is the kind that manages organizations; without a membership
 * check on top, any organizer on the platform could publish under any club's
 * name. That is impersonation, and it is the reason every write here carries
 * two layers.
 *
 * Turning replies off must not destroy the replies already written. Somebody
 * wrote those, other people read them, and a settings toggle is not a
 * moderation decision.
 */

const MANAGER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';

describe('organization announcements', () => {
  let srv;
  let db;
  let manager;
  let student;
  let stranger;
  let managerId;
  let studentId;
  let orgKey;
  let orgId;

  const list = (session = manager) =>
    srv.call('GET', `/api/organizations/${orgKey}/announcements`, undefined, session);
  const post = (body, session = manager) =>
    srv.call('POST', `/api/organizations/${orgKey}/announcements`, body, session);
  const patch = (id, body, session = manager) =>
    srv.call('PATCH', `/api/organizations/${orgKey}/announcements/${id}`, body, session);
  const remove = (id, session = manager) =>
    srv.call('DELETE', `/api/organizations/${orgKey}/announcements/${id}`, undefined, session);
  const reply = (id, body, session = student) =>
    srv.call('POST', `/api/organizations/${orgKey}/announcements/${id}/replies`, { body }, session);

  /** The organization-level setting, which now governs every announcement. */
  const setAllowReplies = (allow) =>
    srv.call('PATCH', `/api/organizations/${orgKey}`, { allowReplies: allow }, manager);

  const join = async (userId, role = 'member') => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role, joined_at = excluded.joined_at
    `).run(orgId, userId, role, new Date().toISOString());
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(MANAGER);
    student = await srv.login(STUDENT);
    stranger = await srv.login(OTHER_STUDENT);

    managerId = (await srv.call('GET', '/api/auth/me', undefined, manager)).body.id;
    studentId = (await srv.call('GET', '/api/auth/me', undefined, student)).body.id;

    const created = await srv.call('POST', '/api/organizations', {
      name: `Announcement Test Org ${Math.random().toString(36).slice(2, 7)}`,
      description: 'An organization used by the announcement tests.',
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_announcements WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(orgId);
    await join(managerId, 'manager');
    await join(studentId, 'member');
  });

  describe('posting', () => {
    it('lets a manager announce something', async () => {
      const res = await post({ body: 'Bring gloves on Saturday.' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.announcement.body).toBe('Bring gloves on Saturday.');
    });

    it('records who wrote it and when', async () => {
      const res = await post({ body: 'Bring gloves on Saturday.' });
      expect(res.body.announcement.author.id).toBe(managerId);
      expect(res.body.announcement.author.name).toBeTruthy();
      expect(res.body.announcement.createdAt).toBeTruthy();
    });

    it('allows replies by default', async () => {
      /* An announcement nobody can answer is a broadcast. */
      const res = await post({ body: 'Bring gloves on Saturday.' });
      expect(res.body.announcement.repliesEnabled).toBe(true);
    });

    it('reports the ORGANIZATION\'s reply setting, not a per-post one', async () => {
      /* A per-post flag in the body must be ignored — there is one answer for
         the whole organization and no individual override. */
      await setAllowReplies(false);
      const res = await post({ body: 'Final notice.', repliesEnabled: true });

      expect(res.body.announcement.repliesEnabled, 'the body flag must not win').toBe(false);
      await setAllowReplies(true);
    });

    it('refuses an empty announcement', async () => {
      const res = await post({ body: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('body_required');
    });

    it('refuses an enormous one', async () => {
      const res = await post({ body: 'x'.repeat(4001) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('body_too_long');
    });
  });

  describe('who may post', () => {
    it('refuses an organizer who does not manage THIS organization', async () => {
      /**
       * The check the capability gate cannot make, and the reason this route
       * has two layers. `organization.manage.own` says only "this account is
       * the kind that manages organizations". A caller holding it who is
       * refused here proves the membership check is what did the refusing —
       * a student would be stopped at the middleware and prove nothing.
       */
      /* The caller is the account that DOES hold the capability, with its
         membership row taken away — the pattern `routes.organizationMembers`
         uses. Reaching for another seeded organizer instead proved nothing: the
         only spare one is unverified, so its capabilities are withheld and it is
         refused by the middleware long before `canManage` is consulted. */
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, managerId);

      const res = await post({ body: 'Posting as somebody else.' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_manager');
      expect((await db.prepare('SELECT COUNT(*) AS c FROM organization_announcements WHERE organization_id = ?')
        .get(orgId)).c).toBe(0);
    });

    it('refuses a plain member of this organization', async () => {
      /* Belonging is not managing. */
      const res = await post({ body: 'I am not a manager.' }, student);
      expect([403, 404]).toContain(res.status);
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await srv.call('POST', `/api/organizations/${orgKey}/announcements`, { body: 'Anon.' });
      expect(res.status).toBe(401);
    });
  });

  describe('replying', () => {
    let announcementId;

    beforeEach(async () => {
      announcementId = (await post({ body: 'Bring gloves on Saturday.' })).body.announcement.id;
    });

    it('lets a member reply', async () => {
      const res = await reply(announcementId, 'That clashes with the game.');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.reply.body).toBe('That clashes with the game.');
      expect(res.body.reply.author.id).toBe(studentId);
    });

    it('shows replies with the announcement', async () => {
      await reply(announcementId, 'That clashes with the game.');
      const found = (await list()).body.announcements.find(a => a.id === announcementId);
      expect(found.replies).toHaveLength(1);
      expect(found.replies[0].body).toBe('That clashes with the game.');
    });

    it('refuses somebody who is not a member', async () => {
      /* An announcement is addressed to the people in the club. */
      const res = await reply(announcementId, 'Butting in.', stranger);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_member');
    });

    it('refuses an empty reply', async () => {
      const res = await reply(announcementId, '   ');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('body_required');
    });
  });

  describe('turning replies off, for the whole organization', () => {
    let announcementId;

    beforeEach(async () => {
      await setAllowReplies(true);
      announcementId = (await post({ body: 'Bring gloves on Saturday.' })).body.announcement.id;
      await reply(announcementId, 'Already said this before it was locked.');
    });

    afterEach(async () => { await setAllowReplies(true); });

    it('stops new replies', async () => {
      await setAllowReplies(false);

      const res = await reply(announcementId, 'Trying anyway.');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('replies_disabled');
    });

    it('applies to EVERY announcement, not just one', async () => {
      /* The point of moving this to the organization: one setting, no post
         left behind with its own answer. */
      const second = (await post({ body: 'A second announcement.' })).body.announcement.id;
      await setAllowReplies(false);

      expect((await reply(announcementId, 'One.')).status).toBe(409);
      expect((await reply(second, 'Two.')).status).toBe(409);
    });

    it('KEEPS the replies already written', async () => {
      /**
       * The property that matters most here.
       *
       * Somebody wrote that and other people have read it. Deleting it as a
       * side effect of a settings change would be destroying another person's
       * words without a moderation decision; hiding it would be worse, because
       * the author would carry on believing they had been heard.
       */
      await setAllowReplies(false);

      const found = (await list()).body.announcements.find(a => a.id === announcementId);
      expect(found.repliesEnabled).toBe(false);
      expect(found.replies, 'existing replies must survive the toggle').toHaveLength(1);
      expect(found.replies[0].body).toBe('Already said this before it was locked.');
    });

    it('can be turned back on, and the thread resumes', async () => {
      await setAllowReplies(false);
      await setAllowReplies(true);

      const res = await reply(announcementId, 'Back open.');
      expect(res.status).toBe(201);

      const found = (await list()).body.announcements.find(a => a.id === announcementId);
      expect(found.replies).toHaveLength(2);
    });

    it('cannot be toggled by somebody who does not manage the organization', async () => {
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, managerId);

      const res = await setAllowReplies(false);
      expect(res.status).toBe(403);
      await join(managerId, 'manager');

      const found = (await list()).body.announcements.find(a => a.id === announcementId);
      expect(found.repliesEnabled).toBe(true);
    });
  });

  describe('editing and deleting', () => {
    let announcementId;

    beforeEach(async () => {
      announcementId = (await post({ body: 'Original wording.' })).body.announcement.id;
    });

    it('lets a manager edit the text', async () => {
      const res = await patch(announcementId, { body: 'Corrected wording.' });
      expect(res.status).toBe(200);
      expect(res.body.announcement.body).toBe('Corrected wording.');
      expect(res.body.announcement.updatedAt).toBeTruthy();
    });

    it('refuses an edit from an organizer who does not manage this organization', async () => {
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, managerId);
      const res = await patch(announcementId, { body: 'Rewritten by a stranger.' });
      expect(res.status).toBe(403);
      await join(managerId, 'manager');

      const found = (await list()).body.announcements.find(a => a.id === announcementId);
      expect(found.body).toBe('Original wording.');
    });

    it('deletes an announcement and its replies together', async () => {
      await reply(announcementId, 'A reply that should go with it.');
      expect((await remove(announcementId)).status).toBe(200);

      expect((await list()).body.announcements.find(a => a.id === announcementId)).toBeUndefined();
      expect((await db.prepare('SELECT COUNT(*) AS c FROM organization_announcement_replies WHERE announcement_id = ?')
        .get(announcementId)).c).toBe(0);
    });

    it('refuses a delete from an outsider', async () => {
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, managerId);
      expect((await remove(announcementId)).status).toBe(403);
      await join(managerId, 'manager');
      expect((await list()).body.announcements.find(a => a.id === announcementId)).toBeTruthy();
    });

    it('404s for an announcement belonging to another organization', async () => {
      /* The id alone must not be enough — every write is scoped to the
         organization in the path as well as the id. */
      const elsewhere = await srv.call('POST', '/api/organizations', {
        name: `Elsewhere ${Math.random().toString(36).slice(2, 7)}`,
        description: 'Another organization.',
      }, manager);
      const otherKey = elsewhere.body.organization.slug;

      const res = await srv.call('DELETE',
        `/api/organizations/${otherKey}/announcements/${announcementId}`, undefined, manager);
      expect(res.status).toBe(404);
    });
  });

  describe('reading', () => {
    it('returns newest first', async () => {
      const first = (await post({ body: 'Older.' })).body.announcement.id;
      await new Promise(r => setTimeout(r, 5));
      const second = (await post({ body: 'Newer.' })).body.announcement.id;

      const ids = (await list()).body.announcements.map(a => a.id);
      expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
    });

    it('is one query for the replies, not one per announcement', async () => {
      /* A club with forty posts must not become forty-one round trips. */
      for (let i = 0; i < 8; i += 1) await post({ body: `Announcement ${i}.` });

      const started = process.hrtime.bigint();
      const res = await list();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;

      expect(res.status).toBe(200);
      expect(res.body.announcements.length).toBeGreaterThanOrEqual(8);
      expect(ms, `listing took ${ms.toFixed(0)}ms`).toBeLessThan(1500);
    });

    it('rejects an unauthenticated reader', async () => {
      expect((await srv.call('GET', `/api/organizations/${orgKey}/announcements`)).status).toBe(401);
    });
  });

  
  /**
   * The organization logo.
   *
   * Kept in this file rather than a new one because it exercises the same two
   * authorization layers over the same organization fixture, and a third
   * `startTestServer` for four assertions is a slow way to say the same thing.
   */
  describe('organization image', () => {
    /* Reuses the file's single server and organization. `startTestServer` refuses
       a second call in one file — deliberately, because two servers in one file
       means two database handles and the anti-leak guard cannot tell which one a
       stray write went to. */
  
    it('publishes both an emoji and an image slot', async () => {
      /* The renderer prefers the upload and falls back to the emoji, which only
         works if both are on the payload. */
      const res = await srv.call('GET', `/api/organizations/${orgKey}`, undefined, manager);
      expect(res.body.organization).toHaveProperty('avatar');
      expect(res.body.organization).toHaveProperty('imageUrl');
    });
  
    it('accepts an emoji through the ordinary edit route', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${orgKey}`, { avatar: '🍎' }, manager);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.organization.avatar).toBe('🍎');
    });
  
    it('lets an organization go back to having no mark', async () => {
      await srv.call('PATCH', `/api/organizations/${orgKey}`, { avatar: '🍎' }, manager);
      const res = await srv.call('PATCH', `/api/organizations/${orgKey}`, { avatar: null }, manager);
      expect(res.body.organization.avatar).toBeNull();
    });
  
    it('refuses something too long to be one emoji', async () => {
      /* Eight characters, the rule `users.avatar` uses — long enough for skin
         tone and joiners, short enough that a payload cannot ride in a field that
         renders on every card. */
      const res = await srv.call('PATCH', `/api/organizations/${orgKey}`, { avatar: 'x'.repeat(40) }, manager);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('avatar');
    });
  
    it('refuses an image upload from somebody who does not manage the organization', async () => {
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .run(orgId, managerId);
  
      const res = await srv.call('DELETE', `/api/organizations/${orgKey}/image`, undefined, manager);
  
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_manager');
  
      await join(managerId, 'manager');
    });
  
    it('refuses an unauthenticated caller', async () => {
      expect((await srv.call('DELETE', `/api/organizations/${orgKey}/image`)).status).toBe(401);
    });
  
    it('clearing the image leaves the emoji standing', async () => {
      /* The fallback order is upload, then emoji, then the building glyph.
         Removing the top of that chain must not take the rest with it. */
      await srv.call('PATCH', `/api/organizations/${orgKey}`, { avatar: '🌱' }, manager);
      const res = await srv.call('DELETE', `/api/organizations/${orgKey}/image`, undefined, manager);
  
      expect(res.status).toBe(200);
      expect(res.body.organization.imageUrl).toBeNull();
      expect(res.body.organization.avatar).toBe('🌱');
    });
  });
});
