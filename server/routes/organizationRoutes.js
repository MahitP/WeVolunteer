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

export default router;
