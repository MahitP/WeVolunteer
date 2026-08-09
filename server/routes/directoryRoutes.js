/**
 * The member directory: public profiles, people/organization search, and the
 * personal relationship controls that hang off a profile.
 *
 * ── Why these are one router ──
 *
 * They share a serializer and they share a threat. Search and profile are the
 * same disclosure at different cardinalities, and the recurring shape of a
 * profile-privacy bug is not a hole in the profile endpoint — it is a second
 * endpoint that returns the same rows and was never thought of as a profile
 * endpoint. Keeping them in one file with one serializer (`profileSerializer.js`)
 * is what makes "search cannot show what the profile hides" structural rather
 * than a thing to remember.
 *
 * Nothing here is reachable without a session. "Public profile" means visible to
 * the school community a student volunteers alongside, not to the open internet:
 * this is a platform whose members are children, and a signed-out, crawlable
 * directory of minors by name, school and general location is not something the
 * word "public" should be allowed to smuggle in.
 */

import express from 'express';
import { authenticateToken } from '../utils.js';
import { can, requireCap } from '../authz.js';
import { db } from '../db.js';
import { publicProfile, profileSummary } from '../profileSerializer.js';
import { volunteerStats } from '../volunteerStats.js';
import {
  areFriends, relationshipState, requestFriend, acceptFriend, removeFriend,
  setUnilateral, clearUnilateral,
} from '../relationships.js';
import { formatOrganization } from '../organizations.js';
import { notificationService } from '../services/notificationService.js';

const router = express.Router();

const SEARCH_MIN = 2;
const SEARCH_MAX_LIMIT = 25;

/** Live, non-deleted accounts only. A deleted account has no profile to show. */
const LIVE_USER = `account_status = 'active'`;

/**
 * Bounds a client-supplied limit.
 *
 * A hard ceiling rather than a trusted parameter: `?limit=100000` on a
 * directory search is how somebody enumerates every minor on the platform in
 * one request.
 */
function boundedLimit(raw, fallback = 20) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, SEARCH_MAX_LIMIT);
}

/**
 * Escapes a user string for use inside a LIKE pattern.
 *
 * `%` and `_` are wildcards. Without this, a search for `_` matches every
 * single-character name and a search for `%` matches everybody — which turns
 * the search box into the enumeration endpoint the limit above exists to
 * prevent.
 */
