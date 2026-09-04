/**
 * Inviting one named person into an organization.
 *
 * ── There is no token, and that is the security design ──
 *
 * `admin_invitations` is the in-repo precedent for inviting somebody: a
 * `crypto.randomBytes(32)` token, stored as a SHA-256 digest, mailed out, and
 * redeemable only by a signed-in account whose verified email address matches
 * the one invited. That last rule — its IV-7 — is the load-bearing one: the mail
 * is not the authority, the address is, so a forwarded or intercepted
 * invitation confers nothing.
 *
 * This module takes that rule to its conclusion. If the authority is the
 * identity of the person invited, then a bearer token is not a second factor —
 * it is a redundant credential that can leak, be logged, be shoulder-read off a
 * screen, or sit in a mailbox after the invitation is revoked. So there is no
 * token at all. An invitation names `invited_user_id`, and the only thing that
 * can accept it is a request whose authenticated principal IS that user.
 *
 * That is strictly stronger than the admin flow, and it needs no verified-email
 * check to get there, because there is nothing to redeem.
 *
 * ── Why not invite by email address ──
 *
 * Considered, and refused. Three arguments, in the order that decided it:
 *
 *   1. **It is an enumeration oracle over the platform's most private field.**
 *      `profileSerializer.js` puts `email` in `PRIVILEGED_FIELDS`, and
 *      `directoryRoutes.js` deliberately does not let anybody search by it. A
 *      form that takes an address and answers anything — "already a member",
 *      "invitation sent", a different latency — is the first place on this
 *      platform where a semi-trusted actor can act on an address they were
 *      never shown. `/api/auth/forgot-password` is written with one frozen
 *      response on every path precisely to avoid this, and an invitation form
 *      cannot be: an inviter has to be told whether their invitation went.
 *   2. **The actor is not comparable to an owner.** `admin.create` is
 *      owner-only and step-up gated. A club's `invite_policy` may be
 *      `'members'` — any student in the club. Copying a design justified by its
 *      caller being the most-trusted account on the platform onto its
 *      least-trusted one is how the reasoning gets lost.
 *   3. **The population is minors.** A club manager who can send mail from the
 *      platform's SPF/DKIM-passing domain, with club branding, to an arbitrary
 *      address, is a phishing capability. `server/email.escaping.test.js` exists
 *      because that concern was found live once already.
 *
 * The recruiting case email would serve — getting somebody who has no account
 * into a club — is already served, better, by a share link: it is a URL a human
 * chooses how to send, it names no address, and the platform never mails a
 * stranger on a club's behalf.
 *
 * ── Why an invitation cannot be resent after a decline ──
 *
 * `inviteUser` refuses when the person has already declined. The partial unique
 * index stops a second PENDING invitation; without this rule, a member could
 * decline-invite-decline-invite indefinitely, which is harassment with a queue
 * behind it. A declined person is not shut out of the club — they can still
 * join with a link or send a request, so the door they chose not to walk
 * through is still there. It is the tap on the shoulder that stops.
 *
 * ── `db` is a parameter ──
 *
 * Same reason as everywhere else in this feature: `db.js` opens its file at
 * module scope, so a module that imports it cannot be unit tested without one.
 */

import crypto from 'node:crypto';
import { NOTE_MAX } from './organizationPolicy.js';

export const INVITATION_STATUSES = Object.freeze([
  'pending', 'accepted', 'declined', 'revoked', 'expired',
]);

/**
 * How long an invitation stands.
 *
 * Fourteen days rather than the admin flow's seven. An administrator invitation
 * is authority awaiting collection and should lapse quickly; a club invitation
 * is an offer, and the person receiving it is a student who may not open the app
 * for a fortnight. It still lapses, because a pending invitation from last year
 * is a decision nobody remembers making.
 */
export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How many invitations one club may have outstanding at once — a PRODUCT SANITY
 * LIMIT, and the name says so.
 *
 * ── Reviewed as an abuse vector, because it is the one that looks like one ──
 *
 * An invitation reaches into another person's notifications and the recipients
 * are minors, so "unlimited pending invitations" is a fair thing to worry about.
 * The worry is answered by three mechanisms, none of which is this number:
 *
 *   - `idx_org_invitations_live`, a partial UNIQUE index over
 *     `(organization_id, invited_user_id) WHERE status = 'pending'`. One
 *     pending invitation per person per club, enforced by the DATABASE. This is
 *     the control that makes repeat-invitation impossible.
 *   - The decline-is-final rule in `inviteUser`. A person who says no cannot be
 *     asked again by that club, so decline-invite-decline is not a loop.
 *   - `joinAttemptLimiter` on the route: 20 per 15 minutes, keyed on the
 *     ACCOUNT. Reaching a hundred distinct recipients therefore takes over an
 *     hour of sustained effort, and the index means they must be a hundred
 *     DIFFERENT people.
 *
 * So the spam bound is the rate limiter and the index, both of which hold under
 * concurrency. This number bounds the length of a manager's own outstanding
 * list, which is a usability property.
 *
 * ── Why advisory is correct ──
 *
 * Nothing in authorization reads it. Overshoot is bounded by in-flight request
 * count and self-corrects on the next attempt, because the check re-reads — and
 * in-flight count here is itself capped at 20 per window by the limiter. Hard
 * enforcement would mean a lock or a counter column, paid to prevent a list
 * being briefly longer than a hundred.
 *
 * `organizations.softLimits.test.js` pins this, including that no database
 * constraint claims to enforce it.
 */
