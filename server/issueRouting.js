/**
 * Which mailbox each issue category's replies belong in. SERVER ONLY.
 *
 * ── Why this is not in `issueReports.js` ──
 *
 * It was a `replyTo` field on each entry of `ISSUE_CATEGORIES`, and the deleted
 * `GET /api/issues/categories` stripped it before answering, with the reason
 * stated plainly: "It is an internal routing decision, and publishing it would
 * tell every reader which mailbox each category reaches."
 *
 * That protection was decorative, because `src/issueReports.js` re-exports
 * `server/issueReports.js` INTO THE BROWSER BUNDLE — so the keys were compiled
 * into the JavaScript every visitor downloads regardless of what the endpoint
 * withheld. Two attempts to close it failed, and both failures are worth
 * recording because each looked correct:
 *
 *   1. Projecting the array in the client mirror to `{value, label}`. No help:
 *      the source array is still imported in order to project FROM, so it stays
 *      in the chunk.
 *   2. Moving the field into a `REPLY_TO_BY_CATEGORY` map inside
 *      `issueReports.js` and not re-exporting it. Also no help, and this one
 *      LOOKED verified: `npm run build` then `grep 'replyTo:' dist/assets/*.js`
 *      found nothing. The grep was testing the field NAME, which had just been
 *      renamed away, not the data — which Rollup kept, because a top-level
 *      `Object.freeze({...})` is a side effect it preserves even when the
 *      binding it was assigned to is tree-shaken. The built chunk still read
 *      ``conduct:`admin`,privacy:`privacy`,security:`security` ``.
 *
 * The only thing that works is for the data to live in a module the client's
 * import graph never reaches. That is this file. It must stay unimported from
 * anywhere under `src/`, and `src/serverModuleBoundary.test.js` asserts that
 * against the transitive graph rather than against a grep, because a grep for a
 * name cannot see a bundler side effect.
 *
 * Keys rather than addresses: `issueRoutes.js` resolves them against
 * `emailIdentity.js`, which reads `process.env` at module scope and is the
 * import that must never reach a browser at all.
 */
import { ISSUE_CATEGORY_VALUES } from './issueReports.js';

/**
 * `Object.create(null)`, not a literal.
 *
 * `REPLY_TO['constructor']` on a plain object is a truthy prototype member, so
 * a category named `constructor` or `toString` would resolve to a function
 * instead of falling through to the `support` default. Unreachable today —
 * `validateIssue` refuses anything outside `ISSUE_CATEGORY_VALUES` before this
 * is consulted — but a prototype-free map costs nothing and removes the need to
 * rely on that ordering.
 */
const REPLY_TO = Object.assign(Object.create(null), {
  bug: 'support',
  account: 'support',
  event: 'support',
  organization: 'support',
  profile: 'support',
  accessibility: 'support',
  information: 'support',
  /* `admin@`, deliberately NOT the moderation queue: somebody reporting a
     person should use Report on that person or event, which preserves evidence
     and escalates a student reporting an adult. This category exists because
     people reach for the general form anyway, and an enforcement address is a
     better landing place than a support inbox. */
  conduct: 'admin',
  privacy: 'privacy',
  security: 'security',
  legal: 'legal',
  other: 'support',
});

/**
 * Which mailbox KEY a category's replies belong in — `'support'`, `'security'`.
 *
 * Defaults to `support` for an unknown category rather than throwing: the
 * caller has already validated, and a report that cannot be routed must still
 * be delivered somewhere a person reads.
 */
export function replyToKeyFor(category) {
  return REPLY_TO[category] || 'support';
}

/**
 * Every category has a declared mailbox.
 *
 * Exported so `issueReports.test.js` can assert it against the vocabulary
 * instead of restating the list — a new category must not quietly acquire the
 * `support` default just because nobody added a row here.
 */
export const ROUTED_CATEGORIES = Object.freeze(
  ISSUE_CATEGORY_VALUES.filter(v => Object.hasOwn(REPLY_TO, v))
);
