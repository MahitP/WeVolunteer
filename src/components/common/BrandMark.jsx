import React from 'react';
import { MARK_PATH, MARK_VIEWBOX, TILE_MARK_RATIO, markStrokeFor } from './logoGeometry';
import {
  BODY_PATH, MARK_PATH_LENGTH, TICK_PATH, TICK_PATH_LENGTH, resolveMotion,
} from './brandMotion';

/**
 * The tile rendered size, in px, for each variant. These are `.brand-mark` and
 * `.brand-mark-lg` in index.css; they are repeated here only because the stroke
 * weight depends on the size the mark is drawn at, and CSS cannot choose an SVG
 * stroke by rendered height.
 */
const TILE_PX = { md: 32, lg: 64 };

/** The behaviours a mark on its own can actually perform. */
const SUPPORTED_MOTION = ['signature', 'lockup', 'loader', 'micro', 'success'];

/** Stroke attributes every copy of the mark shares. */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinejoin: 'bevel',
  strokeLinecap: 'butt',
  strokeMiterlimit: '1',
};

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
 *
 * ── `motion` ──
 *
 * `'signature' | 'lockup' | 'loader' | 'micro' | 'success' | 'none'`, default
 * `'none'`. It selects class names from `wvMotion.css` and changes nothing else:
 * the geometry, the stroke and the tile are identical in every case, and every
 * behaviour rests as the complete mark.
 *
 * **The 32px floor is enforced here.** `markStrokeFor()` thickens the stroke to
 * 15.5 below 32px, so a smaller animated mark would animate different geometry
 * than the frozen 12.5 the dash values were solved against. The default tile
 * draws its mark at 18.6px and therefore **never animates** — only `size="lg"`
 * (a 37.1px mark) does. A refused behaviour renders the static locked mark.
 *
 * `motion="micro"` additionally requires the interactive ancestor to carry
 * `.wv-micro` (and, off a card surface, its own `--wv-sweep`); the pass is a gap
 * painted in the surface colour, which only that ancestor knows.
 */
export default function BrandMark({ label, size, motion = 'none' }) {
  const tile = size === 'lg' ? TILE_PX.lg : TILE_PX.md;
  const markHeightPx = tile * TILE_MARK_RATIO;
  const strokeWidth = markStrokeFor(markHeightPx);
  const behaviour = resolveMotion(motion, { supported: SUPPORTED_MOTION, markHeightPx });

  return (
    <span
      className={size === 'lg' ? 'brand-mark brand-mark-lg' : 'brand-mark'}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <svg className="brand-mark-glyph" viewBox={MARK_VIEWBOX} aria-hidden="true" focusable="false">
        <MarkBody behaviour={behaviour} strokeWidth={strokeWidth} />
      </svg>
    </span>
  );
}

/**
 * The mark's paths for one behaviour. Static and `signature`/`lockup` are one
 * path; the loader needs its ghost, and success needs the frozen body/tick
 * split, because the overreach completes on its own.
 */
function MarkBody({ behaviour, strokeWidth }) {
  if (behaviour === 'loader') {
    return (
      <g className="wv-load-wrap">
        <path className="wv-load-ghost" d={MARK_PATH} strokeWidth={strokeWidth} {...STROKE} />
        <path
          className="wv-load-comet"
          d={MARK_PATH}
          pathLength={MARK_PATH_LENGTH}
          strokeWidth={strokeWidth}
          {...STROKE}
        />
      </g>
    );
  }

  if (behaviour === 'success') {
    return (
      <g className="wv-ok-pull">
        <path
          className="wv-ok-body"
          d={BODY_PATH}
          pathLength={MARK_PATH_LENGTH}
          strokeWidth={strokeWidth}
          {...STROKE}
        />
        <path
          className="wv-ok-tick"
          d={TICK_PATH}
          pathLength={TICK_PATH_LENGTH}
          strokeWidth={strokeWidth}
          {...STROKE}
        />
      </g>
    );
  }

  if (behaviour === 'micro') {
    return (
      <>
        <path d={MARK_PATH} strokeWidth={strokeWidth} {...STROKE} />
        {/* The pass is a GAP in the surface colour travelling through the
            stroke, so `.wv-micro-comet`'s `stroke` (a CSS rule, which outranks
            this presentation attribute) repaints it from `--wv-sweep`. */}
        <path
          className="wv-micro-comet"
          d={MARK_PATH}
          pathLength={MARK_PATH_LENGTH}
          strokeWidth={strokeWidth}
          {...STROKE}
        />
      </>
    );
  }

  const group = behaviour === 'signature' ? 'wv-sig-pull' : behaviour === 'lockup' ? 'wv-lock-pull' : undefined;
  const line = behaviour === 'signature' ? 'wv-sig-line' : behaviour === 'lockup' ? 'wv-lock-line' : undefined;

  return (
    <g className={group}>
      <path
        className={line}
        d={MARK_PATH}
        pathLength={behaviour === 'none' ? undefined : MARK_PATH_LENGTH}
        strokeWidth={strokeWidth}
        {...STROKE}
      />
    </g>
  );
}
