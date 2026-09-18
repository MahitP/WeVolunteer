import React, { useId } from 'react';
import { APP_NAME } from '../../config';
import {
  MARK_PATH, WORDMARK_LETTERS_PATH, WORDMARK_VIEWBOX, WORDMARK_W_STROKE,
} from './logoGeometry';
import { MARK_PATH_LENGTH, resolveMotion } from './brandMotion';

/** The name the vector lettering spells. */
const DRAWN_NAME = 'WeVolunteer';

/** The behaviours the lockup can actually perform. */
const SUPPORTED_MOTION = ['lockup', 'micro'];

/**
 * The reveal edge, as a rect in the wordmark's own coordinate space.
 *
 * `WIPE_RIGHT_EDGE` is the rect's right edge — the edge that uncovers the
 * lettering — and the only geometry the real wordmark changed. It is solved in
 * `wvMotion.css` §6 and checked by `logoAssets.test.jsx`:
 *
 *   at rest the word is held at translateX(-9), which would park the "e"'s
 *   leftmost ink beside the W for any edge right of 88.49; 86 keeps 2.49 units
 *   of clearance. The run (`--wv-wipe-run`, 365) clears the letters' right
 *   extent at 432.16.
 *
 * The rect is wide and tall enough to cover everything left of the edge at every
 * skewed height; only its right edge matters optically.
 */
export const WIPE_RIGHT_EDGE = 86;
export const WIPE_RECT = { width: 600, height: 200, y: -60 };

/**
 * The WeVolunteer wordmark: the checkmark-W as the first letter, then
 * "eVolunteer", as one vector drawing. See `logoGeometry.js` for how it is
 * constructed.
 *
 * It is one image with one accessible name. It is never paired with `BrandMark`
 * — the W already is the mark.
 *
 * Colour is `currentColor`, set by `.wordmark` from `--brand-wordmark`: the
 * brand green on light surfaces, white on dark ones. The mark is never
 * recoloured to a lighter green for dark mode.
 *
 * ── A renamed deployment gets text, not the wrong drawing ──
 *
 * `APP_NAME` is configurable (`VITE_APP_NAME`). The lettering spells one name,
 * so a deployment that sets another one renders that name as text rather than a
 * logo that says something else. **`motion` is a no-op on that branch** — there
 * is no path to draw and no wordmark to reveal, so the text renders exactly as
 * it does today.
 *
 * ── `motion` ──
 *
 * `'lockup'` is the frozen entrance: the W draws through its gait, pulls, holds
 * a beat, and the lettering is then uncovered by an edge parallel to the
 * overreach. `'micro'` is one 560ms pass on hover or focus of the interactive
 * ancestor, which must carry `.wv-micro` and, off a card surface, its own
 * `--wv-sweep`. `'none'` (the default) is the static locked lockup.
 *
 * The other frozen behaviours are mark-only and resolve to `'none'` here: a
 * loader or a success beat is the symbol's job, not the wordmark's, and the
 * return (`.wv-ret-*`) has no product surface yet.
 *
 * **Each animated instance gets its own `clipPath` id** from `useId()`. Ids are
 * document-global; two lockups sharing one would animate in lockstep. A static
 * lockup uses no clip at all, so nothing can clip the resting logo.
 */
export default function Wordmark({ className, motion = 'none' }) {
  /* Called unconditionally: hooks may not sit behind the rename branch. */
  const clipId = useId();

  if (APP_NAME !== DRAWN_NAME) {
    return <span className={className ? `brand-name ${className}` : 'brand-name'}>{APP_NAME}</span>;
  }

  const behaviour = resolveMotion(motion, { supported: SUPPORTED_MOTION });
  const animatedLockup = behaviour === 'lockup';
  const wipeId = `wv-wipe-${clipId}`;

  return (
    <svg
      className={className ? `wordmark ${className}` : 'wordmark'}
      viewBox={WORDMARK_VIEWBOX}
      role="img"
      aria-label={DRAWN_NAME}
      focusable="false"
    >
      {animatedLockup && (
        <defs>
          <clipPath id={wipeId}>
            <rect
              className="wv-wipe wv-lock-wipe"
              x={WIPE_RIGHT_EDGE - WIPE_RECT.width}
              y={WIPE_RECT.y}
              width={WIPE_RECT.width}
              height={WIPE_RECT.height}
            />
          </clipPath>
        </defs>
      )}

      <g className={animatedLockup ? 'wv-lock-pull' : undefined}>
        <path
          className={animatedLockup ? 'wv-lock-line' : undefined}
          d={MARK_PATH}
          pathLength={animatedLockup ? MARK_PATH_LENGTH : undefined}
          fill="none"
          stroke="currentColor"
          strokeWidth={WORDMARK_W_STROKE}
          strokeLinejoin="bevel"
          strokeLinecap="butt"
          strokeMiterlimit="1"
        />
        {behaviour === 'micro' && (
          /* The pass travels the W, which is the mark. `.wv-micro-comet`'s CSS
             `stroke` outranks the attribute and repaints it from `--wv-sweep`. */
          <path
            className="wv-micro-comet"
            d={MARK_PATH}
            pathLength={MARK_PATH_LENGTH}
            fill="none"
            stroke="currentColor"
            strokeWidth={WORDMARK_W_STROKE}
            strokeLinejoin="bevel"
            strokeLinecap="butt"
            strokeMiterlimit="1"
          />
        )}
      </g>

      {animatedLockup ? (
        <g clipPath={`url(#${wipeId})`}>
          <path className="wv-lock-word" d={WORDMARK_LETTERS_PATH} fill="currentColor" />
        </g>
      ) : (
        <path d={WORDMARK_LETTERS_PATH} fill="currentColor" />
      )}
    </svg>
  );
}
