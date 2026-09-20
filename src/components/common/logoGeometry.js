/**
 * The WeVolunteer mark and wordmark, as geometry. The one source of truth.
 *
 * Everything here is transcribed from the Identity Proposal (September 2026),
 * not redrawn by eye. The proposal's own construction page prints the mark as
 * `M16 26 L33 78 L50 34 L67 78 L86 4` at weight 12.5, and every rendering of
 * the mark in that document — the cover, the lockups, the construction plate,
 * the colour tiles, the scale ladder — was extracted and measured against those
 * five points: all of them land on them exactly, stroked with bevel joins and
 * butt caps.
 *
 * `BrandMark`, `Wordmark` and the recovery-code image read these values. The
 * static files the browser fetches outside the document (`public/favicon.svg`,
 * `public/app-icon.svg`, `public/app-icon-maskable.svg`, `public/mark.svg`)
 * cannot import JavaScript, so they carry copies — and `src/logoAssets.test.jsx`
 * fails the build if any copy stops matching what is written here.
 */

/** The five points: cap-line terminal, foot, dropped apex, foot, overshoot. */
export const MARK_POINTS = Object.freeze([
  [16, 26], [33, 78], [50, 34], [67, 78], [86, 4],
]);

export const MARK_PATH = 'M16 26 L33 78 L50 34 L67 78 L86 4';

/**
 * Stroke weight, in the same units as the points.
 *
 * The proposal permits exactly one deviation from the drawing: below 32px the
 * stroke thickens to 15.5 so the mark does not grey out against its tile on a
 * standard-density display. "Thicken the stroke to 15.5 below 32px, and only
 * there." The 32px is the rendered height of the mark, not of a tile around it.
 */
export const MARK_STROKE = 12.5;
export const MARK_STROKE_SMALL = 15.5;
export const MARK_SMALL_BELOW_PX = 32;

export function markStrokeFor(renderedHeightPx) {
  return renderedHeightPx < MARK_SMALL_BELOW_PX ? MARK_STROKE_SMALL : MARK_STROKE;
}

/**
 * `8 -3 86 89`, one unit wider than the proposal's drop-in `8 -3 85 89`.
 *
 * At the small-size weight the overshooting terminal's outer corner reaches
 * x = 93.51, so the drop-in box shaved half a unit off the very tip the mark is
 * about. The height — which is what "size" means for this mark — is unchanged.
 */
export const MARK_VIEWBOX = '8 -3 86 89';
export const MARK_VIEWBOX_WIDTH = 86;
export const MARK_VIEWBOX_HEIGHT = 89;

/**
 * The tile: green square, white mark. From the proposal's `WvTile`: corner
 * radius 0.2236 of the side, mark box 0.58 of the side, centred.
 */
export const TILE_RADIUS_RATIO = 0.2236;
export const TILE_MARK_RATIO = 0.58;

/**
 * The wordmark: the mark's own skeleton as the W, followed by "eVolunteer".
 *
 * Not the proposal's phase-one lockup. That lockup is the tile beside the name
 * typeset in Familjen Grotesk SemiBold at -0.038em. Its page 9 describes
 * redrawing that W "to the symbol's skeleton" only as a possible phase two. The
 * integrated W is used now by the project owner's separate decision, and it is
 * drawn here without adding a font to the product:
 *
 *   - the letters are the proposal's own outlined "WeVolunteer" (its Typography
 *     plate), converted into the mark's coordinate space, so there is no webfont
 *     to load and nothing to fall back from;
 *   - the W is `MARK_PATH` verbatim — same five points, same numbers;
 *   - its weight is the typeface's, not the symbol's. The plate's W measures a
 *     4.554pt stem at a 23.87pt cap height, which is 9.92 units at the mark's
 *     52-unit cap; 10 is used. At 12.5 the W is visibly heavier than every
 *     letter after it and reads as a logo pasted in front of a word;
 *   - "eVolunteer" sits where the typeface's W-to-e spacing puts it: the
 *     narrowest gap between the W and the e across the e's height is held at the
 *     plate's 2.73pt.
 */
