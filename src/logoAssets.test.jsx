/**
 * One logo, however many files have to carry it.
 *
 * The checkmark-W is defined once, in `src/components/common/logoGeometry.js`.
 * Four static files cannot import it — the browser fetches a tab icon, a
 * manifest icon and a pinned-tab mask outside the document — and two more places
 * (the recovery-code canvas and the email template) have to write the brand
 * colour literally. A copy that drifts by one point or one hex digit is a second
 * logo nobody decided on, and it is exactly the kind of drift nobody sees in
 * review: the favicon is sixteen pixels wide.
 *
 * So every copy is read back here and compared with the source. The numbers the
 * source itself holds are pinned to the Identity Proposal (September 2026).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import {
  MARK_POINTS, MARK_PATH, MARK_STROKE, MARK_STROKE_SMALL, MARK_SMALL_BELOW_PX, markStrokeFor,
  MARK_VIEWBOX, MARK_VIEWBOX_WIDTH, MARK_VIEWBOX_HEIGHT, TILE_RADIUS_RATIO, TILE_MARK_RATIO,
  WORDMARK_VIEWBOX, WORDMARK_W_STROKE, WORDMARK_LETTERS_PATH,
} from './components/common/logoGeometry';
import BrandMark from './components/common/BrandMark';
import Wordmark from './components/common/Wordmark';

const ROOT = process.cwd();
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const FOREST = '#0f5a3a';

/** Parses `d` of the form `M16 26 L33 78 …` into points. */
const pointsOf = (d) => [...d.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

/**
 * The ink extent of the stroked polyline. With butt caps and bevel joins the ink
 * is the union of one rectangle per segment (plus bevel triangles inside their
 * hull), so its bounds are the extremes of those rectangles' corners.
 */
function inkCorners(points, width) {
  const corners = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const length = Math.hypot(bx - ax, by - ay);
    const nx = (-(by - ay) / length) * (width / 2);
    const ny = ((bx - ax) / length) * (width / 2);
    for (const [px, py] of [[ax, ay], [bx, by]]) corners.push([px + nx, py + ny], [px - nx, py - ny]);
  }
  return corners;
}
const within = (corners, [minX, minY, w, h]) => corners.every(([x, y]) =>
  x >= minX && x <= minX + w && y >= minY && y <= minY + h);

describe('the source matches the Identity Proposal', () => {
  it('is the five-point drawing printed on the construction plate', () => {
    expect(MARK_PATH).toBe('M16 26 L33 78 L50 34 L67 78 L86 4');
    expect(pointsOf(MARK_PATH)).toEqual(MARK_POINTS);
    expect(MARK_STROKE).toBe(12.5);
    expect(MARK_STROKE_SMALL).toBe(15.5);
    expect(MARK_SMALL_BELOW_PX).toBe(32);
    expect(markStrokeFor(31.9)).toBe(15.5);
    expect(markStrokeFor(32)).toBe(12.5);
    expect(TILE_RADIUS_RATIO).toBe(0.2236);
    expect(TILE_MARK_RATIO).toBe(0.58);
  });

  /* The five decisions the proposal names, measured from the points rather than
     trusted from the prose. */
  it('keeps the overshoot, the dropped apex and the asymmetric final stroke', () => {
    const [[, cap], [, base], [, apex], , [, top]] = MARK_POINTS;
    expect(cap - top).toBe(22); // "The last stroke overshoots by 22 units"
    expect(apex - cap).toBe(8); // "The middle apex sits 8 units below the cap line"
    expect(MARK_POINTS[1][1]).toBe(base);
    expect(MARK_POINTS[3][1]).toBe(base); // both feet on the baseline

    const fromVertical = ([ax, ay], [bx, by]) => Math.atan2(Math.abs(bx - ax), Math.abs(by - ay)) * 180 / Math.PI;
    const angles = MARK_POINTS.slice(1).map((p, i) => fromVertical(MARK_POINTS[i], p));
    // The final stroke is the steepest of the four, and not a mirror of the first.
    expect(Math.max(...angles.slice(0, 3))).toBeGreaterThan(angles[3] + 3);
    expect(angles[3]).not.toBeCloseTo(angles[0], 1);
  });

  it('draws the whole mark inside its viewBox at both weights', () => {
    const box = MARK_VIEWBOX.split(' ').map(Number);
    expect(box[2]).toBe(MARK_VIEWBOX_WIDTH);
    expect(box[3]).toBe(MARK_VIEWBOX_HEIGHT);
    expect(within(inkCorners(MARK_POINTS, MARK_STROKE), box)).toBe(true);
    expect(within(inkCorners(MARK_POINTS, MARK_STROKE_SMALL), box)).toBe(true);
  });

  it('draws the whole wordmark inside its viewBox', () => {
    const box = WORDMARK_VIEWBOX.split(' ').map(Number);
    expect(within(inkCorners(MARK_POINTS, WORDMARK_W_STROKE), box)).toBe(true);
    // Absolute M/L/C/Z only, so every number pair is an on-curve or control
    // point, and control points bound a Bézier.
    expect(WORDMARK_LETTERS_PATH).toMatch(/^[MLCZ\d.\s-]+$/);
    const numbers = WORDMARK_LETTERS_PATH.match(/-?[\d.]+/g).map(Number);
    const pairs = [];
    for (let i = 0; i < numbers.length; i += 2) pairs.push([numbers[i], numbers[i + 1]]);
    expect(within(pairs, box)).toBe(true);
  });
});

