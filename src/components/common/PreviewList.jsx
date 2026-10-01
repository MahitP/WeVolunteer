import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

/**
 * The first few of something, with a way to see the rest.
 *
 * ── Why a component and not three `.slice(0, n)` calls ──
 *
 * The dashboard and the profile both rendered a volunteer's ENTIRE service
 * history inline. For a first-year student that is four rows; for the students
 * this product is built to celebrate it is two hundred, and the page becomes a
 * wall nobody scrolls to the bottom of. The same is true of badges once tiers
 * exist.
 *
 * Capping is the easy half. The half that gets forgotten is telling somebody
 * that what they are looking at IS capped — a list that silently stops at five
 * reads as a complete list of five, and a volunteer with two hundred hours will
 * believe the record is wrong. So the count is always stated, and the link out
 * says how many are behind it.
 *
 * ── Why it navigates rather than expanding ──
 *
 * An inline "show more" solves the visual problem by recreating it one click
 * later: the wall is still there, just deferred. The full history already has a
 * page of its own, built for the job, with its own filtering and its own
 * pagination. Sending people there keeps the dashboard a summary, which is what
 * a dashboard is for.
 */
export default function PreviewList({
  items = [],
  cap = 5,
  renderItem,
  moreHref,
  moreLabel,
  label,
  className = '',
}) {
  const total = items.length;
  const shown = items.slice(0, cap);
  const hidden = total - shown.length;

  return (
    <>
      <div className={className}>
        {shown.map(renderItem)}
      </div>

      {hidden > 0 && (
        <>
          {/**
            * Stated for a screen reader before the link, because "Show all 47"
            * on its own does not say that the list above it was shortened —
            * and somebody who cannot see the list ending mid-history has no
            * other way to find out.
            */}
          <span className="sr-only">
            Showing {shown.length} of {total} {label}.
          </span>
          {moreHref ? (
            <Link to={moreHref} className="btn btn-secondary btn-sm preview-more">
              {moreLabel ?? `Show all ${total}`}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : (
            /* Nowhere to send the reader (an account with no public address):
               say how many more there are rather than render a dead link. */
            <p className="small dim">and {hidden} more.</p>
          )}
        </>
      )}
    </>
  );
}
