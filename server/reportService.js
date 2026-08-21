/**
 * The one write path for a report.
 *
 * ── Why a service and not three route handlers ──
 *
 * Three endpoints create reports: the generic `POST /api/reports`, the
 * message-scoped `POST /api/messages/:id/report`, and the conversation-scoped
 * `POST /api/messages/conversations/:id/report` that both published policies
 * point every student at. Before this file they were two handlers writing two
 * different tables in two different shapes, and the difference was not a
 * decision anybody made — it was two people solving the same problem a year
 * apart.
 *
 * Everything that must be true of every report, whatever door it came through,
 * is true here exactly once: the snapshot is taken, the evidence is frozen, the
 * priority is derived rather than accepted, the refusals are uniform, and the
 * whole thing lands in one transaction. A second copy of this is a second chance
 * to write a report with no evidence attached.
 *
 * `server/moderation.js` holds the taxonomy and imports nothing. This holds the
 * writes and imports the database. The split is what lets the categories, the
 * per-target filter and the priority derivation be unit-tested without booting a
 * listener.
 */

import crypto from 'crypto';
import { isUniqueViolation } from './db/dialectSql.js';
import { runInTransaction } from './db/connectionContext.js';

import { db } from './db.js';
import { rolesWithCapability } from './authz.js';
import { notificationService } from './services/notificationService.js';
import { isConversationParticipant } from './messaging.js';
import {
  MAX_DESCRIPTION_LENGTH,
  collectEvidence,
  derivePriority,
  isValidCategory,
  normalizeTargetType,
  resolveTarget,
  CATEGORY_VALUES,
} from './moderation.js';

/**
 * Refusals, as data.
 *
 * Returned rather than thrown so the caller decides the HTTP shape, and named so
 * a test asserts on a code rather than on prose somebody will reword.
 */
export const REPORT_ERRORS = {
  BAD_TARGET_TYPE: {
    status: 400, code: 'bad_target_type',
    error: 'That is not something you can report.',
  },
  BAD_CATEGORY: {
    status: 400, code: 'bad_category',
    error: 'Choose a reason for the report.',
  },
  DESCRIPTION_TOO_LONG: {
    status: 400, code: 'description_too_long',
    error: `Please keep it under ${MAX_DESCRIPTION_LENGTH} characters.`,
  },
  BAD_TARGET_ID: {
    status: 400, code: 'bad_target_id',
    error: 'That is not something you can report.',
  },
  SELF_REPORT: {
    status: 400, code: 'self_report',
    error: 'You cannot report yourself.',
  },
  /**
   * One answer for "does not exist" and for "exists but you cannot see it".
   *
   * Distinguishable codes here would be an existence oracle over a platform of
   * minors, walkable by any signed-in account against arbitrary ids. That exact
   * leak was found and closed once already in `server/messaging.js`; this follows
   * the precedent rather than reopening it.
   */
  NOT_FOUND: {
    status: 404, code: 'not_found',
    error: 'We could not find what you are reporting.',
  },
};

/**
 * Can the reporter see this target at all?
 *
 * Events and comments are visible to every signed-in account, so existence is
 * the whole check. Messages and conversations are private, so participation is
 * required — and an administrator is deliberately NOT exempted here: reading a
 * conversation you are not part of goes through the evidence route, which logs.
 *
 * A `user` target is never checked, and that is the point: see the note on
 * `resolveTarget`'s user branch. There is no oracle if there is no lookup.
 */
async function canReporterSee(targetType, resolved, reporterId) {
  if (targetType === 'user') return true;
  if (!resolved.exists) return false;
  if (targetType === 'message' || targetType === 'conversation') {
    return await isConversationParticipant(resolved.conversationId, reporterId);
  }
  return true;
}

/**
 * Files a report.
 *
 * @param {object} input
 * @param {{id: string, name?: string, role?: string}} input.reporter  from req.user
 * @param {string} input.targetType  'event'|'comment'|'message'|'conversation'|'user'|'organizer'
 * @param {string} input.targetId
 * @param {string} input.category    one of REPORT_CATEGORIES
 * @param {string} [input.description]
 * @returns {{ok: true, reportId: string, duplicate: boolean} | {ok: false} & typeof REPORT_ERRORS[keyof typeof REPORT_ERRORS]}
 */
