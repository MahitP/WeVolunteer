import React, { useId } from 'react';

/**
 * The Campus Map — a wayfinding map with a walked route across it.
 *
 * The route is the argument. A volunteer signed up for something in a building
 * on the other side of campus, and the map can show them getting most of the
 * way there, which is a truer picture of a dead link than "not found": the
 * link worked, the walk happened, the room is the part that is missing.
 *
 * Modes:
 *   gap      — the route runs out; the destination is a dashed, empty ring
 *   blocked  — the route is fine and a checkpoint stands across it
 *   faded    — the route is dissolving from the start (a session timing out)
 *   unmapped — the far half of the map never loaded (no connection)
 *
 * `unmapped` is the one mode here that is not about this product at all. Half a
 * map arriving and half of it staying blank is what every person with a phone
 * has already seen the moment their signal went, so it needs no explaining —
 * which is exactly what an offline screen has to be. It also gives `offline` a
 * second theme; the radio was the only one that could honestly carry it, so
 * anyone who lost their connection twice in a session saw the same picture
 * twice.
 */

/* The walk. Deliberately not a straight line — a route with corners reads as a
   path between buildings, and a curve reads as a decorative swoosh. */
const ROUTE = 'M 58 236 L 58 196 Q 58 182 74 182 L 128 182 Q 144 182 144 166 L 144 118 Q 144 104 160 104 L 236 104';

/* The same walk, stopping where the map does. The route must not cross into
   the unsurveyed half: a path drawn over blank paper reads as a route that
   failed, and nothing about the walk has failed — only the map ran out. */
const ROUTE_SHORT = 'M 58 236 L 58 196 Q 58 182 74 182 L 128 182 Q 144 182 144 166 L 144 118 Q 144 104 160 104 L 198 104';

const BUILDINGS = [
  { x: 32, y: 44, w: 62, h: 48, tone: 'var(--surface)' },
  { x: 108, y: 36, w: 46, h: 40, tone: 'var(--surface)' },
  { x: 96, y: 206, w: 74, h: 56, tone: 'var(--surface)' },
  { x: 196, y: 196, w: 58, h: 44, tone: 'var(--surface)' },
  { x: 292, y: 62, w: 68, h: 58, tone: 'var(--surface)' },
  { x: 286, y: 176, w: 76, h: 64, tone: 'var(--surface)' },
];

