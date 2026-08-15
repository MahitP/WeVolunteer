/**
 * Appeals — vocabulary, validation, and the conflict-of-interest rule.
 *
 * Imports `node:crypto` and nothing else, deliberately, for the reason
 * `authz.js` and `moderation.js` give: a module that reaches `db.js` cannot be
 * unit-tested without a fixture and cannot be imported by `src/`. The functions
 * that need a database take one as a parameter instead.
 *
 * WHY CONFLICT OF INTEREST LIVES HERE RATHER THAN IN THE ROUTE
 *
 * An independent audit reproduced the administrator who issued a suspension
 * deciding that same user's appeal — HTTP 200, no refusal, no record. Meanwhile
 * `src/views/Appeal.jsx` told the student, in print, that appeals are "reviewed
 * by a different moderator than the one who took the original action". A rule
 * that is published to a minor as a guarantee has to live somewhere it can be
 * tested directly and reused by every path that decides an appeal, rather than
 * inside one handler where the next handler will forget it.
 */
import crypto from 'node:crypto';

/**
 * What an appeal can be about. Free text in the column; validated here.
 *
 * `organization_ban` is the odd one out and is worth saying why it belongs. The
 * other three are platform decisions taken by staff. A ban is taken by another
 * student — a club manager — and is the only decision on this platform that one
 * young person can make about another and have the software enforce. That is
 * exactly the kind of decision that needs somewhere to go, so it goes through
 * the same queue, the same conflict-of-interest rule, and the same record as
 * every other appeal rather than into a manager's inbox.
 */
export const APPEAL_SUBJECTS = Object.freeze([
  'suspension', 'content_removal', 'report_outcome', 'organization_ban',
]);

/**
 * The two outcomes, and the words shown to humans.
 *
 * The T&S MVP §11.3 uses `upheld`/`overturned` and immediately warns that
 * "upheld" is ambiguous in English — a reviewer picking the wrong one tells the
 * appellant the opposite of the truth. Migration 014 shipped `stands`/`reversed`,
 * which is that warning already taken: the stored value says what happened to the
 * ORIGINAL DECISION, and reads the same way in the UI. Keeping it avoids a table
 * rebuild (a CHECK cannot be altered) on the table that now holds the only copy
 * of a student's defence. A `partial` outcome is specified in §11.3 and is NOT
 * delivered here — it needs that rebuild and no launch blocker rests on it.
 */
export const APPEAL_DECISIONS = Object.freeze(['stands', 'reversed']);
export const DECISION_LABELS = Object.freeze({
  stands: 'The original decision stands',
  reversed: 'The original decision is reversed',
});

export const MIN_STATEMENT_LENGTH = 20;
export const MAX_STATEMENT_LENGTH = 5000;
/** Matches MIN_SUSPENSION_REASON: a decision is reviewed against its reasoning. */
export const MIN_REASONING_LENGTH = 20;
export const MAX_REASONING_LENGTH = 5000;

/** Statuses an appeal can hold. 014's CHECK; not widened here (see APPEAL_DECISIONS). */
export const APPEAL_OPEN_STATUSES = Object.freeze(['open', 'reviewing']);
export const APPEAL_FINAL_STATUSES = Object.freeze(['resolved']);

export const isFinal = (status) => APPEAL_FINAL_STATUSES.includes(status);

export const newAppealId = () => `appeal-${crypto.randomUUID()}`;
export const newAppealEventId = () => `apev_${crypto.randomBytes(8).toString('hex')}`;

/**
 * Validates an appellant's statement.
 *
 * Returns `{ ok, value }` or `{ ok: false, error }`. Trimmed before measuring,
 * so twenty spaces is not a statement.
 */
export function validateStatement(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Please write a statement explaining your appeal.' };
  }
  const value = raw.trim();
  if (value.length < MIN_STATEMENT_LENGTH) {
    return {
      ok: false,
      error: `Please write at least ${MIN_STATEMENT_LENGTH} characters so we understand what happened.`,
    };
  }
  if (value.length > MAX_STATEMENT_LENGTH) {
    return { ok: false, error: `Please keep your statement under ${MAX_STATEMENT_LENGTH} characters.` };
  }
  return { ok: true, value };
}

export function validateReasoning(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Reasoning is required.' };
  const value = raw.trim();
  if (value.length < MIN_REASONING_LENGTH) {
    return {
      ok: false,
      error: `Reasoning of at least ${MIN_REASONING_LENGTH} characters is required. `
        + 'The appellant is told what it says.',
    };
  }
  if (value.length > MAX_REASONING_LENGTH) {
    return { ok: false, error: `Please keep the reasoning under ${MAX_REASONING_LENGTH} characters.` };
  }
  return { ok: true, value };
}

/**
 * Conflicts that no privilege level can override.
 *
 * Deciding your own appeal, or the appeal against a suspension you issued, has
 * no legitimate privileged form. A super administrator is not more entitled to
 * judge their own case than anybody else — they are simply the person with
 * nobody above them, which is an argument for sending it off-platform, not for
 * letting them rule on it.
 */