export const SOFT_MAX_PENDING_INVITATIONS = 100;

/**
 * How long the optional note may be — the same bound a join request's note has,
 * and the same constant, declared in `organizationPolicy.js` so the client's
 * character counter cannot drift from what the server accepts.
 */
export { NOTE_MAX } from './organizationPolicy.js';

const INVITATION_COLUMNS = `
  id, organization_id AS "organizationId", invited_user_id AS "invitedUserId",
  invited_by AS "invitedBy", message, status,
  created_at AS "createdAt", expires_at AS "expiresAt", resolved_at AS "resolvedAt"
`;

/**
 * Whether a stored row still stands.
 *
 * Expiry is computed rather than swept, so an invitation that lapsed at
 * midnight is refused at 00:00:01 without waiting for a worker. The stored
 * `'expired'` status exists for rows a manager's list has already reported as
 * lapsed; both are treated identically here, which is what stops a lapsed
 * invitation from being accepted by a request that arrives before the sweep.
 */
export function invitationState(invitation, now = new Date()) {
  if (!invitation) return 'missing';
  if (invitation.status !== 'pending') return invitation.status;
  const expiresAt = invitation.expiresAt ?? invitation.expires_at;
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

export const invitationStands = (invitation, now = new Date()) =>
  invitationState(invitation, now) === 'pending';

/**
 * The invitation this person holds for this club, or `null`.
 *
 * Returns whatever the newest row says, including a declined or revoked one,
 * because `inviteUser` needs to know about a decline and the page needs to know
 * not to offer Accept on a revoked one.
 */
export async function invitationFor(db, organizationId, userId) {
  return (await db.prepare(`
    SELECT ${INVITATION_COLUMNS}
      FROM organization_invitations
     WHERE organization_id = ? AND invited_user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `).get(organizationId, userId)) ?? null;
}

/** The invitation that stands for this person, or `null`. */
export async function pendingInvitationFor(db, organizationId, userId, { now = new Date() } = {}) {
  const invitation = await invitationFor(db, organizationId, userId);
  return invitationStands(invitation, now) ? invitation : null;
}

/**
 * Every invitation this club has outstanding, oldest first.
 *
 * Joined to `users` and returned as flat rows, which is the shape
 * `profileSummary` takes — so who may see what about the invited person is
 * decided by the one serializer that owns that question rather than by the
 * SELECT list here. An invitation whose recipient has since deleted their
 * account drops out, the same way `pendingRequests` drops a deleted requester.
 *
 * The invitation's own `id` is the row's `id`; the invited person's is
 * `userId`, because `profileSummary` writes its own `id` and would otherwise
 * overwrite the invitation's.
 */
export async function pendingInvitations(db, organizationId, { limit = 200 } = {}) {
  const rows = await db.prepare(`
    SELECT i.id, i.message, i.created_at AS "createdAt", i.expires_at AS "expiresAt",
           u.id AS "userId", u.username, u.name, u.avatar,
           u.profile_picture_url, u.avatar_color, u.role, u.location
      FROM organization_invitations i
      JOIN users u ON u.id = i.invited_user_id
     WHERE i.organization_id = ? AND i.status = 'pending'
       AND u.account_status = 'active'
     ORDER BY i.created_at ASC, i.id ASC
     LIMIT ?
  `).all(organizationId, limit);
  return rows ?? [];
}

export async function pendingInvitationCount(db, organizationId) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM organization_invitations WHERE organization_id = ? AND status = 'pending'",
  ).get(organizationId);
  return Number(row?.n ?? 0);
}

/**
 * The live account an invitation may name, or `null`.
 *
 * ── Why this read is here and not in the route ──
 *
 * Two reasons, and both matter. The first is the one
 * `db.accessSurface.test.js` ratchets: this module RECEIVES a handle, so the
 * statement can be given a pooled client, while the same statement written in
 * the route file reaches for the imported global and cannot.
 *
 * The second is that "who may be invited" is a rule, and it belongs beside the
 * others. `account_status = 'active'` is the whole of it: a deleted shell or a
 * suspended account would receive a notification that goes nowhere and leave a
 * manager holding an invitation that can never be accepted.
 *
 * The columns are exactly what `profileSummary` reads, plus nothing. Not a
 * `SELECT *` — so a new column on `users` cannot arrive in a response by being
 * added to the table, which is the property `profileSerializer.js` is an
 * allowlist for. And not a shorter list either: the route hands this row
 * straight to `profileSummary`, so a missing column would publish a person with
 * no avatar and no location and look like a rendering bug.
 */