export async function createReport({ reporter, targetType, targetId, category, description }) {
  const type = normalizeTargetType(targetType);
  if (!type) return { ok: false, ...REPORT_ERRORS.BAD_TARGET_TYPE };

  if (!isValidCategory(category)) {
    return { ok: false, ...REPORT_ERRORS.BAD_CATEGORY, validCategories: CATEGORY_VALUES };
  }

  // A non-string id passes a truthiness check (an object is truthy) but cannot be
  // bound by node:sqlite, which would surface a client mistake as a 500.
  if (typeof targetId !== 'string' || targetId.trim() === '') {
    return { ok: false, ...REPORT_ERRORS.BAD_TARGET_ID };
  }

  const text = description == null ? null : String(description).trim();
  if (text != null && text.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, ...REPORT_ERRORS.DESCRIPTION_TOO_LONG };
  }

  const resolved = await resolveTarget(db, type, targetId, reporter.id);

  if (!await canReporterSee(type, resolved, reporter.id)) {
    return { ok: false, ...REPORT_ERRORS.NOT_FOUND };
  }

  /**
   * Reporting yourself is refused, and it is refused as a 400 rather than
   * silently accepted, because the only ways to reach it are a mis-tap and an
   * attempt to put a decoy in the queue. Compare against the resolved author
   * rather than the raw id so that reporting your own comment is caught too, not
   * just `targetType='user'` pointing at yourself.
   */
  if (resolved.authorId && resolved.authorId === reporter.id) {
    return { ok: false, ...REPORT_ERRORS.SELF_REPORT };
  }

  const priority = derivePriority({
    category,
    reporterRole: reporter.role,
    targetRole: resolved.authorRole,
  });

  const now = new Date().toISOString();
  const id = 'rep_' + crypto.randomBytes(8).toString('hex');

  try {
    /**
     * One transaction, both halves.
     *
     * A report row with no evidence rows is a report a moderator cannot decide,
     * and evidence rows with no report is orphaned message text sitting in a
     * table nobody reads. Neither is a state worth being able to reach.
     */
    await runInTransaction(db, async (tx) => {
      const evidence = await collectEvidence(tx, {
        targetType: type,
        targetId,
        conversationId: resolved.conversationId,
      });

      await tx.prepare(`
        INSERT INTO reports (
          id, reporter_id, reporter_name_snapshot, target_type, target_id,
          target_name_snapshot, target_body_snapshot, target_author_id,
          target_author_name_snapshot, target_role_snapshot,
          conversation_id_snapshot, event_id_snapshot,
          category, description, status, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `).run(
        id, reporter.id, reporter.name ?? null, type, targetId,
        resolved.targetName, resolved.targetBody, resolved.authorId,
        resolved.authorName, resolved.authorRole,
        resolved.conversationId, resolved.eventId,
        category, text || null, priority, now, now
      );

      const insertEvidence = await tx.prepare(`
        INSERT INTO report_evidence
          (report_id, message_id, sender_id, sender_name_snapshot, body, created_at, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const nameOf = await tx.prepare('SELECT name FROM users WHERE id = ?');
      for (const msg of evidence) {
        await insertEvidence.run(
          id, msg.id, msg.sender_id,
          msg.sender_id ? (await nameOf.get(msg.sender_id)?.name ?? null) : null,
          msg.body, msg.created_at, now
        );
      }

      await tx.prepare(`
        INSERT INTO moderation_actions (id, report_id, actor_id, action, created_at)
        VALUES (?, ?, ?, 'filed', ?)
      `).run('act_' + crypto.randomBytes(8).toString('hex'), id, reporter.id, now);
    });
  } catch (err) {
    /**
     * The duplicate index fired: this reporter already has a live report against
     * this exact target.
     *
     * Answered as a 200 carrying the original id, never a 409. A second report of
     * the same thing is not new information — it is usually a double-tap, or
     * somebody checking whether the first one worked. Showing a distressed
     * student an error after they worked up to pressing the button teaches them
     * the button is broken.
     */
    if (isUniqueViolation(err)) {
      const existing = await db.prepare(`
        SELECT id FROM reports
        WHERE reporter_id = ? AND target_type = ? AND target_id = ?
          AND status IN ('open', 'reviewing', 'escalated')
      `).get(reporter.id, type, targetId);
      if (existing) return { ok: true, reportId: existing.id, duplicate: true };
    }
    throw err;
  }

  /**
   * Urgent reports reach a moderator without waiting for one to open the queue.
   *
   * Community Guidelines publishes "anything flagged as a safety concern is
   * looked at the same day", and on a one-to-two-person team the only thing
   * standing between that promise and a queue nobody happened to refresh is this
   * notification. Normal-priority reports deliberately get none: an alert that
   * fires for everything is an alert people learn to close.
   *
   * Nothing is sent to the reported party, at any priority, ever. Telling them a
   * report exists converts a safety control into a provocation — the same
   * reasoning `messaging.js` gives for not revealing a block.
   *
   * ── Why this is after the transaction, and wrapped ──
   *
   * The report is already committed by the time this runs. A notification that
   * fails must therefore not fail the request: the student would be shown "could
   * not submit" for a report that was in fact filed, and would file it again —
   * except the duplicate index would then answer with the first report's id, so
   * they would be told it worked the second time and not the first. Alerting is
   * best-effort by construction; the queue is the system of record.
   */
  if (priority === 'urgent') {
    try {
      for (const moderator of await moderatorIds(db)) {
        await notificationService.dispatch('SYSTEM_ALERT', {
          title: 'Urgent Safety Report',
          body: `An urgent report requires immediate attention. Report ID: ${id}`,
        }, moderator.id);
      }
    } catch (err) {
      console.error('Urgent report alert failed (the report itself is filed):', err);
    }
  }

  return { ok: true, reportId: id, duplicate: false };
}

/**
 * Everyone who can act on a report.
 *
 * Derived from the capability table rather than named: `rolesWithCapability`
 * reads `CAPABILITIES` through `can()`, so a capability moved between roles moves
 * this query with it. The second clause covers per-user grants, which is the
 * whole reason `report.resolve` is a separate capability rather than a synonym
 * for "admin" — a triage-only helper created by `capability.grant` is a
 * moderator for this purpose and must be alerted like one.
 *
 * Suspended and deleted accounts are excluded: a suspended account cannot pass
 * `authenticateToken`, so a notification it can never read is a row nobody will
 * ever clear.
 */
async function moderatorIds(db) {
  const roles = rolesWithCapability('report.resolve');
  if (roles.length === 0) return [];
  const placeholders = roles.map(() => '?').join(', ');
  return await db.prepare(`
    SELECT id FROM users
     WHERE account_status = 'active'
       AND deleted_at IS NULL
       AND (
         role IN (${placeholders})
         OR id IN (
           SELECT user_id FROM user_capabilities
            WHERE capability = 'report.resolve' AND scope = ''
              AND (expires_at IS NULL OR expires_at > ?)
         )
       )
  `).all(...roles, new Date().toISOString());
}
