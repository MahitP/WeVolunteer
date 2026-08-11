import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The notifications popover's geometry has ONE owner.
 *
 * ── The defect this pins ──
 *
 * `.notifications-popover` declares a responsive width —
 * `min(380px, calc(100vw - 2rem))` — and the `max-width: 700px` query re-anchors
 * the panel to `left`/`right` insets with `width: auto`. Both correct. Then a
 * later block, `.premium-popover` (the "Premium Notifications Center" visual
 * treatment), re-declared `width: 380px` and `max-height: 85vh`.
 *
 * All three selectors are a single class, so they carry equal specificity, and a
 * media query adds none — so the last declaration in the file wins. The element
 * carries all three classes at once (`popover notifications-popover
 * premium-popover`, NotificationsBell.jsx), which made the computed width a flat
 * 380px at every viewport.
 *
 * Measured in a real browser at a 320px viewport: the document's scrollWidth was
 * 396px against a clientWidth of 320 — **76px of horizontal overflow, with the
 * close and mark-all-read controls in the clipped region** — and the page became
 * horizontally scrollable. After removing the two declarations: scrollWidth 320,
 * popover 288px, no overflow. Re-injecting the old rule in the live page
 * reproduced the 396px exactly, which is how the cause was confirmed rather than
 * guessed.
 *
 * ── Why a source assertion and not a rendered one ──
 *
 * jsdom performs no layout, so the client suite cannot observe a computed width or
 * a scrollWidth; a test that appeared to check this in jsdom would pass whatever
 * the CSS said. What can be checked, and is what actually broke, is the invariant:
 * the visual-treatment class must not declare geometry, because the positioning
 * class already does and the cascade favours whichever comes last. That is a
 * property of the stylesheet, so the stylesheet is what is asserted.
 */
describe('the notifications popover has one owner for its geometry', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');

  /** The declarations inside a single top-level rule, by exact selector. */
  const ruleBody = (selector) => {
    const results = [];
    const needle = `\n${selector} {`;
    let from = 0;
    for (;;) {
      const start = css.indexOf(needle, from);
      if (start === -1) break;
      const open = css.indexOf('{', start);
      const close = css.indexOf('}', open);
      results.push(css.slice(open + 1, close));
      from = close;
    }
    return results;
  };

  it('declares the responsive width on the positioning class', () => {
    const bodies = ruleBody('.notifications-popover');
    expect(bodies.length, '.notifications-popover rule not found').toBeGreaterThan(0);
    expect(bodies.some(b => /width:\s*min\(380px,\s*calc\(100vw/.test(b))).toBe(true);
  });

  /**
   * Bodies of EVERY at-rule with this header, brace-matched.
   *
   * Plural because the stylesheet has several `@media (max-width: 700px)` blocks
   * and the popover override is not in the first one — a second draft of this test
   * matched only the first and reported the rule missing.
   */
  const atRuleBodies = (header) => {
    const out = [];
    let from = 0;
    for (;;) {
      const start = css.indexOf(header, from);
      if (start === -1) return out;
      const open = css.indexOf('{', start);
      let depth = 0;
      for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') {
          depth--;
          if (depth === 0) { out.push(css.slice(open + 1, i)); from = i; break; }
        }
      }
      if (from <= start) return out;
    }
  };

  it('re-anchors to insets with width:auto on narrow viewports', () => {
    /* The override lives inside `@media (max-width: 700px)`. Brace-depth matching,
       not a delimiter guess: the first draft sliced at the first `\n}\n\n` and cut
       the query off at its first nested rule. */
    const blocks = atRuleBodies('@media (max-width: 700px)');
    expect(blocks.length, 'no 700px media query found').toBeGreaterThan(0);
    expect(
      blocks.some(b => /\.notifications-popover\s*\{[^}]*width:\s*auto/.test(b)),
      'no max-width:700px block re-anchors .notifications-popover with width:auto'
    ).toBe(true);
  });

  /** The regression itself. */
  it('does NOT declare width or max-height on the visual-treatment class', () => {
    const bodies = ruleBody('.premium-popover');
    expect(bodies.length, '.premium-popover rule not found').toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, '.premium-popover must not set width — geometry belongs to .notifications-popover, and this block comes later in the file so it would win at every viewport')
        .not.toMatch(/(^|[^-\w])width\s*:/);
      expect(body, '.premium-popover must not set max-height — it would override the mobile calc(100vh - 78px)')
        .not.toMatch(/max-height\s*:/);
    }
  });

  /**
   * The ordering fact that makes the above matter, asserted so the reason cannot
   * quietly stop being true — if `.premium-popover` were ever moved ABOVE the
   * positioning rules, a width there would be harmless and this guard's rationale
   * would be stale.
   */
  it('the visual-treatment class still comes after the positioning rules', () => {
    expect(css.indexOf('\n.premium-popover {')).toBeGreaterThan(css.indexOf('\n.notifications-popover {'));
    expect(css.indexOf('\n.premium-popover {')).toBeGreaterThan(css.indexOf('@media (max-width: 700px)'));
  });
});
