import crypto from 'crypto';
import { db } from '../db.js';
import { notificationService } from './notificationService.js';

/**
 * Badges: recognition that is CONFERRED, as opposed to milestones, which are
 * DERIVED.
 *
 * ── Why this platform has two achievement systems, and what each is for ──
 *
 * It shipped with two, by accident, and they collided: `MILESTONE_TIERS` — then
 * inline in `routes/userRoutes.js`, now `server/milestones.js` — and the
 * `badges` / `user_badges` tables driven by this
 * module both rendered on the volunteer profile page, with overlapping
 * thresholds and different names for the same achievement — a "Silver Award" at
 * 25 hours beside a "Community Champion" at 50. A student had no way to tell
 * which one was the real record of their service, and neither did we.
 *
 * They are kept, because they answer genuinely different questions, and the line
 * between them is now explicit:
 *
 *   MILESTONES are derived on every read from the attendance ledger and never
 *   stored. They cannot be wrong and they cannot go stale: revoke an hour and
 *   the milestone is gone on the next request. They own EVERY threshold that is
 *   a function of the service record — credited hours and distinct events — and
 *   that is where the district's 25-hour Silver Award lives, matching the
 *   `HOUR_GOAL = 25` the client renders its meter against.
 *
 *   BADGES are awarded records: a row, with a date, optionally an `awarded_by`,
 *   revocable, and surviving in somebody's history after the definition behind
 *   it is retired. They own what a milestone cannot honestly express — a
 *   reliability ratio, organizer work, when somebody joined — and everything a
 *   human confers by hand for a reason no query knows about.
 *
 * The vocabulary below still implements `hours` and `events_attended`, because
 * an administrator may deliberately define such a badge and the evaluation has
 * to be correct when they do. What changed is that the SHIPPED catalogue defines
 * none: `scripts/seed_badges.js` is the reconciliation that removes the
 * collision, and its header carries the rest of the reasoning.
 */

/**
 * The criteria types this service actually evaluates.
 *
 * Exported because it has to be the same list in two places that used to
 * disagree silently: the switch below, and the validation on
 * `POST /api/admin/badges`. That route accepted anything, so `'hourz'` created a
 * badge which passed every check, appeared in the catalogue, and could never be
 * earned by any code path — the same shape of defect as the empty
 * `early_adopter` branch this module used to carry.
 *
 * `manual` is a member and is deliberately never auto-awarded: it is how an
 * administrator says "this one is mine to give".
 */
export const BADGE_CRITERIA_TYPES = Object.freeze([
  'hours',
  'events_attended',
  'events_created',
  'attendance_rate',
  'early_adopter',
  'manual',
]);

/** Whether `type` is a criteria type this service can evaluate. */
export function isKnownCriteriaType(type) {
  return BADGE_CRITERIA_TYPES.includes(type);
}

/**
 * The minimum number of sign-ups before an attendance RATE means anything.
 *
 * One shift attended is a 100% attendance rate, and saying so would make the
 * "Reliable Volunteer" badge a reward for turning up once.
 */
const ATTENDANCE_RATE_MIN_SIGNUPS = 5;

/**
 * Every figure the criteria below are decided against, read once per evaluation.
 *
 * Exported on the service so tests — and anybody debugging "why did this not
 * award?" — can see the inputs rather than infer them from the outcome.
 */
