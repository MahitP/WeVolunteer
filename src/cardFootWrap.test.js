import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * A card footer holding two groups of buttons wraps rather than overflowing.
 *
 * ── The bug ──
 *
 * The new-organization form's footer is `.card-foot.row-between`: Cancel on the
 * left, "Create organization" on the right. `.row-between` is a flex row with no
 * wrap, and `.org-actions` beside it sets `flex-shrink: 0` — deliberately,
 * because a squeezed button is worse than a wrapped one. With a long label there
 * is then nothing left to give, and the row ran 35px past a 390px viewport.
 *
 * The interesting part is what that looked like from the outside. The document
 * became 425px wide, so `.mobilenav` and `.toasts` — both correctly sized to the
 * VIEWPORT — were reported as overflowing too. Three offenders, one cause, and
 * the two obvious-looking ones were innocent. Anything that "fixed" the nav
 * would have been treating a symptom.
 *
 * ── Why the stylesheet is read rather than the DOM measured ──
 *
 * jsdom has no layout engine: every width is zero, so a rendered assertion about
 * overflow measures nothing and passes whatever is written. This asserts the
 * rule that prevents it. The actual containment was verified in a browser at
 * 320px and 390px — `document.scrollWidth === clientWidth` on the organization
 * form, the event form and the external-hours form.
 */

const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8')
  /* Comments stripped first: the rule below is documented in the vocabulary of
     the fix, so an un-stripped search matches the prose and passes even with the
     declaration deleted. That exact vacuity has already happened once in this
     repository. */
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list contains `selector`. */
function ruleFor(selector) {
  const at = CSS.indexOf(selector);
  if (at === -1) return null;
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return open === -1 || close === -1 ? null : CSS.slice(open + 1, close);
}

describe('a card footer cannot push the document wider than the screen', () => {
  it('wraps when its two button groups do not fit on one line', () => {
    const rule = ruleFor('.card-foot.row-between');
    expect(rule, 'no .card-foot.row-between rule — the footer cannot wrap').toBeTruthy();
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
  });

  it('keeps a readable gap between the wrapped lines', () => {
    /* Without `row-gap` the two lines butt together, because the shared `gap`
       on `.row-between` is consumed as a column gap on the line that fits. */
    expect(ruleFor('.card-foot.row-between')).toMatch(/row-gap:/);
  });

  it('does not make every .row-between wrap', () => {
    /**
     * The scope is the point. `.row-between` is used across the product in rows
     * where wrapping would be wrong — a label beside its control, a heading
     * beside its action — and widening the fix to that selector would change
     * layouts nobody reported a problem with.
     */
    const bare = ruleFor('\n.row-between {');
    expect(bare, 'the base .row-between rule has moved or been renamed').toBeTruthy();
    expect(bare, '.row-between must not wrap globally').not.toMatch(/flex-wrap:\s*wrap/);
  });

  it('leaves the action group unshrinkable, which is why wrapping is the fix', () => {
    /* If this ever gains `flex-shrink: 1`, the button squeezes instead of
       wrapping and the reasoning above stops holding — the rule would still be
       here, quietly doing nothing. */
    expect(ruleFor('.org-actions')).toMatch(/flex-shrink:\s*0/);
  });
});
