/**
 * The colours an emoji avatar can sit on.
 *
 * ── Why a fixed set rather than a colour input ──
 *
 * A free colour picker produces avatars nobody can read: black emoji on a
 * near-black circle, or a saturated red that fights every surface it appears on.
 * These eight are chosen to sit under both the light and dark themes, to be
 * distinguishable from each other at 24px (the smallest avatar the application
 * draws), and to leave emoji legible on top.
 *
 * ── The values live in the stylesheet ──
 *
 * Each entry points at a `--avatar-*` custom property declared in
 * `src/index.css`, not at a hex literal. That is where this project keeps
 * colour, it is what the no-hardcoded-colours guard enforces, and it is what
 * makes retuning the palette for dark mode a stylesheet change rather than a
 * data migration.
 *
 * ── Why keys and not hex values on the wire ──
 *
 * The database stores the KEY. A hex arriving from a client would be arbitrary
 * text rendered into a style attribute on every surface that draws that person;
 * a key from this object cannot be anything but one of these. `isAvatarColor`
 * is the one validator, used by both the user and the organization paths so
 * they cannot drift.
 */
export const AVATAR_COLORS = Object.freeze({
  sage:      { label: 'Sage',      value: 'var(--avatar-sage)' },
  sky:       { label: 'Sky',       value: 'var(--avatar-sky)' },
  lavender:  { label: 'Lavender',  value: 'var(--avatar-lavender)' },
  blossom:   { label: 'Blossom',   value: 'var(--avatar-blossom)' },
  clay:      { label: 'Clay',      value: 'var(--avatar-clay)' },
  sand:      { label: 'Sand',      value: 'var(--avatar-sand)' },
  mint:      { label: 'Mint',      value: 'var(--avatar-mint)' },
  slate:     { label: 'Slate',     value: 'var(--avatar-slate)' },
});

export const AVATAR_COLOR_KEYS = Object.freeze(Object.keys(AVATAR_COLORS));

/** Whether a value is one of the offered keys. `null` clears the choice. */
export function isAvatarColor(key) {
  return key === null || Object.hasOwn(AVATAR_COLORS, key);
}

/**
 * The CSS colour for a stored key, or null.
 *
 * Null rather than a default, so a caller renders `--brand-tint` by omitting the
 * property entirely and an unknown key from an older row degrades to the same
 * thing instead of to a broken style.
 */
export function avatarColorValue(key) {
  return AVATAR_COLORS[key]?.value ?? null;
}
