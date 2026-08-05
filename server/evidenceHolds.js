/**
 * One definition of "something under investigation is attached to this".
 *
 * ── Why this is a module and not four inline queries ──
 *
 * Four places have to answer the same question — the event delete, the comment
 * delete, the retention sweep's message pass, and the retention sweep's account
 * purge. A second copy of this logic is a second way to destroy evidence, and it
 * would be the copy nobody remembered to update. The same reasoning
 * `sensitiveActions.js` gives for one definition of the challenge header.
 *
 * ── What "live" means, and why the hold is not permanent ──
 *
 * A hold that never lifts is not a safety mechanism, it is a way to pin an
 * organizer's calendar in place forever: any event that ever attracted a report
 * could never be deleted again, and any account that ever filed one could never
 * finish deleting. So the hold is scoped to reports that are still open or being
 * reviewed. Resolving or dismissing a report releases it.
 *
 * That bound is an event rather than a clock, deliberately, and it matches the
 * shape the Privacy Policy already publishes for messages — "3 years, longer if
 * the conversation has been reported". A number here would be a number nobody
 * could justify; "until somebody has dealt with it" is a commitment the
 * moderation queue can actually discharge.
 *
 * ── What this module does NOT do ──
 *
 * It does not stop a person deleting their account. Account deletion is a right,
 * and the person under a report is as often the victim as the subject —
 * converting a privacy right into a moderation lever against a student who
 * reported an adult would be the exact inversion this phase exists to prevent.
 * Deletion anonymises immediately, as published; only the hard purge of the
 * leftover shell waits, and only while a report is live.
 */

/**
 * Report statuses that still hold evidence.
 *
 * `reports.status` has no 'reviewing' value today and `conversation_reports`
 * does; naming both here means the two tables can share every query below, and
 * means the widening of `reports.status` that the trust & safety spec specifies
 * needs no change to this file.
 */
export const LIVE_REPORT_STATUSES = ['open', 'reviewing'];

const LIVE = LIVE_REPORT_STATUSES.map(s => `'${s}'`).join(', ');

/**
 * The refusal an organizer or administrator sees.
 *
 * Written for the worst case, which is that the reader is the subject of the
 * report: it says enough to be actionable and nothing that identifies who filed
 * it, quotes what it says, or narrows down which conversation or comment
 * triggered it. Telling a possible groomer which student reported them is worse
 * than the deletion this refusal prevents.
 *
 * It deliberately offers no channel for disputing the hold. An "email us about
 * this" line would hand the subject of a report a lobbying route, and a review
 * closing is not something the reader should be invited to influence. The
 * remedy it does offer — cancel instead — is the one that serves the innocent
 * organizer without serving the guilty one.
 *
 * Shape borrowed from the `attendance_exists` refusal it sits beside: state of
 * the thing, what is refused, why in the reader's terms, what to do instead.
 */
export const EVENT_HELD_MESSAGE =
  'This event cannot be deleted while a moderator is reviewing a report connected to it. '
  + 'Cancel it instead — that calls the event off and notifies your volunteers. '
  + 'It can be deleted once the review is closed.';

export const COMMENT_HELD_MESSAGE =
  'This comment is being reviewed by a moderator and cannot be deleted yet. '
  + 'It can be deleted once the review is closed.';

/**
 * Is any evidence attached to this event?
 *
 * Three surfaces, because `DELETE /api/events/:id` destroys all three: the event
 * row itself, every comment on it, and — by cascade through `conversations` —
 * every reported conversation held under it.
 *
 * Returns `true`/`false` rather than a count. A count would be a disclosure: how
 * many people reported you is information the subject of a report does not get.
 */
export function eventHasLiveReport(db, eventId) {
  const row = db.prepare(`
    SELECT 1 AS held
    WHERE EXISTS (
      SELECT 1 FROM conversation_reports cr
      LEFT JOIN conversations c ON c.id = cr.conversation_id
      WHERE cr.status IN (${LIVE})
        AND (c.event_id = :eventId OR cr.event_id_snapshot = :eventId)
    )
    OR EXISTS (
      SELECT 1 FROM reports r
      WHERE r.status IN (${LIVE})
        AND r.target_type = 'event' AND r.target_id = :eventId
    )
    OR EXISTS (
      SELECT 1 FROM reports r
      WHERE r.status IN (${LIVE})
        AND r.target_type = 'comment'
        AND r.target_id IN (SELECT id FROM event_comments WHERE event_id = :eventId)
    )
  `).get({ eventId });
  return Boolean(row);
}

