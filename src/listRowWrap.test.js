import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * List rows must wrap on a phone rather than being cut off.
 *
 * ── The failure this exists to prevent ──
 *
 * `.list-row` is `display: flex` with the default `nowrap`, and its container
 * `.list` is `overflow: hidden`. Measured in a browser on the applicant review
 * at 320px: the row's content was 630px wide inside a 268px box. The 362px
 * hanging off the right — the hours pill, the "N of M attended" counts, the
 * "not confirmed by an organizer" line, the First event tag, and the applied
 * date — was clipped away, and because the overflow was HIDDEN rather than
 * scrollable it did not even read as truncation.
 *
 * So an organizer reviewing applicants on a phone saw a name and nothing they
 * could decide on. Every figure this product computes about follow-through, and
 * every line written to keep those figures fair, was invisible on the device
 * organizers actually carry. It stopped around 768px, which is to say it
 * affected every phone and no desktop — and desktop is where it was looked at.
 *
 * ── Why the CSS is parsed rather than the DOM measured ──
 *
 * jsdom has no layout engine and does not evaluate media queries, so a rendered
 * assertion would report zero for every box and pass whatever the stylesheet
 * said. Parsing the declared rule is what this environment can honestly check;
 * the geometry itself was verified in a browser at 320, 390 and 1280.
 */

const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');

/** The coarse-pointer / narrow-viewport block that carries the phone rules. */
function mobileBlock() {
  const start = CSS.indexOf('@media (hover: none) and (pointer: coarse), (max-width: 700px)');
  expect(start, 'the phone media block has been renamed or removed').toBeGreaterThan(-1);

  let depth = 0;
  let i = CSS.indexOf('{', start);
  const from = i;
  for (; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(from, i + 1);
    }
  }
  throw new Error('unbalanced braces in the phone media block');
}

describe('list rows on a phone', () => {
  it('wrap instead of overflowing a container that hides the overflow', () => {
    const block = mobileBlock();
    expect(block).toMatch(/\.list-row\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('give the person cell its own line, so a name and its badges stay together', () => {
    /* Without this the name shares a line with whatever fits beside it and the
       badges wrap into the gap, which reads as a different volunteer's row. */
    const block = mobileBlock();
    expect(block).toMatch(/\.list-row\s+\.person\s*\{[^}]*flex:\s*1\s+1\s+100%/);
  });

  it('is scoped to the phone block, so desktop rows stay on one line', () => {
    /**
     * The rule must NOT be global. At desktop widths the row fits in one line
     * and wrapping it would turn a scannable six-column list into a stack —
     * verified at 1280px, where `flex-wrap` computes to `nowrap`.
     */
    const beforeMobile = CSS.slice(0, CSS.indexOf('@media (hover: none) and (pointer: coarse), (max-width: 700px)'));
    const baseRule = beforeMobile.match(/^\.list-row\s*\{[^}]*\}/m);

    expect(baseRule, 'the base .list-row rule has moved').toBeTruthy();
    expect(baseRule[0]).not.toMatch(/flex-wrap/);
  });

  it('still keeps .list clipping its corners, which is why wrapping is the fix', () => {
    /* `.list` is `overflow: hidden` to round its corners against the border. It
       is not a scroll container and must not become one — the row has to fit,
       which is what wrapping achieves. */
    expect(CSS).toMatch(/^\.list\s*\{[^}]*overflow:\s*hidden/m);
  });
});