describe('the static files carry the same drawing', () => {
  const FILES = [
    { file: 'public/favicon.svg', stroke: MARK_STROKE_SMALL, ink: '#ffffff', tile: 'rounded', side: 64 },
    { file: 'public/app-icon.svg', stroke: MARK_STROKE, ink: '#ffffff', tile: 'rounded', side: 512 },
    { file: 'public/app-icon-maskable.svg', stroke: MARK_STROKE, ink: '#ffffff', tile: 'square', side: 512 },
    { file: 'public/mark.svg', stroke: MARK_STROKE, ink: FOREST, tile: null },
  ];

  it.each(FILES)('$file', ({ file, stroke, ink, tile, side }) => {
    const svg = read(file);
    const paths = svg.match(/<path\b[^>]*>/g);
    expect(paths).toHaveLength(1);
    const [p] = paths;

    expect(pointsOf(attr(p, 'd'))).toEqual(MARK_POINTS);
    expect(Number(attr(p, 'stroke-width'))).toBe(stroke);
    expect(attr(p, 'stroke-linejoin')).toBe('bevel');
    expect(attr(p, 'stroke-linecap')).toBe('butt');
    expect(attr(p, 'stroke-miterlimit')).toBe('1');
    expect(attr(p, 'fill')).toBe('none');
    expect(attr(p, 'stroke').toLowerCase()).toBe(ink);
    // No letters anywhere: the WV monogram is retired.
    expect(svg).not.toMatch(/<text\b/);

    if (!tile) {
      expect(svg).toMatch(new RegExp(`viewBox="${MARK_VIEWBOX}"`));
      return;
    }

    const rect = svg.match(/<rect\b[^>]*>/)[0];
    expect(attr(rect, 'fill').toLowerCase()).toBe(FOREST);
    expect(Number(attr(rect, 'width'))).toBe(side);
    const rx = Number(attr(rect, 'rx') ?? 0);
    if (tile === 'rounded') expect(rx / side).toBeCloseTo(TILE_RADIUS_RATIO, 3);
    else expect(rx).toBe(0);

    // Placed by a plain transform (some rasterisers ignore a nested <svg>): the
    // mark's viewBox box scaled to 0.58 of the side, with its centre on the
    // tile's centre.
    const [tx, ty, s] = attr(p, 'transform')
      .match(/^translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)$/).slice(1).map(Number);
    const [vx, vy] = MARK_VIEWBOX.split(' ').map(Number);
    expect((MARK_VIEWBOX_HEIGHT * s) / side).toBeCloseTo(TILE_MARK_RATIO, 4);
    expect(tx + (vx + MARK_VIEWBOX_WIDTH / 2) * s).toBeCloseTo(side / 2, 2);
    expect(ty + (vy + MARK_VIEWBOX_HEIGHT / 2) * s).toBeCloseTo(side / 2, 2);
  });

  /* A maskable icon is cut to the platform's shape; only the centred circle of
     radius 0.4 of the side is guaranteed to survive. */
  it('keeps the maskable mark inside the safe zone', () => {
    const side = 512;
    const unit = (side * TILE_MARK_RATIO) / MARK_VIEWBOX_HEIGHT;
    const [vx, vy] = MARK_VIEWBOX.split(' ').map(Number);
    const ox = (side - MARK_VIEWBOX_WIDTH * unit) / 2 - vx * unit;
    const oy = (side - MARK_VIEWBOX_HEIGHT * unit) / 2 - vy * unit;
    const farthest = Math.max(...inkCorners(MARK_POINTS, MARK_STROKE).map(([cx, cy]) =>
      Math.hypot(ox + cx * unit - side / 2, oy + cy * unit - side / 2)));
    expect(farthest / side).toBeLessThan(0.4);
  });

  it('points the document and the manifest at them, in Forest', () => {
    const html = read('index.html');
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
    expect(html).toMatch(/<link rel="mask-icon" href="\/mark\.svg" color="#0f5a3a" \/>/);
    expect(html).toMatch(/<meta name="theme-color" content="#0f5a3a" \/>/);

    const manifest = JSON.parse(read('public/site.webmanifest'));
    expect(manifest.theme_color).toBe(FOREST);
    expect(manifest.background_color).toBe(FOREST);
    expect(manifest.icons.map(i => [i.src, i.purpose])).toEqual([
      ['/app-icon.svg', 'any'],
      ['/app-icon-maskable.svg', 'maskable'],
    ]);
    for (const icon of manifest.icons) expect(existsSync(path.join(ROOT, 'public', icon.src))).toBe(true);
  });
});