export const WORDMARK_VIEWBOX = '11 2.5 421.5 77.5';
export const WORDMARK_W_STROKE = 10;
export const WORDMARK_LETTERS_PATH =
  'M103.33 79C97.13 79 92.41 77.1 89.16 73.31C85.92 69.51 84.3 64.4 84.3 57.95C84.3 53.64 85.02 49.93 86.48 46.81C87.94 43.69 90.07 41.28 92.88 39.57C95.69 37.86 99.13 37 103.21 37C109.05 37 113.51 38.8 116.61 42.39C119.71 45.97 121.26 51.23 121.26 58.15L121.26 60.37L93.95 60.37C94.17 63.88 95.08 66.67 96.68 68.75C98.28 70.83 100.5 71.87 103.35 71.87C105.55 71.87 107.31 71.22 108.65 69.93C109.99 68.65 110.9 67.07 111.36 65.2L120.76 65.2C120.32 67.71 119.41 70.01 118.04 72.09C116.68 74.18 114.78 75.85 112.36 77.11C109.94 78.37 106.93 79 103.33 79Z' +
  'M93.96 53.97L111.61 53.97C111.44 50.74 110.64 48.24 109.21 46.48C107.78 44.72 105.76 43.84 103.15 43.84C100.52 43.84 98.43 44.69 96.86 46.39C95.3 48.1 94.33 50.62 93.96 53.97Z' +
  'M133.72 78L117.8 26.4L117.8 26L128.27 26L141.42 69.2L143.02 69.2L156.03 26L165.97 26L165.97 26.4L150.05 78L133.72 78Z' +
  'M184.01 79C177.52 79 172.68 77.1 169.49 73.3C166.3 69.5 164.71 64.4 164.71 58C164.71 51.6 166.3 46.5 169.49 42.7C172.68 38.9 177.52 37 184.01 37C190.5 37 195.34 38.9 198.52 42.7C201.71 46.5 203.31 51.6 203.31 58C203.31 64.4 201.71 69.5 198.52 73.3C195.34 77.1 190.5 79 184.01 79Z' +
  'M184.01 72.13C187.14 72.13 189.44 70.93 190.89 68.52C192.35 66.11 193.07 62.59 193.07 57.98C193.07 53.36 192.35 49.86 190.89 47.46C189.44 45.07 187.14 43.87 184.01 43.87C180.87 43.87 178.58 45.07 177.12 47.46C175.67 49.86 174.94 53.36 174.94 57.98C174.94 62.59 175.67 66.11 177.12 68.52C178.58 70.93 180.87 72.13 184.01 72.13Z' +
  'M211.03 78C209.86 76.63 209 75.06 208.47 73.29C207.93 71.52 207.67 69.11 207.67 66.07L207.67 24.67L217.57 24.67L217.57 64.98C217.57 68.41 217.95 71.05 218.71 72.91C219.47 74.77 220.45 76.33 221.67 77.6L221.67 78L211.03 78Z' +
  'M238.07 79C233.57 79 230.21 77.59 227.98 74.77C225.76 71.94 224.64 68.18 224.64 63.47L224.64 38L234.54 38L234.54 61.73C234.54 64.63 235.06 66.88 236.11 68.48C237.15 70.07 238.82 70.87 241.11 70.87C243.9 70.87 246.05 69.78 247.57 67.61C249.08 65.44 249.84 62.76 249.84 59.58L249.84 38L259.74 38L259.74 78L250.84 78L250.84 72L249.24 72C248.56 74.06 247.32 75.74 245.52 77.04C243.71 78.35 241.23 79 238.07 79Z' +
  'M266.97 78L266.97 38L276.06 38L276.06 44L277.66 44C278.45 41.95 279.71 40.27 281.42 38.96C283.14 37.66 285.57 37 288.73 37C293.23 37 296.58 38.41 298.77 41.23C300.97 44.04 302.06 47.81 302.06 52.54L302.06 78L292.16 78L292.16 54.27C292.16 51.34 291.64 49.08 290.6 47.5C289.55 45.92 287.87 45.14 285.55 45.14C282.8 45.14 280.67 46.21 279.15 48.37C277.63 50.52 276.86 53.21 276.86 56.42L276.86 78L266.97 78Z' +
  'M314.4 78C313.39 76.8 312.59 75.36 311.99 73.67C311.39 71.98 311.09 69.45 311.09 66.07L311.09 45.1L305.62 45.1L305.62 38L311.22 38L311.22 28L320.9 28L320.9 38L327.45 38L327.45 45.1L320.94 45.1L320.94 64.93C320.94 68.48 321.33 71.18 322.13 73.03C322.92 74.88 323.88 76.4 324.99 77.6L324.99 78L314.4 78Z' +
  'M347.9 79C341.7 79 336.97 77.1 333.73 73.31C330.49 69.51 328.86 64.4 328.86 57.95C328.86 53.64 329.59 49.93 331.05 46.81C332.5 43.69 334.64 41.28 337.45 39.57C340.26 37.86 343.7 37 347.78 37C353.61 37 358.08 38.8 361.18 42.39C364.28 45.97 365.83 51.23 365.83 58.15L365.83 60.37L338.51 60.37C338.73 63.88 339.65 66.67 341.25 68.75C342.85 70.83 345.07 71.87 347.91 71.87C350.11 71.87 351.88 71.22 353.22 69.93C354.56 68.65 355.46 67.07 355.93 65.2L365.33 65.2C364.88 67.71 363.98 70.01 362.61 72.09C361.24 74.18 359.35 75.85 356.93 77.11C354.51 78.37 351.49 79 347.9 79Z' +
  'M338.53 53.97L356.18 53.97C356.01 50.74 355.21 48.24 353.78 46.48C352.34 44.72 350.32 43.84 347.71 43.84C345.09 43.84 343 44.69 341.43 46.39C339.86 48.1 338.9 50.62 338.53 53.97Z' +
  'M386.52 79C380.32 79 375.6 77.1 372.35 73.31C369.11 69.51 367.49 64.4 367.49 57.95C367.49 53.64 368.21 49.93 369.67 46.81C371.13 43.69 373.26 41.28 376.07 39.57C378.88 37.86 382.32 37 386.4 37C392.23 37 396.7 38.8 399.8 42.39C402.9 45.97 404.45 51.23 404.45 58.15L404.45 60.37L377.14 60.37C377.36 63.88 378.27 66.67 379.87 68.75C381.47 70.83 383.69 71.87 386.54 71.87C388.73 71.87 390.5 71.22 391.84 69.93C393.18 68.65 394.08 67.07 394.55 65.2L403.95 65.2C403.51 67.71 402.6 70.01 401.23 72.09C399.87 74.18 397.97 75.85 395.55 77.11C393.13 78.37 390.12 79 386.52 79Z' +
  'M377.15 53.97L394.8 53.97C394.63 50.74 393.83 48.24 392.4 46.48C390.97 44.72 388.95 43.84 386.34 43.84C383.71 43.84 381.62 44.69 380.05 46.39C378.49 48.1 377.52 50.62 377.15 53.97Z' +
  'M408.73 78L408.73 38L417.73 38L417.73 45.2L419.33 45.2C419.59 43.93 420.08 42.71 420.8 41.54C421.52 40.38 422.63 39.44 424.13 38.7C425.63 37.97 427.66 37.6 430.22 37.6L432.16 37.6L432.16 46.6L429.46 46.6C425.63 46.6 422.86 47.58 421.17 49.53C419.47 51.48 418.63 54.44 418.63 58.4L418.63 78L408.73 78Z';
