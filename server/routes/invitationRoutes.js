import express from 'express';
import { runInTransaction } from '../db/connectionContext.js';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import { requireCap, requireAAL2, ROLE } from '../authz.js';
import { ChallengeNotSpent, refuseReauth, spendChallenge } from '../reauthResponses.js';
import { recordAudit } from '../auditLog.js';
import { sendAdminInvitationEmail } from '../email.js';
import {
  createInvitation, invitationRefusal, listPendingInvitations,
  resolveInvitation, revokeInvitation, INVITABLE_ROLES, INVITE_REJECTED, describeFailure,
} from '../adminInvitations.js';

const router = express.Router();

/**
 * Administrator invitations — §4.3 of the specification.
 *
 * The rules live in `adminInvitations.js`; these routes decide who is asking.
 * Every refusal here is one of IV-1 … IV-15 and the module's comments carry the
 * reasoning.
 */

/**
 * POST /api/admin/invitations — offer `admin` to an address.
 *
 * IV-1: owner-only (`admin.create` is SUPER_ONLY) and step-up gated, because
 * this creates administrator authority awaiting collection.
 *
 * IV-4: the token is emailed and NEVER returned. An inviter who keeps it can
 * accept from an address they control, which defeats the address binding that
 * makes the whole feature safe to deliver by mail — so the response says an
 * invitation was sent and nothing more.
 */
router.post('/api/admin/invitations', authenticateToken, requireCap('admin.create'),
  requireAAL2('admin.invite'), async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const role = req.body?.role ?? INVITABLE_ROLES[0];
    const reason = req.body?.reason;

    const refusal = await invitationRefusal(db, { email, role, reason });
    if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

    let created;
    try {
      created = await runInTransaction(db, async (tx) => {
        /* First statement, bound to the address actually being invited, so a
           grant obtained for one person cannot invite another. */
        await spendChallenge(tx, req, 'admin.invite', { email });

        const invite = await createInvitation(tx, {
          email, role, reason, invitedBy: req.user.id,
        });

        await recordAudit(tx, {
          adminId: req.user.id,
          action: 'ADMIN_INVITED',
          /**
           * No `targetUserId`. The invited address may not have an account yet,
           * and `target_user_id` has no foreign key to invent one for — so the
           * address goes in `details`, which is where a reader looks anyway.
           */
          details: `Invited ${email} as ${role}${invite.replaced ? ' (replacing an earlier pending invitation)' : ''}. Reason: ${String(reason).trim()}`,
        });

        return invite;
      });
    } catch (err) {
      if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
      console.error('Failed to create an administrator invitation:', err);
      return res.status(500).json({ error: 'Could not create that invitation.' });
    }

    /**
     * Delivery is outside the transaction, and the invitation stands if it fails.
     *
     * The opposite choice — rolling back on a mail failure — looks safer and is
     * worse: the row is the record that an owner made this decision, and an SMTP
     * blip should not erase it. A pending invitation nobody received is visible
     * in the list and revocable; a decision that silently un-happened is not.
     */
    try {
      sendAdminInvitationEmail(created.email, created.token);
    } catch (err) {
      console.error('Invitation created but the email could not be sent:', err);
    }

    /* IV-4. No token, no link, not even a hash. */
    res.status(201).json({
      sent: true,
      email: created.email,
      role,
      replaced: created.replaced,
      message: `An invitation was emailed to ${created.email}. The link is not shown here — only they can use it.`,
    });
  });

/** GET /api/admin/invitations — the pending list (IV-14). */
router.get('/api/admin/invitations', authenticateToken, requireCap('admin.create'), async (req, res) => {
  try {
    res.json({ invitations: await listPendingInvitations(db) });
  } catch (err) {
    console.error('Failed to list invitations:', err);
    res.status(500).json({ error: 'Could not load the pending invitations.' });
  }
});

/**
 * DELETE /api/admin/invitations/:id — revoke while pending (IV-9).
 *
 * Not step-up gated, deliberately: revocation only ever REMOVES authority, and
 * putting friction in front of it would make the safe action harder than the
 * dangerous one. The same reasoning the platform applies elsewhere — a gate
 * belongs on the operation that grants.
 */
