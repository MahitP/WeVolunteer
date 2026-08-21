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
import { authenticateToken } from '../utils.js';
import { runInTransaction } from '../db/connectionContext.js';
import { can, requireCap } from '../authz.js';
import { db } from '../db.js';
import { recordAudit } from '../auditLog.js';
import {
  validateOrganization, createOrganization, canManage, canHelpRun, MEMBER_ROLES,
  formatOrganization, uniqueSlug,
} from '../organizations.js';
import { syncOrganizerCapabilities } from '../organizationRoles.js';
import { profileSummary } from '../profileSerializer.js';
import {
  organizationHoursForUser,
  organizationHoursByUser,
  organizationHoursTotal,
  organizationHistoryForUser,
} from '../organizationHours.js';
import path from 'node:path';
import sharp from 'sharp';
import { receiveAvatar, deleteUploadedFile, AVATAR_UPLOADS_DIR } from './profilePictureRoutes.js';
import { notificationService } from '../services/notificationService.js';
import { recordAppealEvent, APPEAL_DECISIONS, validateReasoning } from '../appeals.js';

const router = express.Router();

/** Member and event counts, computed in the same statement as the row. */
const ORG_SELECT = `
  SELECT o.*,
         (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS "memberCount",
         (SELECT COUNT(*) FROM events e WHERE e.organization_id = o.id) AS "eventCount"
  FROM organizations o
`;

