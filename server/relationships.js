/**
 * Friend, mute, and restrict.
 *
 * Kept out of the route files for the same reason `authz.js`, `consent.js` and
 * `blocking.js` are: what each of these words MEANS has one home, and it is
 * testable without booting a listener.
 *
 * ── Four controls, four different jobs ──
 *
 * The four together are deliberately not a severity ladder with one knob. Each
 * answers a different question, and a student reaching for one of them usually
 * knows which question they are asking:
 *
 *   Mute      "I don't want to hear about this person."
 *             Silences notifications ABOUT them — their signups stop reaching
 *             my bell. Entirely one-sided and entirely invisible: they are
 *             never told, nothing they can do changes, and they keep every
 *             ability they had. Reversible with no cost.
 *
 *   Restrict  "I don't want them in my orbit, without making a scene."
 *             The least-privilege reading, and the one this product can
 *             actually enforce: they cannot send me a friend request, an
 *             accepted friendship is withdrawn, and my activity stops reaching
 *             them. They are not told, and — critically — nothing about their
 *             volunteering changes. They can still apply to the same events,
 *             still be on the same roster, still be marked present.
 *
 *   Block     "I do not want this person able to contact me."
 *             Already exists (blocking.js). Severs messaging, and does NOT
 *             touch the event relationship, for the reason set out there: a
 *             safety control that costs a student their service record forces
 *             them to weigh feeling unsafe against their graduation
 *             requirement.
 *
 *   Report    "Somebody needs to look at this."
 *             The existing moderation pipeline. Not a personal control at all —
 *             it asks a human to act, and it is the only one of the four that
 *             does.
 *
 * ── Why muting and restricting are not blocks ──
 *
 * A block is visible in its effects and is a moderation signal. Mute and
 * restrict are not, and that is the point of having them: the student who wants
 * one of these usually does not want a confrontation and does not want a
 * report filed. Offering only Block means a student who needs a small amount of
 * distance either takes the largest available action or takes none.
 *
 * ── Why a friendship must be accepted ──
 *
 * An accepted friendship is what unlocks knowing when somebody signs up for
 * something. If friending were unilateral, any account could subscribe to a
 * minor's schedule — where they will be, and when — without that minor ever
 * agreeing. The acceptance step is the consent, and it is why the notification
 * feature is safe to have at all.
 */

import crypto from 'node:crypto';
/* `user_blocks` is blocking.js's table, and a block is an answer this module has
   to respect — see `areFriends`. blocking.js imports nothing but node:crypto, so
   this direction cannot become a cycle. */
import { isBlockedBetween } from './blocking.js';
/* `authz.js` imports nothing at all — see its header — so reading the capability
   table here cannot create a cycle. */
import { can, principalFor } from './authz.js';

export const RELATIONSHIP_KINDS = Object.freeze(['friend', 'mute', 'restrict']);

const id = (prefix) => `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

/** The row for one directed relationship, or undefined. */
export function relationship(db, actorId, subjectId, kind) {
  return db.prepare(`
    SELECT * FROM user_relationships
    WHERE actor_id = ? AND subject_id = ? AND kind = ?
  `).get(actorId, subjectId, kind);
}

/**
 * True when an accepted friendship exists between these two, in either
 * direction.
 *
 * ONE row, not two: `requestFriend` inserts a single directed row and
 * `acceptFriend` flips its `status` to 'accepted', so the `OR` below is asking
 * "whoever sent it, has it been accepted" — not "do both halves exist". The
 * earlier wording said the latter, which matters because this is what unlocks
 * `bio`, `school` and `grade` on a friends-only profile: a reader who trusted
 * the comment would misjudge where that privacy boundary sits.
 *
 * ── A block ends the friendship, for disclosure purposes, immediately ──
 *
 * `block()` now withdraws the friendship row as `restrict` always has, so in a
 * database written by this version the second clause below never fires. It is
 * here for the databases written by the version before it, where blocking left
 * the row standing: a student blocked their harasser, `areFriends` kept
 * returning true, and `profile_visibility = 'friends'` kept handing that person
 * the blocker's school, grade and bio for as long as the row survived.
 *
 * Enforced HERE rather than at each call site on purpose. This function is the
 * single gate that unlocks the friends-only tier, so one check covers every
 * present and future consumer — the same argument `viewerRelationshipState`
 * makes for being the only shape a handler may send. A block is never a state
 * in which two accounts should be treated as friends by anything, so there is
 * no caller that would legitimately want the unfiltered answer.
 *
 * The extra read costs one indexed lookup on a table that is empty for almost
 * every pair, on a path that already runs `volunteerStats`.
 */
export function areFriends(db, a, b) {
  if (!a || !b || a === b) return false;
  if (isBlockedBetween(db, a, b)) return false;
  if (!arePeers(db, a, b)) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM user_relationships
    WHERE kind = 'friend' AND status = 'accepted'
      AND ((actor_id = ? AND subject_id = ?) OR (actor_id = ? AND subject_id = ?))
    LIMIT 1
  `).get(a, b, b, a));
}