/** Is this comment the target of a live report? */
export function commentHasLiveReport(db, commentId) {
  const row = db.prepare(`
    SELECT 1 AS held FROM reports
    WHERE status IN (${LIVE}) AND target_type = 'comment' AND target_id = ?
    LIMIT 1
  `).get(commentId);
  return Boolean(row);
}

/**
 * Is this account a party to a live report, in either direction?
 *
 * Both directions matter and the reporter side is the one that is easy to miss.
 * `conversation_reports.reporter_id` used to be ON DELETE CASCADE, so purging a
 * reporting student's anonymised shell destroyed their own safety report — a
 * victim's privacy right silently erasing the record of what was done to them.
 * Migration 011 severed that cascade so the report now survives the purge; this
 * check is the second half, holding the shell itself while a report is live so
 * the surrounding conversation and its un-snapshotted messages stay reviewable.
 */
export function userIsPartyToLiveReport(db, userId) {
  const row = db.prepare(`
    SELECT 1 AS held
    WHERE EXISTS (
      SELECT 1 FROM conversation_reports
      WHERE status IN (${LIVE}) AND (reporter_id = :userId OR reported_user_id = :userId)
    )
    OR EXISTS (
      SELECT 1 FROM reports WHERE status IN (${LIVE}) AND reporter_id = :userId
    )
    OR EXISTS (
      SELECT 1 FROM conversation_reports cr
      JOIN conversations c ON c.id = cr.conversation_id
      WHERE cr.status IN (${LIVE}) AND (c.student_id = :userId OR c.organizer_id = :userId)
    )
    OR EXISTS (
      -- Organizer of an event under a live report. events.organizer_id is
      -- ON DELETE CASCADE, so purging this shell deletes the event and takes
      -- its comments, announcements and conversations down with it.
      SELECT 1 FROM reports r
      JOIN events e ON e.id = r.target_id
      WHERE r.status IN (${LIVE}) AND r.target_type = 'event' AND e.organizer_id = :userId
    )
    OR EXISTS (
      SELECT 1 FROM reports r
      JOIN event_comments ec ON ec.id = r.target_id
      JOIN events e ON e.id = ec.event_id
      WHERE r.status IN (${LIVE}) AND r.target_type = 'comment'
        AND (ec.user_id = :userId OR e.organizer_id = :userId)
    )
  `).get({ userId });
  return Boolean(row);
}

/**
 * SQL predicate: true for a message the retention sweep may delete.
 *
 * Interpolated into `retentionWorker.js`'s DELETE. Two clauses, closing two
 * separate holes in the single clause it replaces:
 *
 *   1. The snapshot is CAPPED — at most 20 caller-named ids, or the last 10
 *      messages when none are named (`messageRoutes.js`). Exempting only
 *      snapshotted ids therefore sweeps message 11 of a reported conversation
 *      while the investigation is still open. The second clause exempts the
 *      whole thread instead.
 *   2. A conversation reported and then swept leaves a moderator reading ten
 *      messages with no idea that four hundred are missing.
 *
 * The exemption is bounded by the report being live, not by a new retention
 * period: once a report is resolved the ordinary three-year clock applies again
 * to everything except the frozen snapshot, which is the record and is never
 * swept. That keeps the published "3 years — longer if the conversation has been
 * reported" true without inventing a second indefinite class of data, which the
 * amended COPPA Rule would not tolerate on a platform of minors.
 *
 * String-interpolated rather than parameterised because it is a fragment of a
 * prepared statement, not a value. Everything interpolated is a literal defined
 * in this file — never a caller's input.
 */
export const RETAINABLE_MESSAGE_PREDICATE = `
  id NOT IN (SELECT message_id FROM conversation_report_messages)
  AND conversation_id NOT IN (
    SELECT conversation_id FROM conversation_reports WHERE status IN (${LIVE})
  )
`;
