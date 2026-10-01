/**
 * Client mirror of the issue-report vocabulary.
 *
 * Same arrangement as `src/moderation.js` and `src/appeals.js`, for the same
 * reason: a dropdown whose options are typed out again in the client is a
 * dropdown that will one day offer a category the server rejects, and the
 * person finds out after writing their report.
 *
 * `server/issueReports.js` imports `node:crypto` and the address book and
 * nothing else — no database, no config — which is what makes it safe to pull
 * into the browser bundle. Keep it that way.
 */
export {
  ISSUE_CATEGORIES,
  ISSUE_CATEGORY_VALUES,
  MIN_DESCRIPTION,
  MAX_DESCRIPTION,
  validateIssue,
  /* The staff view marks security and privacy reports the way the email does. */
  isSensitive,
} from '../server/issueReports.js';

/**
 * Reply routing is deliberately not reachable from here. It lives in
 * `server/issueRouting.js`, which nothing under `src/` imports, and that
 * separation is the ONLY thing that keeps the mailbox keys out of the bundle:
 * two earlier attempts — projecting this array, and moving the field to a map
 * inside `server/issueReports.js` — both left the data in the built chunk,
 * because Rollup preserves a top-level `Object.freeze({...})` as a side effect
 * even when the binding is tree-shaken. See that file.
 */