function collectStats(userId) {
  /**
   * `COUNT(DISTINCT at.event_id)`, not `COUNT(at.id)`.
   *
   * The original counted attendance ROWS, and there is one row per shift. Two
   * shifts at one event scored as two events, so an "attended 5 events" badge
   * could be earned at a single day-long event with five slots — while
   * `GET /api/users/:id/profile` computed `eventsCompleted` with
   * `COUNT(DISTINCT event_id)` two lines away. The profile and the badge
   * disagreed about the same word, and the profile was right.
   */
  const service = db.prepare(`
    SELECT COALESCE(SUM(hours_awarded), 0) AS total_hours,
           COUNT(DISTINCT event_id)        AS events_attended,
           COUNT(*)                        AS shifts_attended
    FROM attendance
    WHERE user_id = ? AND present = 1
  `).get(userId);

  /**
   * `status != 'cancelled'`, not `status IN ('published', 'completed')`.
   *
   * There is no `'published'` status: the events CHECK constraint permits
   * `open`, `closed`, `completed` and `cancelled` only. So the original clause
   * reduced to "completed", and an organizer could not earn the "Organizer"
   * badge for creating an opportunity until that opportunity had already
   * finished — which is not what "Created approved opportunities" says, and is
   * not when the recognition is worth anything.
   */
  const organizing = db.prepare(`
    SELECT COUNT(*) AS events_created
    FROM events
    WHERE organizer_id = ? AND status != 'cancelled'
  `).get(userId);

  const reliability = db.prepare(`
    SELECT COUNT(*) AS signups,
           COALESCE(SUM(CASE WHEN present = 1 THEN 1 ELSE 0 END), 0) AS present
    FROM attendance
    WHERE user_id = ?
  `).get(userId);

  /**
   * How early this account is, as a 1-based rank over registration order.
   *
   * ── Why a rank rather than a cut-off date ──
   *
   * `criteria_value` is an INTEGER column, so a date would have to be smuggled
   * through it as an epoch or a magic number — and a date cut-off has to be
   * chosen and then re-chosen every time the platform's idea of "early" moves.
   * A rank is stable in a way a date is not: the number of accounts created
   * before yours never changes, so nobody's Early Supporter badge can be
   * revoked by the passage of time or by somebody else signing up.
   *
   * The id is the tie-break, and it is not decorative: the demo seed inserts
   * every account with the same `created_at`, so ordering on the timestamp
   * alone is not a total order and the rank would depend on row order.
   */
  const tenure = db.prepare(`
    SELECT COUNT(*) AS rank
    FROM users
    WHERE created_at < (SELECT created_at FROM users WHERE id = ?)
       OR (created_at = (SELECT created_at FROM users WHERE id = ?) AND id <= ?)
  `).get(userId, userId, userId);

  return {
    totalHours: Number(service?.total_hours ?? 0),
    eventsAttended: Number(service?.events_attended ?? 0),
    shiftsAttended: Number(service?.shifts_attended ?? 0),
    eventsCreated: Number(organizing?.events_created ?? 0),
    signups: Number(reliability?.signups ?? 0),
    present: Number(reliability?.present ?? 0),
    joinRank: Number(tenure?.rank ?? 0),
  };
}

/**
 * Whether `badge` is earned on the strength of `stats`.
 *
 * Three-valued on purpose. `null` means "this service does not decide" — a
 * `manual` badge, or a criteria type that is not in the vocabulary — and it is
 * what keeps the withdrawal pass below from taking away a badge it never had the
 * standing to grant. A two-valued answer would make "not earned" and "not mine
 * to judge" the same thing, and the sweep would then revoke every manual award
 * the first time it ran.
 */
function meetsCriteria(badge, stats) {
  const threshold = Number(badge.criteria_value ?? 0);

  switch (badge.criteria_type) {
    case 'hours':
      return stats.totalHours >= threshold;
    case 'events_attended':
      return stats.eventsAttended >= threshold;
    case 'events_created':
      return stats.eventsCreated >= threshold;
    case 'attendance_rate':
      if (stats.signups < ATTENDANCE_RATE_MIN_SIGNUPS) return false;
      return (stats.present / stats.signups) * 100 >= threshold;
    /**
     * Previously an empty branch with a comment saying the logic "could" check
     * the join date. It never did, so the seeded "Early Supporter" badge was
     * unearnable by every code path in the application — it sat in the
     * catalogue looking like something to aim for.
     *
     * `threshold` is the size of the early cohort. The seeded value is 0, which
     * this reads as "nobody", so an un-reconciled database fails CLOSED rather
     * than awarding the badge to every account that ever evaluates.
     */
    case 'early_adopter':
      return threshold > 0 && stats.joinRank > 0 && stats.joinRank <= threshold;
    case 'manual':
      return null;
    default:
      return null;
  }
}