export async function invitableUser(db, userId) {
  if (typeof userId !== 'string' || !userId) return null;
  return (await db.prepare(`
    SELECT id, name, username, avatar, avatar_color, profile_picture_url, role, location
      FROM users WHERE id = ? AND account_status = 'active'
  `).get(userId)) ?? null;
}

/**
 * Invites somebody.
 *
 * ── The refusals, and why each is safe to be specific about ──
 *
 * Unlike the admin flow's uniform `INVITE_REJECTED`, these name their reason.
 * That is not a relaxation of the same design — it is the consequence of a
 * different threat model. The admin refusals had to be uniform because the
 * caller supplied an EMAIL ADDRESS and a specific answer would disclose whether
 * that address has an account. Here the caller supplies a user id they got from
 * the directory search they are already allowed to use, so every one of these
 * answers is about a person they can already see:
 *
 *   `already_member`   they can see the roster; they are a member of this club.
 *   `declined`         they sent this invitation themselves, or a co-manager did.
 *   `banned`           a manager of this club performed the ban.
 *   `pending`          the invitation they are looking at in their own list.
 *   `full`             a property of their own club.
 *
 * @returns {{ ok: true, invitation }} | {{ ok: false, reason: string }}
 */
export async function inviteUser(db, organizationId, invitedUserId, {
  invitedBy = null, message = null, now = new Date(),
} = {}) {
  const previous = await invitationFor(db, organizationId, invitedUserId);

  if (invitationStands(previous, now)) return { ok: false, reason: 'pending' };
  if (previous?.status === 'declined') return { ok: false, reason: 'declined' };

  if (await pendingInvitationCount(db, organizationId) >= SOFT_MAX_PENDING_INVITATIONS) {
    return { ok: false, reason: 'full' };
  }

  const id = `oinv-${crypto.randomBytes(9).toString('hex')}`;
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString();

  /* ON CONFLICT against the partial unique index, so two managers inviting the
     same person in the same instant produce one invitation rather than one
     invitation and a unique-violation that — on PostgreSQL — would abort the
     surrounding transaction and take the audit row with it. Matching the index
     predicate exactly is what makes this work identically on both engines. */
  const result = await db.prepare(`
    INSERT INTO organization_invitations
      (id, organization_id, invited_user_id, invited_by, message, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT (organization_id, invited_user_id) WHERE status = 'pending' DO NOTHING
  `).run(id, organizationId, invitedUserId, invitedBy, message, now.toISOString(), expiresAt);

  if (!result.changes) return { ok: false, reason: 'pending' };
  return { ok: true, invitation: await invitationFor(db, organizationId, invitedUserId) };
}

/**
 * Resolves an invitation, once.
 *
 * `WHERE status = 'pending'` is the whole concurrency story: whichever of
 * accept, decline and revoke lands first changes the row, and the others report
 * `already_resolved` rather than overwriting a decision. The same shape
 * `decideRequest` uses, for the same reason.
 *
 * @returns 'resolved' | 'already_resolved' | 'not_found'
 */
export async function resolveInvitation(db, organizationId, invitationId, status, { now = new Date() } = {}) {
  if (!INVITATION_STATUSES.includes(status) || status === 'pending') return 'not_found';

  const result = await db.prepare(`
    UPDATE organization_invitations
       SET status = ?, resolved_at = ?
     WHERE id = ? AND organization_id = ? AND status = 'pending'
  `).run(status, now.toISOString(), invitationId, organizationId);

  if (result.changes > 0) return 'resolved';
  const exists = await db.prepare(
    'SELECT 1 FROM organization_invitations WHERE id = ? AND organization_id = ?',
  ).get(invitationId, organizationId);
  return exists ? 'already_resolved' : 'not_found';
}

/**
 * Marks an invitation accepted as part of somebody joining.
 *
 * Called inside the join transaction, next to `retireRequestOnJoin`. An
 * invitation that admitted somebody and then stayed pending would be offered to
 * them again on their own page, and would keep counting against the club's
 * outstanding list forever.
 */
export async function acceptInvitationOnJoin(db, organizationId, userId, { now = new Date() } = {}) {
  await db.prepare(`
    UPDATE organization_invitations
       SET status = 'accepted', resolved_at = ?
     WHERE organization_id = ? AND invited_user_id = ? AND status = 'pending'
  `).run(now.toISOString(), organizationId, userId);
}

/**
 * Retires invitations that have lapsed, so a manager's list stops reporting
 * them as outstanding.
 *
 * Bookkeeping only — `invitationStands` already refuses a lapsed invitation
 * whether or not this has run, which is what makes it safe for this to be lazy.
 * Called from the club's own read path rather than from a worker: the list a
 * manager is looking at is exactly when the tidying is worth doing, and it needs
 * no new scheduled job.
 */
export async function expireLapsedInvitations(db, organizationId, { now = new Date() } = {}) {
  const result = await db.prepare(`
    UPDATE organization_invitations
       SET status = 'expired', resolved_at = ?
     WHERE organization_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
  `).run(now.toISOString(), organizationId, now.toISOString());
  return result.changes ?? 0;
}
