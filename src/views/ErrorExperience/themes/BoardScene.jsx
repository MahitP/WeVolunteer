import React from 'react';

/**
 * The Bulletin Board — a corkboard of pinned signup sheets.
 *
 * The board comes out of the product's own data model rather than being applied
 * to it: an event has slots, students claim spots, and the pinned sheet is the
 * physical thing a school actually puts in a hallway. That is why this theme is
 * the universal fallback — it can explain any failure without stretching.
 *
 * Depth is built the same way in all six scenes: an offset copy of a shape at
 * low opacity is the shadow. `feDropShadow` would be fewer nodes, but its
 * `flood-color` does not reliably resolve a CSS custom property across
 * browsers, and a shadow that silently renders black would defeat the theming
 * these scenes exist to get for free.
 *
 * The anomaly is one sheet, and which one it is carries the whole message:
 *   gap     — the sheet is gone; a bare pin and a dashed outline remain
 *   locked  — the sheet is there and closed to you
 *   rebuild — every sheet is mid-refresh, and one is holding still
 *   partial — the sheet printed halfway and stopped
 *   torn    — the sheet came off; the bottom of it is on the floor
 *   notice  — nothing is wrong with the board; a card is pinned over it
 *
 * ── Why six modes and not three ──
 *
 * This theme is the universal fallback, so it answers six kinds — and the first
 * version answered four of them (`500`, `crash`, `chunk`, `maintenance`) with
 * one picture called `rebuild`. In the contact sheet those four cards were
 * pixel-identical: the rotation claimed six screens and drew three. A reader who
 * meets two failures in a session sees the repetition long before they read the
 * headline that was meant to distinguish them, which is the exact "one design in
 * six hats" failure the whole system exists to avoid. `selector.test.js` now
 * fails the build if any theme maps two kinds to one mode.
 */

/** Six sheets, hand-placed. Even spacing reads as a wireframe, not a board. */
const SHEETS = [
  { x: 42, y: 52, w: 88, h: 76, r: -3.2 },
  { x: 152, y: 44, w: 92, h: 82, r: 1.8 },
  { x: 266, y: 58, w: 84, h: 72, r: -1.4 },
  { x: 38, y: 158, w: 90, h: 78, r: 2.6 },
  { x: 150, y: 168, w: 88, h: 74, r: -2.2 },
  { x: 262, y: 154, w: 92, h: 80, r: 1.2 },
];

/** The sheet that is wrong. Off-centre, so the board reads as a real board. */
const ANOMALY = 4;

/**
 * The ragged edge of a sheet pulled off the board.
 *
 * Stated as an explicit polyline rather than a filter or a wavy stroke: the
 * torn fragment and the piece on the floor have to share the SAME edge for the
 * two halves to read as one sheet, and only a shared point list guarantees it.
 * `dir` is +1 for the piece that is still pinned (the tear is its bottom) and
 * -1 for the piece that fell (the tear is its top).
 */
function tearPoints(x, w, y, dir) {
  const steps = 7;
  return Array.from({ length: steps + 1 }, (_, k) => {
    const px = x + (w * k) / steps;
    /* Alternating, not random: `Math.random()` here would give the two halves
       different edges on every render and they would stop being one sheet. */
    const py = y + dir * (k % 2 === 0 ? 0 : 8);
    return `${px.toFixed(1)} ${py.toFixed(1)}`;
  });
}

