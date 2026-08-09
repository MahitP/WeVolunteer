import express from 'express';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import { requireCap, ROLES, ROLE, can, ALL_CAPABILITIES } from '../authz.js';
import { recordAudit } from '../auditLog.js';

/**
 * Starting and leaving a persona preview.
 *
 * ── What a preview is for ──
 *
 * The platform owner sees a version of this application almost nobody else does.
 * That makes them the worst-placed person to notice that a student's view is
 * broken — which matters for a product whose primary audience is students. A
 * preview renders the application as a plain member of another role, so the
 * thing being checked is the thing students actually get.
 *
 * ── Why this is not a client-side role switch ──
 *
 * A flag in localStorage would be a lie and a hazard at once. A lie, because the
 * server would go on answering every request with the owner's real capabilities,
 * so the preview would show a student's navigation over an administrator's data
 * — a screenshot of a page that does not exist for anybody. A hazard, because a
 * role held in client-controlled storage is the shape of a privilege-escalation
 * bug even when today's implementation happens to be safe.
 *
 * The preview is therefore two columns on the user's own row, and every request
 * resolves it server-side in `buildPrincipal`.
 *
 * ── Why it cannot escalate, for any value, from any writer ──
 *
 * Not because these handlers validate the persona, though they do. `can()`
 * intersects `effectiveRole` with `actualRole`, and `actualRole` is read from the
 * database on every request — so a `preview_persona` of 'super_admin' on a
 * student's row grants that student nothing at all. The guarantee holds for a
 * value written by a bug, by SQL injection, or by a mistake in this file. See the
 * narrowing rule in `authz.js`.
 *
 * That is what makes the asymmetry below acceptable:
 *
 *   - Starting a preview needs `persona.preview`, which is SUPER_ONLY and
 *     therefore ungrantable.
 *   - Leaving one needs `persona.preview.exit`, which EVERY role holds — because
 *     a preview narrows the caller's capabilities, so an owner-only exit would be
 *     lost the instant the owner previewed as a student. It clears the caller's
 *     own two columns and nothing else, so holding it grants nobody anything.
 *
 * ── What a preview deliberately does NOT do ──
 *
 * It does not touch authentication. Whether a second factor is required is
 * decided from the row's real role at sign-in, before a principal exists, so an
 * owner previewing as a student is still an owner as far as signing in is
 * concerned. It does not reveal anybody else's data either: it removes
 * capabilities from one account and adds none, so every record the previewing
 * owner can read is a record they could already read.
 */
const router = express.Router();

/**
 * How long a preview lasts.
 *
 * A preview REMOVES capabilities, so a forgotten one is an owner who has quietly
 * lost their administrative access with no reason to connect it to something they
 * clicked earlier. Thirty minutes is long enough to walk through a flow and short
 * enough that a browser closed mid-preview repairs itself over a coffee break.
 * `persona.preview.exit` is the ordinary way out and is always available.
 */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

/**
 * Personas a preview may be started as.
 *
 * Derived from `ROLES` minus the owner's own, rather than written out: a role
 * added to the kernel becomes previewable without a second list going stale.
 * `super_admin` is excluded because previewing as yourself is not a preview —
 * `buildPrincipal` resolves that to no preview at all, so offering it would be an
 * option that appears to do nothing.
 */
export const PREVIEWABLE = ROLES.filter(r => r !== ROLE.SUPER_ADMIN);

router.post(
  '/api/admin/persona-preview',
  authenticateToken,
  requireCap('persona.preview'),
  (req, res) => {
    const { persona } = req.body ?? {};

    if (!PREVIEWABLE.includes(persona)) {
      return res.status(400).json({
        error: `Choose one of: ${PREVIEWABLE.join(', ')}.`,
        code: 'unknown_persona'
      });
    }

    /**
     * Re-read rather than trusting `req.principal`.
     *
     * `requireCap` proved the caller holds `persona.preview` this request, which
     * is the authorization question. This is a different one: the row is what the
     * write below is about, and the value being stored is only meaningful beside
     * the role it will be intersected with.
     */
    const row = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ error: 'Account not found.' });

    /**
     * The narrowing, asserted here as well as enforced in the kernel.
     *
     * `can()` already makes escalation impossible, so this is not load-bearing
     * and must never be mistaken for the control. It is here so that an attempt
     * to store a WIDENING preview fails loudly at the point somebody wrote it,
     * rather than being silently neutralised at every read for the rest of its
     * life — a preview that appears to have been accepted and then inexplicably
     * grants nothing is a far harder thing to debug than a 400.
     *
     * Both sides are asked through `can()` with `actualRole: null`, which is how
     * you ask "what does a plain member of this role hold" — with the narrowing
     * rule itself switched off, so this compares the two role sets rather than
     * comparing a set against its own intersection and always agreeing.
     *
     * It cannot fire while `super_admin` holds the wildcard. That is the point: it
     * is the assertion that stays true if the capability table changes.
     */
    const plain = (role) => ({ effectiveRole: role, actualRole: null, grants: [], withheld: [] });
    const widening = ALL_CAPABILITIES.filter(
      cap => can(plain(persona), cap) && !can(plain(row.role), cap)
    );
    if (widening.length > 0) {
      console.error(
        `[persona] Refused a widening preview as '${persona}' for a '${row.role}': `
        + widening.join(', ')
      );
      return res.status(400).json({
        error: 'That persona is not a narrower view of this account.',
        code: 'not_a_narrowing'
      });
    }

    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
    db.prepare('UPDATE users SET preview_persona = ?, preview_expires_at = ? WHERE id = ?')
      .run(persona, expiresAt, row.id);

    /**
     * Audited as an administrative action, with the owner as both actor and
     * target. It is the one action in this application that changes what a
     * principal may do without an administrator having acted on somebody else,
     * and "the owner was browsing as a student between 14:02 and 14:31" is
     * exactly the sort of thing an audit trail exists to be able to answer.
     */
    recordAudit(db, {
      adminId: row.id,
      action: 'PERSONA_PREVIEW_START',
      targetUserId: row.id,
      details: `persona=${persona} expires=${expiresAt}`
    });

    res.json({ persona, expiresAt });
  }
);

router.delete(
  '/api/admin/persona-preview',
  authenticateToken,
  requireCap('persona.preview.exit'),
  (req, res) => {
    /**
     * Only the caller's own row, always.
     *
     * Every role holds this capability, so `req.user.id` is the whole of the
     * authorization story — there is no parameter naming whose preview to clear
     * and there must never be one. Ending somebody else's preview would be an
     * action against another account, and this endpoint would then be a
     * capability every student holds over every owner.
     */
    const previous = db.prepare('SELECT preview_persona FROM users WHERE id = ?').get(req.user.id);

    db.prepare(
      'UPDATE users SET preview_persona = NULL, preview_expires_at = NULL WHERE id = ?'
    ).run(req.user.id);

    /* Only audited when there was something to end. Recording a no-op for every
       caller who has never previewed anything would bury the real entries. */
    if (previous?.preview_persona) {
      recordAudit(db, {
        adminId: req.user.id,
        action: 'PERSONA_PREVIEW_END',
        targetUserId: req.user.id,
        details: `persona=${previous.preview_persona}`
      });
    }

    res.json({ persona: null });
  }
);

export default router;
