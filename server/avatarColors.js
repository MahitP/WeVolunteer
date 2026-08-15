/**
 * The avatar background colours a client may choose, as keys.
 *
 * ── Keys here, values in the stylesheet ──
 *
 * The server's only interest is which strings are allowed into the column. The
 * actual colours live in `src/index.css` as `--avatar-*` tokens, so the palette
 * can be retuned — for dark mode, or because one of them reads badly at 24px —
 * without a data migration, and so nothing renders a colour this file has an
 * opinion about.
 *
 * ── Why an allowlist at all ──
 *
 * `avatar_color` is interpolated into a style attribute on every surface that
 * draws a person or an organization. A free-text colour from a client is
 * arbitrary text in that position. A key from this list cannot be anything else,
 * and it is checked in one function so the user path and the organization path
 * cannot drift apart.
 */
export const AVATAR_COLOR_KEYS = Object.freeze([
  'sage', 'sky', 'lavender', 'blossom', 'clay', 'sand', 'mint', 'slate',
]);

/** `null` clears the choice and is deliberately allowed. */
export function isAvatarColor(key) {
  return key === null || AVATAR_COLOR_KEYS.includes(key);
}
