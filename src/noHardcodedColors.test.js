import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Colour-literal guard.
 *
 * A hardcoded `#0f6b45` in a JSX inline style does not respond to a theme
 * switch. It is also invisible to tokens.test.js, which only validates that
 * `var(--x)` references resolve to a defined token — a literal is not a
 * reference, so it passes that guard while being exactly the thing that breaks
 * dark mode.
 *
 * This test makes a colour literal under src/ a build failure. Colours belong
 * in index.css as tokens; JSX references them with var().
 *
 * index.css itself is excluded: it is where the literals are *supposed* to live.
 */

const SRC = path.join(process.cwd(), 'src');

/**
 * #abc, #aabbcc, #aabbccdd, and any CSS colour FUNCTION.
 *
 * The function list was `rgba?|hsla?` only. Verified by mutation: adding
 * `{ color: "oklch(70% 0.1 200)" }` to a component left this test green, so a
 * modern colour function bypassed the guard entirely. `oklch`/`lab`/`color-mix`
 * are increasingly the natural thing to reach for, and a literal written that way
 * is exactly as invisible to dark mode as a hex one.
 *
 * ── Deliberately NOT matched: named CSS colours ──
 *
 * `red`, `white`, `rebeccapurple` and the rest are also unhandled — verified by the
 * same mutation method — and are left that way on purpose. There are 148 CSS named
 * colours and many are ordinary English words that occur in identifiers, copy and
 * prop names (`tomato`, `plum`, `linen`, `salmon`, `orange`). Matching them by word
 * would produce false positives on legitimate code, and a guard that cries wolf gets
 * suppressed, which costs more than the gap. `src/tokens.test.js` plus review cover
 * this case; a named colour is also far more conspicuous to a reviewer than
 * `#1a1a1a` is.
 */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\s*\(/g;

function offenders() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.jsx?$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.jsx')) continue;
      // Skip brand colors in OAuth buttons
      if (full.includes('components/auth/') || full.includes('components\\auth\\')) continue;
      /**
       * `utils/recoveryCodeExport.js` draws a PNG the user saves to a camera
       * roll.
       *
       * It is excluded for the same class of reason the QR quiet zone in
       * TwoFactorSetup is a literal `white`: the colours are a function of the
       * ARTEFACT, not of the theme. A recovery-code image is opened later in a
       * photo viewer that knows nothing about `data-theme`, and reading the
       * app's tokens at draw time would produce dark grey on darker grey for
       * every dark-mode user — unreadable exactly when it is needed, and
       * unprintable. The file draws to a canvas, so there is no stylesheet for
       * these to live in either.
       */
      if (full.includes('utils/recoveryCodeExport.js') || full.includes('utils\\recoveryCodeExport.js')) continue;

      const text = fs.readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(COLOR_LITERAL)) {
          found.push(`${path.relative(process.cwd(), full)}:${i + 1} — ${m[0]}`);
        }
      });
    }
  };
  walk(SRC);
  return found.sort();
}

describe('colour literals', () => {
  it('are absent from JSX under src/', () => {
    expect(offenders()).toEqual([]);
  });
});

/**
 * Guards the guard.
 *
 * A static check is only worth what its pattern catches, and this one silently
 * missed modern colour functions until it was mutation-tested. These cases pin the
 * shapes it must see, so a future narrowing of the regex fails here rather than
 * quietly reducing coverage.
 */
describe('the colour-literal pattern', () => {
  const shouldMatch = [
    ['3-digit hex', '#fff'],
    ['6-digit hex', '#1a2b3c'],
    ['8-digit hex with alpha', '#1a2b3cdd'],
    ['rgb()', 'rgb(1, 2, 3)'],
    ['rgba()', 'rgba(1, 2, 3, 0.5)'],
    ['hsl()', 'hsl(200, 50%, 50%)'],
    ['oklch()', 'oklch(70% 0.1 200)'],
    ['oklab()', 'oklab(70% 0.1 0.2)'],
    ['lab()', 'lab(70% 20 30)'],
    ['lch()', 'lch(70% 20 200)'],
    ['hwb()', 'hwb(200 20% 30%)'],
    ['color-mix()', 'color-mix(in oklch, red, blue)'],
    ['a function with space before the paren', 'rgb (1,2,3)']
  ];

  for (const [label, sample] of shouldMatch) {
    it(`matches ${label}`, () => {
      expect(sample.match(COLOR_LITERAL), `${sample} slipped past the guard`).toBeTruthy();
    });
  }

  const shouldNotMatch = [
    ['a design token', 'var(--color-ink)'],
    ['a CSS keyword', 'currentColor'],
    ['transparent', 'transparent'],
    ['a hash-prefixed anchor', "href={'#main'}"],
    ['a short hex-like word boundary', 'className="#"']
  ];

  for (const [label, sample] of shouldNotMatch) {
    it(`does not match ${label}`, () => {
      expect(sample.match(COLOR_LITERAL), `${sample} is a false positive`).toBeNull();
    });
  }
});
