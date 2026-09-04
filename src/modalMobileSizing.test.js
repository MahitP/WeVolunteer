import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * How a dialog is sized on a phone, asserted against the stylesheet.
 *
 * ── The defect this pins ──
 *
 * There were two `@media (max-width: 700px)` blocks declaring `.modal`, written
 * at different times and separated by two thousand lines. The first described a
 * bottom sheet — `max-height: 92vh`, rounded top corners, sized to its content.
 * The second, headed "Full-screen Mobile Sheets", re-declared the same selector
 * with `height: 100vh` and `border-radius: 0`.
 *
 * The second won, because it came later. So the design in the first block had
 * not applied to anything for as long as both existed, and every dialog in the
 * product was a full-screen sheet on a phone — including the ones containing a
 * paragraph and two buttons, which rendered as a screenful of void with the
 * actions stranded at the bottom.
 *
 * Nothing failed, and nothing could: both declarations were valid CSS, the
 * cascade did exactly what it says, and no test looked at the result. A
 * geometric test in `a11y/workflows/legalNotices.spec.js` now measures the
 * outcome in a real browser; this one guards the cause, because a browser test
 * cannot say WHY a dialog is 812 pixels tall and a duplicate declaration is
 * exactly the kind of thing that gets reintroduced by a merge.
 */

const CSS = readFileSync(path.join(process.cwd(), 'src', 'index.css'), 'utf8');

/** Every `@media (max-width: N)` block's body, with its N. */
function mobileBlocks() {
  const blocks = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let m;
  while ((m = re.exec(CSS)) !== null) {
    /* Brace-count from the opening brace so a nested rule does not end the
       block early. */
    let depth = 1;
    let i = re.lastIndex;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
      i++;
    }
    blocks.push({ width: Number(m[1]), body: CSS.slice(re.lastIndex, i - 1) });
  }
  return blocks;
}

/**
 * Declarations of one exact selector inside a block.
 *
 * Parsed by walking the rules rather than with a constructed RegExp: the
 * selector contains a dot, the body contains braces, and a pattern built from
 * both is the kind of thing that silently matches nothing and reports success.
 * The first version of this did exactly that.
 */
function declarationsFor(body, selector) {
  const found = [];
  let rest = body;
  while (rest.includes('{')) {
    const open = rest.indexOf('{');
    const close = rest.indexOf('}', open);
    if (close === -1) break;

    const heads = rest.slice(0, open)
      /* Comments can carry a `}` and a selector-shaped word; strip them before
         reading what this rule is called. */
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/[};]/).pop()
      .split(',')
      .map(h => h.trim())
      .filter(Boolean);

    if (heads.includes(selector)) found.push(rest.slice(open + 1, close));
    rest = rest.slice(close + 1);
  }
  return found;
}

describe('the mobile dialog sheet', () => {
  const blocks = mobileBlocks();

  it('finds the media blocks at all, so nothing below passes vacuously', () => {
    expect(blocks.length).toBeGreaterThan(5);
    expect(blocks.some(b => b.width === 700)).toBe(true);
  });

  /**
   * The property that broke. One selector, declared once per breakpoint — the
   * cascade is not a place to negotiate between two designs.
   */
  it('declares .modal exactly once across the mobile breakpoints', () => {
    const declarations = blocks.flatMap(b => declarationsFor(b.body, '.modal'));
    expect(
      declarations,
      'two blocks declaring `.modal` is how a later one silently overrode the design '
      + 'in an earlier one for the whole life of the stylesheet'
    ).toHaveLength(1);
  });

  it('declares .modal-overlay exactly once too', () => {
    const declarations = blocks.flatMap(b => declarationsFor(b.body, '.modal-overlay'));
    expect(declarations).toHaveLength(1);
  });

  const modalRule = () => blocks.flatMap(b => declarationsFor(b.body, '.modal'))[0] || '';

  /**
   * `height` is what was wrong, not `max-height`.
   *
   * A cap lets a short dialog be short and a tall one scroll inside
   * `.modal-body`. A fixed height forces both to the full screen, which is
   * correct for neither.
   */
  it('caps the sheet rather than fixing its height', () => {
    const rule = modalRule();
    expect(rule).toMatch(/max-height:/);
    expect(
      /(^|;|\s)height:/.test(rule),
      'a fixed height gives a two-button dialog a screenful of empty space'
    ).toBe(false);
  });

  /**
   * `dvh`, not `vh`. Mobile browser chrome collapses and expands, and `100vh`
   * is the tallest the viewport ever gets — this stylesheet makes the argument
   * in four other places, and a sheet capped in `vh` can still be taller than
   * what the reader can see.
   */
  it('measures that cap in dvh', () => {
    expect(modalRule()).toMatch(/max-height:\s*\d+dvh/);
  });

  /** A sheet anchored to the bottom edge has a rounded top and a square bottom. */
  it('keeps the rounded top edge that says it is a sheet', () => {
    expect(modalRule()).toMatch(/border-radius:\s*var\(--r-lg\)\s+var\(--r-lg\)\s+0\s+0/);
  });

  it('leaves room for the notch and the home indicator', () => {
    /* With `align-items: flex-end` the sheet's bottom edge is the viewport's,
       so the footer has to keep its buttons clear of the home indicator. */
    const all = blocks.map(b => b.body).join('\n');
    expect(all).toMatch(/\.modal-head\s*\{[^}]*env\(safe-area-inset-top/);
    expect(all).toMatch(/\.modal-foot\s*\{[^}]*env\(safe-area-inset-bottom/);
  });
});
