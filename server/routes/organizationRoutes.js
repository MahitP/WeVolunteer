/**
 * Organizations: creating one, managing one, joining one, and reading one.
 *
 * ── Who may do what, and where it is decided ──
 *
 * Creating is `organization.create`, which organizers and administrators hold
 * and students do not. Managing is `organization.manage.own` PLUS an ownership
 * check against `organization_members` — the capability says "this account is
 * the kind that manages organizations", and the membership row says which one.
 * Administrators bypass the second half with `organization.moderate`.
 *
 * That split is the same one `event.edit.own` / `event.moderate` already makes,
 * and it is made here for the same reason: a capability cannot express "this
 * organization and not that one", so anything that tries to is either granting
 * too much or lying about what it grants.
 */

import express from 'express';
import { authenticateToken, inTransaction } from '../utils.js';
import { can, requireCap } from '../authz.js';
import { db } from '../db.js';
import {
  validateOrganization, createOrganization, canManage, formatOrganization, uniqueSlug,
} from '../organizations.js';
import { profileSummary } from '../profileSerializer.js';
import path from 'node:path';
import sharp from 'sharp';
import { receiveAvatar, deleteUploadedFile, AVATAR_UPLOADS_DIR } from './profilePictureRoutes.js';

const router = express.Router();

/** Member and event counts, computed in the same statement as the row. */
const ORG_SELECT = `
  SELECT o.*,
         (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS memberCount,
         (SELECT COUNT(*) FROM events e WHERE e.organization_id = o.id) AS eventCount
  FROM organizations o
`;

/** Loads an organization by slug or id, or answers 404. */
function loadOrganization(req, res) {
  const key = req.params.key;
  const row = db.prepare(`${ORG_SELECT} WHERE (o.slug = ? COLLATE NOCASE OR o.id = ?)`).get(key, key);
  if (!row) {
    res.status(404).json({ error: 'No such organization.', code: 'not_found' });
    return null;
  }
  return row;
}

/**
 * Browse organizations.
 *
 * Paginated by construction. The directory search endpoint covers querying by
 * name; this is the "show me what exists" list, and it is bounded for the same
 * reason that one is.
 */
