import React from 'react';
import { APP_NAME } from '../../config';
import {
  MARK_PATH, WORDMARK_LETTERS_PATH, WORDMARK_VIEWBOX, WORDMARK_W_STROKE,
} from './logoGeometry';

/** The name the vector lettering spells. */
const DRAWN_NAME = 'WeVolunteer';

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
 * logo that says something else.
 */
export default function Wordmark({ className }) {
  if (APP_NAME !== DRAWN_NAME) {
    return <span className={className ? `brand-name ${className}` : 'brand-name'}>{APP_NAME}</span>;
  }
  return (
    <svg
      className={className ? `wordmark ${className}` : 'wordmark'}
      viewBox={WORDMARK_VIEWBOX}
      role="img"
      aria-label={DRAWN_NAME}
      focusable="false"
    >
      <path
        d={MARK_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={WORDMARK_W_STROKE}
        strokeLinejoin="bevel"
        strokeLinecap="butt"
        strokeMiterlimit="1"
      />
      <path d={WORDMARK_LETTERS_PATH} fill="currentColor" />
    </svg>
  );
}
