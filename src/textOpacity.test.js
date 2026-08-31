import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Text is de-emphasised with a colour, not with `opacity`.
 *
 * ── The failure this exists to prevent, five times over ──
 *
 * Every real contrast defect the browser audit found on this platform had the
 * same cause: `opacity` used to make text look secondary, on top of a colour
 * token that had already made it secondary. Measured, with the fix in each case
 * being the removal of the opacity rather than a change of palette:
 *
 *   - `.welly-composer-footer` at 0.7 → 2.65:1. The worst contrast in the
 *     application, on the line telling somebody Welly makes mistakes and not to
 *     type personal information into it.
 *   - `.weather-summary.loading` at 0.7 → 2.38:1, on "Checking the forecast".
 *   - `.hourspill span` at 0.8 → 3.65:1, on the organizer's volunteer list.
 *   - `--ink-inv-3` at 0.7 alpha → 4.10:1 on the brand panel (now 0.8).
 *   - `.nextshift-detail` at 0.78 → dragged a nested badge to 3.66:1 even though
 *     that badge's own text was opaque white chosen for that surface.
 *
 * ── Why the last one is the important one ──
 *
 * Opacity on a CONTAINER dims every descendant and cannot be overridden by one.
 * Three separate attempts to fix that badge by changing its own colours moved
 * the number without ever reaching 4.5:1, because the cause was two levels up
 * and invisible from the element that failed. A colour does not have that
 * problem: a child that sets its own colour keeps it.
 *
 * So the rule is: the selectors below carry no `opacity`. They are the ones that
 * regressed, and each is a place where somebody reaching for a fade would
 * reintroduce a measured failure. The browser sweep is the general net; this is
 * the specific memory, and it runs in milliseconds without a browser.
 */
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
const LOCATION_CSS = fs.readFileSync(
  path.join(process.cwd(), 'src/components/location/LocationDisplay.css'), 'utf8'
);

/** The declaration block for a selector, as written, comments stripped. */
function ruleFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[2] : null;
}

/** Selectors proven to fail a contrast requirement when faded. */
const MUST_NOT_FADE = [
  ['src/index.css', CSS, '.welly-composer-footer'],
  ['src/index.css', CSS, '.hourspill span'],
  ['src/index.css', CSS, '.nextshift-detail'],
  ['LocationDisplay.css', LOCATION_CSS, '.weather-summary.loading']
];

describe('text de-emphasis', () => {
  it('read both stylesheets at all', () => {
    /* Guards the guard: an empty read makes every assertion below vacuous. */
    expect(CSS.length).toBeGreaterThan(100000);
    expect(LOCATION_CSS.length).toBeGreaterThan(1000);
  });

  for (const [file, css, selector] of MUST_NOT_FADE) {
    it(`${selector} (${file}) has a rule at all`, () => {
      /* A renamed class would make the opacity assertion below pass against
         null, which is the vacuous-pass this repo's guards are written against. */
      expect(ruleFor(css, selector), `${selector} is no longer declared`).toBeTruthy();
    });

    it(`${selector} does not fade its text`, () => {
      const body = ruleFor(css, selector) || '';
      expect(
        body,
        `${selector} declares opacity again. It measured a contrast failure with `
        + 'one before. Use a muted colour token instead — it inherits, so a '
        + 'descendant can override it, and it does not drag nested content down.'
      ).not.toMatch(/(^|[;\s])opacity\s*:/);
    });
  }

  it('the inverted muted token stays readable on the brand panel', () => {
    /* rgba(255,255,255,0.7) over --brand-panel-bg (#0f6b45) is 4.10:1 and fails;
       0.8 is 4.81:1. Asserted as a floor on the alpha rather than an exact
       string, so a deliberate move to 0.85 or an opaque value still passes. */
    const declarations = [...CSS.matchAll(/--ink-inv-3:\s*rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/g)]
      .map(m => Number(m[1]));
    expect(declarations.length, 'no --ink-inv-3 rgba declaration found').toBeGreaterThan(0);
    for (const alpha of declarations) {
      expect(alpha, '--ink-inv-3 below 0.8 alpha measures under 4.5:1 on the brand panel')
        .toBeGreaterThanOrEqual(0.8);
    }
  });
});
