import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * A provider button's contents stay inside the provider button.
 *
 * ── The bug ──
 *
 * At 320px the Microsoft logo rendered six pixels OUTSIDE the button's left
 * edge and the label ran past the right edge. Measured in a browser: the button
 * was 256px and its content 263px.
 *
 * It presented as a Microsoft problem and was not one. All three provider
 * buttons are the same centred flex row with `overflow: visible`, and nothing
 * told either child what to do when the row does not fit. `ProviderButtons`
 * composes the label as `${p.label} — not set up on this site`, so the
 * misconfigured state is about fifteen characters longer than "Continue with
 * Google". Microsoft is merely the provider left unconfigured on this
 * deployment — Apple in the same state overflows identically. Centred content
 * that overflows spills from BOTH ends, which is why the icon went left while
 * the text went right.
 *
 * ── Why the stylesheet is read instead of the DOM measured ──
 *
 * jsdom has no layout engine: every `getBoundingClientRect` is zero, so a
 * rendered assertion about overflow would measure nothing and pass whatever was
 * written. This asserts the rules that prevent it exist, in the same spirit as
 * `printIsolation.test.js`. The actual containment was verified in a browser at
 * 320px — icon and label both inside all three buttons, `scrollWidth ===
 * clientWidth`, Microsoft wrapping to two lines at 60px tall.
 *
 * ── Why the rules are in CSS and not the components ──
 *
 * The three components set `display`, `gap` and `padding` INLINE, and an inline
 * declaration cannot be overridden by a rule or a media query. They set nothing
 * on their children, so these land without an `!important` fight — which is
 * also why a test that the selectors target children is worth having.
 */

/**
 * Comments stripped BEFORE anything is matched.
 *
 * Found by breaking this test and watching it pass anyway. The rules being
 * asserted are commented, and those comments explain the fix in the fix's own
 * vocabulary — the `min-width: 0` rule opens by saying why `min-width: 0` is
 * needed. So a naive search of the rule body matched the prose, and deleting the
 * actual declaration changed nothing the test could see. Every assertion here
 * was vacuous in exactly the way that is hardest to notice: green, specific, and
 * measuring the explanation rather than the behaviour.
 */
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const PROVIDERS = ['btn-google', 'btn-microsoft', 'btn-apple'];

/** The declarations of the first rule whose selector list contains `selector`. */
function ruleFor(selector) {
  const at = CSS.indexOf(selector);
  if (at === -1) return null;
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return open === -1 || close === -1 ? null : CSS.slice(open + 1, close);
}

describe('provider sign-in buttons contain their own contents', () => {
  it.each(PROVIDERS)('%s keeps its brand mark from being squeezed or pushed out', (cls) => {
    /* A brand mark is a fixed size — it is the label that has to give way. Without
       this the icon is a shrinkable flex item and a long label pushes it out of
       the box entirely, which is exactly what happened. */
    const rule = ruleFor(`.${cls} > svg`);
    expect(rule, `no child-svg rule for .${cls}`).toBeTruthy();
    expect(rule).toMatch(/flex-shrink:\s*0/);
  });

  it.each(PROVIDERS)('%s lets its label shrink rather than widen the row', (cls) => {
    /**
     * `min-width: 0` is the whole fix. A flex item's automatic minimum size is
     * its content, so without this the text refuses to be narrower than its
     * longest unbroken run and pushes the row wider than the button.
     */
    const rule = ruleFor(`.${cls} > span`);
    expect(rule, `no child-span rule for .${cls}`).toBeTruthy();
    expect(rule).toMatch(/min-width:\s*0/);
  });

  it.each(PROVIDERS)('%s wraps its label instead of truncating it', (cls) => {
    /**
     * Not `text-overflow: ellipsis`. "Microsoft — not set up on this s…" cuts
     * off precisely the part that tells an operator their own deployment is
     * misconfigured, which is the entire reason `ProviderButtons` distinguishes
     * that wording from "coming soon".
     */
    const rule = ruleFor(`.${cls} > span`);
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule, 'the label must not be truncated').not.toMatch(/text-overflow:\s*ellipsis/);
  });

  it.each(PROVIDERS)('%s shows a keyboard user where focus is', (cls) => {
    /**
     * These buttons drive hover through `onMouseOver`/`onMouseOut` handlers that
     * assign `style.backgroundColor`. A keyboard user fires neither, so the
     * first three controls on the first screen of the product gave no indication
     * of focus at all until this rule existed.
     */
    const rule = ruleFor(`.${cls}:focus-visible`);
    expect(rule, `no focus-visible rule for .${cls}`).toBeTruthy();
    expect(rule).toMatch(/outline:/);
  });

  it('applies the containment to every provider, not just the one that overflowed', () => {
    /**
     * The point of the whole fix. Fixing Microsoft alone would leave the same
     * bug waiting behind Apple, or behind any provider added later whose name is
     * long enough — the overflow is a property of the shared layout, not of one
     * brand.
     */
    for (const cls of PROVIDERS) {
      expect(ruleFor(`.${cls} > svg`), `${cls} was left out`).toBeTruthy();
      expect(ruleFor(`.${cls} > span`), `${cls} was left out`).toBeTruthy();
    }
  });
});