export default function MapScene({ mode = 'gap' }) {
  /* Where the surveyed part of the map stops. Everything to the right of this
     is drawn as outline only — the buildings are known to be there, the detail
     never arrived. */
  const unmapped = mode === 'unmapped';
  const EDGE = 196;
  /* Deliberately NOT prefixed `err-`: `errorStyles.test.js` scans these files
     for `err-*` tokens to find dangling class names and cannot tell a class
     from an SVG id, so an id in that namespace reports as a class that styles
     nothing. The colons `useId` returns are stripped — they are legal in an id
     but not in a selector, and this should stay addressable either way. */
  const edgeId = `map-edge-${useId().replace(/:/g, '')}`;

  return (
    <svg
      className="err-scene err-map"
      data-mode={mode}
      viewBox="0 0 400 300"
      role="presentation"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x="8" y="14" width="384" height="272" rx="10" fill="var(--surface-2)"
        stroke="var(--border)" strokeWidth="1.5" />

      {/* Grid: the faint survey lines a printed campus map has. */}
      <g stroke="var(--rule)" strokeWidth="1" opacity="0.5">
        {Array.from({ length: 7 }, (_, i) => (
          <line key={`v${i}`} x1={8 + (i + 1) * 48} y1="14" x2={8 + (i + 1) * 48} y2="286" />
        ))}
        {Array.from({ length: 5 }, (_, i) => (
          <line key={`h${i}`} x1="8" y1={14 + (i + 1) * 45} x2="392" y2={14 + (i + 1) * 45} />
        ))}
      </g>

      {/* The green. Every campus map has one and it is the fastest way to say
          "this is a place", not "this is a diagram". */}
      <path
        d="M 196 36 Q 260 28 272 58 Q 284 92 244 100 Q 200 106 190 74 Q 184 46 196 36 Z"
        fill="var(--brand-soft)"
      />
      <path
        d="M 24 118 Q 62 110 76 132 Q 88 152 58 160 Q 28 166 20 144 Q 16 126 24 118 Z"
        fill="var(--brand-soft)"
      />

      {BUILDINGS.map((b, i) => {
        const beyond = unmapped && b.x >= EDGE;
        if (beyond) {
          /* Known to be there, never drawn in. No fill, no shadow, no label —
             a shadow implies a lit solid, which is the one thing a tile that
             never arrived is not. */
          return (
            <rect
              key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx="3"
              fill="none" stroke="var(--ink-3)" strokeWidth="1.5"
              strokeDasharray="6 5" opacity="0.5"
            />
          );
        }
        return (
          <g key={i}>
            <rect x={b.x + 2} y={b.y + 3} width={b.w} height={b.h} rx="3"
              fill="var(--ink)" opacity="0.08" />
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="3"
              fill={b.tone} stroke="var(--border)" strokeWidth="1" />
            <rect x={b.x + 8} y={b.y + 9} width={Math.max(10, b.w - 30)} height="3.5" rx="1.75"
              fill="var(--ink-3)" opacity="0.45" />
          </g>
        );
      })}

      {unmapped && (
        /* The edge of what arrived. A hard line would read as a wall, which is
           `blocked`'s job — this fades out, because nothing is stopping anyone
           from walking on; there is simply no map past here.
           The gradient id is per-instance: the dev gallery renders every scene
           on one page, and duplicate SVG ids silently resolve to whichever came
           first in the document. */
        <>
          <defs>
            <linearGradient id={edgeId} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="var(--surface-2)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--surface-2)" stopOpacity="0.92" />
            </linearGradient>
          </defs>
          <rect x={EDGE - 44} y="14" width={392 - EDGE + 44} height="272"
            fill={`url(#${edgeId})`} />
        </>
      )}

      {/* The route, under the markers so the pins sit on top of it. */}
      <path
        className="err-map-route"
        d={unmapped ? ROUTE_SHORT : ROUTE}
        fill="none"
        stroke="var(--brand-primary)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray="0.5 11"
        opacity="0.85"
      />

      {/* Where they started. A ring plus a core, so it reads as a "you are
          here" dot rather than a bullet point. */}
      <circle cx="58" cy="236" r="11" fill="var(--brand-primary)" opacity="0.18" />
      <circle cx="58" cy="236" r="5.5" fill="var(--brand-primary)" />

      {mode === 'blocked' && (
        /* A checkpoint across the path: two posts and a striped barrier arm.
           The route is untouched, which is the point — nothing is broken, they
           are simply not through here. */
        <g className="err-map-barrier">
          <rect x="188" y="90" width="6" height="34" rx="3" fill="var(--ink-3)" />
          <rect x="246" y="90" width="6" height="34" rx="3" fill="var(--ink-3)" />
          <rect x="182" y="94" width="76" height="13" rx="3.5" fill="var(--warn-tint)"
            stroke="var(--warn-border)" strokeWidth="1.25" />
          {/* Parallelograms, not skewed rects. `skewX` translates by
              `y * tan(angle)` about the ORIGIN, so at y≈96 these were displaced
              31px to the left and drew outside the barrier arm entirely. Stated
              as paths, each stripe is bounded by construction. */}
          <g fill="var(--warn)" opacity="0.75">
            {[194, 211, 228, 245].map((x) => (
              <path key={x} d={`M${x} 95.5 L${x + 6.5} 95.5 L${x + 3} 105.5 L${x - 3.5} 105.5 Z`} />
            ))}
          </g>
        </g>
      )}

      {mode !== 'blocked' && !unmapped && (
        /* The destination that is not there: a dashed ring with nothing in it,
           sitting exactly where the pin would have been. */
        <g className="err-map-target">
          <circle cx="236" cy="104" r="15" fill="none" stroke="var(--ink-3)"
            strokeWidth="2" strokeDasharray="6 5.5" />
          <circle cx="236" cy="104" r="3" fill="var(--ink-3)" opacity="0.45" />
        </g>
      )}
    </svg>
  );
}
