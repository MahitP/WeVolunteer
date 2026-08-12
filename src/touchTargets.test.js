import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * WCAG 2.1 §2.5.5 guard for the controls where a small target hurts most.
 *
 * ── The failure this exists to prevent ──
 *
 * `.modal-close` was `padding: 0.375rem` around an 18px icon, which measures
 * about 30x37px in a real browser. It is the dismiss control on every dialog in
 * the application — the one thing somebody reaches for when they want OUT — and
 * it was the smallest target on the screen. A close button that needs a second
 * attempt is the worst one to get wrong: the first miss usually lands on the
 * overlay, and on a dialog that does not close on overlay click, nothing
 * happens at all.
 *
 * This stylesheet already enforces a 44px floor for coarse pointers, in the
 * `@media (hover: none) and (pointer: coarse)` block. That block never named
 * `.modal-close`, so the rule existed and this control was outside it.
 *
 * ── Why the CSS is parsed rather than the DOM measured ──
 *
 * jsdom has no layout engine: every `getBoundingClientRect()` is zero, so a
 * rendered assertion would be vacuous in exactly the way that looks convincing.
 * Parsing the declared rule is the honest thing this environment can check, and
 * it catches the regression that actually happens — somebody tuning the padding
 * back down.
 *
 * Real geometry is verified in browser QA instead, where a viewport exists.
 */

const CSS = fs.readFileSync(
  path.join(process.cwd(), 'src/index.css'),
  'utf8',
);

/** The declaration block for a selector, as written. */
function ruleFor(selector) {
  /* Anchored on a line start so `.modal-close` does not also match
     `.modal-close:hover`, and non-greedy so it stops at the first brace. */
  const pattern = new RegExp(`(^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`);
  const match = CSS.match(pattern);
  return match ? match[2] : null;
}

/** A length declaration in px or rem, normalised to px. 16px root. */
function pxOf(body, property) {
  const match = body?.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)(px|rem)`));
  if (!match) return null;
  return match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1]);
}

const MINIMUM = 44;

describe('touch targets', () => {
  describe('.modal-close — the dismiss control on every dialog', () => {
    const body = ruleFor('.modal-close');

    it('has a rule at all', () => {
      /* Guards the guard: a renamed class would otherwise make every
         assertion below pass against null. */
      expect(body, '.modal-close is no longer declared in index.css').toBeTruthy();
    });

    it('declares a hit area of at least 44px in both directions', () => {
      expect(pxOf(body, 'min-width'), 'min-width').toBeGreaterThanOrEqual(MINIMUM);
      expect(pxOf(body, 'min-height'), 'min-height').toBeGreaterThanOrEqual(MINIMUM);
    });

    it('centres its icon, so the target is the button and not the glyph', () => {
      /* Without this the icon sits top-left in a 44px box and the visible
         affordance stops agreeing with the clickable one. */
      expect(body).toMatch(/align-items\s*:\s*center/);
      expect(body).toMatch(/justify-content\s*:\s*center/);
    });

    it('keeps a visible focus ring', () => {
      const focus = ruleFor('.modal-close:focus-visible');
      expect(focus, '.modal-close:focus-visible has no rule').toBeTruthy();
      expect(focus).toMatch(/outline/);
    });
  });

  it('states the 44px floor for coarse pointers somewhere', () => {
    /* The pre-existing rule this control should always have been inside.
       Asserted so the floor cannot be deleted while individual controls keep
       claiming to honour it. */
    expect(CSS).toMatch(/@media \(hover: none\) and \(pointer: coarse\)/);
  });
});
