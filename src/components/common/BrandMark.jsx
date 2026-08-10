import React from 'react';

/**
 * The WeVolunteer mark. One source, so every screen wears the same badge.
 *
 * ── Why a component for eleven characters ──
 *
 * There was no logo component to reuse — there were two hand-written copies of
 * `<span className="brand-mark">WV</span>`, in the app shell and on the
 * certificate verification page, held in agreement by nothing. Adding the mark
 * to the error experience would have made three, and the moment the mark
 * changes (a real glyph, a different pair of letters, a school's own crest) the
 * error screens are exactly the surface that gets forgotten — they are the ones
 * nobody opens on purpose.
 *
 * So the letters and the class live here and the call sites ask for the mark.
 * The styling stays in `index.css` under `.brand-mark`, where the project's
 * colour and token guards can see it.
 *
 * ── It is decoration wherever a wordmark sits beside it ──
 *
 * At every call site the product name is already rendered as text next to this,
 * so announcing "WV" as well says the same thing twice in a worse voice. It is
 * `aria-hidden` by default and takes a `label` for any future placement where
 * the mark stands alone.
 *
 * ── One appearance, in every theme and on every screen ──
 *
 * `size="lg"` adds `.brand-mark-lg`, which changes the dimensions and nothing
 * else. It exists because the Welcome screen had its own `.welcome-mark` — a
 * second tile with its own colours — and so the front door wore a different
 * green from the sidebar behind it whenever dark mode was on. The colours come
 * from `--brand-mark-bg` / `--brand-mark-ink`, the two tokens in `index.css`
 * that deliberately do not follow the theme, so this badge matches the browser
 * tab icon and the header of every transactional email exactly.
 */
export default function BrandMark({ label, size }) {
  return (
    <span
      className={size === 'lg' ? 'brand-mark brand-mark-lg' : 'brand-mark'}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      WV
    </span>
  );
}
