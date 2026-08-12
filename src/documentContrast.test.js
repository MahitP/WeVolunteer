import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * WCAG 2.1 AA §1.4.3 guard for the two printed documents.
 *
 * ── The failure this exists to prevent ──
 *
 * `.certificate-name` — the volunteer's own name, the most important word on a
 * certificate — was `var(--brand-ink)`. That token IS redefined for dark mode,
 * to a pale mint tuned for dark surfaces. `--cert-bg` deliberately is NOT, so
 * that a document reads as printed paper whatever theme surrounds it.
 *
 * The two decisions were individually right and together produced pale mint on
 * cream at **1.54:1**, against a 4.5:1 requirement, on the artefact somebody
 * hands to a college. It shipped because nobody opens a certificate in dark
 * mode while checking contrast in light.
 *
 * ── Why the whole document palette is checked, not just that one rule ──
 *
 * The bug was not a bad colour. It was a document reaching into the app's
 * theme-dependent ramp for one value. So this asserts the general property:
 * every colour these documents use resolves from a token that is never
 * redefined for dark mode, and every one of them clears 4.5:1 on the paper.
 */

const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');

/** CSS with comments stripped, so prose about a token is not read as a use of it. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * How many times a token is DECLARED.
 *
 * Counting declarations is more robust than slicing the dark block and looking
 * inside it: it does not care where a redefinition lives, only that there is
 * more than one. A document token declared twice is a document token with a
 * theme, which is the whole bug.
 */
function declarationCount(name) {
  return (CODE.match(new RegExp(`\\n\\s*${name}\\s*:`, 'g')) || []).length;
}

/** A token's value from `:root`. Hex only — these are all literals by design. */
function tokenValue(name) {
  const match = CSS.match(new RegExp(`\\n\\s*${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  return match ? match[1] : null;
}

function rgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

function luminance(hex) {
  return rgb(hex)
    .map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* Every ink these documents put on their paper, and the ratio each must clear.
   3:1 is the large-text allowance; the figures and headings using it are well
   over 24px. */
const INKS = [
  ['--cert-text', 4.5],
  ['--cert-accent', 4.5],
  ['--certificate-ink-2', 4.5],
  ['--certificate-ink-3', 3],
];

describe('printed document contrast', () => {
  const paper = tokenValue('--cert-bg');

  it('has a paper colour to measure against', () => {
    expect(paper, '--cert-bg is not a literal any more').toMatch(/^#/);
  });

  describe.each(INKS)('%s on document paper', (token, required) => {
    it(`is defined as a literal`, () => {
      expect(tokenValue(token), `${token} is missing from :root`).toMatch(/^#/);
    });

    it(`clears ${required}:1`, () => {
      const ratio = contrast(tokenValue(token), paper);
      expect(
        Number(ratio.toFixed(2)),
        `${token} on --cert-bg is ${ratio.toFixed(2)}:1, below ${required}:1`,
      ).toBeGreaterThanOrEqual(required);
    });

    it('is declared exactly once, so it cannot acquire a theme', () => {
      /**
       * The actual bug. A document token that gets a second, dark-mode value is
       * one that will be rendered on light paper in a dark session — which is
       * exactly how a 1.54:1 name reached production.
       */
      expect(
        declarationCount(token),
        `${token} is declared more than once, so it has a theme while document paper does not`,
      ).toBe(1);
    });
  });

  it('does not let either document use a theme-dependent ink for its name', () => {
    /* `--brand-ink` IS dark-overridden. The two name rules are the ones that
       used it; if either goes back, the ratio goes back to 1.54:1. */
    for (const selector of ['.certificate-name', '.transcript-name']) {
      const rule = CODE.match(new RegExp(`\\n${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
      expect(rule, `${selector} has no rule`).toBeTruthy();
      expect(
        rule[1].includes('--brand-ink'),
        `${selector} uses --brand-ink, which is redefined for dark mode while document paper is not`,
      ).toBe(false);
    }
  });
});
