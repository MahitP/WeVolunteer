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
import { isUniqueViolation } from '../db/dialectSql.js';
import { can, requireCap } from '../authz.js';
import { db } from '../db.js';
import { recordAudit } from '../auditLog.js';
import {
  validateOrganization, createOrganization, canManage, canHelpRun, MEMBER_ROLES,
  memberRoleOf, formatOrganization, publicOrganizationSnapshot, canInvite, uniqueSlug,
  handleAvailable, publicOrganizationByHandle, organizationByKey,
} from '../organizations.js';
import { joinAffordance, affordanceAdmits, normaliseVisibility } from '../organizationPolicy.js';
import {
  createShareLink, revokeShareLink, rotateShareLink, renameShareLink, setShareLinkExpiry,
  shareLinksFor, shareLinkById, primaryShareLink, liveLinkCount, recordShareLinkUse,
  resolveShareToken, openingLinkId, shareLinkPath, linkState, linkIsLive,
  validateLabel, SOFT_MAX_LIVE_LINKS,
} from '../organizationShareLinks.js';
import {
  inviteUser, resolveInvitation, pendingInvitationFor, pendingInvitations,
  pendingInvitationCount, acceptInvitationOnJoin, expireLapsedInvitations, invitableUser,
  NOTE_MAX,
} from '../organizationInvitations.js';
import { validateHandle, normaliseHandle } from '../organizationHandles.js';
import {
  requestToJoin, withdrawRequest, retireRequestOnJoin, pendingRequestFor,
  pendingRequests, pendingRequestCount, decideRequest, requestSubject,
  REQUEST_DECISIONS, validateMessage,
} from '../organizationJoinRequests.js';
import { joinAttemptLimiter } from '../organizationLimiters.js';
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
import {
  receiveAvatar, deleteUploadedFile, AVATAR_UPLOADS_DIR,
  ALLOWED_IMAGE_FORMATS, ALLOWED_IMAGE_FORMAT_LABEL, MAX_IMAGE_INPUT_PIXELS,
} from './profilePictureRoutes.js';
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

/**
 * Loads an organization by handle or id, or answers 404.
 *
 * ── Why the `@` is stripped here ──
 *
 * The canonical public address is `/organizations/@robotics`, and the client
 * passes the segment through verbatim so that one API route serves both the
 * canonical form and every link made before it existed. The `@` is punctuation
 * the URL adds — `organizations.slug` stores `robotics` — exactly as
 * `users.username` is stored bare and rendered `@name`, and for the same reason:
 * two spellings of one handle in the column would be two rows the unique index
 * cannot see are the same.
 *
 * The id branch stays, because notification payloads and audit rows written
 * before handles existed name organizations by id and must keep resolving.
 */