/**
 * Whether these two accounts may be friends at all.
 *
 * ── Why friendship is peer-only ──
 *
 * An accepted friendship opens the friends-only profile tier — school, grade,
 * bio — and the signup notifications. Between two students that is a mutual
 * exchange between equals. Between an organizer and a student it is not: the
 * adult who decides whether a fourteen-year-old is placed on a shift would be
 * asking that student for access to their school and year, and "no" is a much
 * harder answer to give upward than sideways.
 *
 * ── Derived from a capability, never from a role name ──
 *
 * `event.apply` is the capability that means "this account volunteers here",
 * which is exactly the population for whom friendship is a peer relationship.
 * Reading it through `can()` rather than comparing `role` keeps this rule in
 * step with the authorization kernel automatically: a role added later is
 * classified by what it can DO, and `authz.completeness.test.js` forbids the
 * role-string spelling outright.
 *
 * ── Why it is also enforced on the READ side ──
 *
 * `requestFriend` and `acceptFriend` both refuse a non-peer pair, so no new row
 * can be created. That is not sufficient on its own. A row accepted BEFORE the
 * rule existed is already `status = 'accepted'`, and every check on the write
 * path has already run and passed for it — so the only thing standing between a
 * legacy organizer↔student row and that student's school, grade and bio is this
 * function. Gating creation without gating disclosure would have left the exact
 * exposure the rule was written to close, silently, on any database old enough
 * to contain one.
 *
 * Enforced here for the same reason the block check is: this is the single gate
 * that unlocks the friends-only tier, so one check covers every present and
 * future consumer.
 *
 * A missing or deleted account is not a peer — `principalFor` returns null for
 * it, and `can(null, …)` is false, so a relationship pointing at a row that is
 * gone grants nothing.
 */
export function arePeers(db, a, b) {
  const rows = db.prepare(
    'SELECT id, role FROM users WHERE id IN (?, ?)'
  ).all(a, b);
  if (rows.length !== 2) return false;
  return rows.every(row => can(principalFor(row), 'event.apply'));
}

/** True when either party has restricted the other. */
export function isRestrictedBetween(db, a, b) {
  return Boolean(db.prepare(`
    SELECT 1 FROM user_relationships
    WHERE kind = 'restrict'
      AND ((actor_id = ? AND subject_id = ?) OR (actor_id = ? AND subject_id = ?))
    LIMIT 1
  `).get(a, b, b, a));
}

/**
 * Sends or accepts a friend request.
 *
 * One call does both, because from the actor's point of view it is one button:
 * tapping "Add friend" on somebody who has already asked you should complete
 * the friendship rather than open a second, opposite request that both parties
 * then stare at.
 *
 * @returns {{status:'pending'|'accepted', created:boolean}}
 */
export function requestFriend(db, actorId, subjectId, { now = new Date().toISOString() } = {}) {
  const inbound = relationship(db, subjectId, actorId, 'friend');
  if (inbound && inbound.status === 'pending') {
    db.prepare(`UPDATE user_relationships SET status = 'accepted', responded_at = ? WHERE id = ?`)
      .run(now, inbound.id);
    return { status: 'accepted', created: false };
  }
  if (inbound && inbound.status === 'accepted') return { status: 'accepted', created: false };

  const existing = relationship(db, actorId, subjectId, 'friend');
  if (existing) return { status: existing.status, created: false };

  db.prepare(`
    INSERT INTO user_relationships (id, actor_id, subject_id, kind, status, created_at)
    VALUES (?, ?, ?, 'friend', 'pending', ?)
  `).run(id('rel'), actorId, subjectId, now);
  return { status: 'pending', created: true };
}