router.delete('/api/admin/invitations/:id', authenticateToken, requireCap('admin.create'), async (req, res) => {
  try {
    const invitation = await db.prepare(
      'SELECT id, email, role, status FROM admin_invitations WHERE id = ?'
    ).get(req.params.id);
    if (!invitation) return res.status(404).json({ error: 'No such invitation.' });
    if (invitation.status !== 'pending') {
      return res.status(409).json({
        error: `That invitation is already ${invitation.status}.`,
        code: 'not_pending',
      });
    }

    await runInTransaction(db, async (tx) => {
      await revokeInvitation(tx, { id: invitation.id });
      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'ADMIN_INVITE_REVOKED',
        details: `Revoked the pending ${invitation.role} invitation for ${invitation.email}`,
      });
    });

    res.json({ revoked: true });
  } catch (err) {
    console.error('Failed to revoke an invitation:', err);
    res.status(500).json({ error: 'Could not revoke that invitation.' });
  }
});

/**
 * POST /api/auth/accept-invitation — redeem a token.
 *
 * ── Every failure answers identically (§4.3.5) ──
 *
 * A token that never existed, one that expired, one already used, one revoked,
 * and one belonging to somebody else all produce `INVITE_REJECTED`. The real
 * reason is logged server-side and never sent, because a live invitation is
 * administrator authority sitting unclaimed and distinguishing the cases is a
 * probe for one.
 *
 * ── Signed in, as the invited address, verified (IV-6, IV-7) ──
 *
 * `authenticateToken` supplies the account. The module then requires that its
 * address matches and is verified, so a forwarded mail confers nothing: the
 * holder would need the mailbox and proof of it.
 *
 * ── One transaction (IV-8) ──
 *
 * Consume, assign, audit, bump the token version, notify. `recordAudit` never
 * catches, so a failed audit rolls the promotion back: there is no state where
 * somebody became an administrator and the record did not happen.
 */
router.post('/api/auth/accept-invitation', authenticateToken, async (req, res) => {
  try {
    const resolved = await resolveInvitation(db, { token: req.body?.token, user: req.user });

    if (!resolved.ok) {
      console.warn(describeFailure(resolved.logReason));
      /* 400, not 404 or 403: the status must not distinguish the cases either. */
      return res.status(400).json({ error: INVITE_REJECTED.error, code: INVITE_REJECTED.code });
    }

    const { invitation } = resolved;
    const now = new Date().toISOString();

    await runInTransaction(db, async (tx) => {
      await tx.prepare(`
        UPDATE admin_invitations
           SET status = 'accepted', resolved_at = ?, accepted_by = ?
         WHERE id = ? AND status = 'pending'
      `).run(now, req.user.id, invitation.id);

      await tx.prepare(`
        UPDATE users
           SET role = ?, promoted_at = ?, promoted_by = ?, promotion_reason = ?,
               token_version = token_version + 1
         WHERE id = ?
      `).run(ROLE.ADMIN, now, invitation.invited_by, invitation.reason, req.user.id);

      await recordAudit(tx, {
        adminId: invitation.invited_by,
        action: 'ADMIN_INVITE_ACCEPTED',
        targetUserId: req.user.id,
        details: `${invitation.email} accepted the ${invitation.role} invitation. Reason on the invitation: ${invitation.reason}`,
      });
    });

    /**
     * `token_version` IS bumped here, unlike suspension — and for the opposite
     * reason. The session was minted before this account held any administrative
     * capability, and the JWT is what carries `tokenVersion`; re-issuing forces a
     * clean session for the new authority rather than leaving one that predates
     * it. Nothing is being hidden from the person, so there is no explanation to
     * preserve.
     */
    res.json({
      accepted: true,
      role: invitation.role,
      message: 'You are now a WeVolunteer administrator. Sign in again to pick up your new access.',
    });
  } catch (err) {
    console.error('Failed to accept an invitation:', err);
    res.status(500).json({ error: 'Could not accept that invitation.' });
  }
});

export default router;
