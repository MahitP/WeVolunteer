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
import { can, requireCap, principalFor } from '../authz.js';
import { db } from '../db.js';
import { publicProfile, profileSummary } from '../profileSerializer.js';
import { volunteerStats } from '../volunteerStats.js';
import {
  areFriends, relationshipState, viewerRelationshipState, requestFriend, acceptFriend,
  removeFriend, setUnilateral, clearUnilateral,
} from '../relationships.js';
import { formatOrganization } from '../organizations.js';
/* The tag vocabulary is shared with events, so `#nhs` means the same thing in
   both halves of discovery. */
import { normaliseTag } from '../eventTags.js';
import { notificationService } from '../services/notificationService.js';
import { jsonArrayContains, caseInsensitiveLike } from '../db/dialectSql.js';

const router = express.Router();

const SEARCH_MIN = 2;
const SEARCH_MAX_LIMIT = 25;

/**
 * How deep the result set may be paged.
 *
 * The limit below bounds one REQUEST; without a companion bound on `offset` it
 * bounds nothing at all, because `?offset=0,25,50,…` walks the same rows out in
 * pages. That is the enumeration the limit exists to prevent, run twice as
 * slowly — and on a platform whose members are schoolchildren, a complete list
 * of names, handles and general locations is the thing worth not handing over.
 *
 * Eight pages is past where anybody is still reading results and well into
 * harvesting them: a student looking for somebody they know refines the query,
 * they do not scroll to result 300. Deeper paging answers 400 rather than an
 * empty page, so a caller that genuinely wanted more is told to narrow the
 * search instead of quietly receiving nothing.
 */
const SEARCH_MAX_OFFSET = 200;

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
  return `${'%'}${likeEscape(q)}${'%'}`;
}