describe('every literal copy of the colour is the same Forest', () => {
  it('index.css defines it once and the mark and wordmark read it', () => {
    const css = read('src/index.css');
    expect(css).toMatch(/--brand-forest:\s*#0f5a3a;/);
    expect(css).toMatch(/--brand-mark-bg:\s*var\(--brand-forest\);/);
    expect(css).toMatch(/--brand-wordmark:\s*var\(--brand-forest\);/);
    // Dark mode turns the wordmark white — never a lighter green.
    const dark = css.slice(css.indexOf("[data-theme='dark'] {"));
    expect(dark).toMatch(/--brand-wordmark:\s*var\(--brand-mark-ink\);/);
    expect(css).toMatch(/--brand-mark-ink:\s*#ffffff;/);
  });

  it('the recovery-code image and the email header use it', () => {
    expect(read('src/utils/recoveryCodeExport.js')).toMatch(/const BRAND_FOREST = '#0f5a3a';/);
    const email = read('server/email.js');
    expect(email).toMatch(/const wordmarkColor = '#0f5a3a';/);
    expect(email).toMatch(/color: \$\{wordmarkColor\}/);
    expect(email).not.toMatch(/>WV</);
  });
});

describe('the components render the source', () => {
  it('the tile draws the mark, with no letters and no second name', () => {
    const { container } = render(<BrandMark />);
    const tile = container.querySelector('.brand-mark');
    expect(tile.textContent).toBe('');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    const p = tile.querySelector('path');
    expect(p.getAttribute('d')).toBe(MARK_PATH);
    // The 32px tile puts the mark at 18.56px: the small-size weight.
    expect(p.getAttribute('stroke-width')).toBe(String(MARK_STROKE_SMALL));
    expect(p.getAttribute('stroke-linejoin')).toBe('bevel');
    expect(p.getAttribute('stroke-linecap')).toBe('butt');
  });

  it('the large tile draws it at full weight', () => {
    const { container } = render(<BrandMark size="lg" />);
    expect(container.querySelector('path').getAttribute('stroke-width')).toBe(String(MARK_STROKE));
  });

  it('the wordmark is one image, named once, whose W is the mark', () => {
    const { container } = render(<Wordmark />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'WeVolunteer' })).toBeInTheDocument();
    const [w, letters] = container.querySelectorAll('path');
    expect(w.getAttribute('d')).toBe(MARK_PATH);
    expect(w.getAttribute('stroke-width')).toBe(String(WORDMARK_W_STROKE));
    expect(w.getAttribute('stroke-linejoin')).toBe('bevel');
    expect(w.getAttribute('stroke-linecap')).toBe('butt');
    expect(letters.getAttribute('d')).toBe(WORDMARK_LETTERS_PATH);
    expect(container.querySelector('svg').getAttribute('viewBox')).toBe(WORDMARK_VIEWBOX);
  });
});