function Sheet({ s, i, mode, isAnomaly }) {
  const t = `rotate(${s.r} ${s.x + s.w / 2} ${s.y + s.h / 2})`;

  if (isAnomaly && mode === 'gap') {
    return (
      <g transform={t} className="err-board-hole">
        <rect
          x={s.x} y={s.y} width={s.w} height={s.h} rx="4"
          fill="none" stroke="var(--ink-3)" strokeWidth="1.75" strokeDasharray="7 6"
        />
      </g>
    );
  }

  /* chunk — the sheet started printing and stopped. The top is a real sheet
     with names on it; below the cut there is nothing but the outline of where
     the rest should have been. */
  if (isAnomaly && mode === 'partial') {
    const cut = s.y + 34;
    return (
      <g transform={t}>
        <path
          d={`M${s.x} ${s.y + 4}a4 4 0 0 1 4-4h${s.w - 8}a4 4 0 0 1 4 4v${cut - s.y - 4}h${-s.w}z`}
          fill="var(--surface)" stroke="var(--border)" strokeWidth="1"
        />
        <rect x={s.x + 11} y={s.y + 16} width={s.w - 34} height="4" rx="2"
          fill="var(--ink-3)" opacity="0.5" />
        <rect x={s.x + 11} y={s.y + 26} width={s.w - 26} height="3" rx="1.5"
          fill="var(--brand-primary)" opacity="0.34" />

        {/* The half that never arrived. */}
        <path
          d={`M${s.x} ${cut}h${s.w}v${s.h - (cut - s.y) - 4}a4 4 0 0 1-4 4h${-(s.w - 8)}a4 4 0 0 1-4-4z`}
          fill="none" stroke="var(--ink-3)" strokeWidth="1.6" strokeDasharray="7 6" opacity="0.8"
        />

        <circle cx={s.x + s.w / 2} cy={s.y + 1} r="5.5" fill="var(--ink)" opacity="0.14" />
        <circle cx={s.x + s.w / 2} cy={s.y} r="5.5" fill="var(--brand-primary)" />
        <circle cx={s.x + s.w / 2 - 1.6} cy={s.y - 1.8} r="1.7" fill="var(--surface)" opacity="0.65" />
      </g>
    );
  }

  /* crash — the sheet tore. This half is still on its pin; the other half is
     drawn on the floor of the board by the scene below, off the same edge. */
  if (isAnomaly && mode === 'torn') {
    /* REVERSED. The outline reaches the tear having just come down the RIGHT
       edge, so the ragged points have to be walked right-to-left from there —
       traced left-to-right they jump back across the sheet and the fill folds
       into a zigzag sliver. Caught by looking at it; nothing about the path is
       invalid, so no test or lint could have said a word. */
    const tear = tearPoints(s.x, s.w, s.y + 40, 1).reverse();
    return (
      <g transform={t}>
        <path
          d={`M${s.x} ${s.y + 4}a4 4 0 0 1 4-4h${s.w - 8}a4 4 0 0 1 4 4V${s.y + 40}L${tear.slice(1).join('L')}z`}
          fill="var(--surface)" stroke="var(--border)" strokeWidth="1"
        />
        <rect x={s.x + 11} y={s.y + 16} width={s.w - 34} height="4" rx="2"
          fill="var(--ink-3)" opacity="0.5" />
        <rect x={s.x + 11} y={s.y + 27} width={s.w - 30} height="3" rx="1.5"
          fill="var(--brand-primary)" opacity="0.3" />

        <circle cx={s.x + s.w / 2} cy={s.y + 1} r="5.5" fill="var(--ink)" opacity="0.14" />
        <circle cx={s.x + s.w / 2} cy={s.y} r="5.5" fill="var(--brand-primary)" />
        <circle cx={s.x + s.w / 2 - 1.6} cy={s.y - 1.8} r="1.7" fill="var(--surface)" opacity="0.65" />
      </g>
    );
  }

  return (
    <g
      transform={t}
      className={`err-board-sheet${isAnomaly && mode === 'rebuild' ? ' err-board-held' : ''}`}
      style={{ '--err-i': i }}
    >
      {/* Shadow first, so the sheet sits on top of its own weight. */}
      <rect
        x={s.x + 2} y={s.y + 4} width={s.w} height={s.h} rx="4"
        fill="var(--ink)" opacity="0.09"
      />
      <rect
        x={s.x} y={s.y} width={s.w} height={s.h} rx="4"
        fill={isAnomaly && mode === 'locked' ? 'var(--warn-tint)' : 'var(--surface)'}
        stroke={isAnomaly && mode === 'locked' ? 'var(--warn-border)' : 'var(--border)'}
        strokeWidth="1"
      />

      {isAnomaly && mode === 'locked' ? (
        /* A padlock, drawn rather than imported: a lucide glyph dropped into
           artwork is the "default icon floating in space" this brief rules out. */
        <g transform={`translate(${s.x + s.w / 2 - 9} ${s.y + s.h / 2 - 11})`}>
          <path
            d="M4 8V5.5a5 5 0 0 1 10 0V8"
            fill="none" stroke="var(--warn)" strokeWidth="2.2" strokeLinecap="round"
          />
          <rect x="1" y="8" width="16" height="13" rx="2.5" fill="var(--warn)" stroke="var(--warn-border)" strokeWidth="1" opacity="0.9" />
        </g>
      ) : (
        /* Ruled lines: a signup sheet is a list of names. Widths vary so it
           reads as filled in by different people, not as a loading skeleton. */
        <>
          <rect x={s.x + 11} y={s.y + 16} width={s.w - 34} height="4" rx="2"
            fill="var(--ink-3)" opacity="0.5" />
          <rect x={s.x + 11} y={s.y + 30} width={s.w - 22} height="3" rx="1.5"
            fill="var(--brand-primary)" opacity={0.28 + ((i * 7) % 5) * 0.06} />
          <rect x={s.x + 11} y={s.y + 41} width={s.w - 40 - ((i * 11) % 17)} height="3" rx="1.5"
            fill="var(--brand-primary)" opacity={0.22 + ((i * 5) % 4) * 0.07} />
          <rect x={s.x + 11} y={s.y + 52} width={s.w - 30 - ((i * 13) % 21)} height="3" rx="1.5"
            fill="var(--brand-primary)" opacity={0.18 + ((i * 3) % 5) * 0.05} />
        </>
      )}

      {/* The pin. Its highlight is what stops it reading as a flat dot. */}
      <circle cx={s.x + s.w / 2} cy={s.y + 1} r="5.5" fill="var(--ink)" opacity="0.14" />
      <circle cx={s.x + s.w / 2} cy={s.y} r="5.5" fill="var(--brand-primary)" />
      <circle cx={s.x + s.w / 2 - 1.6} cy={s.y - 1.8} r="1.7" fill="var(--surface)" opacity="0.65" />
    </g>
  );
}