/** The same escaping, without the surrounding wildcards. */
function likeEscape(q) {
  return String(q).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A prefix pattern — "starts with q" — with q escaped.
 *
 * The ranking clauses used to interpolate the RAW query here while the `WHERE`
 * used the escaped one, so `likeTerm`'s whole purpose was honoured in the
 * filter and skipped three lines later in the sort. Nothing leaked, because the
 * rows had already been filtered on the escaped value — but it is an unescaped
 * user string inside a LIKE in the one function whose job is escaping, and it
 * would have become a hole the moment anybody moved that predicate up into the
 * `WHERE`.
 */
function likePrefix(q) {
  return `${likeEscape(q)}%`;
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
router.get('/api/users/by-username/:username', authenticateToken, requireCap('directory.read'), async (req, res) => {
  const row = await db.prepare(`SELECT * FROM users WHERE username = ? COLLATE nocase AND ${LIVE_USER}`)
    .get(req.params.username);
  if (!row) return res.status(404).json({ error: 'No account with that username.', code: 'not_found' });
  res.json(await buildProfileResponse(req, row));
});

/** The same profile, addressed by id. */
router.get('/api/users/:id/public-profile', authenticateToken, requireCap('directory.read'), async (req, res) => {
  const row = await db.prepare(`SELECT * FROM users WHERE id = ? AND ${LIVE_USER}`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such account.', code: 'not_found' });
  res.json(await buildProfileResponse(req, row));
});

async function buildProfileResponse(req, row) {
  const viewerId = req.principal.userId;
  const isFriend = await areFriends(db, viewerId, row.id);
  const profile = await publicProfile(db, row, {
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
     * `restrictedBy` is STRIPPED before it goes over the wire — by
     * `viewerRelationshipState`, which is now the ONLY shape any handler in this
     * file sends to the viewer it describes. It used to be an inline destructure
     * here and nowhere else, so the flag went out unmodified on unfriend,
     * accept, mute, restrict and their clears: muting somebody who had
     * restricted you made your own Add-friend button vanish, which is exactly
     * the tell this strip exists to remove.
     *
     * The 409 on a friend request is a knowable signal and a deliberate
     * trade-off — refusing silently would be a worse lie. Leaking the state on
     * every other relationship response was not a trade-off, just an oversight.
     */
    viewer: await viewerRelationshipState(db, viewerId, row.id),
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
router.get('/api/users/:id/service-record', authenticateToken, requireCap('directory.read'), async (req, res) => {
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
  const hostsApplicant = can(req.principal, 'applicant.review') && Boolean(await db.prepare(`
    SELECT 1 FROM applications a
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id = ? AND e.organizer_id = ?
    LIMIT 1
  `).get(targetId, req.principal.userId));

  if (!isSelf && !can(req.principal, 'user.contact.read') && !hostsApplicant) {
    return res.status(403).json({ error: 'That volunteer\'s detailed service record is not public.', code: 'forbidden' });
  }
  const row = await db.prepare(`SELECT id FROM users WHERE id = ? AND ${LIVE_USER}`).get(targetId);
  if (!row) return res.status(404).json({ error: 'No such account.', code: 'not_found' });

  const completed = await db.prepare(`
    SELECT e.id AS "eventId", e.title, e.location, e.category, e.credits_hours AS "creditsHours",
           s.start_datetime AS "startDatetime", s.end_datetime AS "endDatetime",
           at.present, at.hours_awarded AS "hoursAwarded"
    FROM attendance at
    JOIN slots s ON s.id = at.slot_id
    JOIN events e ON e.id = at.event_id
    WHERE at.user_id = ?
    ORDER BY s.start_datetime DESC
    LIMIT 200
  `).all(targetId);

  /**
   * The external log is returned to the SUBJECT and to nobody else — not to
   * staff, and not to the organizer reviewing their application.
   *
   * It used to be on this payload for every reader the record is disclosed to,
   * along with a `status` and a `reviewNote` that no longer exist. Both halves
   * were wrong. External entries are a personal note about service somebody did
   * elsewhere: nobody checked them, so they are not evidence, and putting them
   * in front of an organizer deciding whether to accept an applicant turns a
   * private log into part of an application — which is the one thing this
   * feature is not. Where an organizer needs a record, `completed` is the record:
   * it is the service this platform can actually vouch for.
   */
  const external = isSelf ? (await db.prepare(`
    SELECT id, organization_name AS "organizationName", activity_name AS "activityName",
           description, occurred_on AS "occurredOn", hours
    FROM external_hours WHERE user_id = ? ORDER BY occurred_on DESC LIMIT 200
  `).all(targetId)).map(r => ({ ...r, selfReported: true })) : [];

  res.json({
    completed: completed.map(r => ({ ...r, present: r.present === 1, creditsHours: r.creditsHours !== 0 })),
    external,
    externalWithheld: !isSelf,
    stats: await volunteerStats(db, targetId),
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
router.get('/api/directory/search', authenticateToken, requireCap('directory.read'), async (req, res) => {
  /**
   * NUL bytes are stripped before the value can reach a query.
   *
   * PostgreSQL refuses `\0` inside a text value outright — `invalid byte
   * sequence for encoding "UTF8": 0x00` — and the refusal happens at the driver,
   * so it surfaces as a 500 rather than as an empty result. SQLite stores the
   * byte happily, which is why `?q=@abc%00def` was a harmless no-match there and
   * an unauthenticated 500 here.
   *
   * Stripped rather than rejected: a NUL in a search box is never a deliberate
   * query, and answering 400 to it would tell a prober they had found an edge
   * the server treats specially. Removing it makes the search mean what the
   * visible characters say.
   */
  const raw = String(req.query.q ?? '').replace(/\0/g, '').trim();

  /**
   * ── Two sigils, because a searcher already knows which kind they want ──
   *
   * `@handle` searches PEOPLE and nothing else. `#tag` searches TAGGED things —
   * opportunities and organizations — and no people. Both are conventions
   * borrowed from everywhere else a teenager types into a search box, so
   * neither needs explaining, and both narrow a mixed result list that is
   * otherwise the price of putting three kinds of thing behind one field.
   *
   * The sigil OVERRIDES the `type` parameter rather than combining with it: a
   * caller that sends `?q=@alice&type=organizations` has asked two contradictory
   * questions, and the one the user typed is the one to honour. `intent` goes
   * back in the response so the client can label what it narrowed to.
   *
   * A bare `@` or `#` is not a search — the sigil with nothing after it is
   * somebody mid-keystroke, and it falls through to the `tooShort` branch below
   * rather than matching everything.
   */
  const sigil = raw.startsWith('@') ? 'users' : raw.startsWith('#') ? 'tag' : null;
  const q = sigil ? raw.slice(1).trim() : raw;

  const requestedType = ['users', 'organizations', 'all'].includes(req.query.type)
    ? req.query.type : 'all';
  const type = sigil === 'users' ? 'users'
    : sigil === 'tag' ? 'organizations'
      : requestedType;
  const limit = boundedLimit(req.query.limit);
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

  /* Refused rather than clamped: silently capping the offset would serve page 9
     the contents of page 8, which reads as duplicated results rather than as a
     boundary. See SEARCH_MAX_OFFSET. */
  if (offset > SEARCH_MAX_OFFSET) {
    return res.status(400).json({
      error: 'That is further than search will page. Try a more specific search.',
      code: 'offset_too_deep',
    });
  }

  if (q.length < SEARCH_MIN) {
    return res.json({ users: [], organizations: [], query: q, tooShort: true });
  }
  const term = likeTerm(q);
  const prefix = likePrefix(q);
  /* The normalised key a `#tag` search compares against — the same form
     `event_tags.tag` stores, so one spelling finds the same things on both
     sides. `normaliseTag` returns null for anything that is not a usable tag,
     which the empty-result branch below treats as "no matches". */
  const tagKey = sigil === 'tag' ? (normaliseTag(q)?.tag ?? null) : null;

  let users = [];
  if (type !== 'organizations') {
    /**
     * `LIMIT n + 1` is how `hasMore` is answered without a second COUNT over
     * the whole table. The extra row is dropped before it reaches the client.
     */
    /* SQLite's LIKE ignores case; PostgreSQL's does not, so `@Ana` silently
       stopped matching the handle `ana` — an empty result, not an error. */
    const LIKE = caseInsensitiveLike(db);
    const rows = await db.prepare(`
      SELECT id, username, name, avatar, profile_picture_url, role, location
      FROM users
      WHERE ${LIVE_USER}
        AND (name ${LIKE} ? ESCAPE '\\' OR username ${LIKE} ? ESCAPE '\\')
      ORDER BY
        /* Exact username first, then prefix matches, then the rest. A student
           searching for a friend's exact handle should not have to scroll. */
        CASE WHEN username = ? COLLATE nocase THEN 0
             WHEN username ${LIKE} ? ESCAPE '\\' THEN 1
             WHEN name LIKE ? ESCAPE '\\' THEN 2
             ELSE 3 END,
        name COLLATE nocase
      LIMIT ? OFFSET ?
    `).all(term, term, q, prefix, prefix, limit + 1, offset);
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
     *
     * ── `#tag` matches TAGS, not names ──
     *
     * `organizations.tags` is a JSON array of the labels an organizer typed, so
     * the match walks it with `json_each` rather than pattern-matching the
     * serialised text: a LIKE over the raw JSON would match a tag that merely
     * CONTAINS the query, and would also match the word appearing inside some
     * other tag's label. Comparison is on the normalised form — lower-cased,
     * `#` stripped, whitespace collapsed — which is exactly what `event_tags.tag`
     * stores, so one spelling of a tag finds the same things on both sides.
     */
    const rows = sigil === 'tag'
      ? await db.prepare(`
        SELECT o.*,
               (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS "memberCount",
               (SELECT COUNT(*) FROM events e WHERE e.organization_id = o.id) AS "eventCount"
        FROM organizations o
        WHERE o.status = 'active'
          AND o.tags IS NOT NULL
          AND ${jsonArrayContains(db, 'o.tags', '?')}
        ORDER BY o.name COLLATE nocase
        LIMIT ? OFFSET ?
      `).all(tagKey, limit + 1, offset)
      : await db.prepare(`
        SELECT o.*,
               (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS "memberCount",
               (SELECT COUNT(*) FROM events e WHERE e.organization_id = o.id) AS "eventCount"
        FROM organizations o
        WHERE o.status = 'active' AND (o.name LIKE ? ESCAPE '\\' OR o.slug LIKE ? ESCAPE '\\')
        ORDER BY o.name COLLATE nocase
        LIMIT ? OFFSET ?
      `).all(term, term, limit + 1, offset);
    organizations = rows.slice(0, limit).map(formatOrganization);
    res.locals.orgsHasMore = rows.length > limit;
  }

  res.json({
    query: q,
    /* What the sigil narrowed to, so the client can say so rather than leaving
       the reader to infer it from an unexpectedly short list. */
    intent: sigil ?? 'all',
    users,
    organizations,
    hasMore: Boolean(res.locals.usersHasMore || res.locals.orgsHasMore),
  });
});

/* ── Relationships ──────────────────────────────────────────────────────── */

/** Resolves and validates the target of a relationship action. */
async function resolveTarget(req, res) {
  const targetId = req.params.id;
  if (targetId === req.principal.userId) {
    res.status(400).json({ error: 'That action does not apply to your own account.', code: 'self_target' });
    return null;
  }
  const row = await db.prepare(`SELECT id, name, role FROM users WHERE id = ? AND ${LIVE_USER}`).get(targetId);
  if (!row) {
    res.status(404).json({ error: 'No such account.', code: 'not_found' });
    return null;
  }
  return row;
}

/**
 * ── Friendship is a relation between PEERS, and organizers are not peers ──
 *
 * Every role holding `relationship.manage` could send a friend request to any
 * member, which meant an adult running events could send one to a fourteen-year-
 * old who had applied to their shift. That is the wrong shape for this platform,
 * for reasons the codebase already argues elsewhere:
 *
 *   • An accepted friendship unlocks the friends-only profile tier — school,
 *     grade, bio — and the signup notifications. `relationships.js` says a
 *     unilateral follow "would let any account subscribe to a minor's schedule
 *     without them agreeing"; a request from the adult who decides whether they
 *     get placed on shifts is not meaningfully refusable either. The consent a
 *     request is supposed to obtain is not consent under that asymmetry.
 *   • Blocking is already gated on `event.apply` rather than on a role, with the
 *     note that an organizer able to block "would be able to sever the channel a
 *     student would use to complain about them". The same asymmetry, recognised
 *     in the same terms, one control along.
 *   • An organizer is not short of ways to reach a volunteer: messaging is
 *     scoped to the events they host, and applicant details are on the review
 *     screen. Friendship adds nothing professional and carries everything social.
 *
 * `event.apply` is the test, and it is the right one rather than a convenient
 * one: it means "this account takes part as a volunteer", which is exactly the
 * population friendship is for. Organizer, admin and partner do not hold it.
 * super_admin does — through the wildcard, and correctly, because the owner of
 * this platform is a high-school student who volunteers (see the distinguished
 * profile note), so their student half is a peer like any other.
 *
 * BOTH sides are checked. Testing only the sender would let a student send a
 * request to an organizer that the organizer could never accept — a row nobody
 * can resolve, and a button that appears to work.
 */
function refusePeerOnly(req, res, targetRow) {
  const targetPrincipal = principalFor(targetRow);
  if (can(req.principal, 'event.apply') && can(targetPrincipal, 'event.apply')) return false;

  /* Deliberately the same generic refusal a block produces. Naming the reason
     would tell a student which of the two accounts was disqualified, and there
     is nothing useful they can do with that. */
  res.status(409).json({
    error: 'You cannot add this person as a friend.',
    code: 'not_permitted',
  });
  return true;
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
router.post('/api/users/:id/friend', authenticateToken, requireCap('relationship.manage'), async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;

  if (refusePeerOnly(req, res, target)) return;

  const state = await relationshipState(db, req.principal.userId, target.id);
  if (state.blocked || state.restricted || state.restrictedBy) {
    return res.status(409).json({ error: 'You cannot add this person as a friend.', code: 'not_permitted' });
  }

  const result = await requestFriend(db, req.principal.userId, target.id);

  /**
   * The request itself is a notification, and the accepted case is another.
   * Both are best-effort: a signup or a friendship must never fail because a
   * notification could not be written.
   */
  try {
    const actor = await db.prepare('SELECT name, username FROM users WHERE id = ?').get(req.principal.userId);
    const payload = { actorName: actor.name, actorUsername: actor.username };
    if (result.status === 'pending' && result.created) {
      await notificationService.dispatch('FRIEND_REQUEST', payload, target.id, `friend-request:${req.principal.userId}`);
    } else if (result.status === 'accepted') {
      /* The person who ASKED is the one told it was accepted, which is the
         other party here — this branch runs when the actor completed somebody
         else's inbound request by tapping Add back. */
      await notificationService.dispatch('FRIEND_ACCEPTED', payload, target.id, `friend-accepted:${req.principal.userId}`);
    }
  } catch { /* best effort — see above */ }

  res.json({ status: result.status, ...(await viewerRelationshipState(db, req.principal.userId, target.id)) });
});

/** Accept a pending inbound request explicitly. */
router.post('/api/users/:id/friend/accept', authenticateToken, requireCap('relationship.manage'), async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;
  /* The same peer rule as sending. A row written before this rule existed must
     not become a friendship by being accepted afterwards — the accept side is
     where such a row would otherwise complete. Removal is deliberately NOT
     gated: anybody may always get out of a relationship, whatever created it. */
  if (refusePeerOnly(req, res, target)) return;
  const ok = await acceptFriend(db, req.principal.userId, target.id);
  if (!ok) return res.status(404).json({ error: 'There is no friend request from that person.', code: 'no_request' });
  res.json(await viewerRelationshipState(db, req.principal.userId, target.id));
});

/** Unfriend, decline, or withdraw — all the same removal. */
router.delete('/api/users/:id/friend', authenticateToken, requireCap('relationship.manage'), async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;
  await removeFriend(db, req.principal.userId, target.id);
  res.json(await viewerRelationshipState(db, req.principal.userId, target.id));
});

/**
 * Mute and restrict.
 *
 * One pair of routes over a `kind` path parameter rather than four routes,
 * because the two differ only in what `relationships.js` does with the word —
 * and that difference belongs in the module that documents it, not spread over
 * four handlers that could drift.
 */
router.post('/api/users/:id/:kind(mute|restrict)', authenticateToken, requireCap('relationship.manage'), async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;
  await setUnilateral(db, req.principal.userId, target.id, req.params.kind);
  res.json(await viewerRelationshipState(db, req.principal.userId, target.id));
});

router.delete('/api/users/:id/:kind(mute|restrict)', authenticateToken, requireCap('relationship.manage'), async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return;
  await clearUnilateral(db, req.principal.userId, target.id, req.params.kind);
  res.json(await viewerRelationshipState(db, req.principal.userId, target.id));
});

/** The caller's own friends and pending requests. */
router.get('/api/me/friends', authenticateToken, requireCap('relationship.manage'), async (req, res) => {
  const me = req.principal.userId;
  const rows = await db.prepare(`
    SELECT r.kind, r.status, r.actor_id, r.subject_id,
           u.id, u.username, u.name, u.avatar, u.profile_picture_url, u.role, u.location
    FROM user_relationships r
    JOIN users u ON u.id = CASE WHEN r.actor_id = ? THEN r.subject_id ELSE r.actor_id END
    WHERE r.kind = 'friend' AND (r.actor_id = ? OR r.subject_id = ?)
      AND u.account_status = 'active'
    ORDER BY u.name COLLATE nocase
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
router.get('/api/me/relationships', authenticateToken, requireCap('relationship.manage'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT r.kind, u.id, u.username, u.name, u.avatar, u.profile_picture_url, u.role, u.location
    FROM user_relationships r
    JOIN users u ON u.id = r.subject_id
    WHERE r.actor_id = ? AND r.kind IN ('mute', 'restrict') AND u.account_status = 'active'
    ORDER BY u.name COLLATE nocase
  `).all(req.principal.userId);
  res.json({
    muted: rows.filter(r => r.kind === 'mute').map(profileSummary),
    restricted: rows.filter(r => r.kind === 'restrict').map(profileSummary),
  });
});

export default router;
