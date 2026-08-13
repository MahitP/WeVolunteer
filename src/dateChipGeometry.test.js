import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * A calendar tear-off is its own size, whatever stands beside it.
 *
 * ── The bug ──
 *
 * On Discover one card's date box was 72px tall against another's 45px, same
 * 46px width. It looked like a date-formatting problem — one day was 14, the
 * other 18 — and it was nothing of the kind.
 *
 * `.datechip` is a fixed-WIDTH flex item in `.eventcard-top`, which never set
 * `align-items`. The default is `stretch`, so the chip grew to whatever HEIGHT
 * its sibling column happened to be. The taller card carried a row of tag chips
 * and the shorter one did not; the dates were irrelevant.
 *
 * ── Why the fix is on the chip ──
 *
 * Four surfaces render one (the event card, the organizer dashboard, the
 * organizer profile, and any future caller), each a flex row of its own. Fixing
 * the parents would mean four rules that have to agree forever. A calendar chip
 * has no reason to stretch in any of them.
 *
 * Measured in a browser at 320 and 1280 across single-digit days, double-digit
 * days, short titles, long titles and 0/1/3/12 tags: every chip 46x45.
 */

const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8')
  /* Comments stripped: this rule is documented using the words the assertions
     look for, so an un-stripped search would match the prose. */
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleFor(selector) {
  const at = CSS.indexOf(selector);
  if (at === -1) return null;
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return open === -1 || close === -1 ? null : CSS.slice(open + 1, close);
}

describe('the date chip', () => {
  it('refuses to stretch to its neighbour height', () => {
    const rule = ruleFor('.datechip {');
    expect(rule, 'no .datechip rule').toBeTruthy();
    expect(rule, 'without this the chip grows with whatever sits beside it')
      .toMatch(/align-self:\s*flex-start/);
  });

  it('keeps the fixed width that made the stretch obvious', () => {
    /* The width was never the problem and must not be "fixed" too — a chip that
       shrinks would misalign every card in the list. */
    const rule = ruleFor('.datechip {');
    expect(rule).toMatch(/width:\s*46px/);
    expect(rule).toMatch(/flex-shrink:\s*0/);
  });

  it('does not solve it by pinning a height, which would clip a long month', () => {
    /**
     * The tempting wrong fix. A fixed height looks identical on today's data and
     * crops the moment a locale renders a longer month abbreviation or the
     * reader raises their font size.
     */
    const rule = ruleFor('.datechip {');
    expect(rule, 'a hard-coded height would clip rather than fit').not.toMatch(/[^-]height:\s*\d/);
  });
});
