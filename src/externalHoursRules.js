/**
 * The external-hours rules, re-exported from the server module that owns them.
 *
 * Re-exported, never copied — the same arrangement as `src/eventTags.js` and
 * `src/organizationTags.js`, and for the reason recorded in the latter: a
 * duplicated rule stops matching the original without anything failing, and the
 * bug shows up much later as data being quietly refused or quietly accepted.
 *
 * `server/externalHoursRules.js` has no imports at all, so this does not drag
 * the database or anything else server-side into the browser bundle.
 * `serverModuleBoundary.test.js` is what keeps that true.
 */
export {
  validateExternalHours,
  HOURS_MAX,
  ACTIVITY_MAX,
  ORGANIZATION_MAX,
  DESCRIPTION_MAX,
} from '../server/externalHoursRules.js';