/** Accepts a pending inbound request. Returns false when there was none. */
export function acceptFriend(db, actorId, requesterId, { now = new Date().toISOString() } = {}) {
  const { changes } = db.prepare(`
    UPDATE user_relationships SET status = 'accepted', responded_at = ?
    WHERE actor_id = ? AND subject_id = ? AND kind = 'friend' AND status = 'pending'
  `).run(now, requesterId, actorId);
  return changes > 0;
}

/**
 * Removes a friendship or a request, in whichever direction it exists.
 *
 * Deliberately symmetric. Declining a request, withdrawing one you sent, and
 * unfriending are the same database operation, and giving them three endpoints
 * would give three chances to get the direction wrong.
 */
export function removeFriend(db, actorId, subjectId) {
  const { changes } = db.prepare(`
    DELETE FROM user_relationships
    WHERE kind = 'friend'
      AND ((actor_id = ? AND subject_id = ?) OR (actor_id = ? AND subject_id = ?))
  `).run(actorId, subjectId, subjectId, actorId);
  return changes > 0;
}

/** Records a mute or a restriction. Idempotent. */
export function setUnilateral(db, actorId, subjectId, kind, { now = new Date().toISOString() } = {}) {
  if (kind !== 'mute' && kind !== 'restrict') throw new Error(`Not a unilateral kind: ${kind}`);
  if (relationship(db, actorId, subjectId, kind)) return false;
  db.prepare(`
    INSERT INTO user_relationships (id, actor_id, subject_id, kind, status, created_at, responded_at)
    VALUES (?, ?, ?, ?, 'accepted', ?, ?)
  `).run(id('rel'), actorId, subjectId, kind, now, now);

  /**
   * Restricting also withdraws any friendship between the two.
   *
   * Leaving them friends would leave the restricted party still receiving the
   * restrictor's signup notifications, which is the precise thing the control
   * is being used to stop. A control that visibly does less than it says is
   * worse than not offering it.
   */
  if (kind === 'restrict') removeFriend(db, actorId, subjectId);
  return true;
}

/** Lifts a mute or a restriction. */
export function clearUnilateral(db, actorId, subjectId, kind) {
  const { changes } = db.prepare(`
    DELETE FROM user_relationships WHERE actor_id = ? AND subject_id = ? AND kind = ?
  `).run(actorId, subjectId, kind);
  return changes > 0;
}

/**
 * Everything one viewer needs to know about their standing with one subject,
 * in a single query rather than five.
 */
export function relationshipState(db, viewerId, subjectId) {
  if (!viewerId || !subjectId || viewerId === subjectId) {
    return {
      friendship: 'none', muted: false, restricted: false,
      blocked: false, blockedByViewer: false, restrictedBy: false
    };
  }
  const rows = db.prepare(`
    SELECT actor_id, subject_id, kind, status FROM user_relationships
    WHERE (actor_id = ? AND subject_id = ?) OR (actor_id = ? AND subject_id = ?)
  `).all(viewerId, subjectId, subjectId, viewerId);

  let friendship = 'none';
  let muted = false, restricted = false, restrictedBy = false;
  for (const r of rows) {
    const outbound = r.actor_id === viewerId;
    if (r.kind === 'friend') {
      friendship = r.status === 'accepted' ? 'friends' : outbound ? 'requested' : 'incoming';
    } else if (r.kind === 'mute' && outbound) muted = true;
    else if (r.kind === 'restrict') {
      if (outbound) restricted = true; else restrictedBy = true;
    }
  }

  /**
   * Blocking is read in BOTH directions, and reported as two separate facts.
   *
   * `blocked` — either party has blocked the other. This is what the internal
   *   gates want: a block suppresses messaging, notifications and the
   *   friends-only tier no matter who pressed the button.
   * `blockedByViewer` — the viewer blocked the subject. This is the only half
   *   that may be shown to the viewer, because it is the only half describing
   *   something they did themselves.
   *
   * Two columns rather than one, because `viewerRelationshipState` cannot
   * derive the safe answer from the symmetric one — see its header.
   */
  const blockRows = db.prepare(`
    SELECT blocker_id FROM user_blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
  `).all(viewerId, subjectId, subjectId, viewerId);

  const blocked = blockRows.length > 0;
  const blockedByViewer = blockRows.some(r => r.blocker_id === viewerId);

  return { friendship, muted, restricted, restrictedBy, blocked, blockedByViewer };
}

