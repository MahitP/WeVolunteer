/**
 * Client mirror of the server's organization tag rules.
 *
 * Re-exported from the server module rather than copied, for the reason
 * `src/eventTags.js` gives at length: two copies of a rule drift, and the
 * direction they drift in is "the UI offers something the API rejects".
 *
 * ── The drift this ends ──
 *
 * The organization form did not have a copy of these rules. It had the EVENT
 * rules — it imported `normaliseTag` and handed `TagInput` its event limits —
 * against a route that permits 40 characters and any punctuation. Two things
 * followed, and the second is much worse than the first:
 *
 *   1. "Food & Water", "St. Judes", "501(c)(3)" and every other punctuated
 *      organization name was refused by the form and accepted by the API, so
 *      half of what the platform allowed could not be typed into it.
 *
 *   2. Loading an organization whose stored tags did not satisfy the event
 *      regex silently dropped them from the form, and saving any unrelated
 *      field then wrote the survivors back over the whole column. Editing a
 *      description deleted tags the editor never showed and nobody touched.
 *
 * `server/organizationTags.js` imports nothing at all, which is what makes this
 * safe: it is a pure module, not a database connection. The rest of
 * `server/organizations.js` imports `node:crypto` and is deliberately NOT
 * re-exported here.
 *
 * Client-side validation is a courtesy that tells the organizer immediately.
 * `POST`/`PUT /api/organizations` validate every tag again.
 */
export {
  normaliseOrgTag,
  cleanOrgTag,
  MAX_ORG_TAGS,
  MAX_ORG_TAG_LENGTH,
} from '../server/organizationTags.js';