router.get('/api/organizations', authenticateToken, requireCap('directory.read'), (req, res) => {
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const mineOnly = req.query.mine === 'true';

  const rows = mineOnly
    ? db.prepare(`${ORG_SELECT}
        JOIN organization_members mm ON mm.organization_id = o.id AND mm.user_id = ?
        WHERE o.status = 'active' ORDER BY o.name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(req.principal.userId, limit + 1, offset)
    : db.prepare(`${ORG_SELECT} WHERE o.status = 'active'
        ORDER BY memberCount DESC, o.name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(limit + 1, offset);

  res.json({
    organizations: rows.slice(0, limit).map(formatOrganization),
    hasMore: rows.length > limit,
  });
});

/**
 * One organization, with its members and its events.
 *
 * Members are returned through `profileSummary` — the same strict subset of the
 * public profile baseline that search uses. An organization page listing its
 * roster must not become the route by which somebody reads a field a profile
 * would have withheld.
 */
router.get('/api/organizations/:key', authenticateToken, requireCap('directory.read'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return;

  /**
   * An archived organization is out of circulation, and that has to include
   * this route.
   *
   * Browsing (`status = 'active'`) and directory search both filter on status,
   * and joining refuses an archived organization — so archiving looked like it
   * withdrew a club from the platform. It did not withdraw THIS page, which is
   * the one that lists up to a hundred members. Slugs are derived from the
   * name rather than random, so the address is guessable, and archiving is the
   * only withdrawal mechanism a manager is offered: somebody who archived a
   * club to take its roster of students out of view had not done so.
   *
   * Managers and moderators still see it, because otherwise archiving would be
   * a one-way door — the page is where unarchiving is reached from. 404 rather
   * than 403 for everybody else, matching `loadOrganization`: a distinguishable
   * refusal would confirm the organization exists.
   */
  const mayManage = canManage(db, row.id, req.principal.userId, {
    hasModerate: can(req.principal, 'organization.moderate'),
  });
  if (row.status !== 'active' && !mayManage) {
    return res.status(404).json({ error: 'No such organization.', code: 'not_found' });
  }

  const members = db.prepare(`
    SELECT u.id, u.username, u.name, u.avatar, u.profile_picture_url, u.role, u.location,
           m.member_role AS memberRole, m.joined_at AS joinedAt
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.account_status = 'active'
    ORDER BY CASE m.member_role WHEN 'manager' THEN 0 ELSE 1 END, u.name COLLATE NOCASE
    LIMIT 100
  `).all(row.id);

  /**
   * Upcoming first, then recent past. Cancelled events are excluded: an
   * organization page is a shop window, and an event that is not happening is
   * not something to advertise.
   */
  const events = db.prepare(`
    SELECT e.id, e.title, e.category, e.location, e.status, e.credits_hours AS creditsHours,
           e.application_deadline AS applicationDeadline,
           (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) AS startsAt
    FROM events e
    WHERE e.organization_id = ? AND e.status <> 'cancelled'
    ORDER BY startsAt DESC
    LIMIT 50
  `).all(row.id);

  const membership = db.prepare(
    'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(row.id, req.principal.userId);

  res.json({
    organization: formatOrganization(row),
    members: members.map(m => ({ ...profileSummary(m), memberRole: m.memberRole, joinedAt: m.joinedAt })),
    events: events.map(e => ({ ...e, creditsHours: e.creditsHours !== 0 })),
    viewer: {
      isMember: Boolean(membership),
      memberRole: membership?.member_role ?? null,
      /* Computed once, above, where the archived-organization gate also needs
         it — the two must agree, and two calls is two chances for them not to. */
      canManage: mayManage,
    },
  });
});

/** Create one. The creator becomes its first manager, in the same transaction. */
router.post('/api/organizations', authenticateToken, requireCap('organization.create'), (req, res) => {
  const check = validateOrganization(req.body ?? {});
  if (!check.ok) return res.status(400).json({ error: check.error, field: check.field });

  const creator = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.principal.userId);
  let orgId;
  try {
    inTransaction(() => {
      orgId = createOrganization(db, {
        name: check.value.name,
        description: check.value.description ?? '',
        tags: check.value.tags ?? [],
        creator,
      });
    });
  } catch (err) {
    console.error('Organization create failed:', err);
    return res.status(500).json({ error: 'Could not create the organization.' });
  }

  const row = db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(orgId);
  res.status(201).json({ organization: formatOrganization(row) });
});

/** Edit one. Managers of that organization, or a moderator. */
router.patch('/api/organizations/:key', authenticateToken, requireCap('organization.manage.own'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return;
  if (!canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'You do not manage this organization.', code: 'not_manager' });
  }

  const check = validateOrganization(req.body ?? {}, { partial: true });
  if (!check.ok) return res.status(400).json({ error: check.error, field: check.field });

  const updates = [];
  const values = [];
  if (check.value.name !== undefined) {
    updates.push('name = ?'); values.push(check.value.name);
    /**
     * A rename re-slugs, and any old link stops resolving.
     *
     * The alternative — freezing the slug at creation — leaves a club that
     * renamed itself permanently addressed by its old name, which is worse for
     * the people who have to share the link. There is no redirect table because
     * there is no evidence yet that anybody needs one; adding it later is
     * additive.
     */
    if (check.value.name !== row.name) { updates.push('slug = ?'); values.push(uniqueSlug(db, check.value.name)); }
  }
  if (check.value.description !== undefined) { updates.push('description = ?'); values.push(check.value.description); }
  if (check.value.tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(check.value.tags)); }
  /* The emoji mark. `null` clears it, which is why the check is on `undefined`
     and not on truthiness — an organization may go back to having none. */
  if (check.value.avatar !== undefined) { updates.push('avatar = ?'); values.push(check.value.avatar); }
  if (check.value.allowReplies !== undefined) {
    updates.push('allow_replies = ?'); values.push(check.value.allowReplies ? 1 : 0);
  }
  if (req.body?.status !== undefined) {
    if (!['active', 'archived'].includes(req.body.status)) {
      return res.status(400).json({ error: 'Status must be active or archived.', field: 'status' });
    }
    updates.push('status = ?'); values.push(req.body.status);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

  updates.push('updated_at = ?'); values.push(new Date().toISOString());
  values.push(row.id);
  db.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  res.json({ organization: formatOrganization(db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(row.id)) });
});