/** Loads an organization by slug or id, or answers 404. */
async function loadOrganization(req, res) {
  const key = req.params.key;
  const row = await db.prepare(`${ORG_SELECT} WHERE (o.slug = ? COLLATE nocase OR o.id = ?)`).get(key, key);
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
router.get('/api/organizations', authenticateToken, requireCap('directory.read'), async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const mineOnly = req.query.mine === 'true';

  const rows = mineOnly
    /* `mm.member_role` is selected so the caller can tell the clubs they RUN
       from the ones they merely belong to. Without it every organization on the
       "mine" list looks the same and the page cannot offer Manage on the right
       ones — which is the whole point of that page. */
    ? await db.prepare(`${ORG_SELECT.replace('SELECT o.*', 'SELECT o.*, mm.member_role AS viewer_role')}
        JOIN organization_members mm ON mm.organization_id = o.id AND mm.user_id = ?
        WHERE o.status = 'active' ORDER BY o.name COLLATE nocase LIMIT ? OFFSET ?`)
      .all(req.principal.userId, limit + 1, offset)
    /* `"memberCount"` is QUOTED here because it is quoted where ORG_SELECT
       defines it. PostgreSQL folds an unquoted identifier to lower case, so a
       bare `memberCount` looks for `membercount`, which does not exist — and
       this is an ORDER BY, so the whole query fails rather than sorting oddly.
       SQLite matched it either way, which is why it shipped. */
    : await db.prepare(`${ORG_SELECT} WHERE o.status = 'active'
        ORDER BY "memberCount" DESC, o.name COLLATE nocase LIMIT ? OFFSET ?`)
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
router.get('/api/organizations/:key', authenticateToken, requireCap('directory.read'), async (req, res) => {
  const row = await loadOrganization(req, res);
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
  const mayManage = await canManage(db, row.id, req.principal.userId, {
    hasModerate: can(req.principal, 'organization.moderate'),
  });
  if (row.status !== 'active' && !mayManage) {
    return res.status(404).json({ error: 'No such organization.', code: 'not_found' });
  }

  const members = await db.prepare(`
    SELECT u.id, u.username, u.name, u.avatar, u.profile_picture_url, u.role, u.location,
           m.member_role AS "memberRole", m.joined_at AS "joinedAt"
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.account_status = 'active'
    ORDER BY CASE m.member_role WHEN 'manager' THEN 0 WHEN 'student_organizer' THEN 1 ELSE 2 END, u.name COLLATE nocase
    LIMIT 100
  `).all(row.id);

  /**
   * Upcoming first, then recent past. Cancelled events are excluded: an
   * organization page is a shop window, and an event that is not happening is
   * not something to advertise.
   */
  const events = await db.prepare(`
    SELECT e.id, e.title, e.category, e.location, e.status, e.credits_hours AS "creditsHours",
           e.application_deadline AS "applicationDeadline",
           (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) AS "startsAt"
    FROM events e
    WHERE e.organization_id = ? AND e.status <> 'cancelled'
    ORDER BY "startsAt" DESC
    LIMIT 50
  `).all(row.id);

  const membership = await db.prepare(
    'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(row.id, req.principal.userId);

  /**
   * Hours, scoped to this organization.
   *
   * ── Who sees whose ──
   *
   * The viewer always gets their OWN figure and their own event-by-event
   * history. That is their record; showing somebody their own service discloses
   * nothing.
   *
   * Per-member figures and the organization's totals go to managers only. The
   * justification is narrow and worth stating, because the members here are
   * children: these are hours earned at THIS organization's own events, and a
   * manager is precisely the person whose organization ran them and who
   * confirmed the attendance that created them. It is an aggregation of what
   * they already approved, not a new disclosure.
   *
   * What a manager still does not get is the platform-wide total. A student's
   * service for other organizations is none of this club's business, and the
   * derivation is scoped by `organization_id` so there is no query here that
   * could return it.
   *
   * Ordinary members are given no per-member numbers at all. A roster that
   * ranked classmates by hours is a leaderboard nobody asked for, and on a page
   * about a school club it would read as one.
   */
  const viewerHours = await organizationHoursForUser(db, row.id, req.principal.userId);
  const memberHours = mayManage ? await organizationHoursByUser(db, row.id) : null;

  res.json({
    organization: formatOrganization(row),
    members: members.map(m => ({
      ...profileSummary(m),
      memberRole: m.memberRole,
      joinedAt: m.joinedAt,
      ...(memberHours ? { hours: memberHours.get(m.id)?.hours ?? 0 } : {}),
    })),
    events: events.map(e => ({ ...e, creditsHours: e.creditsHours !== 0 })),
    viewer: {
      isMember: Boolean(membership),
      memberRole: membership?.member_role ?? null,
      /* Computed once, above, where the archived-organization gate also needs
         it — the two must agree, and two calls is two chances for them not to. */
      canManage: mayManage,
      /**
       * "May you post and put events up", which is a WIDER set than `canManage`
       * — it includes the Student Organizers, who can do those two things and
       * none of the manager ones.
       *
       * A separate field rather than something the client derives from
       * `memberRole`, because the client would then be holding its own copy of
       * the rule and would drift from `canHelpRun` the first time either
       * changed. The page renders what the server says it may do.
       */
      /* The capability too, not membership alone. `can()` is what consults
         `principal.withheld`, so a promoted student who has not yet accepted the
         Student Organizer Agreement was shown the composer and met a 403 on
         save — the same defect this file fixed one route over. */
      canPost: can(req.principal, 'organization.post.create')
        && await canHelpRun(db, row.id, req.principal.userId, {
          hasModerate: can(req.principal, 'organization.moderate'),
        }),
      hours: viewerHours.hours,
      events: viewerHours.events,
      history: await organizationHistoryForUser(db, row.id, req.principal.userId),
      /**
       * Whether the viewer is banned from here, and what they can do about it.
       *
       * ── Why the client is told at all ──
       *
       * The ban itself is enforced on the join route and nowhere else — that is
       * the security boundary and it does not move. This exists so the page can
       * stop OFFERING an action the server will refuse: a banned student was
       * shown an ordinary Join button, pressed it, and got an error. The button
       * was not a hole, it was a lie.
       *
       * ── Why the reason travels but the banner's name does not ──
       *
       * A person told they are banned and not told why has nothing to appeal
       * against, so the reason is theirs to see; the schema makes it NOT NULL for
       * that reason. Who pressed the button is a different matter — it is the
       * club's decision rather than an individual's (see the appeals note further
       * down), and naming one manager to the person they excluded invites the
       * conversation to go around the process rather than through it. Managers
       * see it in the moderation list; the subject does not.
       */
      ban: await viewerBanState(row.id, req.principal.userId),
    },
    totals: mayManage ? await organizationHoursTotal(db, row.id) : null,
  });
});

/** Create one. The creator becomes its first manager, in the same transaction. */
router.post('/api/organizations', authenticateToken, requireCap('organization.create'), async (req, res) => {
  const check = validateOrganization(req.body ?? {});
  if (!check.ok) return res.status(400).json({ error: check.error, field: check.field });

  const creator = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.principal.userId);
  let orgId;
  try {
    await runInTransaction(db, async (tx) => {
      orgId = await createOrganization(tx, {
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

  const row = await db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(orgId);
  res.status(201).json({ organization: formatOrganization(row) });
});

/** Edit one. Managers of that organization, or a moderator. */
router.patch('/api/organizations/:key', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return;
  if (!await canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
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
    if (check.value.name !== row.name) { updates.push('slug = ?'); values.push(await uniqueSlug(db, check.value.name)); }
  }
  if (check.value.description !== undefined) { updates.push('description = ?'); values.push(check.value.description); }
  if (check.value.tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(check.value.tags)); }
  /* The emoji mark. `null` clears it, which is why the check is on `undefined`
     and not on truthiness — an organization may go back to having none. */
  if (check.value.avatar !== undefined) { updates.push('avatar = ?'); values.push(check.value.avatar); }
  if (check.value.avatarColor !== undefined) {
    updates.push('avatar_color = ?'); values.push(check.value.avatarColor);
  }
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
  await db.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  res.json({ organization: formatOrganization(await db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(row.id)) });
});

/** Join. Idempotent — tapping Join twice is not an error worth an error page. */
router.post('/api/organizations/:key/membership', authenticateToken, requireCap('organization.join'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return;
  if (row.status !== 'active') {
    return res.status(409).json({ error: 'That organization is no longer accepting members.', code: 'archived' });
  }

  /**
   * A ban is enforced HERE, on the ordinary join path.
   *
   * This is the whole of what a ban means — the client hiding a Join button is
   * a courtesy, and a banned person posting straight to this endpoint is
   * exactly the case the record exists for. `lifted_at IS NULL` is what makes a
   * lifted ban stop applying without deleting the fact that it happened.
   */
  const ban = await db.prepare(`
    SELECT reason FROM organization_bans
    WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
  `).get(row.id, req.principal.userId);
  if (ban) {
    return res.status(403).json({
      error: 'You cannot rejoin this organization while this ban is active.',
      code: 'banned',
      reason: ban.reason,
    });
  }

  await db.prepare(`
    INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
    VALUES (?, ?, 'member', ?)
    ON CONFLICT(organization_id, user_id) DO NOTHING
  `).run(row.id, req.principal.userId, new Date().toISOString());

  res.json({ isMember: true, memberCount: await countMembers(row.id) });
});

/**
 * Leave.
 *
 * The last manager cannot leave. An organization with no manager is one nobody
 * can edit, unarchive, or attach an event to — recoverable only by an
 * administrator, and only if somebody notices. Refusing is a far better answer
 * than silently creating orphans.
 */
router.delete('/api/organizations/:key/membership', authenticateToken, requireCap('organization.join'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return;

  const mine = await db.prepare(
    'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(row.id, req.principal.userId);
  if (!mine) return res.json({ isMember: false, memberCount: await countMembers(row.id) });

  if (mine.member_role === 'manager') {
    const managers = (await db.prepare(
      `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND member_role = 'manager'`
    ).get(row.id)).n;
    if (managers <= 1) {
      return res.status(409).json({
        error: 'You are the only manager. Make somebody else a manager before you leave.',
        code: 'last_manager',
      });
    }
  }

  /* One transaction, for the reason the removal route gives: a throw between
     the two statements would leave somebody who has walked out of the club
     still holding the rank it granted. */
  await runInTransaction(db, async (tx) => {
    await tx.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
      .run(row.id, req.principal.userId);
    /* Walking out of the club you helped run takes the rank with you. */
    await syncOrganizerCapabilities(tx, req.principal.userId, req.principal.userId);
  });
  res.json({ isMember: false, memberCount: await countMembers(row.id) });
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
router.delete('/api/organizations/:key/members/:userId', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return;
  if (!await canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'You do not manage this organization.', code: 'not_manager' });
  }

  const target = await db.prepare(
    'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(row.id, req.params.userId);
  if (!target) {
    return res.status(404).json({ error: 'That person is not a member.', code: 'not_member' });
  }

  if (target.member_role === 'manager') {
    const managers = (await db.prepare(
      `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND member_role = 'manager'`
    ).get(row.id)).n;
    if (managers <= 1) {
      return res.status(409).json({
        error: 'This is the only manager. Make somebody else a manager first.',
        code: 'last_manager',
      });
    }
  }

  /**
   * Kick or ban, and the difference is not cosmetic.
   *
   * A kick ends a membership; they can join again. A ban is a standing decision
   * that they may not, and it needs a reason — enforced here AND by the column,
   * because a person told they are banned and not told why has nothing to
   * appeal against.
   *
   * Defaulting to `kick` matters: a client that omits the field, or an older one
   * that has never heard of banning, must get the reversible action. The
   * permanent one has to be asked for by name.
   */
  const mode = req.body?.mode === 'ban' ? 'ban' : 'kick';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  if (mode === 'ban') {
    if (!reason) {
      return res.status(400).json({
        error: 'Give a reason for the ban. The person is told what it is, and it is what any appeal is heard against.',
        code: 'reason_required',
      });
    }
    if (reason.length > 1000) {
      return res.status(400).json({ error: 'Keep the reason to 1000 characters or fewer.', code: 'reason_too_long' });
    }
    if (req.params.userId === req.principal.userId) {
      /* Banning yourself would lock you out of an organization you manage and
         leave nobody able to lift it. Leaving is a different route. */
      return res.status(409).json({ error: 'You cannot ban yourself.', code: 'cannot_ban_self' });
    }
  } else if (reason.length > 1000) {
    return res.status(400).json({ error: 'Keep the reason to 1000 characters or fewer.', code: 'reason_too_long' });
  }

  const now = new Date().toISOString();

  await runInTransaction(db, async (tx) => {
    await tx.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
      .run(row.id, req.params.userId);
    /* Inside the transaction with the removal, so a rollback cannot leave the
       capability behind on somebody the club believes it has just removed. */
    await syncOrganizerCapabilities(tx, req.params.userId, req.principal.userId);

    if (mode === 'ban') {
      /* `INSERT OR IGNORE` against the partial unique index: banning somebody
         already banned is the state the caller wanted, not an error. */
      await tx.prepare(`
        INSERT INTO organization_bans (id, organization_id, user_id, banned_by, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (organization_id, user_id) WHERE lifted_at IS NULL DO NOTHING
      `).run(`orgban-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        row.id, req.params.userId, req.principal.userId, reason, now);
    }
  });

  /**
   * On the audit log, not only in a notification to the person affected.
   *
   * The notification below tells the subject. It does not produce a record the
   * club or an administrator can read later — so "who banned this student, and
   * when" was answerable only by reading `organization_bans` directly, and a
   * plain removal left no trace at all. Both are moderation actions taken over
   * somebody else's participation, and both belong in the same log as every
   * other one.
   */
  await recordAudit(db, {
    adminId: req.principal.userId,
    action: mode === 'ban' ? 'ORGANIZATION_BANNED' : 'ORGANIZATION_MEMBERSHIP_REMOVED',
    targetUserId: req.params.userId,
    /* The reason is already stored on the ban row, where an appeal is heard
       against it. It is repeated here so the audit line stands on its own. */
    details: mode === 'ban'
      ? `Banned from ${row.name} (${row.id}): ${reason}`
      : `Removed from ${row.name} (${row.id})`,
  });

  /**
   * Told, and told why.
   *
   * Dispatched outside the transaction: a notification that fails must not roll
   * back a removal the manager has already been shown as done.
   */
  const actor = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.principal.userId);
  await notificationService.dispatch(
    mode === 'ban' ? 'ORGANIZATION_BANNED' : 'ORGANIZATION_MEMBERSHIP_REMOVED',
    {
      organizationName: row.name,
      organizationSlug: row.slug,
      organizationId: row.id,
      actorName: actor?.name || 'A manager',
      reason: reason || null,
    },
    req.params.userId,
    `org-${mode}:${row.id}:${now}`,
  );

  res.json({
    userId: req.params.userId,
    isMember: false,
    banned: mode === 'ban',
    memberCount: await countMembers(row.id),
  });
});

/** Promote or demote a member. Managers only. */
router.patch('/api/organizations/:key/members/:userId', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return;
  if (!await canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'You do not manage this organization.', code: 'not_manager' });
  }
  const memberRole = req.body?.memberRole;
  if (!MEMBER_ROLES.includes(memberRole)) {
    return res.status(400).json({
      error: `Role must be one of: ${MEMBER_ROLES.join(', ')}.`,
      field: 'memberRole',
    });
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
   *
   * The condition is "the new role is not manager", NOT "the new role is
   * member". When `student_organizer` arrived, a check written as
   * `memberRole === 'member'` would have let the sole manager step down to it
   * and leave the club with nobody who can ban, archive or promote — the exact
   * hole this guard exists to close, reopened by a third value being added
   * somewhere else.
   */
  if (memberRole !== 'manager') {
    const current = await db.prepare(
      'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
    ).get(row.id, req.params.userId);
    if (current?.member_role === 'manager') {
      const managers = (await db.prepare(
        `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND member_role = 'manager'`
      ).get(row.id)).n;
      if (managers <= 1) {
        return res.status(409).json({
          error: 'This is the only manager. Make somebody else a manager first.',
          code: 'last_manager',
        });
      }
    }
  }

  /* The rank and the capabilities it confers move together or not at all. A
     throw in between would leave a demoted member holding what the rank gave
     them, which is the one state this pair exists to make impossible. */
  let changes = 0;
  await runInTransaction(db, async (tx) => {
    changes = (await tx.prepare(
      'UPDATE organization_members SET member_role = ? WHERE organization_id = ? AND user_id = ?'
    ).run(memberRole, row.id, req.params.userId)).changes;
    if (!changes) return;

    /**
     * The capabilities are recomputed from the membership table, not derived
     * from `memberRole` here — somebody demoted in this club may still be a
     * Student Organizer in another, and reading the new value alone would strip
     * a rank they still hold somewhere else.
     */
    await syncOrganizerCapabilities(tx, req.params.userId, req.principal.userId);
  });
  if (!changes) return res.status(404).json({ error: 'That person is not a member.', code: 'not_member' });

  /**
   * Recorded, because of what the rank gives.
   *
   * A manager handing somebody `student_organizer` hands them the roster of
   * every applicant to the club's events — names, and on the CSV export, email
   * addresses — plus the ability to write credited hours. Both people are
   * usually students. "Who gave this person access, and when" had no answer
   * anywhere before this line.
   */
  await recordAudit(db, {
    adminId: req.principal.userId,
    action: 'ORGANIZATION_RANK_CHANGED',
    targetUserId: req.params.userId,
    details: `Set rank to ${memberRole} in ${row.name} (${row.id})`,
  });

  res.json({ userId: req.params.userId, memberRole });
});

async function countMembers(organizationId) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?')
    .get(organizationId)).n;
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
router.get('/api/organizations/:key/announcements', authenticateToken, requireCap('directory.read'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return undefined;

  const announcements = await db.prepare(`${ANNOUNCEMENT_SELECT} WHERE a.organization_id = ? ORDER BY a.created_at DESC LIMIT 100`)
    .all(row.id);
  if (announcements.length === 0) return res.json({ announcements: [] });

  const placeholders = announcements.map(() => '?').join(',');
  const replyRows = await db.prepare(`
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
router.post('/api/organizations/:key/announcements', authenticateToken, requireCap('organization.post.create'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return undefined;
  if (!await canHelpRun(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only somebody who helps run this organization can post announcements.', code: 'not_manager' });
  }
  /**
   * An archived organization is out of circulation, and that has to include
   * posting as it.
   *
   * Joining refuses an archived club and event creation refuses one, so this
   * was the last surface where an archived organization could still speak —
   * and notify its members, who were told the club had been wound up. Editing
   * and deleting existing announcements are deliberately still allowed: taking
   * something down after archiving is exactly what a manager might need to do.
   */
  if (row.status !== 'active') {
    return res.status(409).json({ error: 'This organization is archived.', code: 'organization_archived' });
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
  await db.prepare(`
    INSERT INTO organization_announcements (id, organization_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, row.id, req.principal.userId, body, new Date().toISOString());

  const created = await db.prepare(`${ANNOUNCEMENT_SELECT} WHERE a.id = ?`).get(id);
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
router.patch('/api/organizations/:key/announcements/:announcementId', authenticateToken, requireCap('organization.post.manage'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return undefined;
  if (!await canHelpRun(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only somebody who helps run this organization can edit announcements.', code: 'not_manager' });
  }

  const existing = await db.prepare('SELECT * FROM organization_announcements WHERE id = ? AND organization_id = ?')
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
  await db.prepare(`UPDATE organization_announcements SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = await db.prepare(`${ANNOUNCEMENT_SELECT} WHERE a.id = ?`).get(existing.id);
  return res.json({ announcement: formatAnnouncement(updated) });
});

/** Removing an announcement. Its replies cascade with it. */
router.delete('/api/organizations/:key/announcements/:announcementId', authenticateToken, requireCap('organization.post.manage'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return undefined;
  if (!await canHelpRun(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only somebody who helps run this organization can delete announcements.', code: 'not_manager' });
  }

  const result = await db.prepare('DELETE FROM organization_announcements WHERE id = ? AND organization_id = ?')
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
router.post('/api/organizations/:key/announcements/:announcementId/replies', authenticateToken, requireCap('organization.join'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return undefined;

  const announcement = await db.prepare('SELECT * FROM organization_announcements WHERE id = ? AND organization_id = ?')
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

  const isMember = await db.prepare('SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?')
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
  await db.prepare(`
    INSERT INTO organization_announcement_replies (id, announcement_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, announcement.id, req.principal.userId, body, new Date().toISOString());

  const created = await db.prepare(`
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
  const row = await loadOrganization(req, res);
  if (!row) return undefined;
  if (!await canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
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
    const previous = (await db.prepare('SELECT image_url FROM organizations WHERE id = ?').get(row.id))?.image_url;

    const filename = `org-${row.id}-${Date.now()}.webp`;
    await sharp(req.file.buffer)
      .resize(400, 400, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .webp({ quality: 82 })
      .toFile(path.join(AVATAR_UPLOADS_DIR, filename));

    const relativeUrl = `/uploads/avatars/${filename}`;
    await db.prepare('UPDATE organizations SET image_url = ?, image_uploaded_at = ?, updated_at = ? WHERE id = ?')
      .run(relativeUrl, new Date().toISOString(), new Date().toISOString(), row.id);

    /* Written before the old one is removed, so a failed unlink leaves an
       orphaned file rather than an organization pointing at nothing. */
    if (previous && previous !== relativeUrl) deleteUploadedFile(previous);

    return res.json({ organization: formatOrganization(await db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(row.id)) });
  } catch (err) {
    console.error('Organization image upload error:', err.message);
    return res.status(500).json({ error: 'That image could not be saved.', code: 'upload_failed' });
  }
});

/** Removing it, falling the page back to the emoji and then the glyph. */
router.delete('/api/organizations/:key/image', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return undefined;
  if (!await canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    return res.status(403).json({ error: 'Only a manager of this organization can change its image.', code: 'not_manager' });
  }

  const previous = (await db.prepare('SELECT image_url FROM organizations WHERE id = ?').get(row.id))?.image_url;
  await db.prepare('UPDATE organizations SET image_url = NULL, image_uploaded_at = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), row.id);
  if (previous) deleteUploadedFile(previous);

  return res.json({ organization: formatOrganization(await db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(row.id)) });
});

/**
 * ══ The organization's appeal inbox ══════════════════════════════════════════
 *
 * ── Why the ORGANIZATION owns this, not the manager who banned somebody ──
 *
 * A ban is issued by one person and is a decision of the club. Routing the
 * appeal back to whoever pressed the button asks the person being complained
 * about to judge the complaint, and it breaks outright the moment that manager
 * leaves, goes on holiday, or is the reason for the appeal. So every manager of
 * the organization sees it, the same set that could have issued the ban.
 *
 * A single-manager club still works: that manager sees it, because they are one
 * of "every manager" rather than a special case. Conflict of interest is
 * surfaced rather than enforced here — with one manager there is nobody else to
 * hand it to, and refusing would leave the appellant with no route at all.
 *
 * ── Why there is no new table ──
 *
 * These are ordinary `appeals` rows with `subject = 'organization_ban'` and
 * `subject_ref` holding the organization id, filed through `POST /api/appeals`
 * like every other appeal. They keep the appeals table's write-once triggers,
 * its append-only `appeal_events` history, and the vocabulary in `appeals.js`.
 * A parallel org-appeal system would have been a second thing to keep correct.
 */

/**
 * The viewer's own ban, and the state of any appeal against it.
 *
 * Returns `null` for the ordinary case — not banned — so the client's check is
 * `viewer.ban && …` and an absent field cannot be mistaken for a ban.
 *
 * The appeal is looked up by `(user, subject, subject_ref)`, which is exactly the
 * key `POST /api/appeals` enforces one-live-appeal-per on, so "is there an appeal
 * open" is answered by the same rule that decides whether another may be filed.
 * Without that agreement the button would offer an appeal the appeals route would
 * then refuse as a duplicate.
 */
async function viewerBanState(organizationId, userId) {
  if (!userId) return null;

  const ban = await db.prepare(`
    SELECT id, reason, created_at
      FROM organization_bans
     WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
  `).get(organizationId, userId);
  if (!ban) return null;

  /* Only an appeal filed against THIS ban. An appeal about an older, already
     lifted ban must not disable the button for a new one — that would leave
     somebody banned a second time with no way to say anything about it. */
  const appeal = await db.prepare(`
    SELECT id, status, decision, created_at
      FROM appeals
     WHERE user_id = ? AND subject = 'organization_ban' AND subject_ref = ?
       AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT 1
  `).get(userId, organizationId, ban.created_at);

  return {
    reason: ban.reason,
    bannedAt: ban.created_at,
    appeal: appeal
      ? {
        status: appeal.status,
        decision: appeal.decision ?? null,
        submittedAt: appeal.created_at,
        /* The one thing the button needs: may another be filed? Derived here
           rather than in the client so both ends read the same rule. */
        pending: appeal.status === 'open' || appeal.status === 'reviewing',
      }
      : null,
  };
}

/** The organization behind a request, or a refusal. Shared by the two routes below. */
async function loadManagedOrganization(req, res) {
  const row = await loadOrganization(req, res);
  if (!row) return null;
  if (!await canManage(db, row.id, req.principal.userId, { hasModerate: can(req.principal, 'organization.moderate') })) {
    res.status(403).json({ error: 'You do not manage this organization.', code: 'not_manager' });
    return null;
  }
  return row;
}

/**
 * GET the appeals against this organization's bans.
 *
 * Scoped by `subject_ref` to THIS organization, so a manager of one club cannot
 * read another's — the capability says "may manage an organization", and
 * `canManage` says which one.
 */
router.get('/api/organizations/:key/appeals', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  const appeals = await db.prepare(`
    SELECT a.id, a.user_id, a.statement, a.status, a.decision, a.reasoning,
           a.created_at, a.updated_at, a.decided_at,
           a.reviewer_id, a.reviewer_name_snapshot,
           u.name AS appellant_name, u.username AS appellant_username,
           b.reason AS ban_reason, b.created_at AS banned_at, b.lifted_at,
           banner.name AS banned_by_name
      FROM appeals a
      JOIN users u ON u.id = a.user_id
      /* The ACTIVE ban only. Migration 044's uniqueness is partial — unique on
         (organization, user) only WHERE lifted_at IS NULL — so lifted bans
         accumulate freely. Without this the join multiplied: one appeal became
         one row per historical ban, each copy carrying a different reason, and
         the reviewer could be shown a reason belonging to a ban that was lifted
         months ago. */
      LEFT JOIN organization_bans b
        ON b.organization_id = a.subject_ref AND b.user_id = a.user_id
       AND b.lifted_at IS NULL
      LEFT JOIN users banner ON banner.id = b.banned_by
     WHERE a.subject = 'organization_ban' AND a.subject_ref = ?
     ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
              a.created_at DESC
     LIMIT 200
  `).all(row.id);

  res.json({
    /* `Promise.all` + an async callback: the issuer lookup below is a query, so
       a bare `.map` would put pending promises in the response body. */
    appeals: await Promise.all(appeals.map(async (a) => ({
      id: a.id,
      status: a.status,
      decision: a.decision,
      reasoning: a.reasoning,
      statement: a.statement,
      createdAt: a.created_at,
      decidedAt: a.decided_at,
      decidedBy: a.reviewer_name_snapshot,
      /* The person appealing, named — a manager cannot weigh an appeal about
         somebody they cannot identify. Nothing beyond name and handle: this is
         not a profile view. */
      appellant: { name: a.appellant_name, username: a.appellant_username },
      /* The ban being appealed. The reason is disclosed to managers because it
         is the thing under review and they could read it on the member list
         anyway; it is never sent to anybody else. */
      ban: {
        reason: a.ban_reason,
        bannedAt: a.banned_at,
        bannedBy: a.banned_by_name,
        active: a.ban_reason != null && a.lifted_at == null,
      },
      /* Surfaced, not enforced. A one-manager club has nobody to hand it to,
         and refusing would leave the appellant with no route at all. */
      /**
       * The ACTIVE ban's issuer.
       *
       * This read every ban for the pair and took whichever came first, which
       * is the OLDEST. Where an earlier ban had been lifted and a different
       * manager issued the current one, the flag inverted: the manager actually
       * being complained about was told they were uninvolved, and an uninvolved
       * one was told they were the issuer. Since this route surfaces the
       * conflict rather than enforcing it, that flag is the whole safeguard.
       */
      /* Parenthesised: `await x.get(…)?.banned_by` would await the PROPERTY of
         a pending promise, which is `undefined`, and every manager would be
         told they did not issue the ban. */
      youIssuedThisBan: (await db.prepare(`
        SELECT banned_by FROM organization_bans
         WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
      `).get(row.id, a.user_id))?.banned_by === req.principal.userId,
    }))),
  });
});

/**
 * Decide one.
 *
 * `reversed` lifts the ban; `stands` leaves it exactly as it was. Both are
 * recorded, and neither deletes anything: the ban row keeps its history and
 * gains `lifted_at`/`lifted_by` rather than disappearing, because "banned, then
 * unbanned" is what an appeal produces and erasing it loses the outcome.
 */
router.post('/api/organizations/:key/appeals/:appealId/decision', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  const { decision } = req.body || {};
  if (!APPEAL_DECISIONS.includes(decision)) {
    return res.status(400).json({
      error: 'Unknown decision.', code: 'decision_invalid', allowed: APPEAL_DECISIONS,
    });
  }

  /* The same floor the platform queue applies. An appellant told only "denied"
     has been given an outcome without a reason, which is the complaint the
     appeal was about. */
  const reasoning = validateReasoning(req.body?.reasoning);
  if (!reasoning.ok) {
    return res.status(400).json({ error: reasoning.error, code: 'reasoning_invalid' });
  }

  /* Scoped in the WHERE clause, not checked afterwards: an appeal id from
     another organization simply does not match, so it cannot be decided by
     guessing an id. */
  const appeal = await db.prepare(`
    SELECT id, user_id, status FROM appeals
     WHERE id = ? AND subject = 'organization_ban' AND subject_ref = ?
  `).get(req.params.appealId, row.id);
  if (!appeal) {
    return res.status(404).json({ error: 'No such appeal for this organization.', code: 'appeal_not_found' });
  }

  /**
   * Nobody decides their own appeal.
   *
   * `appeals.js` declares `self` NEVER_OVERRIDABLE, and its header records the
   * audit that found somebody deciding an appeal they were party to. This route
   * had no such check, and the path was reachable: `organization.moderate` is
   * held by admin and super_admin, `canManage` returns true for those without
   * consulting membership at all, and nothing stops an admin who is a club
   * member from being banned. They could file the appeal and then grant it.
   *
   * Refused outright rather than surfaced, unlike the issuer conflict below it:
   * a club with one manager has nobody else to hand an appeal to, which is why
   * that one is a warning — but "somebody else" always exists here, because the
   * appellant is by definition not the only person who could decide.
   */
  if (appeal.user_id === req.principal.userId) {
    return res.status(403).json({
      error: 'You cannot decide your own appeal.', code: 'self_review',
    });
  }

  /* Already final. Answered 409 rather than silently re-deciding, so two
     managers pressing at once cannot overwrite each other's reasoning. */
  if (appeal.status === 'resolved') {
    return res.status(409).json({ error: 'That appeal has already been decided.', code: 'already_decided' });
  }

  const now = new Date().toISOString();
  const actor = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.principal.userId);

  try {
    await runInTransaction(db, async (tx) => {
      /* Guarded on the status we read, so a concurrent decision loses rather
         than both appearing to win. */
      const { changes } = await tx.prepare(`
        UPDATE appeals
           SET status = 'resolved', decision = ?, reasoning = ?, reviewer_id = ?,
               reviewer_name_snapshot = COALESCE(reviewer_name_snapshot, ?),
               decided_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('open', 'reviewing')
      `).run(decision, reasoning.value, req.principal.userId, actor?.name ?? null, now, now, appeal.id);
      if (changes === 0) throw Object.assign(new Error('raced'), { code: 'already_decided' });

      if (decision === 'reversed') {
        /* Lifted, not deleted — and only if still active, so a second reversal
           cannot rewrite who lifted it or when. */
        /**
         * Only a ban that PREDATES the appeal.
         *
         * `subject_ref` records the organization, not the individual ban, so an
         * appeal does not name what it contests. Without the date bound, this
         * sequence lifted the wrong thing: banned, appealed, ban lifted by
         * hand, rejoined, banned again by somebody else for something else —
         * and then a manager deciding the old, still-open appeal lifted the NEW
         * ban, which nobody had appealed and nobody had reviewed. The reviewer's
         * screen showed them a statement about the first one.
         */
        await tx.prepare(`
          UPDATE organization_bans
             SET lifted_at = ?, lifted_by = ?
           WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
             AND created_at <= (SELECT created_at FROM appeals WHERE id = ?)
        `).run(now, req.principal.userId, row.id, appeal.user_id, appeal.id);
      }

      await recordAppealEvent(tx, {
        appealId: appeal.id,
        actorId: req.principal.userId,
        actorRole: 'organization_manager',
        action: 'decided',
        fromStatus: appeal.status,
        toStatus: 'resolved',
        note: `${decision}: ${reasoning.value}`,
      });
    });
  } catch (err) {
    if (err.code === 'already_decided') {
      return res.status(409).json({ error: 'That appeal has already been decided.', code: 'already_decided' });
    }
    console.error('Failed to decide organization appeal:', err);
    return res.status(500).json({ error: 'We could not record that decision. Please try again.' });
  }

  /* The appeal's own history is in `appeal_events`, which is where a question
     about the appeal belongs. This entry is for the other question — "what
     moderation has happened in this club" — which reads the audit log and would
     otherwise show the ban with no outcome beside it. */
  await recordAudit(db, {
    adminId: req.principal.userId,
    action: decision === 'reversed' ? 'ORGANIZATION_BAN_APPEAL_REVERSED' : 'ORGANIZATION_BAN_APPEAL_STANDS',
    targetUserId: appeal.user_id,
    details: `Appeal against the ban in ${row.name} (${row.id}) ${decision === 'reversed' ? 'upheld; ban lifted' : 'denied; ban stands'}`,
  });

  /* Outside the transaction: a notification that fails must not roll back a
     decision the manager has already been shown as made. */
  await notificationService.dispatch(
    decision === 'reversed' ? 'ORGANIZATION_BAN_APPEAL_REVERSED' : 'ORGANIZATION_BAN_APPEAL_STANDS',
    {
      organizationName: row.name,
      organizationSlug: row.slug,
      reasoning: reasoning.value,
      reviewerName: actor?.name || 'A manager',
    },
    appeal.user_id,
    `org-appeal:${appeal.id}`,
  );

  res.json({ id: appeal.id, status: 'resolved', decision });
});

/**
 * Who is currently banned from this organization.
 *
 * ── Why this is its own route rather than part of the roster ──
 *
 * The roster answers "who is in this club". A banned person is precisely not,
 * and folding them in would put somebody the club has excluded into every list
 * that walks the membership — the events page, the hours totals, the member
 * count. This is a moderation view, read by the moderation screen, and it is the
 * only place the two meet.
 *
 * ── What a manager is shown, and what they are not ──
 *
 * Name, username and avatar so the person is identifiable; when, why, and who
 * issued it, because a standing decision that nobody can attribute is one nobody
 * can review; and the appeal state so the same screen answers "is this waiting on
 * me". Nothing else about the account travels: `profileSummary` is the shared
 * allowlist every other surface uses, so a new column on `users` does not become
 * visible here by accident.
 *
 * Lifted bans are deliberately excluded. "Currently banned" is the question this
 * answers, and a history of every ban ever lifted would bury it — the record of a
 * lifted ban survives in the table and in the audit log, which is where a
 * question about the past belongs.
 */
router.get('/api/organizations/:key/bans', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  /* `u.role` and `u.location` are selected because `profileSummary` reads them —
     `distinction` is derived from the role. Omitting it rendered every banned
     account as an ordinary one, a partner organization included. */
  const bans = await db.prepare(`
    SELECT b.id, b.user_id, b.reason, b.created_at, b.banned_by,
           u.name, u.username, u.avatar, u.avatar_color, u.profile_picture_url,
           u.role, u.location,
           issuer.name AS banned_by_name
      FROM organization_bans b
      JOIN users u ON u.id = b.user_id
      LEFT JOIN users issuer ON issuer.id = b.banned_by
     WHERE b.organization_id = ? AND b.lifted_at IS NULL
     ORDER BY b.created_at DESC
  `).all(row.id);

  /* One query for every appeal in this organization rather than one per banned
     person: the list is small but the N+1 shape is what turns a moderation
     screen into a slow one the first time a club bans twenty people. */
  const appeals = await db.prepare(`
    SELECT user_id, status, decision, created_at
      FROM appeals
     WHERE subject = 'organization_ban' AND subject_ref = ?
     ORDER BY created_at DESC
  `).all(row.id);
  const latestAppeal = new Map();
  for (const a of appeals) if (!latestAppeal.has(a.user_id)) latestAppeal.set(a.user_id, a);

  res.json({
    bans: bans.map(b => {
      const appeal = latestAppeal.get(b.user_id);
      /* Only an appeal filed against the ban that is still standing — the same
         bound the decision route applies when it lifts one. */
      const relevant = appeal && appeal.created_at >= b.created_at ? appeal : null;
      return {
        id: b.id,
        user: profileSummary({
          id: b.user_id,
          name: b.name,
          username: b.username,
          avatar: b.avatar,
          avatar_color: b.avatar_color,
          profile_picture_url: b.profile_picture_url,
          role: b.role,
          location: b.location,
        }),
        reason: b.reason,
        bannedAt: b.created_at,
        bannedBy: b.banned_by ? { id: b.banned_by, name: b.banned_by_name } : null,
        appeal: relevant
          ? {
            status: relevant.status,
            decision: relevant.decision ?? null,
            submittedAt: relevant.created_at,
            pending: relevant.status === 'open' || relevant.status === 'reviewing',
          }
          : null,
      };
    }),
  });
});

/**
 * Lift a ban directly, with no appeal involved.
 *
 * ── Why this exists alongside the appeal decision route ──
 *
 * An appeal is ONE route to being unbanned, not the only one. A manager who bans
 * the wrong person, or who simply changes their mind, must be able to undo it
 * without requiring the person they excluded to first write a formal statement
 * asking to be let back in. Making the subject perform an appeal for a mistake
 * the club made is a bad rule, and it also produces a worse record: an appeal
 * "granted" where nothing was ever contested.
 *
 * ── Why it is a lift and not a delete ──
 *
 * Same reason as everywhere else this table is touched. `lifted_at` is set and
 * the row stays: that somebody was banned and then unbanned is the fact, and
 * deleting the row would erase the ban along with its reversal.
 *
 * ── What it deliberately does NOT do ──
 *
 * It does not restore membership. A ban removed the membership row and lifting
 * it means "you may join again", not "you are back in" — re-adding somebody to a
 * club without their asking would be the mirror of the original problem. They
 * join through the ordinary route, which now stops refusing them.
 *
 * An open appeal against the lifted ban is left open on purpose rather than
 * auto-resolved. Deciding it is a separate act with a reasoning attached, and
 * silently closing it here would file a decision nobody made under a manager's
 * name. The moderation screen shows the appeal is still waiting.
 */
router.post('/api/organizations/:key/bans/:userId/lift', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  const now = new Date().toISOString();

  /* The UPDATE is the authorization on the ban's existence as well as the write:
     `lifted_at IS NULL` means a second press, or two managers pressing at once,
     cannot rewrite who lifted it or when. `changes === 0` is the honest 404. */
  const { changes } = await db.prepare(`
    UPDATE organization_bans
       SET lifted_at = ?, lifted_by = ?
     WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
  `).run(now, req.principal.userId, row.id, req.params.userId);

  if (changes === 0) {
    return res.status(404).json({
      error: 'That person is not currently banned from this organization.',
      code: 'not_banned',
    });
  }

  await recordAudit(db, {
    adminId: req.principal.userId,
    action: 'ORGANIZATION_BAN_LIFTED',
    targetUserId: req.params.userId,
    details: `Lifted the ban in ${row.name} (${row.id}) without an appeal`,
  });

  /* Outside no transaction to roll back, but still after the write: a
     notification that fails must not make a completed unban look failed. */
  const actor = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.principal.userId);
  await notificationService.dispatch(
    'ORGANIZATION_BAN_LIFTED',
    {
      organizationName: row.name,
      organizationSlug: row.slug,
      organizationId: row.id,
      actorName: actor?.name || 'A manager',
    },
    req.params.userId,
    `org-unban:${row.id}:${now}`,
  );

  res.json({ userId: req.params.userId, banned: false, liftedAt: now });
});

export default router;
