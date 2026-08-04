import React from 'react';

/**
 * The Radio Room — the handset a shift coordinator carries.
 *
 * At a real event the radio is how the far end of the field stays in touch with
 * the desk, so it is the product's own object for "we cannot reach each other
 * right now". That makes it the right theme for the network kinds, and the
 * wrong one for anything about permission — nobody's radio refuses them.
 *
 * The composition is a diagonal: the handset sits low-left and the signal
 * travels up and out of the frame, which gives the scene direction. Concentric
 * rings centred on a static object would just be a target.
 *
 * Modes:
 *   silent    — the far ring never completes; the set shows no signal (offline)
 *   partial   — one ring in the middle is broken; the rest carry (a service)
 *   garbled   — every other ring is broken; it arrived in pieces (a chunk)
 *   scheduled — nothing is transmitting, on purpose; the set is tagged off-air
 *
 * `garbled` and `scheduled` exist because `partial` and `silent` each used to
 * answer two kinds with one picture. "It came through in pieces" and "one
 * service is unreachable" are different events, and so are "no signal" and
 * "deliberately off the air" — a reader who meets two of them in one session
 * would otherwise see the same drawing twice and read the rotation as a loop.
 */

/** Ring geometry, so four arcs are not four hand-computed path strings. */
function arc(cx, cy, r, fromDeg, toDeg) {
  const p = (deg) => {
    const a = (deg * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  };
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${p(fromDeg)} A ${r} ${r} 0 ${large} 1 ${p(toDeg)}`;
}

/**
 * The antenna tip: every ring is centred here, so the signal has a source.
 *
 * The radii and the arc are constrained, not chosen. Every ring has to finish
 * inside the 400x300 viewBox — the first pass used r=160 through -90°, which
 * put the outer arcs at y=-27 and, with `overflow: visible`, drew them across
 * the page outside the scene entirely. The sweep now stops short of vertical so
 * the topmost point is `CY - r*sin(75°)`, which stays inside the panel's own
 * top edge (y=14) at r=137. An earlier r=152 cleared the viewBox but not the
 * panel, so one ring hung above the card and looked accidental.
 */
const CX = 118;
const CY = 150;
const RINGS = [50, 79, 108, 137];
const FROM = -75;
const TO = 5;

export default function RadioScene({ mode = 'silent' }) {
  const scheduled = mode === 'scheduled';

  /**
   * Which rings fail, and why each pattern is the honest one.
   *
   *   partial   — one in the MIDDLE. Both ends are fine and something between
   *               them dropped, which is what one service going quiet is.
   *   garbled   — every OTHER one. Some of it arrived and some of it did not,
   *               which is what a half-delivered bundle is.
   *   silent    — the OUTERMOST. The signal simply does not reach that far.
   *   scheduled — all of them. Nothing is being sent, and nothing is wrong.
   */
  const isBrokenRing = (i) => {
    if (scheduled) return true;
    if (mode === 'garbled') return i % 2 === 1;
    if (mode === 'partial') return i === 1;
    return i === RINGS.length - 1;
  };

  return (
    <svg
      className="err-scene err-radio"
      data-mode={mode}
      viewBox="0 0 400 300"
      role="presentation"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x="8" y="14" width="384" height="272" rx="10" fill="var(--surface-2)"
        stroke="var(--border)" strokeWidth="1.5" />
      {/* The wash. Bounded by the panel, not by taste: at cy=176 ry=126 its
          bottom was y=302 — past the 300-unit viewBox and 16 past the panel's
          own edge at 286 — and `.err-scene` is `overflow: visible`, so a soft
          glow painted outside the card on every radio screen. 170±110 keeps it
          inside both. */}
      <ellipse cx="164" cy="170" rx="150" ry="110" fill="var(--brand-soft)" opacity="0.5" />

      {/* ── The signal ── */}
      <g fill="none" strokeLinecap="round">
        {RINGS.map((r, i) => {
          const isBroken = isBrokenRing(i);
          return (
            <path
              key={r}
              className={isBroken ? 'err-radio-lost' : 'err-radio-ring'}
              style={{ '--err-i': i }}
              d={arc(CX, CY, r, FROM, TO)}
              stroke={isBroken ? 'var(--ink-3)' : 'var(--brand-primary)'}
              strokeWidth={isBroken ? 2.5 : 3.5}
              strokeDasharray={isBroken ? '9 12' : undefined}
              opacity={isBroken ? 0.65 : 0.85 - i * 0.16}
            />
          );
        })}
      </g>

      {/* ── The handset ── */}
      <g>
          {/* Antenna, angled with the signal so the object points where it talks. */}
        <rect x="110" y="148" width="7" height="36" rx="3.5" fill="var(--ink-3)"
          transform="rotate(12 113 166)" />
        <circle cx="118" cy="148" r="5.5" fill="var(--brand-primary)" />

        <rect x="56" y="176" width="86" height="108" rx="14" fill="var(--ink)" opacity="0.14" />
        <rect x="52" y="170" width="86" height="108" rx="14" fill="var(--surface)"
          stroke="var(--border)" strokeWidth="1.5" />

        {/* Screen. Its content is the only place the mode shows on the object
            itself, which keeps the rings and the set telling one story. */}
        <rect x="66" y="184" width="58" height="32" rx="5" fill="var(--brand-soft)"
          stroke="var(--brand-background)" strokeWidth="1" />
        {mode === 'silent' && (
          <g stroke="var(--ink-3)" strokeWidth="2.5" strokeLinecap="round" opacity="0.8">
            <line x1="84" y1="193" x2="106" y2="207" />
            <line x1="106" y1="193" x2="84" y2="207" />
          </g>
        )}
        {scheduled && (
          /* Two bars: the pause every set shows when it is off the air on
             purpose. It has to be unmistakably deliberate — an X here would say
             "broken", which is the one thing planned work is not. */
          <g fill="var(--ink-3)" opacity="0.65">
            <rect x="86" y="192" width="6" height="16" rx="2.5" />
            <rect x="98" y="192" width="6" height="16" rx="2.5" />
          </g>
        )}
        {mode === 'garbled' && (
          /* Alternating bars present and outlined, so the meter itself shows
             something arriving in pieces rather than simply arriving weakly. */
          <g>
            <rect x="76" y="202" width="6" height="8" rx="2"
              fill="var(--brand-primary)" opacity="0.6" />
            <rect x="86.8" y="196.8" width="4.4" height="12.4" rx="1.8"
              fill="none" stroke="var(--ink-3)" strokeWidth="1.2" strokeDasharray="2.5 2.5" />
            <rect x="96" y="205" width="6" height="5" rx="2"
              fill="var(--brand-primary)" opacity="0.6" />
            <rect x="106.8" y="198.8" width="4.4" height="10.4" rx="1.8"
              fill="none" stroke="var(--ink-3)" strokeWidth="1.2" strokeDasharray="2.5 2.5" />
          </g>
        )}
        {mode === 'partial' && (
          <g fill="var(--brand-primary)" opacity="0.6">
            <rect x="76" y="202" width="6" height="8" rx="2" />
            <rect x="86" y="196" width="6" height="14" rx="2" />
            <rect x="96" y="205" width="6" height="5" rx="2" />
            <rect x="106" y="198" width="6" height="12" rx="2" />
          </g>
        )}

        {/* Speaker grille and the push-to-talk row. */}
        <g fill="var(--ink-3)" opacity="0.4">
          {Array.from({ length: 3 }, (_, r) =>
            Array.from({ length: 5 }, (_, c) => (
              <circle key={`${r}-${c}`} cx={72 + c * 11} cy={230 + r * 11} r="2.6" />
            ))
          )}
        </g>
        <rect x="70" y="264" width="50" height="8" rx="4" fill="var(--brand-primary)"
          opacity="0.6" />
        <rect x="42" y="200" width="12" height="26" rx="4" fill="var(--ink-3)" opacity="0.5" />

        {scheduled && (
          /* A tag tied on the antenna. Planned work is somebody's decision, and
             a handwritten label is what a decision looks like on an object —
             the difference between "off air until four" and "dead". */
          <g transform="rotate(-9 152 168)">
            <path d="M146 156h44a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4h-44l-8-13z"
              fill="var(--warn-tint)" stroke="var(--warn-border)" strokeWidth="1.25" />
            <circle cx="143" cy="169" r="2.4" fill="var(--warn-border)" />
            <rect x="152" y="163" width="30" height="4" rx="2" fill="var(--warn)" />
            <rect x="152" y="172" width="20" height="3.5" rx="1.75" fill="var(--warn)"
              opacity="0.6" />
          </g>
        )}
      </g>
    </svg>
  );
}
