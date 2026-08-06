/**
 * One definition of "something under investigation is attached to this".
 *
 * ── Why this is a module and not five inline queries ──
 *
 * Five places have to answer the same question — the event delete, the comment
 * delete, the retention sweep's message pass, the retention sweep's account
 * purge, and the moderation queue. A second copy of this logic is a second way
 * to destroy evidence, and it would be the copy nobody remembered to update.
 * The same reasoning `sensitiveActions.js` gives for one definition of the
 * challenge header.
 *
 * ── What "live" means, and why the hold is not permanent ──
 *
 * A hold that never lifts is not a safety mechanism, it is a way to pin an
 * organizer's calendar in place forever: any event that ever attracted a report
 * could never be deleted again, and any account that ever filed one could never
 * finish deleting. So the hold is scoped to reports that are still being worked
 * — open, being reviewed, or escalated. Resolving or dismissing releases it.
 *
 * `escalated` counts as live, and that is the whole reason it is a status rather
 * than a priority: a report that has left the queue for a phone call to DCP&P is
 * the last thing whose evidence should become deletable.
 *
 * That bound is an event rather than a clock, deliberately, and it matches the
 * shape the Privacy Policy already publishes for messages — "3 years, longer if
 * the conversation has been reported". A number here would be a number nobody
 * could justify; "until somebody has dealt with it" is a commitment the
 * moderation queue can actually discharge.
 *
 * ── Why every query reads `reports` and none reads `conversation_reports` ──
 *
 * Migration 013 folded the legacy table into the unified one. After the fold
 * there are two rows for the same report: the frozen legacy one and the live
 * unified one. Reading the legacy row's status would mean that resolving a
 * report in the queue left the legacy copy saying `'open'` for ever, and the
 * hold would never release — turning this module from a safety mechanism into a
 * permanent lock.
 *
 * That is safe only because the fold is exhaustive, and 013 asserts it rather
 * than assuming it: if even one legacy report failed to fold, the migration
 * fails. A legacy report left behind would be a live investigation with no
 * delete hold, which is silent, and silent is the failure mode PR-1 existed to
 * end.
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
 * Kept in step with `REPORT_STATUSES` in server/moderation.js — that module owns
 * the taxonomy, this one owns what the taxonomy means for deletion. They are
 * asserted equal in `server/moderation.test.js` so the two cannot drift.
 */
export const LIVE_REPORT_STATUSES = ['open', 'reviewing', 'escalated'];

const LIVE = LIVE_REPORT_STATUSES.map(s => `'${s}'`).join(', ');

export const LIVE_APPEAL_STATUSES = ['open', 'reviewing'];
const LIVE_APPEALS = LIVE_APPEAL_STATUSES.map(s => `'${s}'`).join(', ');

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
 * Four surfaces, because `DELETE /api/events/:id` destroys all of them: the
 * event row itself, every comment on it, and — by cascade through
 * `conversations` — every reported conversation and every reported message held
 * under it.
 *
 * `event_id_snapshot` is what makes the last two cheap and, more importantly,
 * what makes them still work after the conversation has been destroyed by some
 * other route: the report remembers which event it happened at even when the
 * join no longer resolves.
 *
 * Returns a boolean, never a count. How many people reported you is information
 * the subject of a report does not get.
 */
export function eventHasLiveReport(db, eventId) {
  const row = db.prepare(`
    SELECT 1 AS held
    WHERE EXISTS (
      SELECT 1 FROM reports r
      WHERE r.status IN (${LIVE})
        AND (
          (r.target_type = 'event' AND r.target_id = :eventId)
          OR r.event_id_snapshot = :eventId
          OR (r.target_type = 'comment'
              AND r.target_id IN (SELECT id FROM event_comments WHERE event_id = :eventId))
          OR (r.target_type IN ('conversation', 'message')
              AND r.conversation_id_snapshot IN
                  (SELECT id FROM conversations WHERE event_id = :eventId))
        )
    )
    OR EXISTS (
      SELECT 1 FROM appeals a
      JOIN reports r ON a.report_id = r.id
      WHERE a.status IN (${LIVE_APPEALS})
        AND (
          (r.target_type = 'event' AND r.target_id = :eventId)
          OR r.event_id_snapshot = :eventId
          OR (r.target_type = 'comment'
              AND r.target_id IN (SELECT id FROM event_comments WHERE event_id = :eventId))
          OR (r.target_type IN ('conversation', 'message')
              AND r.conversation_id_snapshot IN
                  (SELECT id FROM conversations WHERE event_id = :eventId))
        )
    )
  `).get({ eventId });
  return Boolean(row);
}

/** Is this comment the target of a live report? */
export function commentHasLiveReport(db, commentId) {
  const row = db.prepare(`
    SELECT 1 AS held FROM reports
    WHERE status IN (${LIVE}) AND target_type = 'comment' AND target_id = ?
    UNION
    SELECT 1 AS held FROM appeals a
    JOIN reports r ON a.report_id = r.id
    WHERE a.status IN (${LIVE_APPEALS}) AND r.target_type = 'comment' AND r.target_id = ?
    LIMIT 1
  `).get(commentId, commentId);
  return Boolean(row);
}

