import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The transcript's name sits ON the signature rule.
 *
 * ── The bug ──
 *
 * The signature block was three elements: the name, then a separate
 * `.transcript-sign-rule` div, then the caption. That div was `height: 2.25rem`
 * with its border along the BOTTOM edge — so 36px of empty box, plus the name's
 * own 8px bottom margin, stood between the name and the line it was supposed to
 * be signed on. Printed, it read as a name floating above an unrelated rule.
 *
 * The certificate never had this problem: `.certificate-sign` puts the border on
 * the box that HOLDS the name, with `min-height` to reserve room for a real
 * signature and `align-items: flex-end` so the text rests on the border however
 * tall the box grows.
 *
 * ── What these tests hold ──
 *
 * That the transcript keeps the certificate's geometry, and — just as important
 * — that the CERTIFICATE is not altered while doing it. The instruction was
 * explicit that certificates are already correct, and the cheapest wrong fix
 * would have been to move both.
 *
 * ── Why the stylesheet is read rather than the DOM measured ──
 *
 * jsdom has no layout engine, so every `getBoundingClientRect` is zero and a
 * rendered assertion about a 44px gap would measure nothing and pass whatever
 * was written. The rendered result was checked in a browser.
 */

const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8')
  /* Comments stripped first: these rules are documented in the vocabulary of the
     fix ("border", "min-height", "flex-end"), so an un-stripped search matches
     the prose and passes with the declarations deleted. */
  .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Comments stripped here too, and for a reason worth recording: the JSX now
 * carries a comment EXPLAINING that the old rule element was removed, and that
 * comment names the class. Matching the bare token therefore failed against
 * correct code — the test was reading its own explanation. Only the rendered
 * `className` counts.
 */
const JSX = fs.readFileSync(
  path.join(process.cwd(), 'src/views/VolunteerPortfolio.jsx'), 'utf8',
).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of the first rule whose selector list contains `selector`. */
function ruleFor(selector) {
  const at = CSS.indexOf(selector);
  if (at === -1) return null;
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return open === -1 || close === -1 ? null : CSS.slice(open + 1, close);
}

describe('the transcript signature line', () => {
  it('draws the rule on the element that holds the name', () => {
    /* The fix in one assertion. If the border moves back onto a sibling, the
       name is once again separated from the line by that sibling's height. */
    const rule = ruleFor('.transcript-signatory');
    expect(rule, 'no .transcript-signatory rule').toBeTruthy();
    expect(rule).toMatch(/border-bottom:\s*1px solid/);
  });

  it('rests the name on that rule instead of centring it in the box', () => {
    /**
     * `min-height` without `align-items: flex-end` reintroduces the gap in a
     * subtler form: the reserved signature space would be split above and below
     * the text, lifting the name off the line again.
     */
    const rule = ruleFor('.transcript-signatory');
    expect(rule).toMatch(/align-items:\s*flex-end/);
    expect(rule).toMatch(/min-height:/);
  });

  it('keeps the name centred, which a flex container does not inherit', () => {
    /* `.transcript-sign` sets `text-align: center`. Making the name a flex
       container discards that, so without this the signature goes hard left. */
    expect(ruleFor('.transcript-signatory')).toMatch(/justify-content:\s*center/);
  });

  it('no longer carries a bottom margin pushing the name off its own rule', () => {
    const rule = ruleFor('.transcript-signatory');
    expect(rule, 'a bottom margin here separates the name from its border')
      .not.toMatch(/margin:\s*0\s+0\s+var\(--s2\)/);
  });

  it('has removed the separate rule element entirely, markup and style', () => {
    /**
     * Both halves. Leaving the div would draw a second line under the caption;
     * leaving the CSS would be dead weight that the next reader takes for a
     * live rule and tries to adjust.
     */
    expect(JSX, 'the standalone rule div is still rendered')
      .not.toMatch(/className=["'][^"']*transcript-sign-rule/);
    expect(ruleFor('.transcript-sign-rule'), 'orphaned .transcript-sign-rule CSS remains')
      .toBeNull();
  });

  it('separates the caption from the rule it sits under', () => {
    /* The gap used to come from the removed element's `margin-bottom`. Scoped
       to the signature block, because the other `.transcript-label`s caption
       figures rather than signatures and keep `margin: 0`. */
    expect(ruleFor('.transcript-sign .transcript-label')).toMatch(/margin-top:/);
  });

  it('leaves the certificate signature exactly as it was', () => {
    /**
     * The explicit instruction: certificates are already right. A change that
     * "fixed" both documents would have broken the one that was working, and
     * this is the assertion that would have caught it.
     */
    const cert = ruleFor('.certificate-sign');
    expect(cert, 'no .certificate-sign rule').toBeTruthy();
    expect(cert).toMatch(/border-bottom:\s*1px solid #a8a29e/);
    expect(cert).toMatch(/min-height:\s*2\.4em/);
    expect(cert).toMatch(/align-items:\s*flex-end/);
    expect(cert).toMatch(/padding-bottom:\s*var\(--s2\)/);
  });

  it('still prints the transcript on paper rather than on white', () => {
    /**
     * Guarded here because this fix touched the transcript's own styling, and
     * the earlier defect was that the transcript printed with a white
     * background while the certificate printed correctly.
     */
    const printAt = CSS.indexOf('@media print');
    expect(printAt).toBeGreaterThan(-1);
    const printBlock = CSS.slice(printAt, printAt + 4000);
    expect(printBlock).toMatch(/\.transcript\b/);
    expect(printBlock).toMatch(/--cert-bg|background/);
  });
});