/** Join. Idempotent — tapping Join twice is not an error worth an error page. */
router.post('/api/organizations/:key/membership', authenticateToken, requireCap('organization.join'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return;
  if (row.status !== 'active') {
    return res.status(409).json({ error: 'That organization is no longer accepting members.', code: 'archived' });
  }
  db.prepare(`
    INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
    VALUES (?, ?, 'member', ?)
    ON CONFLICT(organization_id, user_id) DO NOTHING
  `).run(row.id, req.principal.userId, new Date().toISOString());

  res.json({ isMember: true, memberCount: countMembers(row.id) });
});

/**
 * Leave.
 *
 * The last manager cannot leave. An organization with no manager is one nobody
 * can edit, unarchive, or attach an event to — recoverable only by an
 * administrator, and only if somebody notices. Refusing is a far better answer
 * than silently creating orphans.
 */
router.delete('/api/organizations/:key/membership', authenticateToken, requireCap('organization.join'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return;

  const mine = db.prepare(
    'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(row.id, req.principal.userId);
  if (!mine) return res.json({ isMember: false, memberCount: countMembers(row.id) });

  if (mine.member_role === 'manager') {
    const managers = db.prepare(
      `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND member_role = 'manager'`
    ).get(row.id).n;
    if (managers <= 1) {
      return res.status(409).json({
        error: 'You are the only manager. Make somebody else a manager before you leave.',
        code: 'last_manager',
      });
    }
  }

  db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
    .run(row.id, req.principal.userId);
  res.json({ isMember: false, memberCount: countMembers(row.id) });
});

/**
 * Remove somebody else from the organization. Managers only.
 *
 * ── What this does NOT touch ──
 *
 * Membership, and nothing else. Not the account, not attendance, not credited
 * hours, not certificates, not the transcript, not the events they worked. A
 * volunteer who served forty hours under this organization's banner still
 * served them, and a manager tidying a member list has no business editing
 * somebody's service record — the two are unrelated facts that happen to share
 * a page.
 *
 * That is not a promise a comment can keep, so the route writes exactly one
 * DELETE against `organization_members` and the tests assert every other table
 * is untouched.
 *
 * ── The last manager ──
 *
 * Guarded here for the third time, deliberately. `DELETE …/membership` (leave)
 * and `PATCH …/members/:userId` (demote) both refuse to strip the final
 * manager, and without this a manager could simply remove their co-manager and
 * then themselves — defeating the invariant in two requests rather than one.
 * An organization nobody can manage is recoverable only by an administrator,
 * and only if somebody notices.
 *
 * ── Removing yourself ──
 *
 * Allowed, and routed to the same guard. Refusing would mean a manager who
 * clicks their own row gets an error telling them to use a different button for
 * the same thing, and `DELETE …/membership` already exists for exactly this.
 */
router.delete('/api/organizations/:key/members/:userId', authenticateToken, requireCap('organization.manage.own'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return;
  if (!canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'You do not manage this organization.', code: 'not_manager' });
  }

  const target = db.prepare(
    'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(row.id, req.params.userId);
  if (!target) {
    return res.status(404).json({ error: 'That person is not a member.', code: 'not_member' });
  }

  if (target.member_role === 'manager') {
    const managers = db.prepare(
      `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND member_role = 'manager'`
    ).get(row.id).n;
    if (managers <= 1) {
      return res.status(409).json({
        error: 'This is the only manager. Make somebody else a manager first.',
        code: 'last_manager',
      });
    }
  }

  db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
    .run(row.id, req.params.userId);

  res.json({ userId: req.params.userId, isMember: false, memberCount: countMembers(row.id) });
});

/** Promote or demote a member. Managers only. */
router.patch('/api/organizations/:key/members/:userId', authenticateToken, requireCap('organization.manage.own'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return;
  if (!canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'You do not manage this organization.', code: 'not_manager' });
  }
  const memberRole = req.body?.memberRole;
  if (!['member', 'manager'].includes(memberRole)) {
    return res.status(400).json({ error: 'Role must be member or manager.', field: 'memberRole' });
  }
  /**
   * Demoting the last manager is the same defect as letting them leave, and the
   * leave route guards it while this one did not.
   *
   * Without this, the sole manager demotes themselves (200), the organization
   * now has zero managers, and the leave guard then passes too because it reads
   * `member_role = 'member'` — so the invariant is defeated in two requests
   * rather than one. Same check, same reason: an organization nobody can manage
   * is recoverable only by an administrator, and only if somebody notices.
   */
  if (memberRole === 'member') {
    const current = db.prepare(
      'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
    ).get(row.id, req.params.userId);
    if (current?.member_role === 'manager') {
      const managers = db.prepare(
        `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND member_role = 'manager'`
      ).get(row.id).n;
      if (managers <= 1) {
        return res.status(409).json({
          error: 'This is the only manager. Make somebody else a manager first.',
          code: 'last_manager',
        });
      }
    }
  }

  const { changes } = db.prepare(
    'UPDATE organization_members SET member_role = ? WHERE organization_id = ? AND user_id = ?'
  ).run(memberRole, row.id, req.params.userId);
  if (!changes) return res.status(404).json({ error: 'That person is not a member.', code: 'not_member' });
  res.json({ userId: req.params.userId, memberRole });
});

