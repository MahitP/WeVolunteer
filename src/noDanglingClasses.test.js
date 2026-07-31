import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Guards against a class name that no rule defines.
 *
 * A previous inline-style migration replaced every `style={{…}}` in twelve
 * components with a generated, content-hashed class name — and never emitted the
 * CSS. The markup kept asking for a class; the class did nothing. 78 of them had
 * accumulated by the time this was found, and the failures were silent: elements
 * simply lost their width, gap, colour or padding.
 *
 * One visible consequence was the capacity meter collapsing to 0px wide, which
 * made its two labels render as "0 signed up15 of 15 left". The applicant table's
 * column widths, the calendar's controls, the date-chip remove button and the
 * selection checkboxes were all losing their styling the same way.
 *
 * This test makes that class of regression impossible to land quietly: a
 * generated class with no rule fails the build.
 *
 * It also flags the reverse — a rule kept for a class nothing references any
 * more — so the stylesheet does not silently accumulate dead weight.
 */

const SRC = path.join(process.cwd(), 'src');
const CSS = readFileSync(path.join(SRC, 'index.css'), 'utf8');

/** Every generated class referenced from JS/JSX under src/. */
function referencedGeneratedClasses() {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.jsx?$/.test(entry.name)) continue;
      if (/\.test\.jsx?$/.test(entry.name)) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(/\bs-[0-9a-f]{6}\b/g)) {
        if (!found.has(m[0])) found.set(m[0], new Set());
        found.get(m[0]).add(path.relative(process.cwd(), full));
      }
    }
  };
  walk(SRC);
  return found;
}

/** Every generated class that index.css defines a rule for. */
function definedGeneratedClasses() {
  return new Set([...CSS.matchAll(/\.(s-[0-9a-f]{6})\b/g)].map(m => m[1]));
}

describe('generated class names', () => {
  const referenced = referencedGeneratedClasses();
  const defined = definedGeneratedClasses();

  it('every generated class referenced in JSX has a rule in index.css', () => {
    const dangling = [...referenced]
      .filter(([cls]) => !defined.has(cls))
      .map(([cls, files]) => `${cls} (${[...files].join(', ')})`);
    expect(dangling, 'these class names style nothing').toEqual([]);
  });

  it('every generated rule in index.css is still referenced somewhere', () => {
    const unused = [...defined].filter(cls => !referenced.has(cls));
    expect(unused, 'dead rules — remove them or the reference that was dropped').toEqual([]);
  });

  it('finds the classes at all, so the scan itself cannot silently pass', () => {
    // If the regex or the walk breaks, both assertions above pass vacuously.
    expect(referenced.size).toBeGreaterThan(50);
    expect(defined.size).toBeGreaterThan(50);
  });
});

describe('utility classes used across the app are defined', () => {
  /**
   * The same migration also left `.stack-md` referenced by ten files with no
   * rule anywhere, so those columns rendered with no gap. These are the shared
   * utilities whose absence is invisible in review but obvious on screen.
   */
  const REQUIRED = [
    'stack-xs', 'stack-sm', 'stack-md', 'stack-lg', 'stack',
    'row', 'row-between', 'seats-meter', 'seats-row',
    'modal-overlay', 'modal-overlay-stacked', 'modal', 'modal-head', 'modal-body', 'modal-foot',
    'auth-actions', 'auth-providers', 'field', 'alert', 'alert-danger'
  ];

  for (const cls of REQUIRED) {
    it(`.${cls} has a rule`, () => {
      expect(new RegExp(`\\.${cls}\\s*[,{]`).test(CSS), `.${cls} is referenced but never defined`).toBe(true);
    });
  }
});

describe('class names referenced in JSX that look like utilities exist in CSS', () => {
  /**
   * Catches the `.modal-footer` / `.btn-error` / `.modal-content` class of
   * mistake: markup asking for a class that the stylesheet spells differently.
   * Scoped to the prefixes where a typo means "renders unstyled" rather than
   * "renders slightly differently", so it stays a signal rather than noise.
   */
  const WATCHED = /^(modal|btn|stack|seats|auth|field|alert)-[a-z-]+$/;

  /**
   * Marker classes that intentionally have no rule.
   *
   * The three provider buttons carry their brand styling inline, because a
   * provider's palette has to be exact — Google's #ffffff/#8c8c8c, Apple's
   * #000000 — and `noHardcodedColors.test.js` exempts `components/auth/` for
   * precisely that reason. These class names are identification hooks, not style
   * carriers, so they are not the "lost rule" defect this file guards against.
   */
  const INTENTIONAL_MARKERS = new Set(['btn-google', 'btn-microsoft', 'btn-apple']);

  it('no watched-prefix class is referenced without a rule', () => {
    const referenced = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx$/.test(entry.name) || /\.test\.jsx$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/className=(?:\{[`"']([^`"']*)|["']([^"']*))/g)) {
          const blob = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
          for (const token of blob.split(/\s+/)) {
            if (WATCHED.test(token)) referenced.add(token);
          }
        }
      }
    };
    walk(SRC);

    const missing = [...referenced]
      .filter(cls => !INTENTIONAL_MARKERS.has(cls))
      .filter(cls => !new RegExp(`\\.${cls}\\s*[,{:]`).test(CSS))
      .sort();
    expect(missing, 'referenced but not defined in index.css').toEqual([]);
  });
});
