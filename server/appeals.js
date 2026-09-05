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
export async function disqualifiers(db, actorId, appeal) {
  return applyConflictRules(actorId, appeal, await factsForOne(db, actorId, appeal));
}

/**
 * The statuses that make a report between two people a live conflict.
 *
 * A closed or dismissed report is history; an open one is an active dispute, and
 * a moderator should not be judging the appeal of somebody they are currently in
 * one with.
 */
const LIVE_REPORT_STATUSES_FOR_CONFLICT = ['open', 'reviewing', 'escalated'];

/**
 * The nine rules, applied to facts somebody else has already fetched.
 *
 * ── Why the rules were separated from the loading ──
 *
 * There are now two ways to answer this question — one appeal at a time, and a
 * whole queue page at once (`disqualifiersForMany`). Writing the rules twice
 * would mean a fairness rule could be corrected in one place and silently left
 * wrong in the other, and the wrong one is the moderation queue: the screen
 * where somebody decides whether a suspended student gets their account back.
 *
 * So the rules live here exactly once and both loaders feed them.
 * `appeals.batchedConflicts.test.js` asserts the two paths agree on the same
 * data, which is the assertion that keeps them from drifting.
 *
 * `facts` carries, for this one appeal:
 *   liveSuspendedBy — `users.suspended_by` for the appellant, or null
 *   auditedSuspender — whether the audit trail records the actor suspending them
 *   report          — the row behind `appeal.report_id`, or null
 *   crossReport     — a live report in either direction between actor and appellant
 *   reopener        — whether the actor reopened this appeal
 */
function applyConflictRules(actorId, appeal, facts) {
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
  if (facts.liveSuspendedBy && facts.liveSuspendedBy === actorId) add('suspension_issuer');

  // 4. The audit trail's own answer to "who suspended this person", which is the
  //    only one that survives an unsuspend.
  if (facts.auditedSuspender) add('suspension_auditor');

  // 5-7. Involvement in the report this appeal is attached to.
  if (appeal.report_id && facts.report) {
    const rep = facts.report;
    if (rep.resolved_by === actorId || rep.assigned_to === actorId) add('report_handler');
    if (rep.reporter_id === actorId) add('reporter');
    // The reviewer is the person the appellant complained about.
    if (rep.reporter_id === appeal.user_id && rep.target_author_id === actorId) add('report_subject');
  }

  // 8. A live report in either direction between the reviewer and the appellant.
  if (facts.crossReport) add('cross_report');

  // 9. Whoever reopened this appeal does not then get to decide it. On a
  //    two-person team that means reopening costs you the decision, which is the
  //    right incentive: reopen is otherwise the lever for relitigating an
  //    outcome you disliked.
  if (facts.reopener) add('reopener');

  return found;
}

/** The five lookups for a single appeal. Five round trips, and that is fine for one. */
async function factsForOne(db, actorId, appeal) {
  const live = await db.prepare('SELECT suspended_by FROM users WHERE id = ?').get(appeal.user_id);

  const audited = await db.prepare(`
    SELECT 1 AS hit FROM admin_audit_logs
     WHERE target_user_id = ? AND admin_id = ? AND action = 'ACCOUNT_SUSPENDED'
     LIMIT 1
  `).get(appeal.user_id, actorId);

  const report = appeal.report_id
    ? await db.prepare(
      'SELECT reporter_id, resolved_by, assigned_to, target_author_id FROM reports WHERE id = ?'
    ).get(appeal.report_id)
    : null;

  const statusMarks = LIVE_REPORT_STATUSES_FOR_CONFLICT.map(() => '?').join(',');
  const crossed = await db.prepare(`
    SELECT 1 AS hit FROM reports
     WHERE status IN (${statusMarks})
       AND ((reporter_id = ? AND target_author_id = ?) OR (reporter_id = ? AND target_author_id = ?))
     LIMIT 1
  `).get(...LIVE_REPORT_STATUSES_FOR_CONFLICT, actorId, appeal.user_id, appeal.user_id, actorId);

  const reopened = await db.prepare(`
    SELECT 1 AS hit FROM appeal_events
     WHERE appeal_id = ? AND action = 'reopened' AND actor_id = ?
     LIMIT 1
  `).get(appeal.id, actorId);

  return {
    liveSuspendedBy: live?.suspended_by ?? null,
    auditedSuspender: Boolean(audited),
    report: report ?? null,
    crossReport: Boolean(crossed),
    reopener: Boolean(reopened),
  };
}