function countMembers(organizationId) {
  return db.prepare('SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?')
    .get(organizationId).n;
}

/* ──────────────────────────────────────────────────────────────────────────
   Announcements
   ────────────────────────────────────────────────────────────────────────── */

/** The longest a single announcement or reply may be. */
const ANNOUNCEMENT_MAX = 4000;
const REPLY_MAX = 1000;

/** Shapes one announcement for the client, replies included. */
function formatAnnouncement(row, replies = []) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    body: row.body,
    /* Resolved from the organization and stamped on every announcement, so the
       client renders one consistent answer without having to join them up. */
    repliesEnabled: row.org_allow_replies === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    author: {
      id: row.author_id,
      name: row.author_name || 'Former member',
      avatar: row.author_avatar || null,
    },
    replies,
  };
}

const ANNOUNCEMENT_SELECT = `
  SELECT a.*, u.name AS author_name, u.avatar AS author_avatar,
         o.allow_replies AS org_allow_replies
  FROM organization_announcements a
  LEFT JOIN users u ON u.id = a.author_id
  JOIN organizations o ON o.id = a.organization_id
`;

/**
 * An organization's announcements, newest first, with their replies.
 *
 * `directory.read` to match the organization page itself: an announcement is
 * part of what an organization publishes about itself, and gating it more
 * tightly than the page it appears on would be a lock on an open door.
 *
 * Two queries regardless of how many announcements there are — the replies are
 * fetched for the whole page in one `IN (…)` and grouped in memory. One query
 * per announcement is how a club with forty posts becomes forty-one round
 * trips.
 */
router.get('/api/organizations/:key/announcements', authenticateToken, requireCap('directory.read'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return undefined;

  const announcements = db.prepare(`${ANNOUNCEMENT_SELECT} WHERE a.organization_id = ? ORDER BY a.created_at DESC LIMIT 100`)
    .all(row.id);
  if (announcements.length === 0) return res.json({ announcements: [] });

  const placeholders = announcements.map(() => '?').join(',');
  const replyRows = db.prepare(`
    SELECT r.*, u.name AS author_name, u.avatar AS author_avatar
    FROM organization_announcement_replies r
    LEFT JOIN users u ON u.id = r.author_id
    WHERE r.announcement_id IN (${placeholders})
    ORDER BY r.created_at
  `).all(...announcements.map(a => a.id));

  const byAnnouncement = new Map();
  for (const r of replyRows) {
    if (!byAnnouncement.has(r.announcement_id)) byAnnouncement.set(r.announcement_id, []);
    byAnnouncement.get(r.announcement_id).push({
      id: r.id,
      body: r.body,
      createdAt: r.created_at,
      author: { id: r.author_id, name: r.author_name || 'Former member', avatar: r.author_avatar || null },
    });
  }

  return res.json({
    announcements: announcements.map(a => formatAnnouncement(a, byAnnouncement.get(a.id) ?? [])),
  });
});

/**
 * Posting as the organization.
 *
 * Managers only — `organization.manage.own` plus `canManage`, the same two-layer
 * check every other write in this file uses. The capability says "this account
 * is the kind that manages organizations"; the membership row says which one.
 * Without the second half any organizer could post as any club, which is
 * impersonation with a byline.
 */
