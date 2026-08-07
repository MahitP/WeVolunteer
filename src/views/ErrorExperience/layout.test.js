import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Static cover for the two error-screen layout rules that jsdom cannot check.
 *
 * The component tests render into jsdom, which computes no layout: every box is
 * zero-sized, so "does the button fall below the fold" is unanswerable there.
 * Playwright exists in `tests/e2e/` but is not installed and is not part of the
 * normal loop, so nothing in CI would notice either of the regressions below.
 *
 * These assertions are deliberately about the CSS TEXT. That is a weak form of
 * testing and it is the strongest one available here — it cannot prove the
 * layout is right, but it does stop the rules being deleted by someone who does
 * not know what they were for, which is how both defects arrived.
 */

const CSS = readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');

describe('error screen layout rules that no rendered test can reach', () => {
  /**
   * The landscape-phone defect.
   *
   * The stacked layout keys on width alone (`max-width: 60rem`). A phone held
   * sideways is 812×375: narrow enough to stack, nowhere near tall enough to
   * hold the result. The artwork band plus the copy came to 795px in a 375px
   * viewport, putting the only way out 396px below the fold and making the one
   * screen whose entire job is to offer an exit scroll to reach it.
   *
   * The fix undoes the stack when the viewport is short, which is why this
   * asserts on `max-height` rather than on any particular declaration: whatever
   * the rules inside become, a height-aware query has to exist.
   */
  it('undoes the stacked layout on a short viewport', () => {
    const shortQueries = [...CSS.matchAll(/@media[^{]*max-height[^{]*\{/g)].map((m) => m[0]);
    expect(
      shortQueries.length,
      'no height-aware media query remains — a landscape phone will stack the '
      + 'error screen and push the only way out below the fold'
    ).toBeGreaterThan(0);

    const index = CSS.search(/@media\s*\(max-height:\s*30rem\)\s*and\s*\(min-width:\s*30rem\)/);
    expect(index, 'the short-viewport error rule is gone').toBeGreaterThan(-1);
    // It has to come after the two width queries it overrides, because all three
    // select `.err[data-error-weight]` and the tie is broken by source order.
    expect(index).toBeGreaterThan(CSS.search(/@media\s*\(max-width:\s*60rem\)/));
    expect(index).toBeGreaterThan(CSS.search(/@media\s*\(max-width:\s*30rem\)/));
  });

  /**
   * The weight defect.
   *
   * `medium` was deleted when the 403 became a takeover, because its only member
   * was the 403 and `App.jsx` had already promoted it without `WEIGHTS` being
   * updated — so the refusal rendered at the top level wearing in-shell sizing,
   * landing in the top-left corner above roughly 55% dead space.
   *
   * A rule reintroduced here without a kind to use it is dead weight; a kind
   * pointed at rules that no longer exist is the original bug. `kinds.test.js`
   * owns the other half of this pair.
   */
  it('has no styling left for a weight nothing renders', () => {
    expect(
      CSS.includes("data-error-weight='medium'"),
      'medium-weight CSS is back but no kind uses it — see WEIGHTS in kinds.js'
    ).toBe(false);
  });
});
