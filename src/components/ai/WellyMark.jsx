import React from 'react';

/**
 * Welly's mark.
 *
 * ── Why it is a badge and not an icon ──
 *
 * WeVolunteer already has one: `BrandMark` renders `WV` inside `.brand-mark`,
 * coloured by `--brand-mark-bg` and `--brand-mark-ink` — the two tokens that
 * deliberately do NOT follow the theme, so the badge matches the browser tab
 * icon and the header of every transactional email in both light and dark.
 *
 * Welly wears the same tile. That is the whole idea: a student should read it
 * as part of WeVolunteer at a glance, not as a third party that turned up in
 * the corner. Reusing the tokens also means it cannot drift out of step with
 * the brand, and it is correct in dark mode without a second palette.
 *
 * ── Why the glyph is three dots and not a face ──
 *
 * The obvious options were all wrong. A robot says the software is pretending
 * to be a person. A speech bubble says customer support. A sparkle says
 * generic AI. A mascot face invites the personality to grow into something
 * this product does not want.
 *
 * Three dots climbing to the right is a path — steps, progress, a way through.
 * It reads as guidance rather than as a character, it is unmistakably
 * geometric, it has no connotation borrowed from another product, and at 16px
 * it is still three dots.
 *
 * ── Accessibility ──
 *
 * `aria-hidden` by default, because at nearly every call site the word "Welly"
 * is already rendered next to it and announcing both says the same thing twice
 * in a worse voice. Where the mark stands alone — the topbar button — the
 * accessible name comes from the control, and it is the word "Welly", never a
 * description of a shape.
 */
export default function WellyMark({ label, size }) {
  return (
    <span
      className={size === 'lg' ? 'brand-mark brand-mark-lg welly-mark' : 'brand-mark welly-mark'}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {/* currentColor, so the glyph inherits --brand-mark-ink with the tile. */}
      <svg viewBox="0 0 24 24" width="1em" height="1em" focusable="false" aria-hidden="true">
        <circle cx="5.5" cy="17" r="2.4" fill="currentColor" />
        <circle cx="12" cy="12" r="2.4" fill="currentColor" opacity="0.75" />
        <circle cx="18.5" cy="7" r="2.4" fill="currentColor" opacity="0.5" />
      </svg>
    </span>
  );
}