router.post('/api/organizations/:key/announcements', authenticateToken, requireCap('organization.manage.own'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return undefined;
  if (!canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only a manager of this organization can post announcements.', code: 'not_manager' });
  }

  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Write something to announce.', code: 'body_required' });
  if (body.length > ANNOUNCEMENT_MAX) {
    return res.status(400).json({ error: `An announcement must be ${ANNOUNCEMENT_MAX} characters or fewer.`, code: 'body_too_long' });
  }

  /* No per-post reply flag. Whether replies are open is a property of the
     organization — one setting in Manage Organization, no individual override.
     The column 041 created is left in place but is no longer consulted. */
  const id = `organn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO organization_announcements (id, organization_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, row.id, req.principal.userId, body, new Date().toISOString());

  const created = db.prepare(`${ANNOUNCEMENT_SELECT} WHERE a.id = ?`).get(id);
  return res.status(201).json({ announcement: formatAnnouncement(created) });
});

/**
 * Editing an announcement, including turning replies off.
 *
 * Turning replies off KEEPS the replies that are already there and stops new
 * ones. Deleting them would be destroying other people's words as a side effect
 * of a settings change, and hiding them would be worse still — the authors
 * would carry on believing they had been heard. A closed thread is what this
 * means everywhere else, so nobody has to be taught it.
 */
router.patch('/api/organizations/:key/announcements/:announcementId', authenticateToken, requireCap('organization.manage.own'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return undefined;
  if (!canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only a manager of this organization can edit announcements.', code: 'not_manager' });
  }

  const existing = db.prepare('SELECT * FROM organization_announcements WHERE id = ? AND organization_id = ?')
    .get(req.params.announcementId, row.id);
  if (!existing) return res.status(404).json({ error: 'No such announcement.', code: 'not_found' });

  const updates = [];
  const values = [];
  if (req.body?.body !== undefined) {
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'Write something to announce.', code: 'body_required' });
    if (body.length > ANNOUNCEMENT_MAX) {
      return res.status(400).json({ error: `An announcement must be ${ANNOUNCEMENT_MAX} characters or fewer.`, code: 'body_too_long' });
    }
    updates.push('body = ?'); values.push(body);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

  updates.push('updated_at = ?'); values.push(new Date().toISOString());
  values.push(existing.id);
  db.prepare(`UPDATE organization_announcements SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare(`${ANNOUNCEMENT_SELECT} WHERE a.id = ?`).get(existing.id);
  return res.json({ announcement: formatAnnouncement(updated) });
});

/** Removing an announcement. Its replies cascade with it. */
router.delete('/api/organizations/:key/announcements/:announcementId', authenticateToken, requireCap('organization.manage.own'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return undefined;
  if (!canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only a manager of this organization can delete announcements.', code: 'not_manager' });
  }

  const result = db.prepare('DELETE FROM organization_announcements WHERE id = ? AND organization_id = ?')
    .run(req.params.announcementId, row.id);
  if (result.changes === 0) return res.status(404).json({ error: 'No such announcement.', code: 'not_found' });

  return res.json({ ok: true });
});

/**
 * Replying.
 *
 * `organization.join` rather than a management capability: replying is what an
 * ordinary member does, and it is the capability every role that can belong to
 * an organization already holds. Membership itself is checked below — an
 * announcement is addressed to the people in the club, and a stranger answering
 * it is a stranger in the room.
 */
