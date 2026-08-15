/**
 * The order badges are shown in, and how many.
 *
 * ── Why alternating ──
 *
 * A volunteer with 250 hours and a 12-month run has earned nine hour tiers and
 * five streak tiers. Sorted by category that reads as a column of medals
 * followed by a column of flames, and the first thing anybody sees is nine
 * variations on one fact. Interleaving them puts the two DIFFERENT things a
 * person has done at the top:
 *
 *     🏅 250 Hours
 *     🔥 12 Month Streak
 *     🏅 200 Hours
 *     🔥 9 Month Streak
 *
 * Each row says something the row above it did not. When one category runs out
 * the other simply continues.
 *
 * ── Why the highest first ──
 *
 * Lower tiers are implied by higher ones. Somebody with 250 hours obviously has
 * 5, so the 5-hour badge is the least informative row on the page — and under
 * an ascending order it would be the first one read.
 */

/** Categories that form a progression, in the order they interleave. */
const PROGRESSIONS = ['Service hours', 'Consistency'];

/**
 * A badge's rank within its progression, or null if it is not in one.
 *
 * Read off `criteria_value` rather than parsed out of the name: the threshold
 * is the number the server decided the badge on, and a name is display text
 * that can be reworded.
 */
const tierOf = (badge) => (
  typeof badge?.criteria_value === 'number' ? badge.criteria_value : null
);

/**
 * Orders earned badges for display.
 *
 * Progressions interleave highest-first; everything else — Early Supporter,
 * Reliable Volunteer, the organizer badges — keeps its server order and follows,
 * because those are singular facts rather than rungs and reordering them by a
 * threshold would be meaningless.
 *
 * @param {Array} badges as the server returned them
 * @returns {Array} the same badges, reordered
 */
export function orderBadges(badges) {
  if (!Array.isArray(badges)) return [];

  const lanes = PROGRESSIONS.map(category => badges
    .filter(b => b?.category === category && tierOf(b) !== null)
    .sort((a, b) => tierOf(b) - tierOf(a)));

  const singular = badges.filter(b => !PROGRESSIONS.includes(b?.category) || tierOf(b) === null);

  const interleaved = [];
  for (let i = 0; i < Math.max(...lanes.map(l => l.length), 0); i += 1) {
    for (const lane of lanes) {
      if (lane[i]) interleaved.push(lane[i]);
    }
  }

  return [...interleaved, ...singular];
}

/**
 * The few badges worth showing an ORGANIZER beside an applicant's name.
 *
 * Deliberately not the volunteer's whole cabinet. An organizer deciding who
 * gets one of twenty places is answering "have they done this before, and do
 * they turn up" — and a row of nine hour tiers answers neither while burying
 * the two badges that do. So: the status badge, then the single highest tier
 * from each progression as evidence of scale, and nothing else.
 */
export function organizerBadges(badges) {
  if (!Array.isArray(badges)) return [];

  const status = badges.filter(b => b?.criteria_type === 'attendance_rate');
  const topOfEach = PROGRESSIONS
    .map(category => badges
      .filter(b => b?.category === category && tierOf(b) !== null)
      .sort((a, b) => tierOf(b) - tierOf(a))[0])
    .filter(Boolean);

  return [...status, ...topOfEach];
}
