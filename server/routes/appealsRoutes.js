/**
 * Appeals — the route a suspended person takes to contest an enforcement action.
 *
 * Two things about this file are load-bearing and easy to undo by accident:
 *
 * 1. **The appellant's statement is written once, at submission, and is never in
 *    an UPDATE anywhere in this file.** The previous version wrote the student's
 *    words into `appeals.reasoning` and then the review handler overwrote that
 *    same column with the moderator's reasoning, destroying the defence with the
 *    ruling on it. Migration 015 splits them and freezes `statement` with a
 *    trigger, so a regression here fails at the database rather than silently.
 *
 * 2. **Conflict of interest is checked before the appeal can be decided, and the
 *    cascade is ordered most-privileged-first ending in an explicit deny.**
 *    `can(super_admin, …)` is true for every capability, so a capability branch
 *    placed above the conflict test would swallow every conflicted case. The
 *    disqualifying relationships are data questions and live in `appeals.js`.
 */
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { authenticateToken, inTransaction } from '../utils.js';
import { can, requireCap } from '../authz.js';
import { recordAudit } from '../auditLog.js';
import { notificationService } from '../services/notificationService.js';
import {
  APPEAL_SUBJECTS, APPEAL_DECISIONS, MIN_REASONING_LENGTH,
  validateStatement, validateReasoning, disqualifiers, allOverridable,
  explainConflicts, recordAppealEvent, newAppealId, isFinal,
} from '../appeals.js';

const router = express.Router();

/**
 * One response for an unknown, expired or spent token.
 *
 * Distinguishing them would be a token oracle, and the token is a bearer
 * credential for an account we already know is suspended.
 */
const TOKEN_REFUSAL = { error: 'This appeal link does not work any more.', code: 'appeal_link_invalid' };

/** Reads a live token row, or null. Expiry is compared as ISO-8601 UTC throughout. */
function liveToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare(
    'SELECT token, user_id, expires_at, used_at FROM appeal_tokens WHERE token = ?'
  ).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Unauthenticated, token-addressed. A suspended account cannot authenticate at
 * all (utils.js refuses it before req.user exists), so these two routes are the
 * only way the person most affected by a moderation decision can answer it.
 * ──────────────────────────────────────────────────────────────────────────── */