router.post('/api/organizations/:key/announcements/:announcementId/replies', authenticateToken, requireCap('organization.join'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return undefined;

  const announcement = db.prepare('SELECT * FROM organization_announcements WHERE id = ? AND organization_id = ?')
    .get(req.params.announcementId, row.id);
  if (!announcement) return res.status(404).json({ error: 'No such announcement.', code: 'not_found' });

  /**
   * The ORGANIZATION's setting, not the announcement's.
   *
   * Enforced here and only here: existing replies are untouched by it, because
   * a settings toggle is not a moderation decision and the people who wrote
   * them were heard. See migration 042.
   */
  if (row.allow_replies !== 1) {
    return res.status(409).json({ error: 'This organization has turned off replies.', code: 'replies_disabled' });
  }

  const isMember = db.prepare('SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?')
    .get(row.id, req.principal.userId);
  if (!isMember && !can(req.principal, 'organization.moderate')) {
    return res.status(403).json({ error: 'Join the organization to reply.', code: 'not_member' });
  }

  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Write a reply first.', code: 'body_required' });
  if (body.length > REPLY_MAX) {
    return res.status(400).json({ error: `A reply must be ${REPLY_MAX} characters or fewer.`, code: 'body_too_long' });
  }

  const id = `orgrep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO organization_announcement_replies (id, announcement_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, announcement.id, req.principal.userId, body, new Date().toISOString());

  const created = db.prepare(`
    SELECT r.*, u.name AS author_name, u.avatar AS author_avatar
    FROM organization_announcement_replies r
    LEFT JOIN users u ON u.id = r.author_id
    WHERE r.id = ?
  `).get(id);

  return res.status(201).json({
    reply: {
      id: created.id,
      body: created.body,
      createdAt: created.created_at,
      author: { id: created.author_id, name: created.author_name || 'Former member', avatar: created.author_avatar || null },
    },
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   Organization image
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Uploading a logo.
 *
 * ── Everything here is borrowed on purpose ──
 *
 * `receiveAvatar` (the multer config, the 5 MB limit, the mimetype pre-filter
 * and the three refusal shapes), `AVATAR_UPLOADS_DIR` and `deleteUploadedFile`
 * all come from `profilePictureRoutes.js`. A second upload pipeline would be a
 * second size limit to keep in step, a second set of error codes for the client
 * to learn, and — the one that matters — a second path-containment check on a
 * delete. The comment on `deleteUploadedFile` records what the hand-written
 * version of that check got wrong.
 *
 * ── The two things that are NOT borrowed ──
 *
 * Authorization: a profile picture is gated on being yourself, and there is no
 * "yourself" for an organization. It is `organization.manage.own` plus
 * `canManage`, the same two layers as every other write in this file.
 *
 * `fit: 'contain'` rather than `cover`, on a white ground. A person's avatar is
 * a face and cropping to a square is right; a club's logo is frequently wide,
 * and entropy-cropping a wordmark cuts the middle out of the name. Letterboxing
 * a logo is ugly in the worst case; cropping one is illegible.
 */
router.post('/api/organizations/:key/image', authenticateToken, requireCap('organization.manage.own'), receiveAvatar, async (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return undefined;
  if (!canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only a manager of this organization can change its image.', code: 'not_manager' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image provided.', code: 'no_file' });

  /* Decoded before anything is written, and a bad image answered as a 400 —
     the same two-pass reasoning the profile picture handler gives: "these bytes
     are not an image" is the caller's mistake and "the disk is full" is ours,
     and telling them apart by inspecting an error message is the fragile thing
     being avoided. */
  let decoded;
  try {
    decoded = await sharp(req.file.buffer).metadata();
  } catch {
    decoded = null;
  }
  if (!decoded?.format) {
    return res.status(400).json({
      error: 'That file could not be read as an image. Choose a JPEG, PNG, WebP or GIF.',
      code: 'unsupported_media_type',
    });
  }

  try {
    const previous = db.prepare('SELECT image_url FROM organizations WHERE id = ?').get(row.id)?.image_url;

    const filename = `org-${row.id}-${Date.now()}.webp`;
    await sharp(req.file.buffer)
      .resize(400, 400, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .webp({ quality: 82 })
      .toFile(path.join(AVATAR_UPLOADS_DIR, filename));

    const relativeUrl = `/uploads/avatars/${filename}`;
    db.prepare('UPDATE organizations SET image_url = ?, image_uploaded_at = ?, updated_at = ? WHERE id = ?')
      .run(relativeUrl, new Date().toISOString(), new Date().toISOString(), row.id);

    /* Written before the old one is removed, so a failed unlink leaves an
       orphaned file rather than an organization pointing at nothing. */
    if (previous && previous !== relativeUrl) deleteUploadedFile(previous);

    return res.json({ organization: formatOrganization(db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(row.id)) });
  } catch (err) {
    console.error('Organization image upload error:', err.message);
    return res.status(500).json({ error: 'That image could not be saved.', code: 'upload_failed' });
  }
});

/** Removing it, falling the page back to the emoji and then the glyph. */
router.delete('/api/organizations/:key/image', authenticateToken, requireCap('organization.manage.own'), (req, res) => {
  const row = loadOrganization(req, res);
  if (!row) return undefined;
  if (!canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only a manager of this organization can change its image.', code: 'not_manager' });
  }

  const previous = db.prepare('SELECT image_url FROM organizations WHERE id = ?').get(row.id)?.image_url;
  db.prepare('UPDATE organizations SET image_url = NULL, image_uploaded_at = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), row.id);
  if (previous) deleteUploadedFile(previous);

  return res.json({ organization: formatOrganization(db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(row.id)) });
});

export default router;
