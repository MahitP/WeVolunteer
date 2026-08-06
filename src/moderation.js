/**
 * Client mirror of the server's report taxonomy.
 *
 * Re-exported from the server module rather than copied, for the reason
 * `src/authz.js` gives about the capability table: two copies of a list drift,
 * and the direction they drift in is "the UI offers something the API rejects".
 *
 * That is not hypothetical here. It has already happened twice on this surface:
 *
 *   - `src/components/messages/ReportModal.jsx` offered
 *     `spam · harassment · inappropriate · other` against a server that accepted
 *     `inappropriate · spam · safety · other`, so "Harassment or bullying" — the
 *     reason a student is most likely to reach for — was refused with a 400 every
 *     time, and the only error handling was a `console.error`.
 *   - `src/components/ReportModal.jsx` sent free prose where the unified model
 *     expected a category, so every report of an event or a comment landed in the
 *     catch-all and the eighteen-category taxonomy was unreachable from the
 *     product entirely.
 *
 * `server/moderation.js` imports nothing at all — no db, no config — which is
 * what makes it safe to pull into the client bundle. Keep it that way.
 *
 * This is presentation only. The server re-validates every category, derives
 * priority itself and ignores anything the client asserts about it; the
 * per-target filter below is a way of keeping a list of eighteen scannable, never
 * a rule. A category offered for the "wrong" target is a mis-tap, and the server
 * deliberately accepts it — 400-ing a distressed student over a category/target
 * combination is worse in every way than filing a slightly mis-categorised
 * report.
 */
export {
  REPORT_CATEGORIES,
  CATEGORY_GROUPS,
  CATEGORY_VALUES,
  CATEGORY_PRIORITY,
  REPORT_PRIORITIES,
  REPORT_STATUSES,
  REPORT_RESOLUTIONS,
  REPORT_TARGET_TYPES,
  MAX_DESCRIPTION_LENGTH,
  categoriesForTarget,
  isValidCategory,
  normalizeTargetType,
} from '../server/moderation.js';

import { CATEGORY_GROUPS, categoriesForTarget } from '../server/moderation.js';

/**
 * The offered categories, arranged for a `<select>`: groups in the order the
 * taxonomy declares them, each carrying only the categories that survived the
 * per-target filter, and empty groups dropped so a certificate report does not
 * render four empty headings.
 *
 * Grouped rather than flat because eighteen options in one list is not something
 * anybody reads — least of all somebody upset enough to be filing a report.
 */
export function groupedCategoriesFor(targetType) {
  const offered = categoriesForTarget(targetType);
  return Object.entries(CATEGORY_GROUPS)
    .map(([key, label]) => ({
      key,
      label,
      options: offered.filter(c => c.group === key),
    }))
    .filter(group => group.options.length > 0);
}

/**
 * What a moderator sees instead of the stored value.
 *
 * Stored values are stable snake_case and are never displayed — the labels are
 * written in the first person for the student filing, and the moderation queue
 * shows the same words so both sides of a report are talking about the same
 * thing.
 */
export function categoryLabel(value) {
  if (!value) return 'No category';
  const match = categoriesForTarget('message').find(c => c.value === value);
  // A category the server has retired still has to render: an old report keeps
  // whatever it was filed as, and a blank cell on a moderation surface reads as
  // "nothing wrong here".
  return match?.label ?? value.replace(/_/g, ' ');
}
