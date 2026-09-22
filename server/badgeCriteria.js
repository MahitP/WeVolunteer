/**
 * The badge criteria vocabulary, and nothing else.
 *
 * ── Why this is its own module ──
 *
 * It lived in `server/services/badgeService.js`, which is the right home for
 * the evaluator and the wrong one for the vocabulary: that module imports
 * `db.js`, `notificationService.js`, `reliability.js` and
 * `volunteerInsights.js`, so it cannot be pulled into the browser bundle — the
 * dev server would hand a module chain reaching `process.env` to a browser that
 * has no `process`, which is the exact failure `src/serverModuleBoundary.test.js`
 * was written for.
 *
 * The badge administration form needs these seven strings, and there are only
 * three ways it could get them:
 *
 *   1. Type them out again in the client. That is a dropdown offering criteria
 *      types the server rejects, and the person finds out after filling the
 *      form in. `POST /api/admin/badges` validates against this list and
 *      answers `{ error, field: 'criteria_type' }`, so the two would drift into
 *      contradicting each other.
 *   2. Add an endpoint that publishes them. `GET /api/issues/categories` is
 *      exactly that, and it has no callers: the client imports
 *      `server/issueReports.js` directly instead, which is a stronger guarantee
 *      because it holds at build time rather than at request time.
 *   3. Extract the vocabulary into a module with no dependencies, which is what
 *      `server/issueReports.js` and `server/sensitiveActions.js` already do,
 *      and what this is.
 *
 * ── Keep it dependency-free ──
 *
 * No imports, no `process`, no `db`. `src/badgeCriteria.js` re-exports this
 * file into the bundle, and `serverModuleBoundary.test.js` fails the build if
 * anything reachable from here names a Node global at module scope.
 */

/**
 * Every criteria type the evaluator can decide.
 *
 * A type outside this list produces a badge that is real, visible in the
 * catalogue, and impossible to earn: `badgeService`'s switch falls through to
 * "not mine to decide" on a type it does not know, so nothing fails, nothing
 * logs, and the only symptom is a badge nobody ever gets — which reads as
 * "nobody has qualified yet".
 *
 * `manual` is a member and is deliberately never auto-awarded: it is how an
 * administrator says "this one is mine to give".
 */
export const BADGE_CRITERIA_TYPES = Object.freeze([
  'hours',
  'events_attended',
  'events_created',
  'attendance_rate',
  'streak_months',
  'early_adopter',
  'manual',
]);

/** Whether `type` is a criteria type this service can evaluate. */
export function isKnownCriteriaType(type) {
  return BADGE_CRITERIA_TYPES.includes(type);
}

/**
 * What each type means, and what its threshold counts.
 *
 * The form is unusable without this. "criteria_value" against a bare
 * `attendance_rate` is a number with no unit — an administrator cannot tell
 * whether 80 means 80 percent or 80 shifts, and `badgeService` compares it
 * against a percentage. Guessing wrong produces a badge that is either trivial
 * or unearnable, and the symptom of both is silence.
 *
 * `threshold: false` means the type takes no number, and `manual` is the only
 * one: it is given by hand, and `meetsCriteria` answers `null` for it rather
 * than comparing anything.
 *
 * `early_adopter` used to be marked that way too, on the reading that it is
 * "decided by when somebody joined rather than by how much they have done".
 * True of the QUESTION and false of the definition: the threshold is the size
 * of the early cohort — the seeded Early Supporter carries 250 — and
 * `badgeService.meetsCriteria` requires it to be positive, deliberately, so an
 * un-reconciled database fails closed rather than awarding the badge to every
 * account that evaluates.
 *
 * With the field hidden the form saved 0, so an administrator defining a new
 * early-adopter badge got one that validated, saved, appeared in the catalogue
 * and could never be earned by anybody — the second of the two outcomes named
 * above, whose symptom is silence. `badges.test.js` now refuses any type that
 * hides a threshold the evaluator will not award without.
 */
export const BADGE_CRITERIA_META = Object.freeze({
  hours: {
    label: 'Hours volunteered',
    threshold: true,
    unit: 'hours',
    help: 'Earned once the volunteer has this many credited hours.',
  },
  events_attended: {
    label: 'Events attended',
    threshold: true,
    unit: 'events',
    help: 'Earned once the volunteer has been marked present at this many events.',
  },
  events_created: {
    label: 'Events created',
    threshold: true,
    unit: 'events',
    help: 'For organizers: earned once they have posted this many events.',
  },
  attendance_rate: {
    label: 'Attendance rate',
    threshold: true,
    unit: '%',
    help: 'Earned once this percentage of accepted shifts were attended. '
      + 'Only counts once there is enough history to be fair — see MIN_EVIDENCE.',
  },
  streak_months: {
    label: 'Consecutive months',
    threshold: true,
    unit: 'months',
    help: 'Earned after volunteering in this many months in a row.',
  },
  early_adopter: {
    label: 'Early adopter',
    threshold: true,
    unit: 'accounts',
    help: 'Earned by the first N accounts to join, counted by signup order. '
      + 'The threshold is the size of that group — the seeded Early Supporter '
      + 'badge uses 250. Nobody qualifies at 0.',
  },
  manual: {
    label: 'Awarded by hand',
    threshold: false,
    unit: null,
    help: 'Never awarded automatically. An administrator gives this one '
      + 'deliberately, and can take it back.',
  },
});