async function loadOrganization(req, res) {
  /* `organizationByKey` carries the argument for why this is two lookups and
     not one `slug = ? OR id = ?`, and it lives in `organizations.js` because
     that module receives a handle — see `db.accessSurface.test.js`. */
  const row = await organizationByKey(db, req.params.key);
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

  const membership = await db.prepare(
    'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(row.id, req.principal.userId);

  /**
   * The roster goes to the club, not to the platform.
   *
   * ── What this changed, and why it had to ──
   *
   * This query used to run for every reader holding `directory.read`, which is
   * every signed-in account except `partner`. So any account could open any
   * organization and read up to a hundred of its members: on this platform, a
   * named list of children belonging to a club the reader has nothing to do
   * with. Each row went through `profileSummary`, so no field leaked that a
   * profile would have withheld — but the LIST is itself the disclosure, and no
   * per-field allowlist can answer that.
   *
   * Members, managers and moderators see it. Everybody else gets
   * `organization.memberCount`, which is already on the payload, names nobody,
   * and is what actually answers "is this club real and how big is it" for
   * somebody deciding whether to join.
   *
   * A manager who is not a member cannot occur (managing IS a membership row),
   * but `mayManage` is included because `organization.moderate` bypasses
   * membership and an administrator reviewing a club needs to see who is in it.
   */
  const mayReadRoster = Boolean(membership) || mayManage;

  const members = mayReadRoster ? await db.prepare(`
    SELECT u.id, u.username, u.name, u.avatar, u.avatar_color, u.profile_picture_url,
           u.role, u.location,
           m.member_role AS "memberRole", m.joined_at AS "joinedAt"
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.account_status = 'active'
    ORDER BY CASE m.member_role WHEN 'manager' THEN 0 WHEN 'student_organizer' THEN 1 ELSE 2 END, u.name COLLATE nocase
    LIMIT 100
  `).all(row.id) : [];

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

  const organization = formatOrganization(row);
  const ban = await viewerBanState(row.id, req.principal.userId);
  const joinRequest = await pendingRequestFor(db, row.id, req.principal.userId);
  /* An invitation addressed to THIS reader. Read before the affordance is
     computed, because holding one is what turns an `invite_required` club into
     one this person may walk into — and unlike a share token, an invitation is
     server-side state, so the server can and does decide it here. */
  const invitation = membership ? null : await pendingInvitationFor(db, row.id, req.principal.userId);

  /**
   * What the primary control should say — decided HERE, not in the browser.
   *
   * There are seven states and which one is right depends on the policy, the
   * membership row, an active ban, the organization's status and the capability.
   * A client computing that would be holding a second implementation of the
   * membership policy, and the direction it drifts is the one this codebase
   * already names as the failure: the UI offers a button the API rejects.
   *
   * `hasInvite` is FALSE here on purpose. The token is not accepted as a query
   * parameter — a GET carrying it would put a live link into browser history,
   * server logs and anything that prefetches — so a reader holding one is told
   * `invite_required` and the client, which knows it is holding a token for this
   * club, renders Join and sends the token with the press. The server is still
   * the authority: a stale token gets a 403 there and the page reloads into the
   * honest state.
   */
  const affordance = joinAffordance({
    joinPolicy: organization.joinPolicy,
    status: row.status,
    isMember: Boolean(membership),
    isBanned: Boolean(ban),
    hasPendingRequest: Boolean(joinRequest),
    canJoinAtAll: can(req.principal, 'organization.join'),
    /* `isInvited`, not `hasInvite` — a direct invitation, which admits whatever
       the setting says. It is TRUE here where the token is false, because there
       is nothing to keep out of a URL: the invitation is a row naming this
       user, resolved from the session. */
    isInvited: Boolean(invitation),
  });

  const mayInvite = canInvite({
    invitePolicy: organization.invitePolicy,
    memberRole: membership?.member_role ?? null,
    hasModerate: can(req.principal, 'organization.moderate'),
  });

  /**
   * Whether a link EXISTS, never the link itself.
   *
   * The token is handed out by `GET …/share-link` alone, which is one route with
   * one authorization rule. Putting it on the page payload would mean every
   * organization page load carried a credential, to every reader the roster
   * gate lets through, for a control most of them will never open.
   */
  const link = mayInvite ? await primaryShareLink(db, row.id) : null;

  res.json({
    organization,
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
      /* The one canonical description of what this reader may do about
         membership. `policy` travels with it so the page can explain the state
         ("this club admits by invitation") without re-deriving which of the
         three modes produced it. */
      affordance: affordance.action,
      joinPolicy: affordance.policy,
      /* Present only while a request is live, so `viewer.joinRequest` is a fact
         and not a nullable field the page has to interpret. */
      ...(joinRequest ? { joinRequest: { submittedAt: joinRequest.createdAt } } : {}),
      /* May this person pass the link on — the club's `invite_policy` turned
         into a yes or a no by `canInvite`, never re-derived from `memberRole`
         in the browser. Creating and rotating the link is `canManage`, which is
         already on this payload. */
      canInvite: mayInvite,
      shareLink: mayInvite
        ? { exists: Boolean(link), createdAt: link?.createdAt ?? null, label: link?.label ?? null }
        : null,
      /**
       * The invitation this reader holds, if any.
       *
       * Who sent it is NOT on this payload. The note is, because a note written
       * to somebody is for them to read; the inviter's identity would make a
       * declined invitation traceable back to a classmate, and the club — not
       * the individual member who pressed the button — is what is doing the
       * inviting as far as the invitee is concerned.
       */
      ...(invitation
        ? {
          invitation: {
            id: invitation.id,
            message: invitation.message ?? null,
            expiresAt: invitation.expiresAt ?? null,
          },
        }
        : {}),
      /* The badge on the Requests card. A count rather than the queue: the
         queue is its own authenticated route, and a manager who is not looking
         at it should not be paying for it on every page load. */
      pendingRequests: mayManage ? await pendingRequestCount(db, row.id) : null,
      /* The companion badge, on the same rule: a count, not the list. */
      pendingInvitations: mayManage ? await pendingInvitationCount(db, row.id) : null,
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
      ban,
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
        /* All three settings the form offers, PASSED ON. They were validated
           onto `check.value` and then dropped, so a creator who chose "Only
           people signed in" got a club open to the internet and one who chose
           "Invitation only" got a club anybody could walk into. */
        ...(check.value.visibility !== undefined ? { visibility: check.value.visibility } : {}),
        ...(check.value.joinPolicy !== undefined ? { joinPolicy: check.value.joinPolicy } : {}),
        ...(check.value.invitePolicy !== undefined ? { invitePolicy: check.value.invitePolicy } : {}),
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
  }

  /**
   * The handle, changed only when a manager asks for it — never by renaming.
   *
   * ── Why a rename no longer moves the address ──
   *
   * It used to: a rename recomputed the slug, and the form promised as much.
   * That was defensible while the slug was a private convenience and became
   * wrong the moment it was the thing a club prints on a flyer. It was also
   * already breaking three things, none of them theoretical: stored
   * notification payloads bake `/organizations/<slug>` into rows that outlive
   * the rename; `pendingInvite` keys a remembered invitation on the slug, so a
   * rename between opening a link and finishing signup dropped the token; and
   * `?organization=<slug>` filters are the kind of URL people bookmark.
   *
   * So the handle is now edited on purpose or not at all. `organizationHandles.js`
   * carries the argument in full.
   *
   * The refusal on collision is a 409 naming the handle, which is not an
   * enumeration concern: every organization's handle is already in its public
   * URL, and the directory lists them.
   */
  /* Held in a local rather than read back out of `values` by
     `updates.indexOf('slug = ?')`. That worked only because every clause above
     happens to push exactly one value, which is a property nobody maintaining
     this file has any reason to preserve. */
  let newHandle = null;
  if (req.body?.handle !== undefined) {
    const handle = validateHandle(req.body.handle);
    if (!handle.ok) return res.status(400).json({ error: handle.error, field: handle.field });
    if (handle.value !== row.slug) {
      if (!await handleAvailable(db, handle.value, { excluding: row.id })) {
        return res.status(409).json({
          error: 'Another organization already uses that web address.',
          field: 'handle',
          code: 'handle_taken',
        });
      }
      newHandle = handle.value;
      updates.push('slug = ?'); values.push(newHandle);
    }
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
  if (check.value.joinPolicy !== undefined) {
    updates.push('join_policy = ?'); values.push(check.value.joinPolicy);
  }
  if (check.value.invitePolicy !== undefined) {
    updates.push('invite_policy = ?'); values.push(check.value.invitePolicy);
  }
  if (check.value.visibility !== undefined) {
    updates.push('visibility = ?'); values.push(check.value.visibility);
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

  /**
   * The edit, the link it may require, and the record of both — one transaction.
   *
   * ── Why switching to `invite` mints a link here ──
   *
   * A club whose policy is `invite` and which has no link is a club nobody can
   * join, including by the route the setting exists to enable. Leaving that to a
   * second, separate press means the manager's most likely path through the
   * settings screen produces a broken club and no error — the setting saved, and
   * the consequence arrives later, to somebody else.
   *
   * So the link is created in the same transaction as the setting that needs it.
   * A club that already has one keeps it: this mints, it never rotates, because
   * changing the setting must not silently invalidate a link already on a flyer.
   *
   * ── Why the change is audited ──
   *
   * Who may join a club, and who may hand out its address, are exactly the
   * questions somebody asks six months later when a student turns up in a club
   * they should not be in. `recordAudit` never catches, so a failed audit rolls
   * the whole edit back — the same argument the promotion route makes.
   */
  const policyChanged = check.value.joinPolicy !== undefined
    && check.value.joinPolicy !== row.join_policy;
  const inviteChanged = check.value.invitePolicy !== undefined
    && check.value.invitePolicy !== row.invite_policy;
  const visibilityChanged = check.value.visibility !== undefined
    && check.value.visibility !== normaliseVisibility(row.visibility);

  try {
    await runInTransaction(db, async (tx) => {
      await tx.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      if (check.value.joinPolicy === 'invite' && !await primaryShareLink(tx, row.id)) {
        await createShareLink(tx, row.id, { createdBy: req.principal.userId });
        await recordAudit(tx, {
          adminId: req.principal.userId,
          action: 'ORGANIZATION_SHARE_LINK_CREATED',
          details: `Created the invitation link for ${row.name} (@${row.slug}) `
            + 'when switching it to invitation-only.',
        });
      }

      /**
       * One audit row for all three settings, because they answer one question.
       *
       * "Who can get into this club, and who can see it" is what somebody asks
       * six months later when a student turns up in a club they should not be
       * in, or when a parent asks why their child's club is on the open web.
       * Three separate rows for one save would make the answer a join.
       *
       * The handle is written as `@handle`, which is how it appears in the URL
       * a reader would go and check.
       */
      if (policyChanged || inviteChanged || visibilityChanged) {
        const parts = [];
        if (policyChanged) parts.push(`who can join: ${row.join_policy ?? 'open'} to ${check.value.joinPolicy}`);
        if (inviteChanged) parts.push(`who can share the link: ${row.invite_policy ?? 'helpers'} to ${check.value.invitePolicy}`);
        if (visibilityChanged) {
          parts.push(`page visibility: ${normaliseVisibility(row.visibility)} to ${check.value.visibility}`);
        }
        await recordAudit(tx, {
          adminId: req.principal.userId,
          action: 'ORGANIZATION_MEMBERSHIP_POLICY_CHANGED',
          details: `${row.name} (@${row.slug}) — ${parts.join('; ')}.`,
        });
      }

      /* A rename or a handle change is audited on its own, because it is the
         one edit that makes every link anybody already has stop working. */
      if (newHandle) {
        await recordAudit(tx, {
          adminId: req.principal.userId,
          action: 'ORGANIZATION_HANDLE_CHANGED',
          details: `${row.name} moved from @${row.slug} to @${newHandle}. `
            + 'Links to the old address no longer work.',
        });
      }
    });
  } catch (err) {
    /**
     * Two managers claiming the same handle in the same instant.
     *
     * `handleAvailable` is a read, so it cannot be atomic with the write —
     * `idx_organizations_slug` is what actually decides, and the loser arrives
     * here. Answering 500 would tell them the product broke when what happened
     * is that somebody took the address, which is a thing they can act on.
     */
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        error: 'Another organization already uses that web address.',
        field: 'handle',
        code: 'handle_taken',
      });
    }
    console.error('Organization update failed:', err);
    return res.status(500).json({ error: 'Could not save those changes.' });
  }

  res.json({ organization: formatOrganization(await db.prepare(`${ORG_SELECT} WHERE o.id = ?`).get(row.id)) });
});

