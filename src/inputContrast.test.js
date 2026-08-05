import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * WCAG 2.1 AA §1.4.11 guard for form-field boundaries.
 *
 * ── The failure this exists to prevent ──
 *
 * `--input-border` used to alias `--rule-strong`, which is tuned for
 * decorative separators between text blocks. On a form field that produced
 * 1.74:1 against `--surface` in light mode and roughly 1.15:1 in dark — well
 * under the 3:1 that §1.4.11 requires for the visual boundary of a UI
 * component. Every form in the product was affected, including the three that
 * matter most on the legal surface: the certificate-verify code field, the
 * DELETE confirmation input, and the step-up password prompt.
 *
 * A low-vision user could not reliably see where the input was. That is not a
 * cosmetic defect; the boundary IS the affordance.
 *
 * ── Why this is computed rather than asserted ──
 *
 * The obvious test is `expect(inputBorder).toBe('#828b99')`. That is worthless:
 * it pins a string, not a property, so it passes for any value somebody swaps
 * in and fails for an equivalent one written differently. It also cannot catch
 * the real regression, which is not "the token changed" but "the token changed
 * AND the background moved with it".
 *
 * So this parses the actual values out of index.css, composites the
 * translucent dark-mode ones over their real backdrop, and recomputes the
 * ratio. Change either the border or the surface it sits on and the arithmetic
 * follows.
 *
 * ── Which backdrop is binding ──
 *
 * Light: an input renders on `--surface` (#fbfcfd) inside a card and on
 * `--bg-primary` (#f1f3f6) on the page. The lighter of the two is the harder
 * target, so both are checked and both must pass.
 *
 * Dark: `--input-bg` is itself translucent — rgba(255,255,255,0.03) — so the
 * comparison is border-over-input-bg-over-surface. Compositing twice is the
 * only way to get the number the user actually sees.
 */

const CSS = path.join(process.cwd(), 'src', 'index.css');

/* ── Colour maths (WCAG 2.x relative luminance) ─────────────────────────── */

function parseHex(h) {
  let s = h.replace('#', '').trim();
  if (s.length === 3) s = [...s].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}

/** `rgba(r, g, b, a)` -> `{ rgb, alpha }`. Opaque hex -> alpha 1. */
function parseColor(value) {
  const v = value.trim();
  const m = v.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/);
  if (m) {
    return { rgb: [+m[1], +m[2], +m[3]].map(Math.round), alpha: m[4] === undefined ? 1 : +m[4] };
  }
  if (v.startsWith('#')) return { rgb: parseHex(v), alpha: 1 };
  throw new Error(`Cannot parse colour: ${value}`);
}

/** Source-over composite of a translucent colour onto an opaque backdrop. */
function composite(fg, backdrop) {
  return fg.rgb.map((c, i) => Math.round(c * fg.alpha + backdrop[i] * (1 - fg.alpha)));
}

function luminance(rgb) {
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* ── Reading the tokens back out of index.css ───────────────────────────── */

const css = fs.readFileSync(CSS, 'utf8');

/** The `:root` block, and the `[data-theme='dark']` block, separately. */
function themeBlocks() {
  const rootStart = css.indexOf(':root {');
  const rootEnd = css.indexOf('\n}', rootStart);
  const darkStart = css.indexOf("[data-theme='dark'] {");
  const darkEnd = css.indexOf('\n}', darkStart);
  expect(rootStart, ':root block not found in index.css').toBeGreaterThan(-1);
  expect(darkStart, "[data-theme='dark'] block not found in index.css").toBeGreaterThan(-1);
  return {
    light: css.slice(rootStart, rootEnd),
    dark: css.slice(darkStart, darkEnd),
  };
}

const BLOCKS = themeBlocks();

/**
 * Resolves a token to a literal colour within one theme block, following
 * `var(--other)` indirection and falling back to `:root` the way the cascade
 * does for a token the dark block does not override.
 */
function resolve(token, theme, seen = new Set()) {
  expect(seen.has(token), `circular token reference at ${token}`).toBe(false);
  seen.add(token);

  const find = (block) => {
    const m = block.match(new RegExp(`(?:^|\\n)\\s*${token}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };

  let value = theme === 'dark' ? find(BLOCKS.dark) ?? find(BLOCKS.light) : find(BLOCKS.light);
  expect(value, `${token} is not defined for theme "${theme}"`).toBeTruthy();

  const varRef = value.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/);
  if (varRef) return resolve(varRef[1], theme, seen);
  return value;
}

/** Resolve to an opaque rgb triple, compositing over `backdrop` if translucent. */
function opaque(token, theme, backdrop) {
  const parsed = parseColor(resolve(token, theme));
  return parsed.alpha === 1 ? parsed.rgb : composite(parsed, backdrop);
}

const MIN_UI_CONTRAST = 3.0;

describe('WCAG 1.4.11 — form field boundaries', () => {
  it('light mode: --input-border clears 3:1 on --surface', () => {
    const surface = opaque('--surface', 'light', [255, 255, 255]);
    const border = opaque('--input-border', 'light', surface);
    const ratio = contrast(border, surface);
    expect(
      ratio,
      `--input-border on --surface is ${ratio.toFixed(2)}:1, below the 3:1 required for a UI `
        + 'component boundary. A form field border is what tells a low-vision user where the '
        + 'input is. Darken --input-border; do NOT darken --rule-strong, whose other consumers '
        + 'are decorative separators that are correctly subtle.'
    ).toBeGreaterThanOrEqual(MIN_UI_CONTRAST);
  });

  it('light mode: --input-border clears 3:1 on the page background', () => {
    const page = opaque('--bg-primary', 'light', [255, 255, 255]);
    const border = opaque('--input-border', 'light', page);
    const ratio = contrast(border, page);
    expect(
      ratio,
      `--input-border on --bg-primary is ${ratio.toFixed(2)}:1, below 3:1. Inputs render `
        + 'directly on the page as well as inside cards, so both backdrops are binding.'
    ).toBeGreaterThanOrEqual(MIN_UI_CONTRAST);
  });

  it('dark mode: --input-border clears 3:1 over the composited input background', () => {
    // --input-bg is itself translucent in dark mode, so the border is compared
    // against input-bg-over-surface, not against --surface directly.
    const surface = opaque('--surface', 'dark', [0, 0, 0]);
    const inputBg = opaque('--input-bg', 'dark', surface);
    const border = opaque('--input-border', 'dark', inputBg);
    const ratio = contrast(border, inputBg);
    expect(
      ratio,
      `--input-border over --input-bg is ${ratio.toFixed(2)}:1 in dark mode, below 3:1. `
        + 'Note --input-bg is translucent, so the border must be measured against it '
        + 'composited on --surface — not against --surface alone.'
    ).toBeGreaterThanOrEqual(MIN_UI_CONTRAST);
  });

  it('the hover border is at least as visible as the resting one', () => {
    // A hover state that drops below its own resting contrast is a regression
    // nobody notices, because hover is not where accessibility is audited.
    for (const theme of ['light', 'dark']) {
      const surface = opaque('--surface', theme, theme === 'dark' ? [0, 0, 0] : [255, 255, 255]);
      const inputBg = opaque('--input-bg', theme, surface);
      const rest = contrast(opaque('--input-border', theme, inputBg), inputBg);
      const hover = contrast(opaque('--input-border-hover', theme, inputBg), inputBg);
      expect(
        hover,
        `${theme}: --input-border-hover (${hover.toFixed(2)}:1) is less visible than `
          + `--input-border (${rest.toFixed(2)}:1)`
      ).toBeGreaterThanOrEqual(rest - 0.01);
    }
  });

  it('--rule-strong is left alone — decorative separators keep their subtlety', () => {
    // Guards the *reason* for the fix, not just the fix. If someone later
    // "simplifies" --input-border back to var(--rule-strong), the three tests
    // above fail. If instead they darken --rule-strong to make those pass,
    // this one fails and says why that is the wrong lever.
    const light = resolve('--input-border', 'light');
    expect(
      light.includes('var(--rule-strong)'),
      '--input-border must not alias --rule-strong: that alias is exactly what caused the '
        + '1.74:1 failure. Keep them separate.'
    ).toBe(false);
  });
});
