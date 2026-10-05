/**
 * Dates on the legal surface.
 *
 * Extracted because the Legal Center, the document page and the editor all print
 * the same kind of date and the reasoning below is the whole reason the function
 * is not a one-liner. Duplicated, the copy without the comment eventually gets
 * "simplified" into `new Date(iso)`, which is the bug it exists to prevent.
 */

/**
 * A `YYYY-MM-DD` effective date, in the reader's locale.
 *
 * Parsed as a plain date, not a timestamp: `new Date('2026-08-05')` is midnight
 * UTC, which prints as the 4th for every reader west of Greenwich. An effective
 * date that is a day early is the kind of error nobody notices until it is the
 * thing being argued about.
 *
 * Returns null rather than a placeholder, so a caller decides what an absent
 * date should look like instead of inheriting "Invalid Date".
 */
export function formatLegalDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

/** Today as `YYYY-MM-DD`, in the reader's own timezone rather than UTC. */
export function todayIso() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The effective date as a version line states it: "in effect since …" once it
 * has arrived, "takes effect …" while it is still ahead.
 *
 * Every line used to say "in effect since", which stopped being true the first
 * time a document was published ahead of its date — what a notice period is.
 * Terms 2.0 is published thirty days early, as Terms §13 promises, and for those
 * thirty days the page would have told readers they were already bound by it.
 *
 * The reader's own calendar day, like the editor's picker: the server compares
 * in UTC with a day of slack for the same reason (`parseEffectiveAt`).
 */
export function effectiveDateLabel(iso, today = todayIso()) {
  const formatted = formatLegalDate(iso);
  if (!formatted) return null;
  return String(iso).slice(0, 10) > today
    ? `takes effect ${formatted}`
    : `in effect since ${formatted}`;
}

/**
 * The latest date the server will accept, as `YYYY-MM-DD`.
 *
 * Mirrors `MAX_EFFECTIVE_DAYS_AHEAD` in server/legalStore.js. The server owns
 * the answer — this exists only so the native date picker refuses the bad range
 * before a round trip, and so the hint can print the bound rather than describe
 * it vaguely.
 *
 * A year is past every real notice period and every school-year alignment, and
 * still catches the error these fields attract: a mistyped leading digit.
 */
export const MAX_EFFECTIVE_DAYS_AHEAD = 365;

export function latestEffectiveIso(from = todayIso()) {
  /* Built from the date string rather than from `Date.now()`, so it is exactly
     N days after whatever `todayIso()` decided — the two cannot disagree across
     a midnight boundary or a timezone. */
  const at = new Date(`${from}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + MAX_EFFECTIVE_DAYS_AHEAD);
  return at.toISOString().slice(0, 10);
}

/**
 * `todayIso()` plus N days, as `YYYY-MM-DD`.
 *
 * Built from the date string in UTC and then read back as a plain date, the
 * same way `latestEffectiveIso` is: adding days to a `Date` built from local
 * midnight crosses a DST boundary twice a year and returns a day early or late.
 *
 * Used for the material-change notice floor. `N` comes from the server
 * (`materialNoticeDays` on the editor payload), so the browser's picker floor
 * and the server's refusal are computed from one number.
 */
export function isoPlusDays(days, from = todayIso()) {
  const at = new Date(`${from}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + Number(days || 0));
  return at.toISOString().slice(0, 10);
}