/** GET /api/appeals/token/:token — what the form needs, and nothing about the person. */
router.get('/api/appeals/token/:token', (req, res) => {
  const row = liveToken(req.params.token);
  if (!row) return res.status(404).json(TOKEN_REFUSAL);

  const user = db.prepare(
    'SELECT account_status, suspension_reason, suspended_at FROM users WHERE id = ?'
  ).get(row.user_id);
  if (!user) return res.status(404).json(TOKEN_REFUSAL);

  /**
   * An appeal already filed on this token is reported back rather than refused.
   *
   * A student who reopens their emailed link previously saw an empty form,
   * wrote their statement a second time, and got "invalid or expired" as a red
   * error on submit — concluding their appeal had never been received. The
   * token is spent either way; what changes is that they are told so.
   */
  /**
   * The reviewer named to the appellant is whoever made the decision they are
   * reading, which is not always the snapshot.
   *
   * `reviewer_name_snapshot` is write-once — 015's
   * `appeals_reviewer_name_write_once` trigger aborts any change, and the
   * decision handler COALESCEs onto it for that reason. That is correct for a
   * name that must outlive a deleted reviewer account, and wrong as the answer
   * to "who decided this", because a reopened appeal is frequently decided by
   * somebody else: whoever reopened it is disqualified, so the second decision
   * often lands with a third administrator.
   *
   * Reproduced before this was changed: reviewer A upholds, B reopens, C
   * reverses — and the appellant was told the reversal was A's. Attributing a
   * decision to an administrator who did not make it misstates a published fact
   * and misrepresents whether the person who decided was conflicted.
   *
   * So the live name wins and the snapshot is the fallback for when the account
   * is gone. `appeal_events` keeps every reviewer either way; nothing is lost.
   */
  /**
   * The suspension snapshots are SELECTed here, and that is the whole point of
   * them.
   *
   * They were not, and the `?? appeal?.suspension_reason_snapshot` fallback below
   * therefore read `undefined` on every request. `POST /unsuspend` NULLs the live
   * `suspension_reason` and `suspended_at`, so the moment an appeal succeeded —
   * or a suspension was lifted while the appeal was still open — the reinstated
   * student opening their link was told they had been suspended for nothing, with
   * no date. Migration 015 froze these columns for exactly this reader; nothing
   * was reading them.
   */
  const appeal = db.prepare(`
    SELECT a.id, a.status, a.decision, a.reasoning, a.created_at, a.decided_at,
           a.suspension_reason_snapshot, a.suspended_at_snapshot,
           COALESCE(u.name, a.reviewer_name_snapshot) AS reviewer_name_snapshot
      FROM appeals a
      LEFT JOIN users u ON u.id = a.reviewer_id
     WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 1
  `).get(row.user_id);

  const alreadyFiled = Boolean(row.used_at);

  /**
   * The outcome stays readable after reinstatement.
   *
   * This used to require `account_status === 'suspended'`, so the moment an
   * appeal succeeded the only channel the student had went dead — they could
   * never learn they had won. A reinstated account can still read its own
   * decision here.
   */
  if (!alreadyFiled && user.account_status !== 'suspended') {
    return res.status(404).json(TOKEN_REFUSAL);
  }

  res.json({
    subject: 'suspension',
    accountStatus: user.account_status,
    // Live column first (it is the current truth while the suspension is in
    // force), snapshot second (it is the only truth once it has been lifted).
    suspensionReason: user.suspension_reason ?? appeal?.suspension_reason_snapshot ?? null,
    suspendedAt: user.suspended_at ?? appeal?.suspended_at_snapshot ?? null,
    expiresAt: row.expires_at,
    alreadyFiled,
    appeal: appeal && alreadyFiled ? {
      status: appeal.status,
      decision: appeal.decision,
      // The reviewer's reasoning is what the Community Guidelines promise the
      // appellant is told, along with who reviewed it.
      reasoning: appeal.decision ? appeal.reasoning : null,
      reviewerName: appeal.decision ? appeal.reviewer_name_snapshot : null,
      submittedAt: appeal.created_at,
      decidedAt: appeal.decided_at,
    } : null,
  });
});

