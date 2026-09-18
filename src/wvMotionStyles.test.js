import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Reduced motion covers the whole brand-motion stylesheet.
 *
 * `errorStyles.test.js` exists because `index.css` states a house rule — "every
 * animated selector below appears in the `prefers-reduced-motion` block" — that
 * nothing enforced. `wvMotion.css` is the app's only other animated stylesheet,
 * it lives outside `index.css`, and `noDanglingClasses`/`errorStyles` both read
 * `index.css` alone. Without this file the brand motion would be the one
 * animated surface in the product covered by no guard at all.
 *
 * It checks both triggers, because the app has both and they fail differently:
 *
 *   `@media (prefers-reduced-motion: reduce)`   the operating system
 *   `:root[data-motion='reduce']`               the reader's own setting
 *
 * The attribute matters more than it looks. `index.css` already crushes every
 * animation to 0.001ms under that attribute, which is not the same as holding a
 * behaviour complete: the signature's final keyframe is zero-length and
 * transparent, so an instantly-finished loop would rest on *nothing* and the
 * logo would vanish for exactly the reader who asked for less motion.
 */

const SRC = path.join(process.cwd(), 'src');
const CSS_RAW = readFileSync(path.join(SRC, 'components/common/wvMotion.css'), 'utf8');

/** Comments carry example CSS; they are not rules. */
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/** A declaration that starts an animation — not `animation: none`, and not
 *  `animation-timing-function`, which is how the keyframes carry their easing. */
const DECLARES_ANIMATION = /(^|[;\s])animation(-name)?\s*:\s*(?!none)/;

/** Text of a balanced at-rule block, from its header. */
function blocksOf(css, header) {
  const out = [];
  for (let i = css.indexOf(header); i !== -1; i = css.indexOf(header, i + 1)) {
    let depth = 0;
    let end = css.indexOf('{', i);
    for (let j = end; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { end = j; break; }
    }
    out.push(css.slice(i, end + 1));
  }
  return out;
}

/** Every `@keyframes` body, which declares no rules of its own. */
const keyframeBlocks = blocksOf(CSS, '@keyframes');
const reducedMotionBlocks = blocksOf(CSS, '@media (prefers-reduced-motion: reduce)');

/** The stylesheet with the keyframes and the OS block removed: what is left is
 *  the application rules plus the attribute mirror. */
let REST = CSS;
for (const block of [...keyframeBlocks, ...reducedMotionBlocks]) REST = REST.replace(block, '');

/** Rules as [selector, body]. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    out.push([selector, m[2]]);
  }
  return out;
}

const attributeMirror = rules(REST)
  .filter(([selector]) => selector.includes("[data-motion='reduce']"));

/** Animated brand selectors: the application rules, excluding the mirror. */
const animated = rules(REST)
  .filter(([selector, body]) =>
    !selector.includes("[data-motion='reduce']")
    && DECLARES_ANIMATION.test(body))
  .flatMap(([selector]) => selector.split(',').map((s) => s.trim()));

describe('every animated brand selector is disabled for reduced motion', () => {
  it('finds the animated selectors at all, so this cannot pass vacuously', () => {
    expect(animated.length, 'no animated .wv-* selectors found — parser broken?')
      .toBeGreaterThanOrEqual(12);
    expect(reducedMotionBlocks.length, 'no prefers-reduced-motion block').toBe(1);
    expect(attributeMirror.length, "no :root[data-motion='reduce'] mirror").toBeGreaterThan(0);
  });

  it('animates only `.wv-` classes, so nothing else is swept up', () => {
    for (const selector of animated) expect(selector).toMatch(/\.wv-/);
  });

  it.each(animated.map((s) => [s]))('%s stops for the OS preference', (selector) => {
    const covering = reducedMotionBlocks.find((b) => b.includes(selector));
    expect(
      covering,
      `${selector} keeps animating for a reader whose system asked it not to`,
    ).toBeTruthy();
    expect(covering).toContain('animation: none');
  });

  it.each(animated.map((s) => [s]))("%s stops for the reader's own setting", (selector) => {
    const covering = attributeMirror.find(([sel, body]) =>
      sel.includes(selector) && /animation\s*:\s*none/.test(body));
    expect(
      covering,
      `${selector} keeps animating for a reader who set "reduce motion" in Settings`,
    ).toBeTruthy();
  });
});

describe('the frozen inventory is intact', () => {
  /* The motion system is frozen: three curves, seven durations, and the
     behaviours below. A new curve or duration is a design change, and this is
     where an accidental one is caught. */
  it('declares exactly three easing curves', () => {
    const curves = [...CSS.matchAll(/--wv-(fall|climb|settle):\s*(cubic-bezier\([^)]*\))/g)];
    expect(curves.map((m) => m[1]).sort()).toEqual(['climb', 'fall', 'settle']);
    const allCubics = new Set([...CSS.matchAll(/cubic-bezier\([^)]*\)/g)].map((m) => m[0]));
    expect(allCubics.size, 'a fourth easing curve appeared').toBe(3);
  });

  it('declares exactly the seven named durations', () => {
    const durations = [...CSS.matchAll(/--wv-(signature|lockup|return|loader|micro|success|idle):\s*(\d+)ms/g)]
      .map((m) => [m[1], Number(m[2])]);
    expect(Object.fromEntries(durations)).toEqual({
      signature: 3600, lockup: 4000, return: 1800, loader: 2200, micro: 560, success: 900, idle: 9000,
    });
  });

  it('keeps the frozen keyframe set, and adds none', () => {
    const names = keyframeBlocks
      .map((b) => b.match(/@keyframes\s+([\w-]+)/)[1])
      .sort();
    expect(new Set(names)).toEqual(new Set([
      'wv-hero', 'wv-pull', 'wv-travel',
      'wv-tick', 'wv-fill', 'wv-tickpull',
      'wv-lock-line', 'wv-lock-pull', 'wv-lock-wipe', 'wv-lock-word',
      'wv-ret-wipe', 'wv-ret-word', 'wv-ret-line',
      'wv-rm-in', 'wv-rm-breathe',
    ]));
  });

  it('keeps the 80ms touchdown on every timeline that starts at zero length', () => {
    /* 2.200% of 3600, 2.000% of 4000, 4.444% of 1800, 14.340% of the 558ms tick. */
    for (const stop of ['2.200%', '2.000%', '95.556%', '14.340%']) {
      expect(CSS, `the touchdown stop ${stop} is gone`).toContain(stop);
    }
  });

  it('keeps the pull at 1.7 units along the overreach axis', () => {
    expect(CSS).toContain('--wv-pull-x:  0.423px');
    expect(CSS).toContain('--wv-pull-y: -1.647px');
  });
});