/**
 * The same answer for a whole page of appeals, in five queries instead of five
 * per appeal.
 *
 * ── What this replaces ──
 *
 * The moderation queue called `disqualifiers()` in a loop, and before that
 * re-read each appeal row it already held. At fifty appeals that was around
 * three hundred statements, issued in series — on `node:sqlite` that cost
 * nothing, and on PostgreSQL it is three hundred network round trips to render
 * one screen.
 *
 * Returns a `Map` from appeal id to the reason array, so the caller reads it the
 * same way it read the per-appeal answer.
 *
 * The rules are NOT reimplemented here — this function only fetches. Every
 * decision goes through `applyConflictRules` above, the same one
 * `disqualifiers()` uses.
 */
export async function disqualifiersForMany(db, actorId, appeals) {
  const out = new Map();
  if (!appeals.length) return out;

  const marks = (n) => Array.from({ length: n }, () => '?').join(',');

  const appellantIds = [...new Set(appeals.map(a => a.user_id).filter(Boolean))];
  const reportIds = [...new Set(appeals.map(a => a.report_id).filter(Boolean))];
  const appealIds = appeals.map(a => a.id);

  // 3. Live `suspended_by`, per appellant.
  const liveByUser = new Map();
  if (appellantIds.length) {
    for (const r of await db.prepare(
      `SELECT id, suspended_by FROM users WHERE id IN (${marks(appellantIds.length)})`
    ).all(...appellantIds)) {
      liveByUser.set(r.id, r.suspended_by ?? null);
    }
  }

  // 4. Which appellants this actor is recorded as having suspended.
  const auditedUsers = new Set();
  if (appellantIds.length) {
    for (const r of await db.prepare(`
      SELECT DISTINCT target_user_id FROM admin_audit_logs
       WHERE target_user_id IN (${marks(appellantIds.length)})
         AND admin_id = ? AND action = 'ACCOUNT_SUSPENDED'
    `).all(...appellantIds, actorId)) {
      auditedUsers.add(r.target_user_id);
    }
  }

  // 5-7. The reports behind the page's appeals.
  const reportById = new Map();
  if (reportIds.length) {
    for (const r of await db.prepare(`
      SELECT id, reporter_id, resolved_by, assigned_to, target_author_id
        FROM reports WHERE id IN (${marks(reportIds.length)})
    `).all(...reportIds)) {
      reportById.set(r.id, r);
    }
  }

  /**
   * 8. Live reports in either direction between the actor and any appellant.
   *
   * Both directions in one statement, then matched per appellant below. The
   * pair test is reproduced exactly: a row counts only if it is
   * actor→appellant or appellant→actor, so widening the query does not widen
   * the rule.
   */
  const crossedUsers = new Set();
  if (appellantIds.length) {
    const statusMarks = marks(LIVE_REPORT_STATUSES_FOR_CONFLICT.length);
    const idMarks = marks(appellantIds.length);
    const rows = await db.prepare(`
      SELECT reporter_id, target_author_id FROM reports
       WHERE status IN (${statusMarks})
         AND ((reporter_id = ? AND target_author_id IN (${idMarks}))
           OR (target_author_id = ? AND reporter_id IN (${idMarks})))
    `).all(
      ...LIVE_REPORT_STATUSES_FOR_CONFLICT,
      actorId, ...appellantIds,
      actorId, ...appellantIds,
    );
    for (const r of rows) {
      if (r.reporter_id === actorId) crossedUsers.add(r.target_author_id);
      if (r.target_author_id === actorId) crossedUsers.add(r.reporter_id);
    }
  }

  // 9. Which of these appeals this actor reopened.
  const reopenedAppeals = new Set();
  for (const r of await db.prepare(`
    SELECT DISTINCT appeal_id FROM appeal_events
     WHERE appeal_id IN (${marks(appealIds.length)}) AND action = 'reopened' AND actor_id = ?
  `).all(...appealIds, actorId)) {
    reopenedAppeals.add(r.appeal_id);
  }

  for (const appeal of appeals) {
    out.set(appeal.id, applyConflictRules(actorId, appeal, {
      liveSuspendedBy: liveByUser.get(appeal.user_id) ?? null,
      auditedSuspender: auditedUsers.has(appeal.user_id),
      report: appeal.report_id ? (reportById.get(appeal.report_id) ?? null) : null,
      crossReport: crossedUsers.has(appeal.user_id),
      reopener: reopenedAppeals.has(appeal.id),
    }));
  }

  return out;
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
export async function recordAppealEvent(db, { appealId, actorId = null, actorRole = null, action, fromStatus = null, toStatus = null, note = null }) {
  await db.prepare(`
    INSERT INTO appeal_events (id, appeal_id, actor_id, actor_role, action, from_status, to_status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newAppealEventId(), appealId, actorId, actorRole, action, fromStatus, toStatus, note, new Date().toISOString());
}