/** POST /api/appeals/token/:token — file the appeal. Single use. */
router.post('/api/appeals/token/:token', (req, res) => {
  const check = validateStatement(req.body?.statement);
  if (!check.ok) return res.status(400).json({ error: check.error, code: 'statement_invalid' });

  const row = liveToken(req.params.token);
  if (!row || row.used_at) return res.status(404).json(TOKEN_REFUSAL);

  const user = db.prepare(`
    SELECT id, account_status, suspension_reason, suspended_at, suspended_by
      FROM users WHERE id = ?
  `).get(row.user_id);
  if (!user || user.account_status !== 'suspended') return res.status(404).json(TOKEN_REFUSAL);

  const suspender = user.suspended_by
    ? db.prepare('SELECT name FROM users WHERE id = ?').get(user.suspended_by)
    : null;

  const appealId = newAppealId();
  const now = new Date().toISOString();

  try {
    inTransaction(() => {
      // Spend the token first: a statement recorded against a token that was
      // not spent is a statement that can be filed twice.
      const spent = db.prepare(
        'UPDATE appeal_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL'
      ).run(now, row.token);
      if (spent.changes !== 1) throw Object.assign(new Error('token already spent'), { spent: true });

      /**
       * The suspension is snapshotted onto the appeal.
       *
       * `POST /unsuspend` NULLs `suspension_reason`, `suspended_at` and
       * `suspended_by` on `users`, and this record used to read all three live.
       * So lifting a suspension — including lifting it because the appeal
       * succeeded — erased what the appeal was contesting, and the reviewer UI
       * rendered "Suspended By: System" over a 1970 date. Migration 015 freezes
       * these four columns; nothing can take them away again.
       */
      db.prepare(`
        INSERT INTO appeals (
          id, user_id, report_id, subject, subject_ref, statement, status,
          suspension_reason_snapshot, suspended_at_snapshot,
          suspended_by_snapshot, suspended_by_name_snapshot,
          created_at, updated_at
        ) VALUES (?, ?, NULL, 'suspension', NULL, ?, 'open', ?, ?, ?, ?, ?, ?)
      `).run(
        appealId, user.id, check.value,
        user.suspension_reason, user.suspended_at,
        user.suspended_by, suspender?.name ?? null,
        now, now
      );

      recordAppealEvent(db, {
        appealId, actorId: user.id, actorRole: 'appellant',
        action: 'submitted', toStatus: 'open',
        note: 'Filed through the emailed appeal link.',
      });
    });
  } catch (err) {
    if (err?.spent) return res.status(404).json(TOKEN_REFUSAL);
    console.error('Failed to submit appeal:', err);
    return res.status(500).json({ error: 'We could not record your appeal. Please try again.' });
  }

  res.status(201).json({
    success: true,
    appealId,
    message: 'Your appeal has been received.',
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Authenticated. For a NON-suspended user contesting a content removal or the
 * outcome of a report — a suspended one cannot reach these at all.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/appeals
 *
 * The previous version of this route had never worked: it inserted into
 * `moderation_actions (… target_user_id, detail …)`, columns that migration 012
 * does not create, so every call carrying a `reportId` threw inside
 * `inTransaction` with no catch and answered 500. It also accepted any
 * `reportId` at all, with no check that the caller had anything to do with it.
 */
router.post('/api/appeals', authenticateToken, (req, res) => {
  const check = validateStatement(req.body?.statement);
  if (!check.ok) return res.status(400).json({ error: check.error, code: 'statement_invalid' });

  const subject = req.body?.subject ?? 'report_outcome';
  if (!APPEAL_SUBJECTS.includes(subject)) {
    return res.status(400).json({
      error: 'Unknown appeal subject.', code: 'subject_invalid', allowed: APPEAL_SUBJECTS,
    });
  }

  /**
   * Ownership, checked rather than assumed.
   *
   * `subject_ref` is attacker-chosen. Without this, any signed-in student could
   * attach an appeal to a report about somebody else and put a third party's
   * report — including the reporter's identity — in front of a reviewer as the
   * context for their own case. The rule is the narrow one: you may appeal a
   * report only if you are the person it is about.
   */
  const subjectRef = typeof req.body?.reportId === 'string' ? req.body.reportId : null;
  let reportId = null;

  if (subjectRef) {
    const report = db.prepare(
      'SELECT id, target_author_id, target_type, target_id FROM reports WHERE id = ?'
    ).get(subjectRef);

    const isAboutCaller = report && (
      report.target_author_id === req.user.id
      || (report.target_type === 'user' && report.target_id === req.user.id)
    );

    // Identical refusal for "no such report" and "not yours", so this cannot be
    // walked to discover which report ids exist.
    if (!isAboutCaller) {
      return res.status(404).json({
        error: 'We could not find what you are appealing.', code: 'subject_not_found',
      });
    }
    reportId = report.id;
  }

  /** One live appeal per person per subject. A duplicate is not new information. */
  const existing = db.prepare(`
    SELECT id FROM appeals
     WHERE user_id = ? AND status IN ('open', 'reviewing')
       AND subject = ? AND (subject_ref IS ? OR subject_ref = ?)
     LIMIT 1
  `).get(req.user.id, subject, subjectRef, subjectRef);
  if (existing) {
    return res.status(200).json({ success: true, appealId: existing.id, duplicate: true });
  }

  const appealId = newAppealId();
  const now = new Date().toISOString();

  try {
    inTransaction(() => {
      db.prepare(`
        INSERT INTO appeals (id, user_id, report_id, subject, subject_ref, statement,
                             status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
      `).run(appealId, req.user.id, reportId, subject, subjectRef, check.value, now, now);

      recordAppealEvent(db, {
        appealId, actorId: req.user.id, actorRole: 'appellant',
        action: 'submitted', toStatus: 'open',
      });

      // The moderation history is report-scoped, so it only gets a row when this
      // appeal is actually attached to a report. The column list is the one
      // migration 012 creates — see this route's header.
      if (reportId) {
        db.prepare(`
          INSERT INTO moderation_actions (id, report_id, actor_id, action, created_at)
          VALUES (?, ?, ?, 'appealed', ?)
        `).run(`act_${crypto.randomBytes(8).toString('hex')}`, reportId, req.user.id, now);
      }
    });
  } catch (err) {
    console.error('Failed to create appeal:', err);
    return res.status(500).json({ error: 'We could not record your appeal. Please try again.' });
  }

  res.status(201).json({ success: true, appealId, duplicate: false });
});

/** GET /api/appeals/mine — including the reasons and the reviewer, which are promised. */
router.get('/api/appeals/mine', authenticateToken, (req, res) => {
  // Live reviewer name first, snapshot as the fallback — same reasoning as the
  // token route above: a reopened appeal is usually decided by somebody else.
  const appeals = db.prepare(`
    SELECT a.id, a.subject, a.subject_ref, a.statement, a.status, a.decision, a.reasoning,
           COALESCE(u.name, a.reviewer_name_snapshot) AS reviewerName,
           a.created_at, a.decided_at
      FROM appeals a
      LEFT JOIN users u ON u.id = a.reviewer_id
     WHERE a.user_id = ? ORDER BY a.created_at DESC
  `).all(req.user.id);
  res.json({ appeals });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Moderator-facing.
 * ──────────────────────────────────────────────────────────────────────────── */

/** GET /api/admin/appeals — oldest first; the SLA is a promise about the oldest item. */
router.get('/api/admin/appeals', authenticateToken, requireCap('appeal.review'), (req, res) => {
  /**
   * LEFT JOIN, not JOIN.
   *
   * `appeals.user_id` is RESTRICT so a hard delete cannot orphan a row today,
   * but an inner join is the failure nobody notices: an appeal that vanishes
   * from the queue is indistinguishable from an appeal nobody filed.
   */
  /**
   * `?status=` widens the view; the DEFAULT is unchanged.
   *
   * Without this a decided appeal was reachable only by knowing its id, so
   * "what did we decide about this person last time" had no answer on any
   * screen — which matters most for a repeat appellant, the case where the
   * previous decision is the context.
   *
   * The default stays `open,reviewing` deliberately: the queue is a worklist,
   * and quietly folding resolved appeals into it would bury the live ones. An
   * unknown value falls back to the default rather than 400-ing, because the
   * cost of a typo here is a moderator seeing an empty queue and believing
   * there is nothing to do.
   */
  const ALLOWED_STATUSES = ['open', 'reviewing', 'resolved'];
  const requested = String(req.query.status ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const statuses = requested.filter(s => ALLOWED_STATUSES.includes(s));
  const filter = statuses.length ? statuses : ['open', 'reviewing'];
  const placeholders = filter.map(() => '?').join(', ');

  /**
   * Who is already working it.
   *
   * Claiming is advisory — it refuses a second CLAIM but does not stop another
   * reviewer deciding — and that is acceptable on a two-person team only if the
   * duplication is visible. Without this the queue showed `reviewing` with no
   * indication of whose it was, so the second reviewer had no way to know before
   * spending the effort. Read from `appeal_events` rather than a column on
   * `appeals`, so there is no second piece of state to keep in step.
   */
  const appeals = db.prepare(`
    SELECT a.id, a.user_id, a.subject, a.status, a.decision, a.created_at, a.decided_at,
           COALESCE(u.name, 'Account since deleted') AS user_name,
           (SELECT COALESCE(cu.name, 'Account since deleted')
              FROM appeal_events e
              LEFT JOIN users cu ON cu.id = e.actor_id
             WHERE e.appeal_id = a.id AND e.action = 'claimed'
             ORDER BY e.created_at DESC LIMIT 1) AS claimed_by_name
      FROM appeals a
      LEFT JOIN users u ON a.user_id = u.id
     WHERE a.status IN (${placeholders})
     ORDER BY a.created_at ASC
  `).all(...filter);

  /**
   * Reversals whose account has not actually been switched back on.
   *
   * Reversing an appeal deliberately does not lift the suspension — that is a
   * separate action behind `user.suspend`, which the deciding reviewer may not
   * hold. The gap that left: the appeal goes `resolved` and drops out of the
   * queue above, the appellant is told they won, and nothing anywhere shows that
   * they are still locked out. A reviewer who closed the tab after deciding left
   * a student suspended indefinitely on the strength of an appeal they had won,
   * and no screen in the product would ever have mentioned it again.
   *
   * DERIVED rather than a `remedy_pending` column, deliberately. A stored flag
   * has to be set by one code path and cleared by another, and the failure mode
   * of the pair going out of step is a queue that either nags about accounts
   * that are fine or stays silent about ones that are not. This query cannot
   * drift: the row appears because the account is suspended and disappears the
   * moment it is not, whoever reinstated it and by whatever route.
   *
   * Ordered oldest-first for the same reason the queue is: the longest-waiting
   * one is the person who has been wrongly locked out the longest.
   */
  const pendingRemedies = db.prepare(`
    SELECT a.id, a.user_id, a.decided_at,
           COALESCE(u.name, 'Account since deleted') AS user_name,
           u.suspension_reason
      FROM appeals a
      JOIN users u ON u.id = a.user_id
     WHERE a.decision = 'reversed'
       AND a.status = 'resolved'
       AND u.account_status = 'suspended'
     ORDER BY a.decided_at ASC
  `).all();

  // Which of these the caller may not decide, computed once so the queue can mark
  // them rather than letting the moderator find out with a 403 after they have
  // read the case and written their reasoning.
  const withConflicts = appeals.map(a => {
    const full = db.prepare('SELECT * FROM appeals WHERE id = ?').get(a.id);
    const conflicts = disqualifiers(db, req.user.id, full);
    return { ...a, conflicts, canDecide: conflicts.length === 0 };
  });

  res.json({
    appeals: withConflicts,
    pendingRemedies,
    counts: {
      open: withConflicts.filter(a => a.status === 'open').length,
      reviewing: withConflicts.filter(a => a.status === 'reviewing').length,
      // Counted separately from the queue: these are not appeals waiting to be
      // decided, they are people waiting to be let back in.
      remediesPending: pendingRemedies.length,
    },
  });
});

/**
 * GET /api/admin/appeals/:id
 *
 * A read, and only a read. This used to flip `open` -> `reviewing` as a side
 * effect, which silently claimed the appeal for whoever glanced at it, bumped
 * `updated_at` (destroying the only proxy for a decision time), and — once
 * conflict of interest exists — would have marked an appeal as in progress for a
 * reviewer who is then refused. Claiming is now an explicit POST.
 */
router.get('/api/admin/appeals/:id', authenticateToken, requireCap('appeal.review'), (req, res) => {
  const appeal = db.prepare(`
    SELECT a.*, u.name AS user_name, u.account_status
      FROM appeals a
      LEFT JOIN users u ON a.user_id = u.id
     WHERE a.id = ?
  `).get(req.params.id);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });

  let report = null;
  if (appeal.report_id) {
    // `reason` has not existed on `reports` since migration 012 renamed it to
    // `description`; the reviewer's context panel had been rendering blank.
    report = db.prepare(`
      SELECT id, category, description, status, target_type, target_body_snapshot,
             reporter_name_snapshot, created_at
        FROM reports WHERE id = ?
    `).get(appeal.report_id);
  }

  const history = db.prepare(`
    SELECT e.action, e.from_status, e.to_status, e.note, e.created_at, e.actor_role,
           COALESCE(u.name, 'Account since deleted') AS actor_name
      FROM appeal_events e
      LEFT JOIN users u ON e.actor_id = u.id
     WHERE e.appeal_id = ? ORDER BY e.created_at ASC
  `).all(appeal.id);

  // Reading is deliberately allowed while conflicted — a moderator has to be
  // able to see what was said about them. Only the decision is refused.
  const conflicts = disqualifiers(db, req.user.id, appeal);

  /**
   * Reading somebody's appeal is logged, on the model the evidence route already
   * set (`REPORT_EVIDENCE_VIEWED`, adminRoutes.js).
   *
   * This is the only appeal route that serves one person's statement to another
   * person. The token route and `/api/appeals/mine` are self-access, and the
   * queue list carries no statement at all — so auditing here covers the whole
   * exposure without logging a row every time a moderator glances at the queue.
   *
   * A statement is a suspended student explaining themselves, frequently naming
   * other people, and reading it while conflicted is expressly permitted above.
   * That permission is only defensible if the reading leaves a trace: the
   * Administrator Responsibilities Policy's rule is that access to a student's
   * account of events is logged against the administrator's name.
   *
   * **The statement itself is never written to the log.** `admin_audit_logs` is
   * readable by every `audit.read` holder and is exported in operational
   * tooling; copying the private text into it would widen the exposure this row
   * exists to record. The id is enough to reconstruct who read what, from a
   * table that is already access-controlled.
   *
   * A GET that writes is deliberate here, exactly as it is for evidence reads.
   * It is idempotent in effect — the row records an access, and an access
   * genuinely happened each time.
   */
  recordAudit(db, {
    adminId: req.user.id,
    action: 'APPEAL_VIEWED',
    targetUserId: appeal.user_id,
    details: `Read appeal ${appeal.id}`
      + (appeal.statement === null ? ' (no statement recorded)' : ' including the appellant\'s statement')
      + (conflicts.length ? ` while conflicted (${conflicts.join(',')})` : ''),
  });

  res.json({
    appeal: {
      ...appeal,
      // Named explicitly so nobody re-introduces the bug where the reviewer's
      // own reasoning was rendered under a heading saying "Appeal Statement".
      statement: appeal.statement,
      statementMissing: appeal.statement === null,
      reviewerReasoning: appeal.reasoning,
    },
    report,
    history,
    conflicts,
    canDecide: conflicts.length === 0,
    canOverride: allOverridable(conflicts) && can(req.principal, 'admin.create'),
  });
});

/** POST /api/admin/appeals/:id/claim — take an appeal, deliberately. */
router.post('/api/admin/appeals/:id/claim', authenticateToken, requireCap('appeal.review'), (req, res) => {
  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(req.params.id);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
  if (appeal.status !== 'open') {
    return res.status(409).json({ error: 'That appeal is not open.', code: 'not_open' });
  }

  const conflicts = disqualifiers(db, req.user.id, appeal);
  if (conflicts.length > 0 && !(allOverridable(conflicts) && can(req.principal, 'admin.create'))) {
    return res.status(403).json({
      error: `You cannot review this appeal because ${explainConflicts(conflicts)}.`,
      code: 'conflict_of_interest', conflicts,
    });
  }

  const now = new Date().toISOString();
  inTransaction(() => {
    db.prepare("UPDATE appeals SET status = 'reviewing', updated_at = ? WHERE id = ?").run(now, appeal.id);
    recordAppealEvent(db, {
      appealId: appeal.id, actorId: req.user.id, actorRole: 'reviewer',
      action: 'claimed', fromStatus: appeal.status, toStatus: 'reviewing',
    });
  });
  res.json({ success: true, status: 'reviewing' });
});

/**
 * PATCH /api/admin/appeals/:id — record the decision.
 *
 * The conflict cascade below is ordered most-privileged-first and ends in an
 * explicit deny, per authz.js's header: `can()` is true for every capability a
 * super_admin asks about, so a bare `else` here would let the most privileged
 * account through the branch meant to stop it.
 */
router.patch('/api/admin/appeals/:id', authenticateToken, requireCap('appeal.review'), (req, res) => {
  const { decision, reasoning, overrideReason } = req.body ?? {};

  if (!APPEAL_DECISIONS.includes(decision)) {
    return res.status(400).json({
      error: 'Choose whether the original decision stands or is reversed.',
      code: 'decision_invalid', allowed: APPEAL_DECISIONS,
    });
  }
  const reasons = validateReasoning(reasoning);
  if (!reasons.ok) return res.status(400).json({ error: reasons.error, code: 'reasoning_required' });

  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(req.params.id);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });

  /**
   * A decided appeal is not silently re-decidable.
   *
   * The previous handler UPDATEd unconditionally, so an outcome could be
   * rewritten as many times as anybody liked with no record of the earlier one.
   * Changing a decision now requires an explicit, audited reopen.
   */
  if (isFinal(appeal.status)) {
    return res.status(409).json({
      error: 'This appeal has already been decided. Reopen it if the decision needs to change.',
      code: 'already_decided',
    });
  }

  const conflicts = disqualifiers(db, req.user.id, appeal);
  let override = null;

  if (conflicts.length === 0) {
    // Eligible. Nothing to record beyond the decision itself.
  } else if (can(req.principal, 'admin.create') && allOverridable(conflicts)) {
    // SUPER_ONLY escalation tier. Available ONLY for conflicts that are not in
    // NEVER_OVERRIDABLE — deciding your own appeal, or one against a suspension
    // you issued, has no privileged form, and a super_admin who is the subject
    // has no on-platform path by design. The resolution there is off-platform.
    const why = validateReasoning(overrideReason);
    if (!why.ok) {
      return res.status(400).json({
        error: `You are conflicted on this appeal (${explainConflicts(conflicts)}). `
          + `To decide it anyway, give a reason of at least ${MIN_REASONING_LENGTH} characters. `
          + 'It is recorded and shown to the appellant.',
        code: 'override_reason_required', conflicts,
      });
    }
    override = why.value;
  } else {
    // Explicit deny. Never a bare else.
    return res.status(403).json({
      error: `You cannot decide this appeal because ${explainConflicts(conflicts)}. `
        + 'It stays in the queue for another administrator.',
      code: 'conflict_of_interest', conflicts,
    });
  }

  const reviewer = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
  const now = new Date().toISOString();

  /**
   * The link the outcome notice points at.
   *
   * The appellant's own token, spent or not. A still-suspended person cannot
   * sign in, so the token route is the only surface on which they can read the
   * decision — which is why that route now serves the outcome for a spent token
   * instead of 404ing the moment the appeal is over.
   */
  const outcomeToken = db.prepare(`
    SELECT token FROM appeal_tokens
     WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1
  `).get(appeal.user_id, now)?.token ?? null;

  try {
    inTransaction(() => {
      db.prepare(`
        UPDATE appeals
           SET status = 'resolved', decision = ?, reasoning = ?, reviewer_id = ?,
               reviewer_name_snapshot = COALESCE(reviewer_name_snapshot, ?),
               decided_at = ?, updated_at = ?
         WHERE id = ?
      `).run(decision, reasons.value, req.user.id, reviewer?.name ?? null, now, now, appeal.id);

      recordAppealEvent(db, {
        appealId: appeal.id, actorId: req.user.id, actorRole: 'reviewer',
        action: 'decided', fromStatus: appeal.status, toStatus: 'resolved',
        note: override
          ? `${decision}: ${reasons.value} [conflict override: ${override}]`
          : `${decision}: ${reasons.value}`,
      });

      recordAudit(db, {
        adminId: req.user.id,
        action: 'APPEAL_REVIEWED',
        targetUserId: appeal.user_id,
        details: `Appeal ${appeal.id} decided: ${decision}.`
          + (override ? ` Conflict overridden (${conflicts.join(',')}): ${override}` : ''),
      });

      /**
       * The appellant is told, always.
       *
       * This is the promise Appeal.jsx has been making in print with nothing
       * behind it, and the one both the Community Guidelines and the Terms make
       * in the contract. It is a MANDATORY notice, so it is delivered whatever
       * the account's email preference says.
       */
      /**
       * `stillSuspended` decides which of the two reversal notices is sent.
       *
       * Reversing does not lift the suspension (see the note below the
       * transaction), so the appellant is frequently still locked out at the
       * moment they are told they won. Read here rather than assumed: a
       * `content_removal` appeal has no suspension behind it at all, and a
       * suspension may already have been lifted while the appeal was open.
       */
      const stillSuspended = db.prepare(
        "SELECT 1 AS s FROM users WHERE id = ? AND account_status = 'suspended'"
      ).get(appeal.user_id) != null;

      notificationService.dispatch(
        decision === 'reversed' ? 'APPEAL_DECISION_REVERSED' : 'APPEAL_DECISION_STANDS',
        {
          reasoning: reasons.value,
          reviewerName: reviewer?.name ?? 'a WeVolunteer administrator',
          token: outcomeToken,
          stillSuspended,
        },
        appeal.user_id
      );
    });
  } catch (err) {
    console.error('Failed to decide appeal:', err);
    return res.status(500).json({ error: 'We could not record that decision. Please try again.' });
  }

  /**
   * Reversing an appeal does NOT lift the suspension here.
   *
   * Reinstatement is a second decision with its own audit row, its own refusals
   * (a super admin cannot be unsuspended by an ordinary admin) and its own
   * notice. Doing it as a side effect of this transaction would produce an
   * account change with no actor recorded against it. The response carries the
   * remedy the reviewer must now perform so the UI can offer it as one click
   * rather than a paragraph asking them to remember.
   */
  res.json({
    success: true,
    status: 'resolved',
    decision,
    remedy: decision === 'reversed'
      ? { required: true, action: 'unsuspend', userId: appeal.user_id,
          message: 'Reinstate this account to complete the reversal.' }
      : { required: false },
  });
});

/**
 * POST /api/admin/appeals/:id/reopen
 *
 * The only way a decided appeal changes. Whoever reopens is thereby disqualified
 * from deciding it (see `disqualifiers`) — on a small team that means reopening
 * costs you the decision, which is the right incentive, because reopen is
 * otherwise the lever for relitigating an outcome you disliked.
 */
router.post('/api/admin/appeals/:id/reopen', authenticateToken, requireCap('appeal.review'), (req, res) => {
  const why = validateReasoning(req.body?.reason);
  if (!why.ok) return res.status(400).json({ error: why.error, code: 'reason_required' });

  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(req.params.id);
  if (!appeal) return res.status(404).json({ error: 'Appeal not found' });
  if (!isFinal(appeal.status)) {
    return res.status(409).json({ error: 'That appeal is not decided.', code: 'not_decided' });
  }

  const now = new Date().toISOString();
  try {
    inTransaction(() => {
      db.prepare("UPDATE appeals SET status = 'reviewing', updated_at = ? WHERE id = ?")
        .run(now, appeal.id);

      recordAppealEvent(db, {
        appealId: appeal.id, actorId: req.user.id, actorRole: 'reviewer',
        action: 'reopened', fromStatus: appeal.status, toStatus: 'reviewing', note: why.value,
      });

      recordAudit(db, {
        adminId: req.user.id, action: 'APPEAL_REOPENED', targetUserId: appeal.user_id,
        details: `Appeal ${appeal.id} reopened: ${why.value}`,
      });

      // An appeal that silently returns to 'reviewing' after the appellant was
      // told the outcome is worse than never telling them.
      const token = db.prepare(`
        SELECT token FROM appeal_tokens
         WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1
      `).get(appeal.user_id, now)?.token ?? null;
      notificationService.dispatch('APPEAL_REOPENED', { reason: why.value, token }, appeal.user_id);
    });
  } catch (err) {
    console.error('Failed to reopen appeal:', err);
    return res.status(500).json({ error: 'We could not reopen that appeal.' });
  }

  res.json({ success: true, status: 'reviewing' });
});

export default router;
