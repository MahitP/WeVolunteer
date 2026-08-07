import crypto from 'node:crypto';
/**
 * `ROLE` only. `authz.js` imports nothing at all, so taking the role names from
 * it costs no coupling — and the completeness guard fails the build on a role
 * compared against a literal, for the reason its own header gives: a typo in a
 * scattered string is a silent deny, while a typo here cannot compile.
 */
import { ROLE } from './authz.js';

/**
 * Administrator invitations — §4.3, IV-1 … IV-15.
 *
 * ── Why this is a module and not four route handlers ──
 *
 * Almost every requirement in §4.3 is a refusal, and refusals that live in
 * handlers get copied when a second entry point appears. The rules about who may
 * be invited, what a token is worth, and what makes an acceptance valid are
 * stated once here; the routes decide who is asking.
 *
 * `db` is a parameter, never imported. `db.js` opens its file at module scope, so
 * a module that reaches for it cannot be unit tested without a database — the
 * same reason `authz.js` and `suspension.js` take it as an argument.
 *
 * ── The one idea worth holding on to ──
 *
 * A pending invitation is administrator authority awaiting collection, which
 * makes it the highest-value target on this platform. Everything below follows
 * from that: the token is stored hashed, never shown to its creator, bound to a
 * verified address rather than to whoever holds it, and every failure to redeem
 * one answers identically.
 */

/** Seven days. Long enough to be seen, short enough that a stale one lapses. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Only `admin` today. The owner tier is granted from a shell, never by invitation. */
export const INVITABLE_ROLES = Object.freeze(['admin']);

const MIN_REASON = 12;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const normaliseEmail = (raw) => String(raw ?? '').trim().toLowerCase();

/**
 * Every way redeeming a token can fail, collapsed to one answer (§4.3.5).
 *
 * ── Why one code and not four ──
 *
 * Distinguishing "never existed" from "expired" from "already used" from "not
 * your address" lets somebody probe for live invitations, and a live invitation
 * is administrator authority sitting unclaimed. The four cases are recorded
 * server-side — `describeFailure` below — so an operator can still diagnose
 * them; the caller learns only that the link did not work.
 *
 * The sentence deliberately covers all four without hinting which applies.
 */
export const INVITE_REJECTED = Object.freeze({
  ok: false,
  code: 'invitation_invalid',
  error: 'That invitation link is not valid. It may have expired, been used already, '
    + 'or been sent to a different address. Ask whoever invited you for a new one.',
});

/**
 * The real reason, for the server log only.
 *
 * Never returned to a caller. It exists because "the link did not work" is
 * unhelpful to the operator fielding the complaint, and the alternative — an
 * operator with no way to tell an expiry from a typo — is how a uniform response
 * gets relaxed six months later.
 */
export function describeFailure(reason) {
  return `invitation redemption refused: ${reason}`;
}

/**
 * Who may be offered a role.
 *
 * Returns `null` when the address may be invited, or a refusal. These are the
 * checks that must not be duplicated in a handler, because each one is a
 * requirement with a reason:
 *
 *   IV-11 — already holds the role. Inviting them is a no-op that produces a
 *           live token for an account that needs none.
 *   IV-12 — an owner's address. Ownership is strictly greater than `admin`, so
 *           accepting would be a silent demotion of the platform owner, and it
 *           would be performed BY the owner's own mailbox.
 */
export function invitationRefusal(db, { email, role, reason }) {
  const address = normaliseEmail(email);

  if (!address || !address.includes('@')) {
    return { status: 400, error: 'Enter the email address to invite.', code: 'email_invalid' };
  }
  if (!INVITABLE_ROLES.includes(role)) {
    return {
      status: 400,
      error: `Only ${INVITABLE_ROLES.join(' or ')} can be invited. Ownership is granted from the command line.`,
      code: 'role_invalid',
    };
  }
  if (String(reason ?? '').trim().length < MIN_REASON) {
    return {
      status: 400,
      /* Same floor and same reasoning as a suspension reason: this text is read
         later by somebody asking why this person has administrative access, and
         "board" is not something anybody can act on. */
      error: `Give a reason of at least ${MIN_REASON} characters. It is recorded against the invitation and read later by whoever asks why this person is an administrator.`,
      code: 'reason_required',
    };
  }

  const existing = db.prepare(
    'SELECT id, role FROM users WHERE email = ? COLLATE NOCASE'
  ).get(address);

  if (existing?.role === ROLE.SUPER_ADMIN) {
    return {
      status: 409,
      error: 'That address belongs to a platform owner. Ownership already includes everything an administrator can do.',
      code: 'already_owner',
    };
  }
  if (existing?.role === role) {
    return {
      status: 409,
      error: 'That account is already an administrator.',
      code: 'already_holds_role',
    };
  }

  return null;
}

