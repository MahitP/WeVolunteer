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
} from '../server/issueReports.js';