/**
 * Join. Idempotent — tapping Join twice is not an error worth an error page.
 *
 * ── Where the membership policy is enforced ──
 *
 * Here, and only here. `join_policy` is rendered by the page and validated by
 * the settings form, but this is the boundary: a client that skips the page and
 * posts directly meets exactly the same three refusals. `joinAffordance` is the
 * single function that decides which, so the button the page drew and the answer
 * this route gives are the same computation with the same inputs.
 *
 * ── The token is presented HERE, in the body ──
 *
 * Not carried in a session, not cached against the page load, and not accepted
 * in the query string. Resolving it inside this handler is what makes rotation
 * and revocation instant — there is no window in which a page opened under an
 * old link still holds permission — and it is why a GET never sees it.
 *
 * `openingLinkId` asks whether the token opens THIS organization, not merely
 * whether it resolves to something. A Chess Club link must not admit anybody to
 * the Robotics Club.
 *
 * ── One limiter, keyed on the ACCOUNT ──
 *
 * `joinAttemptLimiter` and deliberately NOT `shareTokenLimiter`, even though
 * this route consumes a token. That one is keyed on the device address, which is
 * right for the public endpoint (there is no principal there) and wrong here: a
 * school leaves the internet from one address, so a teacher sharing a link with
 * a class of thirty would have the students at the back refused — the exact
 * failure `mailLimiter`, `reportLimiter` and `checkinLimiters` all record. This
 * route has a principal, so it is bounded per account instead, which caps a
 * client looping tokens without capping a classroom.
 */