/**
 * Creates the invitation and returns the token ONCE.
 *
 * ── The token is returned to the CALLER, not to the inviter ──
 *
 * IV-4: the plaintext must reach the invited address and must not be shown to
 * whoever created it, because an inviter holding the token can accept from an
 * address they control and defeat IV-7 entirely. So this returns it for the
 * delivery step and the route must never put it in a response body. The test
 * suite asserts that.
 *
 * ── Replacement rather than refusal (IV-13) ──
 *
 * A second invitation for the same address supersedes the first, marked
 * `replaced` rather than deleted so the history survives. The partial unique
 * index makes the swap atomic: without it, "mark old, insert new" is a race
 * whose failure mode is two live tokens for one address, and revoking one then
 * leaves the other working.
 */
export function createInvitation(db, { email, role, reason, invitedBy, now = new Date() }) {
  const address = normaliseEmail(email);
  const token = crypto.randomBytes(32).toString('base64url');

  const superseded = db.prepare(`
    UPDATE admin_invitations
       SET status = 'replaced', resolved_at = ?
     WHERE email = ? AND status = 'pending'
  `).run(now.toISOString(), address).changes;

  const id = `inv_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO admin_invitations
      (id, email, role, token_hash, invited_by, reason, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id, address, role, sha256(token), invitedBy, String(reason).trim(),
    now.toISOString(), new Date(now.getTime() + INVITE_TTL_MS).toISOString()
  );

  return { id, token, email: address, replaced: superseded > 0 };
}

/**
 * Resolves a token to the invitation it may redeem, for a specific account.
 *
 * ── Every failure returns the same object ──
 *
 * Not a boolean and not four codes: `INVITE_REJECTED`, identical in all cases,
 * with the real reason available separately for the server log. A caller cannot
 * tell a token that never existed from one that expired, was used, was revoked,
 * or belongs to somebody else.
 *
 * ── The address, not the token, is the authority (IV-7) ──
 *
 * `user` must be the signed-in account, and its address must match the
 * invitation's. A forwarded or intercepted mail therefore confers nothing: the
 * holder would have to control the mailbox AND have proved it. This is the check
 * that makes the whole feature safe to deliver by email.
 */
export function resolveInvitation(db, { token, user, now = new Date() }) {
  if (!token || typeof token !== 'string') {
    return { ...INVITE_REJECTED, logReason: 'no token supplied' };
  }

  const invitation = db.prepare(
    'SELECT * FROM admin_invitations WHERE token_hash = ?'
  ).get(sha256(token));

  if (!invitation) return { ...INVITE_REJECTED, logReason: 'no such token' };
  if (invitation.status !== 'pending') {
    return { ...INVITE_REJECTED, logReason: `status is ${invitation.status}` };
  }
  if (Date.parse(invitation.expires_at) <= now.getTime()) {
    /* IV-10: expiry is terminal. There is deliberately no renewal here — a
       lapsed invitation is re-issued by an owner, which puts the decision back
       with the person accountable for it. */
    return { ...INVITE_REJECTED, logReason: 'expired' };
  }

  if (!user) return { ...INVITE_REJECTED, logReason: 'not signed in' };
  if (normaliseEmail(user.email) !== invitation.email) {
    return { ...INVITE_REJECTED, logReason: 'signed-in address does not match the invitation' };
  }
  /**
   * IV-6: the address must be VERIFIED, not merely typed. Without this a token
   * could be redeemed by registering the invited address without ever proving
   * control of it, which is the whole guarantee IV-7 rests on.
   */
  if (user.email_verified !== 1) {
    return { ...INVITE_REJECTED, logReason: 'address not verified' };
  }

  /**
   * IV-15. Cannot occur today — ownership is not removable through the product —
   * but checked so the property survives a future change rather than becoming a
   * comment nobody re-reads.
   */
  const inviter = db.prepare('SELECT role FROM users WHERE id = ?').get(invitation.invited_by);
  if (inviter?.role !== ROLE.SUPER_ADMIN) {
    return { ...INVITE_REJECTED, logReason: 'inviting owner no longer holds ownership' };
  }

  return { ok: true, invitation };
}

/** The owner-facing list (IV-14): address, role, inviter, age, expiry. */
export function listPendingInvitations(db, { now = new Date() } = {}) {
  const rows = db.prepare(`
    SELECT i.id, i.email, i.role, i.reason, i.created_at, i.expires_at,
           COALESCE(u.name, 'Account since deleted') AS invitedByName
      FROM admin_invitations i
      LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.status = 'pending'
     ORDER BY i.created_at DESC
  `).all();

  /**
   * Expired-but-unresolved rows are reported as expired rather than hidden.
   *
   * Expiry is derived from the data, not from a sweep — the same rule suspension
   * follows — so a row can be past its date while still `pending`. Hiding it
   * would make an owner think an invitation is gone when the row is still there,
   * which is exactly the confusion IV-13 exists to prevent.
   */
  return rows.map((r) => ({
    ...r,
    expired: Date.parse(r.expires_at) <= now.getTime(),
  }));
}

/** IV-9: revocable while pending, and recorded. Returns whether anything changed. */
export function revokeInvitation(db, { id, now = new Date() }) {
  return db.prepare(`
    UPDATE admin_invitations
       SET status = 'revoked', resolved_at = ?
     WHERE id = ? AND status = 'pending'
  `).run(now.toISOString(), id).changes > 0;
}

/** Exposed for tests and for the delivery step; never for storage. */
export const __hashToken = sha256;