/**
 * Is this account a party to a live report, in either direction?
 *
 * Both directions matter and the reporter side is the one that is easy to miss.
 * `reports.reporter_id` used to be ON DELETE CASCADE, so purging a reporting
 * student's anonymised shell destroyed their own safety report — a victim's
 * privacy right silently erasing the record of what was done to them. Migration
 * 011 severed that cascade so the report now survives the purge; this check is
 * the second half, holding the shell itself while a report is live so the
 * surrounding conversation and its un-snapshotted messages stay reviewable.
 *
 * The organizer clauses exist because `events.organizer_id` is ON DELETE
 * CASCADE: purging an organizer's shell deletes every event they ran and takes
 * its comments, announcements and conversations with it.
 */
export function userIsPartyToLiveReport(db, userId) {
  const row = db.prepare(`
    SELECT 1 AS held
    WHERE EXISTS (
      SELECT 1 FROM reports
      WHERE status IN (${LIVE})
        AND (reporter_id = :userId OR target_author_id = :userId
             OR (target_type = 'user' AND target_id = :userId))
    )
    OR EXISTS (
      SELECT 1 FROM reports r
      JOIN conversations c ON c.id = r.conversation_id_snapshot
      WHERE r.status IN (${LIVE}) AND (c.student_id = :userId OR c.organizer_id = :userId)
    )
    OR EXISTS (
      SELECT 1 FROM reports r
      JOIN events e ON e.id = r.event_id_snapshot
      WHERE r.status IN (${LIVE}) AND e.organizer_id = :userId
    )
    OR EXISTS (
      SELECT 1 FROM appeals a
      WHERE a.status IN (${LIVE_APPEALS}) AND a.user_id = :userId
    )
    OR EXISTS (
      SELECT 1 FROM appeals a
      JOIN reports r ON a.report_id = r.id
      WHERE a.status IN (${LIVE_APPEALS})
        AND (r.reporter_id = :userId OR r.target_author_id = :userId
             OR (r.target_type = 'user' AND r.target_id = :userId))
    )
  `).get({ userId });
  return Boolean(row);
}

/**
 * SQL predicate: true for a message the retention sweep may delete.
 *
 * Interpolated into `retentionWorker.js`'s DELETE. Four clauses, closing four
 * separate ways a live investigation could have its evidence swept out from
 * under it:
 *
 *   1. `report_evidence` — the unified snapshot. Frozen bodies are the record;
 *      the live message is the copy, but deleting the copy while the report is
 *      open loses the surrounding thread.
 *   2. `conversation_report_messages` — the LEGACY snapshot. Still named
 *      explicitly even though 013 copied every row into `report_evidence`,
 *      because dropping it from the predicate on the strength of "the fold
 *      covered it" would silently un-exempt every legacy snapshot the moment the
 *      fold turned out to have missed one.
 *   3. A message that is itself the target of a live report.
 *   4. Every message in a conversation under a live report — because the
 *      snapshot is bounded (ten either side of a reported message, five hundred
 *      for a thread) and message 501 is still evidence while somebody is
 *      reading it.
 *
 * The exemption is bounded by the report being live, not by a new retention
 * period: once a report is resolved the ordinary three-year clock applies again
 * to everything except the frozen snapshot, which is never swept. That keeps the
 * published "3 years — longer if the conversation has been reported" true
 * without inventing a second indefinite class of data, which the amended COPPA
 * Rule would not tolerate on a platform of minors.
 *
 * String-interpolated rather than parameterised because it is a fragment of a
 * prepared statement, not a value. Everything interpolated is a literal defined
 * in this file — never a caller's input.
 */
export const RETAINABLE_MESSAGE_PREDICATE = `
  id NOT IN (
    SELECT re.message_id FROM report_evidence re 
    JOIN reports r ON r.id = re.report_id 
    WHERE r.status IN (${LIVE})
  )
  AND id NOT IN (
    SELECT crm.message_id FROM conversation_report_messages crm
    JOIN conversation_reports cr ON cr.id = crm.report_id
    WHERE cr.status IN (${LIVE})
  )
  AND id NOT IN (
    SELECT target_id FROM reports
    WHERE target_type = 'message' AND status IN (${LIVE})
  )
  AND conversation_id NOT IN (
    SELECT conversation_id_snapshot FROM reports
    WHERE conversation_id_snapshot IS NOT NULL AND status IN (${LIVE})
  )
  AND id NOT IN (
    SELECT re.message_id FROM report_evidence re 
    JOIN reports r ON r.id = re.report_id 
    JOIN appeals a ON a.report_id = r.id
    WHERE a.status IN (${LIVE_APPEALS})
  )
  AND id NOT IN (
    SELECT crm.message_id FROM conversation_report_messages crm
    JOIN conversation_reports cr ON cr.id = crm.report_id
    JOIN appeals a ON a.report_id = cr.id
    WHERE a.status IN (${LIVE_APPEALS})
  )
  AND conversation_id NOT IN (
    SELECT conversation_id_snapshot FROM reports r
    JOIN appeals a ON a.report_id = r.id
    WHERE r.conversation_id_snapshot IS NOT NULL AND a.status IN (${LIVE_APPEALS})
  )
`;