/**
 * Grants and withdraws in one pass.
 *
 * ── Why withdrawal belongs here ──
 *
 * Attendance can be un-marked: `finalizeAttendance` produces an `outcome.revoked`
 * list, hours come back off the ledger, and the derived milestone disappears on
 * the volunteer's next page load. The badge did not. A student could keep a
 * "Community Champion" badge for fifty hours that had been taken off their
 * record — a stored achievement contradicting the ledger it was computed from,
 * on the same page as the ledger.
 *
 * Only AUTOMATIC awards are withdrawn (`awarded_by IS NULL`). A manual award is
 * a decision a person made for a reason not visible to any query, and a nightly
 * sweep undoing human judgement is a worse failure than the one being fixed.
 * Removing one of those is `DELETE /api/admin/users/:userId/badges/:badgeId`,
 * which is audited because it is somebody choosing to do it.
 *
 * Inactive definitions are out of the loop in BOTH directions: retiring a badge
 * stops it being awarded and freezes the awards already made under it, so
 * reconciling the catalogue can never wipe somebody's history.
 *
 * @returns {{awarded: string[], withdrawn: string[]}} badge ids that changed
 */
function evaluateBadges(userId) {
  const result = { awarded: [], withdrawn: [] };

  try {
    const stats = collectStats(userId);

    const candidates = db.prepare(`
      SELECT b.*, ub.id AS user_badge_id, ub.awarded_by
      FROM badges b
      LEFT JOIN user_badges ub ON ub.badge_id = b.id AND ub.user_id = ?
      WHERE b.active = 1
    `).all(userId);

    for (const badge of candidates) {
      const earned = meetsCriteria(badge, stats);
      if (earned === null) continue;

      if (earned && !badge.user_badge_id) {
        db.prepare(`
          INSERT INTO user_badges (id, user_id, badge_id, earned_at)
          VALUES (?, ?, ?, ?)
        `).run(`ub-${crypto.randomUUID()}`, userId, badge.id, new Date().toISOString());
        result.awarded.push(badge.id);
        announce(userId, badge);
        continue;
      }

      if (!earned && badge.user_badge_id && badge.awarded_by === null) {
        db.prepare('DELETE FROM user_badges WHERE id = ?').run(badge.user_badge_id);
        result.withdrawn.push(badge.id);
      }
    }
  } catch (err) {
    /**
     * Best-effort, deliberately. Badge evaluation runs after attendance has
     * already been confirmed and committed; a failure here must never look to
     * the organizer like the attendance failed. `notificationService.dispatch`
     * makes the same distinction and documents it, for the same reason.
     */
    console.error(`Error evaluating badges for user ${userId}:`, err);
  }

  return result;
}

/**
 * Tells the volunteer, through the one path that respects their preferences.
 *
 * This used to be a raw `INSERT INTO notifications`, which bypassed three things
 * at once: the per-category notification preference (a volunteer who had turned
 * Volunteer notifications off was told anyway), the `dedupe_key` unique index
 * (`_insertInApp` is what populates it), and the `priority` column that the
 * 30-day retention sweep reads. It also linked to `/profile?tab=badges`, and
 * `VolunteerProfile` has no `tab` query handling — so the query string was
 * ignored and the link went to the top of the profile.
 *
 * Failure is swallowed here rather than at the call site: the badge is earned
 * whether or not we managed to say so, and `dispatch` already rethrows for the
 * mandatory-notice class, which a badge is emphatically not.
 */
function announce(userId, badge) {
  try {
    notificationService.dispatch(
      'BADGE_EARNED',
      { badgeId: badge.id, badgeName: badge.name, badgeIcon: badge.icon },
      userId,
      /**
       * Keyed on the badge, so re-earning one after a revocation does not
       * produce a second copy of the same congratulation. The unique index is
       * on (user_id, dedupe_key), which makes that permanent rather than the
       * seven days `dispatch`'s own check covers — the right trade for a
       * message whose entire content is "you have this badge".
       */
      `badge:${badge.id}`
    );
  } catch (err) {
    console.error(`Failed to announce badge ${badge.id} to ${userId}:`, err);
  }
}

export const badgeService = {
  evaluateBadges,
  collectStats,
  meetsCriteria,
};