router.post('/api/organizations/:key/membership', authenticateToken, requireCap('organization.join'),
  joinAttemptLimiter, async (req, res) => {
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

  /* Already in? Say so and stop, before the policy gets a chance to refuse
     somebody who is standing inside the club. A club switched to `invite` after
     they joined must not answer their second press with "you need a link". */
  const already = await db.prepare(
    'SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(row.id, req.principal.userId);

  /**
   * Which link, if any, opened the door — resolved before the affordance so the
   * use can be counted against it afterwards.
   *
   * `openingLinkId` asks the scoped question: not "is this a valid token
   * anywhere" but "is this a live link belonging to THIS club". A Chess Club
   * token must not open the Robotics Club, and a revoked or lapsed one must not
   * open anything.
   */
  const token = typeof req.body?.shareToken === 'string' ? req.body.shareToken : null;
  const linkId = already ? null : await openingLinkId(db, row.id, token);
  /* A direct invitation is the other way in. Server-side state naming this
     user, so unlike the token there is nothing for the client to present. */
  const invitation = already ? null : await pendingInvitationFor(db, row.id, req.principal.userId);

  if (!already) {
    const affordance = joinAffordance({
      joinPolicy: row.join_policy,
      status: row.status,
      isMember: false,
      isBanned: false,          /* refused above, with its own message */
      hasPendingRequest: false, /* a pending request does not block a link join */
      canJoinAtAll: true,       /* `requireCap` has already said so */
      /* The two authorities, kept apart. A link is an address and admits only
         where the club says a link is the way in; a direct invitation names
         this person and admits whatever the setting says. Both are re-checked
         HERE, at the moment of the act, rather than trusted from the page load
         — which is what makes revoking a link or withdrawing an invitation take
         effect instantly. See `joinAffordance`. */
      hasInvite: Boolean(linkId),
      isInvited: Boolean(invitation),
    });

    if (!affordanceAdmits(affordance.action)) {
      if (affordance.action === 'request') {
        return res.status(409).json({
          error: 'This organization approves members. Send a request to join and a manager will look at it.',
          code: 'request_required',
        });
      }
      return res.status(403).json({
        error: 'This organization admits members by invitation. Ask somebody in it for the invitation link.',
        code: 'invite_required',
      });
    }
  }

  await runInTransaction(db, async (tx) => {
    await tx.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, 'member', ?)
      ON CONFLICT(organization_id, user_id) DO NOTHING
    `).run(row.id, req.principal.userId, new Date().toISOString());

    /* A request that has been overtaken by events stops waiting for a decision
       nobody now needs to make. `withdrawn` rather than `accepted`, because no
       manager decided it — see `retireRequestOnJoin`. In the same transaction as
       the membership row, so the two cannot disagree. */
    await retireRequestOnJoin(tx, row.id, req.principal.userId);

    /* An invitation that admitted somebody stops being outstanding. Same
       transaction, for the same reason: an accepted invitation still pending
       would be offered back to them on their own page and would count against
       the club's list for ever. */
    if (invitation) await acceptInvitationOnJoin(tx, row.id, req.principal.userId);

    /* And the link that opened the door gets its count. Inside the transaction
       because a counted use with no membership behind it is a lie, and a
       membership with an uncounted use loses the only number this reports. */
    if (linkId) await recordShareLinkUse(tx, row.id, linkId);
  });

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
  /* Allowlisted, not merely decodable. Same reasoning as the profile picture
     path, and imported from it rather than restated: both handlers open-coded a
     truthy `format` check, which is how they came to accept SVG, TIFF, AVIF and
     HEIF while their error messages named four formats. */
  if (!decoded?.format || !ALLOWED_IMAGE_FORMATS.includes(decoded.format)) {
    return res.status(400).json({
      error: `That file could not be read as an image. Choose a ${ALLOWED_IMAGE_FORMAT_LABEL}.`,
      code: 'unsupported_media_type',
    });
  }

  try {
    const previous = (await db.prepare('SELECT image_url FROM organizations WHERE id = ?').get(row.id))?.image_url;

    const filename = `org-${row.id}-${Date.now()}.webp`;
    await sharp(req.file.buffer, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS })
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


/* ──────────────────────────────────────────────────────────────────────────
   The invitation link
   ────────────────────────────────────────────────────────────────────────── */

/**
 * The managers of an organization, for the notification fan-out.
 *
 * One query returning ids, the shape `memberIds` already uses and for the same
 * reason: a request that notified a club of three hundred one query at a time
 * would be three hundred round trips inside the request that filed it. Deleted
 * accounts are excluded here rather than by the notification worker, so the
 * fan-out does not enqueue mail for somebody who is gone.
 */
async function managerIds(handle, organizationId, { excluding = [] } = {}) {
  const rows = await handle.prepare(`
    SELECT m.user_id FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND m.member_role = 'manager'
      AND u.account_status = 'active'
  `).all(organizationId);
  const skip = new Set(excluding);
  return rows.map(r => r.user_id).filter(id => !skip.has(id));
}

/* ──────────────────────────────────────────────────────────────────────────
   Invitation links
   ────────────────────────────────────────────────────────────────────────── */

/**
 * What a link looks like in a response, and who is allowed to see which half.
 *
 * ── Two projections, one function ──
 *
 * A member who may pass the link on needs the URL. A manager needs the URL, what
 * the link is called, whether it still works, when it lapses and how many people
 * joined through it. Those are different disclosures, and computing them in one
 * place is what stops the list endpoint from quietly handing a member the
 * management view because a new field was added to the SELECT.
 *
 * `uses` and `lastUsedAt` are managers-only. Not because they are sensitive in
 * themselves — they are aggregate counts — but because they are the club's
 * operational record, and a member who may hand out an address has not been
 * given a reason to read it.
 */
const shareLinkView = (link, { forManager, now = new Date() }) => ({
  id: link.id,
  path: shareLinkPath(link.token),
  label: link.label,
  state: linkState(link, now),
  createdAt: link.createdAt,
  expiresAt: link.expiresAt ?? null,
  ...(forManager
    ? {
      revokedAt: link.revokedAt ?? null,
      uses: Number(link.uses ?? 0),
      lastUsedAt: link.lastUsedAt ?? null,
    }
    : {}),
});

/**
 * Who may do what with a club's links, decided once.
 *
 * ── Two different questions, deliberately not one setting ──
 *
 * **Reading a link to pass it on** is governed by `invite_policy`, because that
 * is precisely what the setting means: a club that chose "all members" wants its
 * students handing the address out.
 *
 * **Deciding what the links ARE** — creating one, renaming it, setting it to
 * lapse, revoking it, regenerating it so every printed copy stops working — is
 * `canManage`. Widening that by an option would mean a club whose setting says
 * "members may share our address" also says "any member may break the flyer on
 * the wall", and nobody choosing the first thing is choosing the second.
 */
async function shareLinkAccess(row, principal) {
  const memberRole = await memberRoleOf(db, row.id, principal.userId);
  const hasModerate = can(principal, 'organization.moderate');
  return {
    mayRead: canInvite({ invitePolicy: row.invite_policy, memberRole, hasModerate }),
    mayManage: hasModerate || memberRole === 'manager',
  };
}

/**
 * GET the club's links.
 *
 * A manager gets all of them, live ones first, revoked and lapsed ones after —
 * see `shareLinksFor` for why the dead ones are included rather than hidden.
 * Anybody else who may share gets the one primary link and nothing else: the
 * club's address, which is all the Share control needs.
 */
router.get('/api/organizations/:key/share-links', authenticateToken, requireCap('organization.join'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return;

  const { mayRead, mayManage } = await shareLinkAccess(row, req.principal);
  if (!mayRead) {
    return res.status(403).json({
      error: 'Only people who help run this organization can share its invitation link.',
      code: 'not_allowed_to_invite',
    });
  }

  const now = new Date();
  const all = await shareLinksFor(db, row.id);

  if (!mayManage) {
    const primary = await primaryShareLink(db, row.id, { now });
    /* 200 with an empty list, not a 404. "There is no link yet" is a normal
       state of a club that never made one, and the dialog's job in that state is
       to say so — which a 404 would turn into an error screen. */
    return res.json({
      links: primary ? [shareLinkView(primary, { forManager: false, now })] : [],
      canManage: false,
      canCreate: false,
      maxLinks: SOFT_MAX_LIVE_LINKS,
    });
  }

  /* Live first, then the rest, each group newest first — the order a manager
     reads: what is working now, then what used to. */
  const live = all.filter(link => linkIsLive(link, now));
  const retired = all.filter(link => !linkIsLive(link, now));

  res.json({
    links: [...live, ...retired].map(link => shareLinkView(link, { forManager: true, now })),
    canManage: true,
    canCreate: live.length < SOFT_MAX_LIVE_LINKS,
    maxLinks: SOFT_MAX_LIVE_LINKS,
  });
});

/**
 * Validates an expiry a manager typed.
 *
 * `null` is the answer for "no expiry", and it is the DEFAULT — see the
 * `organizationShareLinks` header for why the flyer on the wall in September
 * must still work in May. A date in the past is refused rather than accepted
 * and instantly dead, which would look like a link that never worked.
 */
const MAX_EXPIRY_MS = 5 * 365 * 24 * 60 * 60 * 1000;

function validateExpiry(value, { now = new Date() } = {}) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, field: 'expiresAt', error: 'That is not a date we can read.' };
  }
  if (at.getTime() <= now.getTime()) {
    return { ok: false, field: 'expiresAt', error: 'Choose a date in the future.' };
  }
  /* An upper bound, so "never" is expressed by clearing the field rather than by
     a date in the year 9999 that no manager will ever revisit. */
  if (at.getTime() - now.getTime() > MAX_EXPIRY_MS) {
    return { ok: false, field: 'expiresAt', error: 'Choose a date within the next five years, or leave it blank so the link does not expire.' };
  }
  return { ok: true, value: at.toISOString() };
}

/**
 * POST — mint a link. Managers only.
 *
 * ── Why POST and not a lazily-minting GET ──
 *
 * A GET that created a credential would put it in browser history and hand it to
 * anything that speculatively prefetches links — the argument
 * `POST /api/applications/:id/checkin-code` already makes for the same shape. It
 * also keeps "look at our links" and "make another one" from being confused.
 */
router.post('/api/organizations/:key/share-links', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;
  if (row.status !== 'active') {
    return res.status(409).json({
      error: 'Unarchive this organization before making an invitation link for it.',
      code: 'archived',
    });
  }

  const label = validateLabel(req.body?.label);
  if (!label.ok) return res.status(400).json({ error: label.error, field: label.field });
  const expiry = validateExpiry(req.body?.expiresAt);
  if (!expiry.ok) return res.status(400).json({ error: expiry.error, field: expiry.field });

  if (await liveLinkCount(db, row.id) >= SOFT_MAX_LIVE_LINKS) {
    return res.status(409).json({
      error: `This organization already has ${SOFT_MAX_LIVE_LINKS} working invitation links. `
        + 'Switch one off before making another.',
      code: 'too_many_links',
    });
  }

  let created;
  try {
    created = await runInTransaction(db, async (tx) => {
      const link = await createShareLink(tx, row.id, {
        label: label.value,
        expiresAt: expiry.value,
        createdBy: req.principal.userId,
      });
      await recordAudit(tx, {
        adminId: req.principal.userId,
        action: 'ORGANIZATION_SHARE_LINK_CREATED',
        /* No token in the audit trail. The trail is read by administrators who
           are not in this club, and a credential written into it would be a
           credential in a table with a different retention rule and a different
           audience. What matters six months later is that somebody made a link
           and when — not what it said. */
        details: `Created the invitation link "${link.label}" for ${row.name} (@${row.slug})`
          + `${expiry.value ? `, expiring ${expiry.value}` : ', with no expiry'}.`,
      });
      return link;
    });
  } catch (err) {
    console.error('Could not issue an organization invitation link:', err);
    return res.status(500).json({ error: 'Could not make an invitation link.' });
  }

  const link = await shareLinkById(db, row.id, created.id);
  res.status(201).json({ link: shareLinkView(link, { forManager: true }) });
});

/**
 * PATCH — rename a link, change when it lapses, or regenerate it.
 *
 * Three operations on one route because they are three edits to one row and the
 * client's form submits them together. `rotate` is the one that is not an edit —
 * it replaces the row — so it is exclusive: a request that both renames and
 * regenerates would leave a manager unsure which name the new link carries.
 */
router.patch('/api/organizations/:key/share-links/:linkId', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  const existing = await shareLinkById(db, row.id, req.params.linkId);
  if (!existing) return res.status(404).json({ error: 'No such invitation link.', code: 'not_found' });

  const rotate = req.body?.rotate === true;
  const renaming = req.body?.label !== undefined;
  const reExpiring = req.body?.expiresAt !== undefined;

  if (rotate && (renaming || reExpiring)) {
    return res.status(400).json({
      error: 'Regenerate the link on its own, then rename it.',
      code: 'conflicting_change',
    });
  }

  if (rotate) {
    /**
     * A dead link cannot be regenerated, and "dead" includes lapsed.
     *
     * `rotateShareLink` inherits the old link's expiry on purpose — a link made
     * for one event booth must not become permanent by being regenerated — so
     * rotating an EXPIRED link minted a replacement that was born expired. It
     * read as a regeneration that silently did nothing, which is the worst
     * possible answer for a control whose whole promise is "the old copies stop
     * working and here is the new one".
     *
     * Both dead states are refused with their own reason, because "switched off"
     * and "expired" are different things a manager did (or did not do) and the
     * next step is the same either way: make a new link.
     */
    const state = linkState(existing);
    if (state !== 'live') {
      return res.status(409).json({
        error: state === 'revoked'
          ? 'That link is switched off. Make a new one instead.'
          : 'That link has expired. Make a new one instead.',
        code: state,
      });
    }
    const replacement = await runInTransaction(db, async (tx) => {
      const fresh = await rotateShareLink(tx, row.id, existing.id, { createdBy: req.principal.userId });
      await recordAudit(tx, {
        adminId: req.principal.userId,
        action: 'ORGANIZATION_SHARE_LINK_ROTATED',
        details: `Regenerated the invitation link "${existing.label}" for ${row.name} (@${row.slug}). `
          + 'The previous link no longer works; members were unaffected.',
      });
      return fresh;
    });
    const link = await shareLinkById(db, row.id, replacement.id);
    return res.json({ link: shareLinkView(link, { forManager: true }), rotated: true });
  }

  let label = { ok: true, value: existing.label };
  if (renaming) {
    label = validateLabel(req.body.label, { fallback: existing.label });
    if (!label.ok) return res.status(400).json({ error: label.error, field: label.field });
  }
  let expiry = { ok: true, value: existing.expiresAt ?? null };
  if (reExpiring) {
    expiry = validateExpiry(req.body.expiresAt);
    if (!expiry.ok) return res.status(400).json({ error: expiry.error, field: expiry.field });
  }

  await runInTransaction(db, async (tx) => {
    if (renaming) await renameShareLink(tx, row.id, existing.id, label.value);
    if (reExpiring) await setShareLinkExpiry(tx, row.id, existing.id, expiry.value);
    /* Audited only when the expiry moved. A rename changes no permission and
       nothing a member can observe; an expiry decides whether the link admits
       anybody next Tuesday, which is the kind of change somebody asks about
       later. */
    if (reExpiring && (expiry.value ?? null) !== (existing.expiresAt ?? null)) {
      await recordAudit(tx, {
        adminId: req.principal.userId,
        action: 'ORGANIZATION_SHARE_LINK_EXPIRY_SET',
        details: expiry.value
          ? `Set the invitation link "${label.value}" for ${row.name} (@${row.slug}) to stop working ${expiry.value}.`
          : `Removed the expiry from the invitation link "${label.value}" for ${row.name} (@${row.slug}).`,
      });
    }
  });

  const link = await shareLinkById(db, row.id, existing.id);
  res.json({ link: shareLinkView(link, { forManager: true }) });
});

/**
 * DELETE — switch one link off.
 *
 * Not step-up gated and deliberately cheaper than creating one, on the rule the
 * administrator invitation routes already state: revocation only ever REMOVES
 * reach, and putting friction in front of the safe action makes it harder than
 * the dangerous one.
 *
 * A club whose policy is `invite` and whose last link has just been switched off
 * can be joined by nobody, which is a legitimate thing to want — an intake
 * window that has closed — and is why this does not also change the policy. The
 * client says so plainly in the confirmation.
 */
router.delete('/api/organizations/:key/share-links/:linkId', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  const existing = await shareLinkById(db, row.id, req.params.linkId);
  if (!existing) return res.status(404).json({ error: 'No such invitation link.', code: 'not_found' });

  const revoked = await runInTransaction(db, async (tx) => {
    const gone = await revokeShareLink(tx, row.id, existing.id);
    if (gone) {
      await recordAudit(tx, {
        adminId: req.principal.userId,
        action: 'ORGANIZATION_SHARE_LINK_REVOKED',
        details: `Switched off the invitation link "${existing.label}" for ${row.name} (@${row.slug}). `
          + 'Members were unaffected.',
      });
    }
    return gone;
  });

  const link = await shareLinkById(db, row.id, existing.id);
  res.json({ link: shareLinkView(link, { forManager: true }), revoked });
});

/**
 * GET the public projection an invitation link opens. UNAUTHENTICATED.
 *
 * ── The one endpoint on this platform that answers with no session ──
 *
 * That is the point: somebody handed a link has no account, and asking them to
 * make one before they can see what they are joining is how a share link stops
 * being worth sharing. So this is modelled on `GET /api/certificates/verify/:code`
 * — the only other unauthenticated read of real data — and it copies both of
 * that route's disciplines.
 *
 * **It discloses only what the club itself advertises.** `publicOrganization` is
 * an allowlist, and its header sets out field by field what is absent and why:
 * no member, no founder, no event location, no announcement, no hours, no id.
 *
 * **Every failure answers identically.** No such token, a revoked one, one whose
 * organization has been archived — all 404 with the same body. A distinguishable
 * refusal would turn this into a probe for live links, and the shape of the
 * refusal is the only thing an attacker gets to measure.
 *
 * Rate limiting is mounted in app.js ahead of the router, keyed on the device,
 * counting successes — see `shareTokenLimiter` for why successes count and why
 * the message must never read as a verdict on the link.
 */
router.get('/api/public/organizations/invite/:token', async (req, res) => {
  const gone = () => res.status(404).json({
    error: 'That invitation link does not work. It may have been replaced or switched off. '
      + 'Ask whoever shared it for the current one.',
    code: 'invalid_link',
  });

  try {
    const org = await resolveShareToken(db, req.params.token);
    if (!org) return gone();

    /* The reads AND the allowlist live together in `organizations.js` — see
       `publicOrganizationSnapshot` for why, and for what it refuses to select. */
    res.json({ organization: await publicOrganizationSnapshot(db, org) });
  } catch (err) {
    console.error('Invitation link lookup failed:', err);
    /* The same body as a miss. A 500 here would tell a caller that the token
       matched something and the failure came afterwards, which is more than a
       uniform refusal is willing to say. */
    return gone();
  }
});

/**
 * GET the public page of an organization, by its handle. UNAUTHENTICATED.
 *
 * ── Why this is a second unauthenticated route and not the invitation one ──
 *
 * They answer the same projection and mean completely different things, and
 * keeping them apart is the point of the whole design:
 *
 *   `/invite/:token`  a CREDENTIAL. Holding it is what lets a Join press
 *                     succeed at an invitation-only club. Unguessable, revocable,
 *                     and it works whatever the club's visibility is — that is
 *                     what makes a flyer work.
 *   `/@handle`        an ADDRESS. Readable, printable, guessable BY DESIGN — it
 *                     is the club's name — and it carries no authority
 *                     whatsoever. It opens only a club that chose to be public,
 *                     and a Join press arriving with nothing but a handle is
 *                     judged by `join_policy` alone.
 *
 * A handle that granted joining authority would be a password anybody can read
 * off a poster and derive from a club's name, which is why `joinAffordance`
 * never sees one.
 *
 * ── Why an unlisted club answers exactly like a club that does not exist ──
 *
 * Same 404, same body. Handles are guessable, so a distinguishable refusal
 * would turn this into a directory of every club on the platform that has
 * chosen not to be listed — including which schools have one. "It is not public"
 * and "there is no such club" are the same answer here on purpose.
 *
 * Rate limiting is mounted in app.js ahead of the router.
 */
router.get('/api/public/organizations/:handle', async (req, res) => {
  const gone = () => res.status(404).json({
    error: 'We could not find an organization at that address.',
    code: 'not_found',
  });

  try {
    /**
     * NOT shape-checked with `validateHandle`, deliberately.
     *
     * `validateHandle` governs what a manager may CHOOSE. It is stricter than
     * what already exists in the column: `slugify` predates it and could return
     * `hq` (under the 3-character floor), `2024-team` (digit-initial) or 60
     * characters (over the 40 ceiling), and migration 063 does not rewrite
     * existing slugs — rewriting them would break the links those clubs have
     * already handed out, which is the whole reason renaming stopped moving the
     * address.
     *
     * Gating the public route on it meant such a club could set
     * `visibility = 'public'`, watch the Share dialog offer it a public address
     * with a Copy button, and have every visitor — including one holding a
     * printed poster — answered 404. Fail-closed, so nothing leaked; the
     * product simply lied to the manager about whether their page was public.
     *
     * `publicOrganizationByHandle` can only ever return a row that exists, so
     * it is the honest authority here. All this needs is a length ceiling, to
     * refuse a megabyte of path without a round trip.
     */
    const handle = normaliseHandle(req.params.handle);
    if (!handle || handle.length > 200) return gone();

    /* One function decides "is there a public club at this handle" — see
       `publicOrganizationByHandle` for the three conditions and why all three
       failures are the same null. */
    const row = await publicOrganizationByHandle(db, handle);
    if (!row) return gone();

    res.json({ organization: await publicOrganizationSnapshot(db, row) });
  } catch (err) {
    console.error('Public organization lookup failed:', err);
    /* The same body as a miss, for the reason the invitation route gives: a 500
       would tell a caller that the handle matched something and the failure came
       afterwards. */
    return gone();
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   Direct invitations
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Why inviting a named person is `canManage` and sharing a link is not.
 *
 * `invite_policy` answers "who may hand out our address". A club that chose
 * "all members" is saying its students may pass a URL on — an act with a human
 * in the middle, aimed at somebody they are talking to anyway.
 *
 * Inviting a named individual is different in kind. It reaches into another
 * person's notifications, it names them in the club's own records, and the
 * people on both ends are frequently minors. It is a decision about the club's
 * roster, which is the line `canManage` already draws.
 *
 * `organizationInvitations.js` sets out the rest of the model — no token, no
 * email, and no second invitation after a decline.
 */
router.get('/api/organizations/:key/invitations', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  /* Lazily retire the lapsed ones, so the list a manager is reading does not
     report an invitation as outstanding that `invitationStands` would refuse.
     Bookkeeping, not enforcement — the refusal does not depend on this having
     run, which is what makes it safe for it to be lazy rather than a worker. */
  await expireLapsedInvitations(db, row.id);

  const rows = await pendingInvitations(db, row.id);
  res.json({
    invitations: rows.map(invitation => ({
      /* `invitationId`, not `id` — `profileSummary` writes its own `id` for the
         person, and spreading it over the invitation's would silently hand the
         client a person id where it expected an invitation id. The join-request
         queue names its own field the same way, for the same reason. */
      invitationId: invitation.id,
      ...profileSummary({ ...invitation, id: invitation.userId }),
      message: invitation.message ?? null,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    })),
  });
});

/**
 * POST — invite somebody.
 *
 * The target is a USER ID, obtained from the directory search the caller is
 * already allowed to use. Never an email address: see the
 * `organizationInvitations.js` header for the three arguments that decided it,
 * the first of which is that an address field here would be the platform's only
 * write oracle over a `PRIVILEGED_FIELDS` column.
 */
router.post('/api/organizations/:key/invitations', authenticateToken, requireCap('organization.manage.own'),
  joinAttemptLimiter, async (req, res) => {
    const row = await loadManagedOrganization(req, res);
    if (!row) return;
    if (row.status !== 'active') {
      return res.status(409).json({
        error: 'Unarchive this organization before inviting anybody to it.',
        code: 'archived',
      });
    }

    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    if (!userId) return res.status(400).json({ error: 'Choose somebody to invite.', field: 'userId' });

    const note = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (note.length > NOTE_MAX) {
      return res.status(400).json({
        error: `Keep the note to ${NOTE_MAX} characters or fewer.`,
        field: 'message',
      });
    }

    /* A live account — `invitableUser` carries the rule and the reason it is
       not a `SELECT *`. */
    const target = await invitableUser(db, userId);
    if (!target) return res.status(404).json({ error: 'We could not find that person.', code: 'no_such_user' });

    /* Says what happened, not something about their own membership. A manager
       who mis-clicked their own row in the search results was told "You are
       already in this organization" while trying to invite somebody else. */
    if (target.id === req.principal.userId) {
      return res.status(400).json({ error: 'You cannot invite yourself.', code: 'self' });
    }
    if (await memberRoleOf(db, row.id, target.id)) {
      return res.status(409).json({
        error: `${target.name} is already in this organization.`,
        code: 'already_member',
      });
    }
    /* A banned person is not invited back by an invitation — lifting the ban is
       its own deliberate act, with its own audit row, and an invitation that
       bypassed it would be a second door into a club that closed the first. */
    if (await viewerBanState(row.id, target.id)) {
      return res.status(409).json({
        error: 'That person is banned from this organization. Lift the ban first.',
        code: 'banned',
      });
    }

    const outcome = await runInTransaction(db, async (tx) => {
      const result = await inviteUser(tx, row.id, target.id, {
        invitedBy: req.principal.userId,
        message: note || null,
      });
      if (!result.ok) return result;
      await recordAudit(tx, {
        adminId: req.principal.userId,
        action: 'ORGANIZATION_INVITATION_SENT',
        /* The note is NOT in the audit trail. It was written to one person, and
           the trail is read by administrators who are not in this club. */
        details: `Invited ${target.name} (@${target.username}) to ${row.name} (@${row.slug}).`,
      });
      return result;
    });

    if (!outcome.ok) {
      const refusals = {
        pending: [409, `${target.name} already has an invitation to this organization.`],
        declined: [409, `${target.name} declined an invitation to this organization. `
          + 'They can still join using an invitation link if they change their mind.'],
        full: [409, 'This organization has too many invitations outstanding. '
          + 'Withdraw some before sending more.'],
      };
      const [status, error] = refusals[outcome.reason] ?? [409, 'That invitation could not be sent.'];
      return res.status(status).json({ error, code: outcome.reason });
    }

    /* Dispatched OUTSIDE the transaction, on the rule the rest of this file
       follows: a notification is a side effect, and a mail or push failure must
       not roll back the invitation it is telling somebody about. */
    await notificationService.dispatch(
      'ORGANIZATION_INVITATION_RECEIVED',
      { organizationName: row.name, organizationSlug: row.slug },
      target.id,
      `org-invite:${outcome.invitation.id}`,
    );

    /* The same shape the list endpoint returns, field for field — see the
       `invitationId` note there for why the invitation's id is not `id`. One
       shape means the client renders a newly-sent invitation with the component
       it already uses for the list. */
    res.status(201).json({
      invitation: {
        invitationId: outcome.invitation.id,
        ...profileSummary(target),
        message: outcome.invitation.message ?? null,
        createdAt: outcome.invitation.createdAt,
        expiresAt: outcome.invitation.expiresAt,
      },
    });
  });

/**
 * DELETE — decline the invitation addressed to me.
 *
 * ── Why there is no matching "accept" route ──
 *
 * Accepting an invitation IS joining, and joining already has a route that
 * holds the whole story: the capability check, the ban check, the affordance,
 * the capacity, the transaction that writes the membership row and retires the
 * request and the invitation together. A second route that also created
 * memberships would be a second implementation of that, and the one that drifts
 * is always the newer one.
 *
 * So the client's Accept press posts to `…/membership`, exactly as Join does,
 * and the invitation is what makes it succeed.
 *
 * ── Why declining is `organization.join` and not manager-gated ──
 *
 * It is the invited person's own answer about their own membership. `:key` is
 * resolved and the row is matched on `invited_user_id = the caller` inside
 * `pendingInvitationFor`, so this can only ever decline an invitation addressed
 * to whoever is asking.
 */
router.delete('/api/organizations/:key/invitations/mine', authenticateToken, requireCap('organization.join'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return;

  const invitation = await pendingInvitationFor(db, row.id, req.principal.userId);
  if (!invitation) {
    return res.status(404).json({ error: 'You do not have an invitation to this organization.', code: 'not_found' });
  }

  const outcome = await resolveInvitation(db, row.id, invitation.id, 'declined');
  if (outcome !== 'resolved') {
    return res.status(409).json({ error: 'That invitation has already been answered.', code: 'already_resolved' });
  }

  /* No notification to the club. A decline is a private answer, and a queue of
     "so-and-so said no" notifications is how a club's managers end up
     discussing it with them. It disappears from the outstanding list, which is
     the only thing a manager needs to see. */
  res.json({ declined: true });
});

/**
 * DELETE — withdraw an invitation. Managers only.
 *
 * Declared AFTER the `…/invitations/mine` route above, so that `mine` is never
 * matched as an invitation id — the same ordering discipline `/organizations/new`
 * and `/users/id/:id` rely on in the client route table. An id can never be the
 * literal `mine` (they are all `oinv-<hex>`), so the two can never both match.
 *
 * Deliberately cheaper than sending one, on the rule the administrator
 * invitation routes state: revocation only ever removes reach.
 *
 * The invited person is NOT notified that their invitation was withdrawn. An
 * invitation they never opened, withdrawn, is a non-event; telling them would
 * mean a student's first news of a club is that it changed its mind about them.
 */
router.delete('/api/organizations/:key/invitations/:invitationId', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  const outcome = await runInTransaction(db, async (tx) => {
    const result = await resolveInvitation(tx, row.id, req.params.invitationId, 'revoked');
    if (result === 'resolved') {
      await recordAudit(tx, {
        adminId: req.principal.userId,
        action: 'ORGANIZATION_INVITATION_REVOKED',
        details: `Withdrew an invitation to ${row.name} (@${row.slug}).`,
      });
    }
    return result;
  });

  if (outcome === 'not_found') {
    return res.status(404).json({ error: 'No such invitation.', code: 'not_found' });
  }
  if (outcome === 'already_resolved') {
    return res.status(409).json({
      error: 'That invitation has already been answered.',
      code: 'already_resolved',
    });
  }
  res.json({ revoked: true });
});

/* ──────────────────────────────────────────────────────────────────────────
   Requests to join
   ────────────────────────────────────────────────────────────────────────── */

/**
 * POST — ask to join.
 *
 * ── Only for a club that actually approves members ──
 *
 * A request filed against an `open` club is refused with the affordance that
 * club really offers, rather than accepted and left in a queue nobody looks at.
 * Against an `invite` club it is refused too: the club has said the way in is
 * its link, and letting a stranger file a request instead would be a second door
 * the setting was chosen to close.
 *
 * ── Duplicates are settled by the database ──
 *
 * `requestToJoin` leans on the partial unique index and reports the existing
 * request as the same success as a new one. Two simultaneous presses therefore
 * produce one row, not two — and the second press is not an error, because
 * pressing a button twice never is.
 */
router.post('/api/organizations/:key/join-requests', authenticateToken, requireCap('organization.join'),
  joinAttemptLimiter, async (req, res) => {
    const row = await loadOrganization(req, res);
    if (!row) return;
    if (row.status !== 'active') {
      return res.status(409).json({ error: 'That organization is no longer accepting members.', code: 'archived' });
    }

    const ban = await db.prepare(`
      SELECT reason FROM organization_bans
      WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
    `).get(row.id, req.principal.userId);
    /* Enforced here as well as on the join route, and for the same reason it is
       enforced there: a ban that only stopped one of the two ways in would be a
       ban a client could route around. */
    if (ban) {
      return res.status(403).json({
        error: 'You cannot ask to rejoin this organization while this ban is active.',
        code: 'banned',
        reason: ban.reason,
      });
    }

    const membership = await memberRoleOf(db, row.id, req.principal.userId);
    if (membership) return res.status(409).json({ error: 'You are already a member.', code: 'already_member' });

    const affordance = joinAffordance({
      joinPolicy: row.join_policy,
      status: row.status,
      canJoinAtAll: true,
    });
    if (affordance.action !== 'request') {
      return res.status(409).json({
        error: affordance.action === 'join'
          ? 'This organization lets you join straight away.'
          : 'This organization admits members by invitation, not by request.',
        code: 'not_by_request',
        affordance: affordance.action,
      });
    }

    /**
     * The optional note.
     *
     * Validated before anything is written, and stored verbatim — see
     * `validateMessage` for why there is no sanitiser here: the value is
     * rendered as text by React, which escapes it, and stripping markup would
     * mangle a child's message while adding no protection.
     */
    const note = validateMessage(req.body?.message);
    if (!note.ok) return res.status(400).json({ error: note.error, field: note.field });

    let request;
    try {
      request = await runInTransaction(db, async (tx) => {
        const filed = await requestToJoin(tx, row.id, req.principal.userId, { message: note.value });
        if (!filed.created) return filed;

        const requester = await tx.prepare('SELECT name FROM users WHERE id = ?').get(req.principal.userId);
        for (const managerId of await managerIds(tx, row.id, { excluding: [req.principal.userId] })) {
          await notificationService.dispatch('ORGANIZATION_JOIN_REQUEST_RECEIVED', {
            organizationName: row.name,
            organizationSlug: row.slug,
            actorName: requester?.name ?? 'Somebody',
          }, managerId, `org-join-request:${filed.id}`);
        }
        return filed;
      });
    } catch (err) {
      console.error('Could not file a request to join:', err);
      return res.status(500).json({ error: 'Could not send that request.' });
    }

    res.status(request.created ? 201 : 200).json({
      pending: true,
      submittedAt: request.createdAt,
      /* The note as STORED, which for a second press is the one already on
         file rather than the one just typed. A page that echoed the new text
         while the queue showed the old would be lying to whoever is looking at
         it about what the manager will read. */
      message: request.message ?? null,
      created: request.created,
    });
  });

/**
 * DELETE — take your own request back.
 *
 * `/mine` rather than an id, so there is nothing to get wrong: the route cannot
 * be pointed at somebody else's request, because it never accepts an identifier.
 * That is a stronger guarantee than checking ownership, and it is the same
 * reason `DELETE …/membership` takes no user id.
 */
router.delete('/api/organizations/:key/join-requests/mine', authenticateToken, requireCap('organization.join'), async (req, res) => {
  const row = await loadOrganization(req, res);
  if (!row) return;
  const withdrawn = await withdrawRequest(db, row.id, req.principal.userId);
  res.json({ pending: false, withdrawn });
});

/**
 * GET the queue. Managers only.
 *
 * ── Why not `canHelpRun` ──
 *
 * Two reasons, and the second is the one that decides it. Admitting somebody is
 * a standing decision about who is in the club, which is the class of question
 * `canManage` guards — and this response is a list of named students who have
 * asked for something, which is a disclosure a Student Organizer has no need
 * for. `canHelpRun`'s own header argues against widening the dangerous question
 * by an option; this asks the narrow one.
 *
 * Every row goes through `profileSummary`, the same strict subset the roster and
 * directory search use, so a queue cannot become the route by which a manager
 * reads a field a profile would have withheld.
 */
router.get('/api/organizations/:key/join-requests', authenticateToken, requireCap('organization.manage.own'), async (req, res) => {
  const row = await loadManagedOrganization(req, res);
  if (!row) return;

  const rows = await pendingRequests(db, row.id);
  res.json({
    requests: rows.map(r => ({
      /* `requestId` and not `id`, because `profileSummary` publishes `id` and it
         means the USER — the same shape the roster uses, so one row component
         serves both and links to the same profile. Naming the request `id` here
         made the spread below overwrite it, which is not a clash a reader
         notices and cost the decision route its identifier. */
      requestId: r.id,
      submittedAt: r.createdAt,
      /* The note the student wrote, if they wrote one. Read only by the club's
         managers — the queue endpoint they are the only callers of — and never
         published to the roster or to any other member. */
      message: r.message ?? null,
      /* Handed over as it came out of the database, because `profileSummary`
         reads the column names — it is the same strict subset the roster and
         directory search publish, so a queue cannot disclose a field a profile
         would have withheld. */
      ...profileSummary({ ...r, id: r.userId }),
    })),
    /* So the client's badge and its list cannot disagree after a decision. */
    pendingRequests: rows.length,
  });
});

/**
 * POST a decision. Managers only.
 *
 * ── One transaction, and a conditional update inside it ──
 *
 * Accepting is four writes that must all happen or none: the request's status,
 * the membership row, the recomputation of the new member's helper capabilities,
 * and the audit row. `recordAudit` never catches, so a failed audit rolls the
 * admission back — there is no state in which somebody joined a club and the
 * record did not happen.
 *
 * `decideRequest` writes `… WHERE id = ? AND organization_id = ? AND status =
 * 'pending'`, which is what makes two managers pressing Accept at the same
 * moment produce one membership and one honest 409 rather than two writes racing
 * over one row. The membership insert is `ON CONFLICT DO NOTHING`, so even the
 * loser's write would be harmless if it got that far.
 *
 * ── Why `organization_id` is in that WHERE clause ──
 *
 * Request ids are random UUIDs, so this is not a guessing defence. It is what
 * stops a manager of one club deciding another club's request by pasting an id
 * into a route scoped to theirs — the cross-organization case the brief asks
 * about, closed in the statement rather than in a preceding check.
 */
router.post('/api/organizations/:key/join-requests/:requestId/decision', authenticateToken,
  requireCap('organization.manage.own'), async (req, res) => {
    const row = await loadManagedOrganization(req, res);
    if (!row) return;

    const decision = req.body?.decision;
    if (!REQUEST_DECISIONS.includes(decision)) {
      return res.status(400).json({
        error: `The decision must be ${REQUEST_DECISIONS.join(' or ')}.`,
        field: 'decision',
      });
    }

    const subject = await requestSubject(db, row.id, req.params.requestId);
    /* 404 before the update, so "no such request in this club" is answered once
       and the update below only ever handles the race. */
    if (!subject) return res.status(404).json({ error: 'No such request.', code: 'not_found' });

    let outcome;
    try {
      outcome = await runInTransaction(db, async (tx) => {
        /**
         * The ban, re-checked HERE — the third admission path, and the one that
         * was missing it.
         *
         * `POST …/membership` and `POST …/join-requests` both re-read the ban at
         * the moment of the act, and this file's own comment claims the ban is
         * enforced on the join path because that is the boundary. Accepting a
         * request is a second way onto the roster, so the boundary has to be
         * here too. Banning does not retire a pending request, so the queue can
         * hold a row for somebody who has since been banned, with nothing
         * marking them.
         *
         * ── Before `decideRequest`, not after ──
         *
         * `decideRequest` writes the status. Checking the ban after it and
         * returning early would commit a request marked `accepted` with no
         * membership row behind it — a worse state than the bug being fixed,
         * and one no later read could tell from a real acceptance.
         *
         * Refusing leaves the request PENDING, which is what the response tells
         * the manager: lift the ban and accept, or decline. Deciding it for them
         * in either direction would be the wrong call to make on their behalf.
         */
        if (decision === 'accept') {
          const banned = await tx.prepare(`
            SELECT 1 AS ok FROM organization_bans
             WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
          `).get(row.id, subject.userId);
          if (banned) return 'banned';
        }

        const result = await decideRequest(tx, {
          organizationId: row.id,
          requestId: req.params.requestId,
          decision,
          deciderId: req.principal.userId,
        });
        if (result !== 'decided') return result;

        if (decision === 'accept') {
          await tx.prepare(`
            INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
            VALUES (?, ?, 'member', ?)
            ON CONFLICT(organization_id, user_id) DO NOTHING
          `).run(row.id, subject.userId, new Date().toISOString());

          /* An invitation this person was also holding stops being outstanding,
             exactly as it would if they had joined through the ordinary route.
             Left pending, it would count against the club's list for ever, be
             offered back to them on their own page, block re-invitation for a
             fortnight, and walk them back into an `invite`-only club if they
             ever left. */
          await acceptInvitationOnJoin(tx, row.id, subject.userId);

          /* Recomputed for the same reason leaving recomputes it: the answer is
             derived from the membership table rather than remembered, so it
             cannot drift from the thing it describes. Joining as an ordinary
             member grants nothing, and calling it anyway is what makes the rule
             one sentence instead of four call sites. */
          await syncOrganizerCapabilities(tx, subject.userId, req.principal.userId);
        }

        await recordAudit(tx, {
          adminId: req.principal.userId,
          action: decision === 'accept' ? 'ORGANIZATION_REQUEST_ACCEPTED' : 'ORGANIZATION_REQUEST_REJECTED',
          targetUserId: subject.userId,
          details: `${decision === 'accept' ? 'Accepted' : 'Declined'} a request to join ${row.name} (${row.slug}).`,
        });

        await notificationService.dispatch(
          decision === 'accept'
            ? 'ORGANIZATION_JOIN_REQUEST_ACCEPTED'
            : 'ORGANIZATION_JOIN_REQUEST_REJECTED',
          { organizationName: row.name, organizationSlug: row.slug },
          subject.userId,
          `org-join-request-decision:${req.params.requestId}`,
        );

        return result;
      });
    } catch (err) {
      console.error('Could not decide a request to join:', err);
      return res.status(500).json({ error: 'Could not save that decision.' });
    }

    if (outcome === 'already_decided') {
      return res.status(409).json({
        error: 'Somebody has already answered that request.',
        code: 'already_decided',
      });
    }
    /* The request was answerable and the person is banned. The row stays
       pending, so a manager who lifts the ban can still accept it — which is
       better than deciding it for them in either direction. */
    if (outcome === 'banned') {
      return res.status(409).json({
        error: 'That person is banned from this organization. Lift the ban first, '
          + 'or decline the request.',
        code: 'banned',
      });
    }
    if (outcome !== 'decided') {
      return res.status(404).json({ error: 'No such request.', code: 'not_found' });
    }

    res.json({
      decision,
      memberCount: await countMembers(row.id),
      pendingRequests: await pendingRequestCount(db, row.id),
    });
  });


export default router;
