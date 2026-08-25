/**
 * What kind of thing an opportunity IS — the fixed vocabulary behind
 * `events.category`.
 *
 * ── Why this file exists ──
 *
 * The vocabulary was five words: `School`, `5K`, `Food Pantry`, `Fundraiser`,
 * `Other`. Four of them are one district's four commonest events and the fifth
 * is a shrug, and the shape of the list shows it: `5K` names a single race
 * distance while `Other` has to carry animal shelters, river cleanups, nursing
 * homes, tutoring, blood drives and set-building for the school play. On the
 * seeded demo data the snack shack — the flagship event — is filed under
 * `Other`, because there is nothing else it could be.
 *
 * That has two costs, and the second is the real one:
 *
 *   · The category filter on Discover cannot narrow anything, because most of
 *     the platform is in one bucket.
 *   · `impact.js` aggregates on this column and `weighting.js` reads it for the
 *     Auto Select draw. "What kind of service does this district do?" is a
 *     question the Impact Dashboard is supposed to answer, and the honest
 *     answer it could give was "mostly Other".
 *
 * ── What is NOT changing ──
 *
 * The model. `category` stays exactly what it was: ONE fixed value per event, on
 * the events row, behind a CHECK constraint. Tags remain the open,
 * organizer-typed vocabulary beside it (`server/eventTags.js` explains the
 * split, and none of that reasoning is disturbed here — a food drive run by the
 * honour society still gets `#NHS` and `#FoodDrive` as tags, and picks the one
 * category that says what it is).
 *
 * Every one of the five original values is still a value. Widening an enum
 * cannot invalidate a row; renaming or removing one would, and nothing here does
 * either. `5K` in particular is kept as-is rather than being generalised to
 * `Sports`, because rows carry it — its LABEL now reads "5K, race or athletics",
 * which is a display change and touches no data.
 *
 * ── Why groups ──
 *
 * Sixteen options in one flat `<select>` is a list to be read; five headed
 * groups of two to four is a list to be scanned. The grouping is presentational
 * — `<optgroup>` in the form, section headings anywhere else — and is
 * deliberately NOT stored: a second stored field would be a taxonomy to keep in
 * step with this one, and `events` would then have two columns that can
 * disagree about the same event. The group is a property of the value, so it is
 * derived from the value.
 *
 * ── Where this file may be imported from ──
 *
 * Anywhere, including the browser. It imports nothing — no `db`, no `config`, no
 * Node globals — which is what lets `src/eventCategories.js` re-export it
 * straight into the client bundle rather than keeping a second copy that can
 * drift. `src/serverModuleBoundary.test.js` enforces the "imports nothing"
 * half of that; keep it true.
 */

/**
 * The vocabulary, in the order it should be offered.
 *
 * `value` is what is stored and what the CHECK constraint admits. `label` is
 * what a person reads and may be re-worded freely — nothing keys on it.
 *
 * The order is not alphabetical and is not arbitrary: education first because
 * this is a school platform and that is where most events start, `Other` last
 * because a catch-all offered early is a catch-all that gets picked.
 */
export const CATEGORY_GROUPS = Object.freeze([
  {
    group: 'Education & youth',
    categories: [
      { value: 'School', label: 'School & classroom' },
      { value: 'Tutoring', label: 'Tutoring & mentoring' },
      { value: 'Youth Programs', label: 'Youth programs & camps' },
    ],
  },
  {
    group: 'Community & care',
    categories: [
      { value: 'Food Pantry', label: 'Food pantry & meals' },
      { value: 'Housing & Shelter', label: 'Housing & shelter' },
      { value: 'Seniors', label: 'Seniors & care homes' },
      { value: 'Health', label: 'Health & blood drives' },
    ],
  },
  {
    group: 'Environment & animals',
    categories: [
      { value: 'Environment', label: 'Environment & cleanups' },
      { value: 'Animals', label: 'Animals & shelters' },
    ],
  },
  {
    group: 'Events & recreation',
    categories: [
      { value: '5K', label: '5K, race or athletics' },
      { value: 'Sports', label: 'Sports & coaching' },
      { value: 'Arts & Culture', label: 'Arts, culture & performance' },
    ],
  },
  {
    group: 'Support the cause',
    categories: [
      { value: 'Fundraiser', label: 'Fundraiser' },
      { value: 'Donation Drive', label: 'Donation & collection drive' },
      { value: 'Administrative', label: 'Office & admin support' },
    ],
  },
  {
    group: 'Anything else',
    categories: [
      { value: 'Other', label: 'Other community service' },
    ],
  },
]);

/**
 * Every stored value, flattened, in offer order.
 *
 * This is the allowlist the create and update routes check against, and the
 * same list `057_widen_event_categories.js` writes into the CHECK constraint —
 * `server/db.categoryVocabulary.test.js` asserts the two agree, so a value added
 * here and not migrated cannot reach production as a 500 on INSERT.
 */
export const VALID_CATEGORIES = Object.freeze(
  CATEGORY_GROUPS.flatMap(g => g.categories.map(c => c.value)),
);

/** `value` → the words a reader sees. Falls back to the value itself. */
const LABELS = Object.freeze(Object.fromEntries(
  CATEGORY_GROUPS.flatMap(g => g.categories.map(c => [c.value, c.label])),
));

/**
 * The label for a stored value.
 *
 * Returns the value unchanged for anything it does not recognise, rather than
 * an empty string or "Unknown". A row written before a future vocabulary change
 * still has to render as SOMETHING, and the stored word is the most truthful
 * thing available.
 */
export function categoryLabel(value) {
  return LABELS[value] ?? String(value ?? '');
}

/** Which group a stored value belongs to, or `''` if it is not in the vocabulary. */
export function categoryGroup(value) {
  return CATEGORY_GROUPS.find(g => g.categories.some(c => c.value === value))?.group ?? '';
}

/** Whether a value is one this platform stores. */
export function isValidCategory(value) {
  return VALID_CATEGORIES.includes(value);
}
