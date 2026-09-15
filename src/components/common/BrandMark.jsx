import React from 'react';
import { MARK_PATH, MARK_VIEWBOX, TILE_MARK_RATIO, markStrokeFor } from './logoGeometry';

/**
 * The tile rendered size, in px, for each variant. These are `.brand-mark` and
 * `.brand-mark-lg` in index.css; they are repeated here only because the stroke
 * weight depends on the size the mark is drawn at, and CSS cannot choose an SVG
 * stroke by rendered height.
 */
const TILE_PX = { md: 32, lg: 64 };

/**
 * The WeVolunteer symbol in its tile: the checkmark-W, white on the brand green.
 * One source, so every screen wears the same badge.
 *
 * ── Why a component ──
 *
 * There was no logo component to reuse — there were two hand-written copies of
 * the old `WV` badge markup, in the app shell and on the certificate
 * verification page, held in agreement by nothing. The moment the mark changed,
 * the error screens were exactly the surface that would have been forgotten —
 * they are the ones nobody opens on purpose. The mark has now changed, and it
 * changed here once.
 *
 * The geometry lives in `logoGeometry.js`; the colours and the tile's shape stay
 * in `index.css` under `.brand-mark`, where the project's colour and token
 * guards can see them.
 *
 * ── Where this is used, and where `Wordmark` is used instead ──
 *
 * The tile is the symbol on its own: the Welcome and appeal screens, and the
 * tablet rail, where there is no room for the name. Wherever the product name is
 * shown, it is shown by `Wordmark`, whose W is this same drawing — so the tile is
 * never placed beside the wordmark, which would print the W twice.
 *
 * ── It is decoration unless it stands alone ──
 *
 * `aria-hidden` by default and takes a `label` for a placement where the mark is
 * the only thing naming the product.
 *
 * ── One appearance, in every theme and on every screen ──
 *
 * `size="lg"` adds `.brand-mark-lg`, which changes the dimensions and nothing
 * else. The colours come from `--brand-mark-bg` / `--brand-mark-ink`, the two
 * tokens in `index.css` that deliberately do not follow the theme, so this badge
 * matches the browser tab icon exactly.
 */
export default function BrandMark({ label, size }) {
  const tile = size === 'lg' ? TILE_PX.lg : TILE_PX.md;
  return (
    <span
      className={size === 'lg' ? 'brand-mark brand-mark-lg' : 'brand-mark'}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <svg className="brand-mark-glyph" viewBox={MARK_VIEWBOX} aria-hidden="true" focusable="false">
        <path
          d={MARK_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth={markStrokeFor(tile * TILE_MARK_RATIO)}
          strokeLinejoin="bevel"
          strokeLinecap="butt"
          strokeMiterlimit="1"
        />
      </svg>
    </span>
  );
}