export default function BoardScene({ mode = 'gap' }) {
  return (
    <svg
      className="err-scene err-board"
      data-mode={mode}
      viewBox="0 0 400 300"
      role="presentation"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x="8" y="14" width="384" height="272" rx="10" fill="var(--surface-2)"
        stroke="var(--border)" strokeWidth="1.5" />
      <g fill="var(--brand-primary)" opacity="0.13">
        {Array.from({ length: 26 }, (_, i) => (
          <circle
            key={i}
            cx={26 + ((i * 61) % 350)}
            cy={32 + ((i * 97) % 240)}
            r={1 + ((i * 7) % 3) * 0.4}
          />
        ))}
      </g>

      {SHEETS.map((s, i) => (
        <Sheet key={i} s={s} i={i} mode={mode} isAnomaly={i === ANOMALY} />
      ))}

      {/* 404 only: the sheet that left. Rotated hard and carrying a long shadow,
          so it reads as mid-air rather than as a seventh sheet on the board. */}
      {mode === 'gap' && (
        /* Nested: the OUTER group carries the static lift that keeps the sheet
           inside the viewBox, the inner one carries the flutter. They cannot be
           the same element — CSS `transform` and the SVG `transform` attribute
           are one property, so the keyframe would silently drop the offset. */
        <g transform="translate(0 -9)">
        <g className="err-board-loose">
          <rect x="300" y="228" width="78" height="66" rx="4"
            transform="rotate(14 339 261)" fill="var(--ink)" opacity="0.1" />
          <rect x="296" y="222" width="78" height="66" rx="4"
            transform="rotate(14 335 255)" fill="var(--surface)"
            stroke="var(--border)" strokeWidth="1" />
          <g transform="rotate(14 335 255)" opacity="0.45">
            <rect x="306" y="236" width="46" height="3.5" rx="1.75" fill="var(--ink-3)" />
            <rect x="306" y="246" width="56" height="3" rx="1.5" fill="var(--brand-primary)" />
            <rect x="306" y="255" width="38" height="3" rx="1.5" fill="var(--brand-primary)" />
          </g>
        </g>
        </g>
      )}

      {/* crash only: the half that came away, on the floor of the board.
          Its top edge is the SAME polyline as the fragment still pinned above
          (dir -1), which is what makes the two read as one torn sheet rather
          than as a small sheet under a short one. Bounded by construction: the
          card is 28 tall at y=246 and rotated 9°, so its lowest point is 279 —
          inside the cork, which ends at 286. */}
      {mode === 'torn' && (
        /* Nested for the same reason as the loose sheet above: the OUTER group
           carries the static rotation, the inner one carries the flutter. CSS
           `transform` and the SVG attribute are one property, so a keyframe on
           this element would silently discard the tilt. */
        <g transform="rotate(9 235 260)">
        <g className="err-board-loose">
          <path
            d={`M200 250L${tearPoints(200, 70, 250, -1).slice(1).join('L')}V270a4 4 0 0 1-4 4h-62a4 4 0 0 1-4-4z`}
            fill="var(--ink)" opacity="0.1" transform="translate(3 4)"
          />
          <path
            d={`M200 250L${tearPoints(200, 70, 250, -1).slice(1).join('L')}V270a4 4 0 0 1-4 4h-62a4 4 0 0 1-4-4z`}
            fill="var(--surface)" stroke="var(--border)" strokeWidth="1"
          />
          <rect x="210" y="260" width="42" height="3" rx="1.5"
            fill="var(--brand-primary)" opacity="0.32" />
          <rect x="210" y="267" width="30" height="3" rx="1.5"
            fill="var(--brand-primary)" opacity="0.24" />
        </g>
        </g>
      )}

      {/* maintenance only: nothing on the board is broken, so no sheet is.
          Somebody has simply taped a card over the middle of it. The tape is
          what makes it read as put there this morning rather than printed. */}
      {mode === 'notice' && (
        <g transform="rotate(-3.5 200 148)">
          <rect x="126" y="112" width="148" height="72" rx="5"
            fill="var(--ink)" opacity="0.14" transform="translate(3 5)" />
          {/* Opaque backing under the tint. `--warn-tint` is a low-alpha colour,
              so on its own the sheets behind read straight through the card and
              it looks like a projection rather than a piece of paper. */}
          <rect x="126" y="112" width="148" height="72" rx="5" fill="var(--surface)" />
          <rect x="126" y="112" width="148" height="72" rx="5"
            fill="var(--warn-tint)" stroke="var(--warn-border)" strokeWidth="1.5" />
          <rect x="146" y="132" width="60" height="7" rx="3.5" fill="var(--warn)" />
          <rect x="146" y="149" width="104" height="5" rx="2.5" fill="var(--warn)" opacity="0.6" />
          <rect x="146" y="161" width="78" height="5" rx="2.5" fill="var(--warn)" opacity="0.42" />

          {/* Tape, over the card's own corners so it reads as put there this
              morning rather than printed. Opaque and light — at low opacity
              over a dark board it was two smudges. */}
          <g fill="var(--surface-3)">
            <rect x="112" y="105" width="38" height="14" rx="1.5"
              transform="rotate(-40 131 112)" opacity="0.9" />
            <rect x="250" y="105" width="38" height="14" rx="1.5"
              transform="rotate(40 269 112)" opacity="0.9" />
          </g>
        </g>
      )}
    </svg>
  );
}