/**
 * The same state, with `restrictedBy` removed — the ONLY shape that may be sent
 * to the viewer it describes.
 *
 * ── Why this exists as its own function ──
 *
 * Restriction is documented above as invisible to its subject. That is the whole
 * difference between it and blocking, and the reason a student who wants
 * distance without a confrontation has something to reach for.
 *
 * `GET /api/users/:id/public-profile` knew that and stripped the flag inline.
 * Every OTHER handler that answers with a relationship state — unfriend, accept,
 * mute, restrict, and their clears — returned this object raw, so the flag went
 * out on the next request the restricted person made. It was not merely on the
 * wire: PublicProfile.jsx writes the response straight into `viewer` and hides
 * the Add-friend button on `viewer.restrictedBy`, so muting somebody who had
 * restricted you made your own Add-friend button disappear. That is precisely
 * the tell the inline strip existed to remove, reached by a different door.
 *
 * A named function rather than a second inline destructure, because the property
 * being protected is "no handler may forget", and five copies of a strip is five
 * chances to forget. `relationshipState` stays exported for the INTERNAL gates
 * that legitimately need the flag — the friend-request refusal reads it to decide
 * whether to allow the request at all, and that decision must see the truth.
 */
export function viewerRelationshipState(db, viewerId, subjectId) {
  const { restrictedBy, blockedByViewer, ...visible } = relationshipState(db, viewerId, subjectId);

  /**
   * ── `blocked` is narrowed to the viewer's OWN block ──
   *
   * `relationshipState.blocked` is symmetric, and sending it raw told the
   * blocked party they had been blocked — the same disclosure `restrictedBy`
   * is stripped to prevent, reached through the other flag in the same object.
   * It was not even ambiguous: `GET /api/blocks` returns the viewer's OUTBOUND
   * blocks only, so a viewer seeing `blocked: true` for somebody absent from
   * that list learns, in two requests, that the subject blocked them.
   *
   * Blocking is not secret the way restriction is — the blocked party finds out
   * the moment they try to message — but "they cannot reach you" and "here is a
   * definitive list of everyone who has blocked you" are different disclosures,
   * and only the first is a consequence anybody chose. The second is an
   * enumeration tool, and on a platform of minors that is worth refusing.
   *
   * The viewer's own block survives, because the Unblock control is built from
   * it (PublicProfile.jsx) and the viewer plainly already knows.
   */
  return { ...visible, blocked: blockedByViewer };
}

/**
 * Who should be told that `userId` signed up for something.
 *
 * The privacy decision is made HERE, in one query, before any notification row
 * exists — not by filtering a feed later. A recipient list that was never built
 * cannot be leaked by a future endpoint that forgets to re-apply the filter,
 * and there is no stored row for an audit to find.
 *
 * Four conditions, each of which independently empties the list:
 *
 *   1. The signer-up has `friend_activity_visible` on. Off means nobody, full
 *      stop — checked first so the rest of the query never runs.
 *   2. The friendship is accepted, in either direction.
 *   3. The recipient has not muted the signer-up.
 *   4. Neither has restricted or blocked the other.
 *
 * Returns [] rather than throwing on any of them, because the caller is a
 * signup and a signup must never fail because of a notification.
 */
export function friendsToNotify(db, userId) {
  const owner = db.prepare('SELECT friend_activity_visible FROM users WHERE id = ?').get(userId);
  if (!owner || owner.friend_activity_visible === 0) return [];

  return db.prepare(`
    SELECT DISTINCT friend_id FROM (
      SELECT subject_id AS friend_id FROM user_relationships
        WHERE actor_id = ? AND kind = 'friend' AND status = 'accepted'
      UNION
      SELECT actor_id AS friend_id FROM user_relationships
        WHERE subject_id = ? AND kind = 'friend' AND status = 'accepted'
    ) f
    JOIN users u ON u.id = f.friend_id
    WHERE u.account_status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM user_relationships r
        WHERE r.kind IN ('mute', 'restrict')
          AND ((r.actor_id = f.friend_id AND r.subject_id = ?)
            OR (r.actor_id = ? AND r.subject_id = f.friend_id AND r.kind = 'restrict'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks b
        WHERE (b.blocker_id = f.friend_id AND b.blocked_id = ?)
           OR (b.blocker_id = ? AND b.blocked_id = f.friend_id)
      )
  `).all(userId, userId, userId, userId, userId, userId).map(r => r.friend_id);
}
