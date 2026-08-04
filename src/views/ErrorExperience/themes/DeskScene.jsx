import React from 'react';

/**
 * The Front Desk — the check-in table at the start of a shift.
 *
 * Every volunteer event has one: a table, a clipboard, a bell nobody rings, and
 * a box of lanyards. It is where a school decides who you are and what you may
 * do, which makes it the only honest place to explain a permission refusal —
 * and unlike a padlock or a shield, it is somewhere the reader has physically
 * stood.
 *
 * The badge hangs from a lanyard that leaves the top of the frame, so the
 * composition reads as a held object at eye level rather than an icon centred
 * in a box.
 *
 * Modes:
 *   locked  — the badge is real, and its access strip is not yours
 *   expired — the badge has gone blank; the lanyard is still around your neck
 */
export default function DeskScene({ mode = 'locked' }) {
  const expired = mode === 'expired';

  return (
    <svg
      className="err-scene err-desk"
      data-mode={mode}
      viewBox="0 0 400 300"
      role="presentation"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* The room behind the table: a soft wash so the badge has something to
          sit against and the scene has a back plane. */}
      <rect x="8" y="14" width="384" height="272" rx="10" fill="var(--surface-2)"
        stroke="var(--border)" strokeWidth="1.5" />
      <ellipse cx="200" cy="150" rx="150" ry="120" fill="var(--brand-soft)" opacity="0.55" />

      {/* The desk, low in frame. Its front face is what gives the scene a floor. */}
      <rect x="8" y="232" width="384" height="10" rx="3" fill="var(--brand-background)" />
      <rect x="8" y="242" width="384" height="44" fill="var(--brand-soft)" />
      <rect x="8" y="242" width="384" height="44" fill="var(--ink)" opacity="0.06" />

      {/* Clipboard on the desk, angled — the sign-in sheet everybody queues for. */}
      <g transform="rotate(-7 92 250)">
        <rect x="50" y="216" width="76" height="30" rx="3" fill="var(--ink)" opacity="0.1" />
        <rect x="48" y="212" width="76" height="30" rx="3" fill="var(--surface)"
          stroke="var(--border)" strokeWidth="1" />
        <rect x="74" y="207" width="24" height="9" rx="3" fill="var(--ink-3)" opacity="0.6" />
        <rect x="56" y="222" width="46" height="3" rx="1.5" fill="var(--brand-primary)" opacity="0.4" />
        <rect x="56" y="230" width="58" height="3" rx="1.5" fill="var(--brand-primary)" opacity="0.28" />
      </g>

      {/* The bell. Nobody rings it, and leaving it out would be the difference
          between a desk and a rectangle. */}
      <g transform="translate(302 200)">
        <ellipse cx="22" cy="42" rx="24" ry="4" fill="var(--ink)" opacity="0.12" />
        <path d="M2 40 Q2 16 22 16 Q42 16 42 40 Z" fill="var(--brand-primary)" opacity="0.85" />
        <rect x="0" y="38" width="44" height="5" rx="2.5" fill="var(--brand-primary)" />
        <circle cx="22" cy="12" r="4" fill="var(--brand-primary)" />
        <path d="M10 30 Q12 22 20 20" fill="none" stroke="var(--surface)" strokeWidth="2.5"
          strokeLinecap="round" opacity="0.5" />
      </g>

      {/* ── The badge ── */}
      <g className="err-desk-badge">
        {/* Lanyard, leaving the frame. Two cords, not one, or it reads as string. */}
        <path d="M172 14 L196 92" fill="none" stroke="var(--brand-primary)" strokeWidth="7"
          strokeLinecap="round" opacity="0.9" />
        <path d="M228 14 L204 92" fill="none" stroke="var(--brand-primary)" strokeWidth="7"
          strokeLinecap="round" opacity="0.75" />
        <rect x="192" y="88" width="16" height="18" rx="3" fill="var(--ink-3)" />
        <rect x="195" y="92" width="10" height="7" rx="2" fill="var(--surface-2)" />

        <rect x="146" y="112" width="108" height="136" rx="9" fill="var(--ink)" opacity="0.16" />
        <rect
          x="144" y="106" width="108" height="136" rx="9"
          fill="var(--surface)"
          stroke={expired ? 'var(--ink-3)' : 'var(--border)'}
          strokeWidth={expired ? '1.75' : '1.25'}
          strokeDasharray={expired ? '7 5' : undefined}
        />

        {/* Access strip. On a real badge this is the coloured band that tells a
            steward at a glance where you may go — so it is the whole message. */}
        <path
          d="M144 115a9 9 0 0 1 9-9h90a9 9 0 0 1 9 9v13H144z"
          fill={expired ? 'var(--ink-3)' : 'var(--warn)'}
          opacity={expired ? 0.35 : 0.9}
        />

        {/* Photo. A soft silhouette, never a face — a drawn face at 40px is the
            fastest way to make a scene look like clip art. */}
        <circle cx="198" cy="158" r="21" fill="var(--brand-soft)" />
        <circle cx="198" cy="151" r="8" fill="var(--brand-primary)" opacity={expired ? 0.28 : 0.55} />
        <path d="M182 174a16 16 0 0 1 32 0z" fill="var(--brand-primary)"
          opacity={expired ? 0.28 : 0.55} />

        <rect x="166" y="190" width="64" height="6" rx="3" fill="var(--ink-3)"
          opacity={expired ? 0.3 : 0.6} />
        <rect x="176" y="203" width="44" height="4.5" rx="2.25" fill="var(--ink-3)"
          opacity={expired ? 0.22 : 0.42} />

        {mode === 'locked' ? (
          /* A closed padlock struck across the badge's own access row. */
          <g transform="translate(186 216)">
            <rect x="-22" y="-2" width="72" height="18" rx="9" fill="var(--warn-tint)" />
            <path d="M6 6V3.5a3.6 3.6 0 0 1 7.2 0V6" fill="none" stroke="var(--warn)"
              strokeWidth="2" strokeLinecap="round" />
            <rect x="3.6" y="6" width="12" height="9" rx="2" fill="var(--warn)" />
            <rect x="22" y="7.5" width="24" height="4" rx="2" fill="var(--warn)" opacity="0.55" />
          </g>
        ) : (
          <g transform="translate(186 216)">
            <rect x="-22" y="-2" width="72" height="18" rx="9" fill="var(--surface-2)" />
            <rect x="-10" y="5" width="48" height="4.5" rx="2.25" fill="var(--ink-3)" opacity="0.4" />
          </g>
        )}
      </g>
    </svg>
  );
}
