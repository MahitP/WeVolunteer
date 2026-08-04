import React from 'react';

/**
 * The Club Fair — a row of booths under bunting, and one nobody set up.
 *
 * This is the friendliest theme in the set and it is restricted to the kinds
 * that can carry friendliness: a missing page and a planned pause. A gymnasium
 * of club tables is a good way to say "that stall isn't here" and a tasteless
 * way to say "the server fell over while you were signing up".
 *
 * The empty booth is second of three rather than on an end, so the row reads as
 * a fair with a gap in it instead of a fair that stops.
 *
 * Modes:
 *   empty  — the booth was never set up; bare table, no backboard
 *   closed — the booth is set up with a card on it saying back shortly
 */

const P0 = [10, 44];
const P1 = [200, 98];
const P2 = [390, 44];

/** Point on the bunting curve, so the flags hang off the line rather than near it. */
function onCurve(t) {
  const u = 1 - t;
  return [
    u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0],
    u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1],
  ];
}

const BOOTHS = [
  { x: 34, w: 100, h: 62 },
  { x: 150, w: 100, h: 70 },  // the anomaly
  { x: 266, w: 100, h: 58 },
];
const ANOMALY = 1;
const TABLE_Y = 214;

export default function FairScene({ mode = 'empty' }) {
  const closed = mode === 'closed';

  return (
    <svg
      className="err-scene err-fair"
      data-mode={mode}
      viewBox="0 0 400 300"
      role="presentation"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x="8" y="14" width="384" height="272" rx="10" fill="var(--surface-2)"
        stroke="var(--border)" strokeWidth="1.5" />
      {/* The gym floor: one line does more for depth than any amount of shading. */}
      <rect x="8" y="238" width="384" height="48" fill="var(--brand-soft)" opacity="0.7" />
      <line x1="8" y1="238" x2="392" y2="238" stroke="var(--brand-background)" strokeWidth="2" />

      {/* ── Bunting ── */}
      <g className="err-fair-bunting">
        <path
          d={`M ${P0[0]} ${P0[1]} Q ${P1[0]} ${P1[1]} ${P2[0]} ${P2[1]}`}
          fill="none" stroke="var(--ink-3)" strokeWidth="2" opacity="0.55"
        />
        {Array.from({ length: 13 }, (_, i) => {
          const [x, y] = onCurve((i + 0.5) / 13);
          const tone = ['var(--brand-primary)', 'var(--accent)', 'var(--ok)'][i % 3];
          return (
            <path
              key={i}
              d={`M ${x - 9} ${y} L ${x + 9} ${y} L ${x} ${y + 21} Z`}
              fill={tone}
              opacity={0.62 + (i % 3) * 0.1}
            />
          );
        })}
      </g>

      {BOOTHS.map((b, i) => {
        const bare = i === ANOMALY && !closed;
        /* The closed booth's poster IS the sign. Propping a card in front of
           the table instead put it over the clipboard and the pen jar, and in
           dark mode a small amber shape on a dark table was barely there. */
        const signed = i === ANOMALY && closed;
        return (
          <g key={i}>
            {/* Backboard — the poster every club brings. */}
            {bare ? (
              <rect
                x={b.x} y={TABLE_Y - b.h} width={b.w} height={b.h} rx="4"
                fill="none" stroke="var(--ink-3)" strokeWidth="1.75" strokeDasharray="7 6"
                opacity="0.7"
              />
            ) : (
              <>
                <rect x={b.x + 2} y={TABLE_Y - b.h + 3} width={b.w} height={b.h} rx="4"
                  fill="var(--ink)" opacity="0.08" />
                <rect x={b.x} y={TABLE_Y - b.h} width={b.w} height={b.h} rx="4"
                  fill="var(--surface)" stroke="var(--border)" strokeWidth="1" />
                {signed ? (
                  /* A tent card standing where the poster would be, big enough
                     to read at thumbnail size and in dark mode. */
                  <g transform={`translate(${b.x + b.w / 2 - 32} ${TABLE_Y - b.h + 15})`}>
                    <path d="M0 40 L13 2 L51 2 L64 40 Z" fill="var(--warn-tint)"
                      stroke="var(--warn-border)" strokeWidth="1.5" />
                    <rect x="21" y="13" width="22" height="5" rx="2.5" fill="var(--warn)" />
                    <rect x="15" y="25" width="34" height="4" rx="2" fill="var(--warn)"
                      opacity="0.6" />
                  </g>
                ) : (
                  <>
                    <rect x={b.x + 12} y={TABLE_Y - b.h + 12} width={b.w - 46} height="6" rx="3"
                      fill="var(--ink-3)" opacity="0.55" />
                    <rect x={b.x + 12} y={TABLE_Y - b.h + 26} width={b.w - 24} height="4" rx="2"
                      fill="var(--brand-primary)" opacity="0.4" />
                    <rect x={b.x + 12} y={TABLE_Y - b.h + 36} width={b.w - 38} height="4" rx="2"
                      fill="var(--brand-primary)" opacity="0.3" />
                  </>
                )}
              </>
            )}

            {/* Table. Bare for the missing booth — no cloth, no sign-up sheet.
                Overhang is 4, not 8: at 8 the three tables met edge to edge and
                read as one long counter rather than three booths. */}
            <rect x={b.x - 4} y={TABLE_Y} width={b.w + 8} height="9" rx="3"
              fill={bare ? 'var(--surface-3)' : 'var(--brand-primary)'}
              opacity={bare ? 1 : 0.85} />
            <rect x={b.x - 2} y={TABLE_Y + 9} width="6" height="26" fill="var(--ink-3)"
              opacity="0.45" />
            <rect x={b.x + b.w - 4} y={TABLE_Y + 9} width="6" height="26" fill="var(--ink-3)"
              opacity="0.45" />

            {!bare && !signed && (
              /* A clipboard and a jar of pens: the two things on every table. */
              <>
                <rect x={b.x + 14} y={TABLE_Y - 13} width="30" height="13" rx="2"
                  fill="var(--surface)" stroke="var(--border)" strokeWidth="1" />
                <rect x={b.x + b.w - 34} y={TABLE_Y - 15} width="16" height="15" rx="3"
                  fill="var(--accent)" opacity="0.6" />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