function likeTerm(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/* ── Profiles ───────────────────────────────────────────────────────────── */

/**
 * The canonical public profile, addressed by username.
 *
 * A separate path segment from `/api/users/:id/profile` rather than a
 * polymorphic `:idOrUsername`, because a route that accepts either is a route
 * that can be handed an id where a username was expected and answer about the
 * wrong person. The client's `/users/@name` URL resolves here; the id form
 * remains for internal links that already hold an id.
 */
router.get('/api/users/by-username/:username', authenticateToken, requireCap('directory.read'), (req, res) => {
  const row = db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE AND ${LIVE_USER}`)
    .get(req.params.username);
  if (!row) return res.status(404).json({ error: 'No account with that username.', code: 'not_found' });
  res.json(buildProfileResponse(req, row));
});

/** The same profile, addressed by id. */
router.get('/api/users/:id/public-profile', authenticateToken, requireCap('directory.read'), (req, res) => {
  const row = db.prepare(`SELECT * FROM users WHERE id = ? AND ${LIVE_USER}`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such account.', code: 'not_found' });
  res.json(buildProfileResponse(req, row));
});

function buildProfileResponse(req, row) {
  const viewerId = req.principal.userId;
  const isFriend = areFriends(db, viewerId, row.id);
  const profile = publicProfile(db, row, {
    viewerId,
    canSeeContact: can(req.principal, 'user.contact.read'),
    isFriend,
  });
  return {
    profile,
    /**
     * The viewer's own standing, not a property of the subject. Kept in a
     * sibling key rather than merged into `profile` so that no caller can
     * mistake "you have muted this person" for something the subject published.
     *
     * `restrictedBy` is STRIPPED before it goes over the wire. Restriction is
     * documented in relationships.js as invisible to its subject — that is the
     * whole difference between it and blocking, and the reason a student who
     * wants distance without a confrontation has something to reach for. Sending
     * the flag told the restricted person directly, and the client rendered it
     * as a missing Add-friend button that appears on every other profile. To the
     * restricted party this must be indistinguishable from no relationship,
     * which is what deleting the key achieves.
     *
     * The 409 on a friend request is a knowable signal and a deliberate
     * trade-off — refusing silently would be a worse lie. Leaking the state on
     * every profile GET was not a trade-off, just an oversight.
     */
    viewer: (() => {
      const { restrictedBy, ...visible } = relationshipState(db, viewerId, row.id);
      return visible;
    })(),
  };
}

/**
 * The itemised service history — separately, and behind a narrower gate.
 *
 * The list carries every past event's title, its location and its exact times.
 * For a minor that is a record of where they have been and when, so it is not
 * in the public profile at any privacy setting. Self, or staff holding
 * `user.contact.read`.
 */
router.get('/api/users/:id/service-record', authenticateToken, requireCap('directory.read'), (req, res) => {
  const targetId = req.params.id;
  const isSelf = targetId === req.principal.userId;

  /**
   * The same rule `GET /api/users/:id/profile` applies to its `completed`
   * array, restated here against the same three conditions rather than a
   * narrower set of two.
   *
   * Two endpoints returning the same rows under different rules is the failure
   * this file's header warns about, and it does not matter which of the two is
   * stricter — the looser one is the effective policy either way. An organizer
   * reviewing somebody who applied to THEIR event is the applicant-review
   * workflow and is a reviewed decision (see the note in userRoutes.js and the
   * test that pins it); it requires an application this organizer cannot
   * manufacture.
   */
  const hostsApplicant = can(req.principal, 'applicant.review') && Boolean(db.prepare(`
    SELECT 1 FROM applications a
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id = ? AND e.organizer_id = ?
    LIMIT 1
  `).get(targetId, req.principal.userId));

  if (!isSelf && !can(req.principal, 'user.contact.read') && !hostsApplicant) {
    return res.status(403).json({ error: 'That volunteer\'s detailed service record is not public.', code: 'forbidden' });
  }
  const row = db.prepare(`SELECT id FROM users WHERE id = ? AND ${LIVE_USER}`).get(targetId);
  if (!row) return res.status(404).json({ error: 'No such account.', code: 'not_found' });

  const completed = db.prepare(`
    SELECT e.id AS eventId, e.title, e.location, e.category, e.credits_hours AS creditsHours,
           s.start_datetime AS startDatetime, s.end_datetime AS endDatetime,
           at.present, at.hours_awarded AS hoursAwarded
    FROM attendance at
    JOIN slots s ON s.id = at.slot_id
    JOIN events e ON e.id = at.event_id
    WHERE at.user_id = ?
    ORDER BY s.start_datetime DESC
    LIMIT 200
  `).all(targetId);

  const external = db.prepare(`
    SELECT id, organization_name AS organizationName, activity_name AS activityName,
           description, occurred_on AS occurredOn, hours, status, review_note AS reviewNote
    FROM external_hours WHERE user_id = ? ORDER BY occurred_on DESC LIMIT 200
  `).all(targetId);

  res.json({
    completed: completed.map(r => ({ ...r, present: r.present === 1, creditsHours: r.creditsHours !== 0 })),
    external,
    stats: volunteerStats(db, targetId),
  });
});

/* ── Search ─────────────────────────────────────────────────────────────── */

/**
 * People and organizations in one endpoint.
 *
 * One request rather than two, because the client shows one result list and two
 * requests would make it flicker as they land at different times. `type`
 * narrows it when a caller genuinely wants one kind.
 *
 * Every user row goes through `profileSummary`, which is a strict subset of the
 * public baseline — so there is no field search can show that the profile would
 * withhold. Suspended and deleted accounts are excluded outright.
 */
router.get('/api/directory/search', authenticateToken, requireCap('directory.read'), (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const type = ['users', 'organizations', 'all'].includes(req.query.type) ? req.query.type : 'all';
  const limit = boundedLimit(req.query.limit);
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

  if (q.length < SEARCH_MIN) {
    return res.json({ users: [], organizations: [], query: q, tooShort: true });
  }
  const term = likeTerm(q);

  let users = [];
  if (type !== 'organizations') {
    /**
     * `LIMIT n + 1` is how `hasMore` is answered without a second COUNT over
     * the whole table. The extra row is dropped before it reaches the client.
     */
    const rows = db.prepare(`
      SELECT id, username, name, avatar, profile_picture_url, role, location
      FROM users
      WHERE ${LIVE_USER}
        AND (name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')
      ORDER BY
        /* Exact username first, then prefix matches, then the rest. A student
           searching for a friend's exact handle should not have to scroll. */
        CASE WHEN username = ? COLLATE NOCASE THEN 0
             WHEN username LIKE ? ESCAPE '\\' THEN 1
             WHEN name LIKE ? ESCAPE '\\' THEN 2
             ELSE 3 END,
        name COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(term, term, q, `${q}%`, `${q}%`, limit + 1, offset);
    users = rows.slice(0, limit).map(profileSummary);
    res.locals.usersHasMore = rows.length > limit;
  }

  let organizations = [];
  if (type !== 'users') {
    /**
     * Member and event counts are computed in the same statement as the
     * organizations, as correlated subqueries against indexed columns — not by
     * looping the results and counting each. Twenty results would otherwise be
     * forty extra queries.
     */
    const rows = db.prepare(`
      SELECT o.*,
             (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS memberCount,
             (SELECT COUNT(*) FROM events e WHERE e.organization_id = o.id) AS eventCount
      FROM organizations o
      WHERE o.status = 'active' AND (o.name LIKE ? ESCAPE '\\' OR o.slug LIKE ? ESCAPE '\\')
      ORDER BY o.name COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(term, term, limit + 1, offset);
    organizations = rows.slice(0, limit).map(formatOrganization);
    res.locals.orgsHasMore = rows.length > limit;
  }

  res.json({
    query: q,
    users,
    organizations,
    hasMore: Boolean(res.locals.usersHasMore || res.locals.orgsHasMore),
  });
});

/* ── Relationships ──────────────────────────────────────────────────────── */

/** Resolves and validates the target of a relationship action. */
function resolveTarget(req, res) {
  const targetId = req.params.id;
  if (targetId === req.principal.userId) {
    res.status(400).json({ error: 'That action does not apply to your own account.', code: 'self_target' });
    return null;
  }
  const row = db.prepare(`SELECT id, name FROM users WHERE id = ? AND ${LIVE_USER}`).get(targetId);
  if (!row) {
    res.status(404).json({ error: 'No such account.', code: 'not_found' });
    return null;
  }
  return row;
}

/**
 * Send a friend request, or accept one already waiting from this person.
 *
 * Refused when either party has blocked or restricted the other. Refusing here
 * as well as in the notification fan-out is deliberate belt-and-braces: the
 * fan-out check is what protects the data, and this one is what stops a
 * restricted account discovering it has been restricted by watching a request
 * silently do nothing.
 */
router.post('/api/users/:id/friend', authenticateToken, requireCap('relationship.manage'), (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;

  const state = relationshipState(db, req.principal.userId, target.id);
  if (state.blocked || state.restricted || state.restrictedBy) {
    return res.status(409).json({ error: 'You cannot add this person as a friend.', code: 'not_permitted' });
  }

  const result = requestFriend(db, req.principal.userId, target.id);

  /**
   * The request itself is a notification, and the accepted case is another.
   * Both are best-effort: a signup or a friendship must never fail because a
   * notification could not be written.
   */
  try {
    const actor = db.prepare('SELECT name, username FROM users WHERE id = ?').get(req.principal.userId);
    const payload = { actorName: actor.name, actorUsername: actor.username };
    if (result.status === 'pending' && result.created) {
      notificationService.dispatch('FRIEND_REQUEST', payload, target.id, `friend-request:${req.principal.userId}`);
    } else if (result.status === 'accepted') {
      /* The person who ASKED is the one told it was accepted, which is the
         other party here — this branch runs when the actor completed somebody
         else's inbound request by tapping Add back. */
      notificationService.dispatch('FRIEND_ACCEPTED', payload, target.id, `friend-accepted:${req.principal.userId}`);
    }
  } catch { /* best effort — see above */ }

  res.json({ status: result.status, ...relationshipState(db, req.principal.userId, target.id) });
});

/** Accept a pending inbound request explicitly. */
router.post('/api/users/:id/friend/accept', authenticateToken, requireCap('relationship.manage'), (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  const ok = acceptFriend(db, req.principal.userId, target.id);
  if (!ok) return res.status(404).json({ error: 'There is no friend request from that person.', code: 'no_request' });
  res.json(relationshipState(db, req.principal.userId, target.id));
});

/** Unfriend, decline, or withdraw — all the same removal. */
router.delete('/api/users/:id/friend', authenticateToken, requireCap('relationship.manage'), (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  removeFriend(db, req.principal.userId, target.id);
  res.json(relationshipState(db, req.principal.userId, target.id));
});

/**
 * Mute and restrict.
 *
 * One pair of routes over a `kind` path parameter rather than four routes,
 * because the two differ only in what `relationships.js` does with the word —
 * and that difference belongs in the module that documents it, not spread over
 * four handlers that could drift.
 */
router.post('/api/users/:id/:kind(mute|restrict)', authenticateToken, requireCap('relationship.manage'), (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  setUnilateral(db, req.principal.userId, target.id, req.params.kind);
  res.json(relationshipState(db, req.principal.userId, target.id));
});

router.delete('/api/users/:id/:kind(mute|restrict)', authenticateToken, requireCap('relationship.manage'), (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  clearUnilateral(db, req.principal.userId, target.id, req.params.kind);
  res.json(relationshipState(db, req.principal.userId, target.id));
});

/** The caller's own friends and pending requests. */
router.get('/api/me/friends', authenticateToken, requireCap('relationship.manage'), (req, res) => {
  const me = req.principal.userId;
  const rows = db.prepare(`
    SELECT r.kind, r.status, r.actor_id, r.subject_id,
           u.id, u.username, u.name, u.avatar, u.profile_picture_url, u.role, u.location
    FROM user_relationships r
    JOIN users u ON u.id = CASE WHEN r.actor_id = ? THEN r.subject_id ELSE r.actor_id END
    WHERE r.kind = 'friend' AND (r.actor_id = ? OR r.subject_id = ?)
      AND u.account_status = 'active'
    ORDER BY u.name COLLATE NOCASE
    LIMIT 500
  `).all(me, me, me);

  const friends = [], incoming = [], outgoing = [];
  for (const r of rows) {
    const summary = profileSummary(r);
    if (r.status === 'accepted') friends.push(summary);
    else if (r.actor_id === me) outgoing.push(summary);
    else incoming.push(summary);
  }
  res.json({ friends, incoming, outgoing });
});

/** The caller's own mutes and restrictions, so Settings can list and lift them. */
router.get('/api/me/relationships', authenticateToken, requireCap('relationship.manage'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.kind, u.id, u.username, u.name, u.avatar, u.profile_picture_url, u.role, u.location
    FROM user_relationships r
    JOIN users u ON u.id = r.subject_id
    WHERE r.actor_id = ? AND r.kind IN ('mute', 'restrict') AND u.account_status = 'active'
    ORDER BY u.name COLLATE NOCASE
  `).all(req.principal.userId);
  res.json({
    muted: rows.filter(r => r.kind === 'mute').map(profileSummary),
    restricted: rows.filter(r => r.kind === 'restrict').map(profileSummary),
  });
});

export default router;
