import React from 'react';

/**
 * The Ops Wall — the organiser's board of running events.
 *
 * A school's operations wall is paper strips and magnets, not a NASA console.
 * That distinction is the whole reason this theme is allowed to exist in a
 * volunteering product: it explains a systems failure with the artefact a
 * coordinator actually keeps behind their desk, so "one of ours went down"
 * lands as an ordinary Tuesday rather than a klaxon.
 *
 * Every other strip stays green and running, which is the reassurance the copy
 * is also making — one thing failed, the rest of the day is still happening.
 *
 * Modes:
 *   fault   — one strip has dropped out, and its own row shows it
 *   dropped — one strip has physically come off the wall
 *   planned — one strip is deliberately paused; nothing is wrong
 *
 * `dropped` exists because `fault` used to answer both `500` and `crash` with
 * the same picture. They are different events and the wall says so: a service
 * that stopped reporting is a red light on a strip that is still hanging, and a
 * screen that died is the strip on the floor.
 */

const STRIPS = [
  { label: 0.62, fill: 0.9 },
  { label: 0.44, fill: 0.72 },
  { label: 0.7, fill: 0.0 },   // the anomaly
  { label: 0.5, fill: 0.84 },
  { label: 0.58, fill: 0.66 },
];

const ANOMALY = 2;
/* Five strips have to finish inside the panel: TOP + 4*(H+GAP) + H + the
   3px shadow must stay under y=286. The first pass overflowed by 13px. */
const TOP = 68;
const H = 36;
const GAP = 6;

export default function OpsScene({ mode = 'fault' }) {
  const planned = mode === 'planned';
  const dropped = mode === 'dropped';
  const badTone = planned ? 'var(--warn)' : 'var(--danger)';
  const badTint = planned ? 'var(--warn-tint)' : 'var(--danger-tint)';
  const badEdge = planned ? 'var(--warn-border)' : 'var(--danger-border)';

  return (
    <svg
      className="err-scene err-ops"
      data-mode={mode}
      viewBox="0 0 400 300"
      role="presentation"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x="8" y="14" width="384" height="272" rx="10" fill="var(--surface-2)" />
      <rect x="8" y="14" width="384" height="272" rx="10" fill="none"
        stroke="var(--border)" strokeWidth="1.5" />

      {/* Header: the board's own label, and a legend. Both are what make a stack
          of bars read as somebody's wall rather than a chart. */}
      <rect x="30" y="36" width="86" height="8" rx="4" fill="var(--ink-3)" opacity="0.55" />
      <g>
        {[
          { cx: 288, tone: 'var(--ok)' },
          { cx: 318, tone: 'var(--warn)' },
          { cx: 348, tone: 'var(--danger)' },
        ].map((d) => (
          <g key={d.cx}>
            <circle cx={d.cx} cy="40" r="4.5" fill={d.tone} opacity="0.85" />
            <rect x={d.cx + 8} y="37.5" width="14" height="5" rx="2.5"
              fill="var(--ink-3)" opacity="0.4" />
          </g>
        ))}
      </g>
      <line x1="30" y1="58" x2="370" y2="58" stroke="var(--rule)" strokeWidth="1.5" />

      {STRIPS.map((s, i) => {
        const y = TOP + i * (H + GAP);
        const bad = i === ANOMALY;

        /* `dropped` empties this slot: the strip is not here any more, it is on
           the floor of the panel below. Drawing it rotated IN PLACE looked like
           a wedge sliding under the rows beneath it, because those rows paint
           afterwards — the fallen strip has to come last, so it lives outside
           this map. */
        if (bad && dropped) {
          return (
            <g key={i}>
              <rect x="30" y={y} width="336" height={H} rx="6"
                fill="none" stroke="var(--ink-3)" strokeWidth="1.4"
                strokeDasharray="7 6" opacity="0.5" />
              {/* The magnet it came off, with nothing on it. */}
              <circle cx="30" cy={y + H / 2} r="3.5" fill="var(--ink-3)" opacity="0.55" />
            </g>
          );
        }

        return (
          <g
            key={i}
            className={bad ? 'err-ops-bad' : 'err-ops-strip'}
            style={{ '--err-i': i }}
          >
            <rect x="32" y={y + 3} width="336" height={H} rx="6"
              fill="var(--ink)" opacity="0.07" />
            <rect
              x="30" y={y} width="336" height={H} rx="6"
              fill={bad ? badTint : 'var(--surface)'}
              stroke={bad ? badEdge : 'var(--border)'}
              strokeWidth={bad ? '1.5' : '1'}
              strokeDasharray={bad && planned ? '6 4.5' : undefined}
            />

            {/* Status light. */}
            <circle cx="50" cy={y + H / 2} r="5.5"
              fill={bad ? badTone : 'var(--ok)'} opacity={bad ? 1 : 0.85} />

            {/* Event name. */}
            <rect x="66" y={y + H / 2 - 3.5} width={110 * s.label} height="7" rx="3.5"
              fill="var(--ink-3)" opacity={bad ? 0.7 : 0.55} />

            {/* Fill meter — how many spots are taken. The broken row's is empty,
                which is what "this one stopped reporting" looks like. */}
            <rect x="212" y={y + H / 2 - 5} width="132" height="10" rx="5"
              fill="var(--brand-soft)" />
            {s.fill > 0 ? (
              <rect x="212" y={y + H / 2 - 5} width={132 * s.fill} height="10" rx="5"
                fill="var(--brand-primary)" opacity="0.75" />
            ) : (
              <rect x="212" y={y + H / 2 - 5} width="132" height="10" rx="5"
                fill="none" stroke={badTone} strokeWidth="1.5" strokeDasharray="5 5" />
            )}

            {/* The magnet holding the strip up. */}
            <circle cx="30" cy={y + H / 2} r="3.5" fill="var(--brand-primary)" opacity="0.5" />
          </g>
        );
      })}

      {/* The strip that came off, lying across the ones below it. Drawn LAST so
          it is on top of them — as the thing that fell has to be.

          The angle is bounded, not chosen. At 6° about (30, 226) the far bottom
          corner lands at 226 + 336·sin6° + 18·cos6° ≈ 279, inside the panel,
          which ends at 286. It was 13° in place first, which put that corner at
          296 and drew it through the bottom of the card. */}
      {dropped && (
        <g transform="rotate(6 30 226)">
          <rect x="32" y="211" width="336" height={H} rx="6"
            fill="var(--ink)" opacity="0.16" />
          <rect x="30" y="208" width="336" height={H} rx="6"
            fill="var(--surface)" />
          <rect x="30" y="208" width="336" height={H} rx="6"
            fill={badTint} stroke={badEdge} strokeWidth="1.5" />
          <circle cx="50" cy="226" r="5.5" fill={badTone} />
          <rect x="66" y="222.5" width="77" height="7" rx="3.5"
            fill="var(--ink-3)" opacity="0.7" />
          <rect x="212" y="221" width="132" height="10" rx="5"
            fill="none" stroke={badTone} strokeWidth="1.5" strokeDasharray="5 5" />
        </g>
      )}
    </svg>
  );
}