export const NEVER_OVERRIDABLE = Object.freeze(['self', 'suspension_issuer', 'suspension_auditor']);

/**
 * Every disqualifying relationship between a would-be reviewer and an appeal.
 *
 * Data questions, never role questions — `authz.js` owns roles, and a role
 * comparison here would fail guard 1 of `authz.completeness.test.js` anyway.
 *
 * Returns an array of string reasons, empty when the actor is eligible.
 */
export function disqualifiers(db, actorId, appeal) {
  const found = [];
  const add = (r) => { if (!found.includes(r)) found.push(r); };

  // 1. The appellant cannot review their own appeal.
  if (appeal.user_id === actorId) add('self');

  // 2. The administrator who issued the suspension being appealed, as recorded on
  //    the appeal itself at filing time. The snapshot is what makes this survive
  //    the suspension later being lifted (which NULLs the live column).
  if (appeal.suspended_by_snapshot && appeal.suspended_by_snapshot === actorId) add('suspension_issuer');

  // 3. The same question against the LIVE column, which catches a re-suspension
  //    issued after this appeal was filed.
  const live = db.prepare('SELECT suspended_by FROM users WHERE id = ?').get(appeal.user_id);
  if (live?.suspended_by && live.suspended_by === actorId) add('suspension_issuer');

  // 4. The audit trail's own answer to "who suspended this person", which is the
  //    only one that survives an unsuspend.
  const audited = db.prepare(`
    SELECT 1 AS hit FROM admin_audit_logs
     WHERE target_user_id = ? AND admin_id = ? AND action = 'ACCOUNT_SUSPENDED'
     LIMIT 1
  `).get(appeal.user_id, actorId);
  if (audited) add('suspension_auditor');

  // 5-7. Involvement in the report this appeal is attached to.
  if (appeal.report_id) {
    const rep = db.prepare(
      'SELECT reporter_id, resolved_by, assigned_to, target_author_id FROM reports WHERE id = ?'
    ).get(appeal.report_id);
    if (rep) {
      if (rep.resolved_by === actorId || rep.assigned_to === actorId) add('report_handler');
      if (rep.reporter_id === actorId) add('reporter');
      // The reviewer is the person the appellant complained about.
      if (rep.reporter_id === appeal.user_id && rep.target_author_id === actorId) add('report_subject');
    }
  }

  // 8. A live report in either direction between the reviewer and the appellant.
  const crossed = db.prepare(`
    SELECT 1 AS hit FROM reports
     WHERE status IN ('open', 'reviewing', 'escalated')
       AND ((reporter_id = ? AND target_author_id = ?) OR (reporter_id = ? AND target_author_id = ?))
     LIMIT 1
  `).get(actorId, appeal.user_id, appeal.user_id, actorId);
  if (crossed) add('cross_report');

  // 9. Whoever reopened this appeal does not then get to decide it. On a
  //    two-person team that means reopening costs you the decision, which is the
  //    right incentive: reopen is otherwise the lever for relitigating an
  //    outcome you disliked.
  const reopened = db.prepare(`
    SELECT 1 AS hit FROM appeal_events
     WHERE appeal_id = ? AND action = 'reopened' AND actor_id = ?
     LIMIT 1
  `).get(appeal.id, actorId);
  if (reopened) add('reopener');

  return found;
}

/** True when every conflict found is one a super administrator may override. */
export const allOverridable = (conflicts) =>
  conflicts.length > 0 && conflicts.every(c => !NEVER_OVERRIDABLE.includes(c));

/** Human-readable, shown to the disqualified moderator. */
export const CONFLICT_EXPLANATIONS = Object.freeze({
  self: 'this appeal is your own',
  suspension_issuer: 'you issued the suspension being appealed',
  suspension_auditor: 'the audit trail records you as having suspended this account',
  report_handler: 'you assigned or resolved the report behind this action',
  reporter: 'you filed the report behind this action',
  report_subject: 'this appellant reported you',
  cross_report: 'there is an open report between you and this appellant',
  reopener: 'you reopened this appeal, so somebody else decides it',
});

export const explainConflicts = (conflicts) =>
  conflicts.map(c => CONFLICT_EXPLANATIONS[c] || c).join('; ');

/**
 * Appends one row to the appeal's permanent history.
 *
 * Every state change goes through here so the history cannot be half-written by
 * one path and skipped by another. The table is append-only by trigger
 * (migration 015), so this is the only operation available on it.
 */
export function recordAppealEvent(db, { appealId, actorId = null, actorRole = null, action, fromStatus = null, toStatus = null, note = null }) {
  db.prepare(`
    INSERT INTO appeal_events (id, appeal_id, actor_id, actor_role, action, from_status, to_status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newAppealEventId(), appealId, actorId, actorRole, action, fromStatus, toStatus, note, new Date().toISOString());
}
