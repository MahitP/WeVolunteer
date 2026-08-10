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
