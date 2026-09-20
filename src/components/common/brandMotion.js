import { MARK_STROKE, markStrokeFor } from './logoGeometry';

/**
 * The names a caller may pass to `BrandMark`/`Wordmark`'s `motion` prop, and
 * the class names each resolves to. The behaviours themselves — every keyframe,
 * duration and curve — live in `wvMotion.css`; nothing here animates anything.
 *
 * The seven frozen behaviours map onto the two components like this:
 *
 *   signature (A)  BrandMark   the mark draws, pulls and releases, looping
 *   lockup    (B)  Wordmark    the W draws, then the angled edge reveals the
 *                              lettering; on BrandMark, the same draw without a
 *                              wordmark to reveal
 *   return    (C)  —           shipped in the stylesheet as `.wv-ret-*`; no
 *                              product surface yet (see docs/features/brand-motion.md)
 *   loader    (D)  BrandMark   a segment walks a ghost mark, endlessly
 *   micro     (E)  both        one pass on hover/focus of the interactive parent
 *   success   (F)  BrandMark   the overreach completes, the body rises behind it
 *   idle      (G)  —           `.wv-idle-comet` exists; deliberately unapplied
 */
export const MOTION_VALUES = ['signature', 'lockup', 'loader', 'micro', 'success', 'none'];

/**
 * The frozen dash system is expressed in mark units and depends on this
 * normalisation. A path animated without it dashes in user units and is wrong
 * at every size.
 */
export const MARK_PATH_LENGTH = '225.4484';

/** The overreach on its own — success's tick, and its own normalised length. */
export const TICK_PATH = 'M67 78 L86 4';
export const TICK_PATH_LENGTH = '76.4003';
/** The mark minus the overreach — success's body. */
export const BODY_PATH = 'M16 26 L33 78 L50 34 L67 78';

/**
 * Nothing animates while the mark is drawn smaller than this.
 *
 * Not a legibility rule: `markStrokeFor()` thickens the stroke to 15.5 below
 * 32px so the mark does not grey out against its tile, which means a smaller
 * animated mark would animate *different geometry* than the frozen 12.5 system
 * the dash values were solved against. The floor is therefore the mark's own
 * rendered height, not the tile's.
 */
export const MOTION_MIN_MARK_PX = 32;

export function motionAllowedAt(markHeightPx) {
  return markStrokeFor(markHeightPx) === MARK_STROKE;
}

/**
 * Resolves a requested behaviour to the one that will actually render.
 * Anything unsupported — an unknown name, a behaviour the component has no
 * geometry for, or a mark too small to animate honestly — becomes `'none'`, so
 * a caller always gets the static locked logo rather than a broken one.
 */
export function resolveMotion(requested, { supported, markHeightPx }) {
  if (!requested || requested === 'none') return 'none';
  if (!supported.includes(requested)) return 'none';
  if (typeof markHeightPx === 'number' && !motionAllowedAt(markHeightPx)) return 'none';
  return requested;
}
