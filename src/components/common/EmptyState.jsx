import React from 'react';
import { Info } from 'lucide-react';

/**
 * Nothing here yet, said in a way somebody can act on.
 *
 * ── `headingLevel` ──
 *
 * The title is an `h3` by default because that is what it has always been and
 * what twenty-eight callers render inside a section that already has an `h2`.
 * Changing the default would have moved all of them at once to fix one page.
 *
 * But an empty state is sometimes the FIRST thing under the page's `h1` — when a
 * list is empty there is no section heading above it — and then `h1 → h3` skips
 * a level. Somebody navigating by heading, which is how a screen reader user
 * skims a page, is told a level exists that does not.
 *
 * So the level is a prop, defaulting to the level that is right in the common
 * case, and pages where the empty state is the only thing on them pass `2`.
 *
 * ── `notFound` ──
 *
 * Says that this empty state is not "nothing here yet" but "the thing you asked
 * for does not exist". It renders `data-error-kind="404"`, the same marker
 * `ErrorExperience` sets, and that is the whole reason it is a prop and not a
 * caption somebody writes.
 *
 * The accessibility sweep walks every route and refuses to count one that
 * rendered a not-found panel, because React Router serves the shell for any
 * path: a parameterised route whose fixture does not exist in the seed returns
 * 200, lands on exactly the requested URL, and renders "no such profile" —
 * which the sweep then measured and filed under the real route's name. Numbers
 * that look like coverage are worse than a route that was skipped.
 *
 * `walk.mjs` detects that by reading `data-error-kind`, so it could only ever
 * see the views whose not-found state is an `ErrorExperience`. A view that says
 * it with an `EmptyState` was invisible to the check — recorded as the known
 * remaining exposure when the sweep's fixtures were fixed on 2026-09-03, and
 * closed by this prop.
 *
 * Only for "this does not exist". NOT for a page that loaded and is empty, and
 * NOT for a failure to load: "no badges yet" is the real page, and "could not
 * reach the server" is a fault at our end, not a wrong address. Marking either
 * would throw away coverage of a page that genuinely rendered.
 */
export default function EmptyState({
  icon: Icon = Info,
  title,
  message,
  action = null,
  style = {},
  className = '',
  headingLevel = 3,
  notFound = false
}) {
  /**
   * Anything that is not an integer from 1 to 6 falls back to the default.
   *
   * Not a clamp. Clamping read well and behaved inconsistently: `0` is falsy so
   * `Number(x) || 3` turned it into 3, while `-3` clamped to 1 — two nonsense
   * inputs, two different answers, for no reason a caller could predict. One
   * rule is easier to hold: a level this component cannot render is the default
   * one.
   *
   * It matters because `<h7>` is not an element. React renders it as an unknown
   * tag, so the title would look right on screen and be absent from the document
   * outline entirely.
   */
  const asked = Number(headingLevel);
  const level = Number.isInteger(asked) && asked >= 1 && asked <= 6 ? asked : 3;
  const Heading = `h${level}`;

  return <div
      className={`card empty ${className}`.trim()}
      style={style}
      /* Undefined rather than false, so the attribute is absent — not
         `data-error-kind="false"`, which would read as a kind named "false" to
         anything matching on the attribute's presence, the sweep included. */
      data-error-kind={notFound ? '404' : undefined}
    >
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      {title && <Heading>{title}</Heading>}
      {message && <p>{message}</p>}
      {action && <div className="s-2b52df">{action}</div>}
    </div>;
}
