/**
 * Client mirror of the badge criteria vocabulary.
 *
 * Same arrangement as `src/issueReports.js`, `src/moderation.js` and
 * `src/appeals.js`, for the same reason: a dropdown whose options are typed out
 * again in the client is a dropdown that will one day offer a criteria type the
 * server rejects — and here the rejection is worse than a validation error,
 * because an unknown type produces a badge that is visible in the catalogue and
 * can never be earned by anybody.
 *
 * `server/badgeCriteria.js` imports NOTHING — no database, no config, no
 * `process` — which is what makes it safe to pull into the browser bundle.
 * Keep it that way; `src/serverModuleBoundary.test.js` fails the build if
 * anything reachable from it names a Node global at module scope.
 */
export {
  BADGE_CRITERIA_TYPES,
  BADGE_CRITERIA_META,
  isKnownCriteriaType,
} from '../server/badgeCriteria.js';
