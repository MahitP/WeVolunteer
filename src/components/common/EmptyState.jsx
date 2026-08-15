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
 */
export default function EmptyState({
  icon: Icon = Info,
  title,
  message,
  action = null,
  style = {},
  className = '',
  headingLevel = 3
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

  return <div className={`card empty ${className}`.trim()} style={style}>
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      {title && <Heading>{title}</Heading>}
      {message && <p>{message}</p>}
      {action && <div className="s-2b52df">{action}</div>}
    </div>;
}
