/**
 * Client mirror of the event-category vocabulary.
 *
 * Re-exported from the server module rather than copied, for the reason
 * `src/eventTags.js`, `src/authz.js` and `src/moderation.js` all give: two
 * copies of a rule drift, and the direction they drift in is "the UI offers
 * something the API rejects". Here that would be a category an organizer can
 * pick from a dropdown and cannot publish — a 400 naming a field they chose
 * from a list this app gave them.
 *
 * `server/eventCategories.js` imports nothing at all, which is what makes this
 * safe to pull into the browser bundle. Keep it that way.
 */
export {
  CATEGORY_GROUPS,
  VALID_CATEGORIES,
  categoryLabel,
  categoryGroup,
  isValidCategory,
} from '../server/eventCategories.js';
