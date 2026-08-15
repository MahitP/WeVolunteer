import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Only the document prints.
 *
 * ── The bug ──
 *
 * Printing a certificate printed the whole application. The print block hid the
 * navigation chrome BY NAME — `.sidebar`, `.mobilenav`, `.topbar`, `.demobar`,
 * `.toasts`, `.no-print` — and that list can never be complete, because a
 * certificate opens as a MODAL ON TOP OF A ROUTE. The dashboard behind it was
 * never in the list, so the dashboard printed and the certificate printed after
 * it.
 *
 * Enumerating what to hide is the wrong shape of solution: every page added to
 * the product is another thing that might end up behind a document. So the rule
 * is inverted — hide everything, then show the document — and these tests hold
 * that inversion in place.
 *
 * The stylesheet is parsed rather than the DOM measured: jsdom has no layout
 * engine and does not evaluate `@media print` at all, so a rendered assertion
 * would report nothing and pass whatever was written. Real print output was
 * checked in a browser against the live CSSOM.
 */

const CSS = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');

/** The single `@media print` block, brace-matched. */
function printBlock() {
  const start = CSS.indexOf('@media print {');
  expect(start, 'the print block has been renamed or removed').toBeGreaterThan(-1);

  let depth = 0;
  const from = CSS.indexOf('{', start);
  for (let i = from; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(from, i + 1);
    }
  }
  throw new Error('unbalanced braces in the print block');
}

const BLOCK = printBlock();
/* Comments quote the rules they replaced, so prose must not satisfy a check. */
const RULES = BLOCK.replace(/\/\*[\s\S]*?\*\//g, '');

describe('print isolation', () => {
  it('hides everything in the body by default', () => {
    expect(RULES).toMatch(/body\s+\*\s*\{[^}]*visibility:\s*hidden/);
  });

  it('shows the certificate and its descendants', () => {
    expect(RULES).toMatch(/\.certificate\s*,[\s\S]{0,80}\.certificate\s+\*/);
    const shown = RULES.match(/\.certificate\s*,[\s\S]*?\}/);
    expect(shown[0]).toMatch(/visibility:\s*visible/);
  });

  it('shows the transcript and its descendants', () => {
    expect(RULES).toMatch(/\.transcript\s*,?[\s\S]{0,80}\.transcript\s+\*/);
  });

  it('lifts the document out of flow, so hidden boxes reserve no paper', () => {
    /**
     * Not cosmetic. A `visibility: hidden` element still occupies its box, so
     * without this the printer is handed a dashboard's worth of blank paper and
     * only then the document.
     */
    expect(RULES).toMatch(/\.certificate\s*,\s*\n?\s*\.transcript\s*\{[^}]*position:\s*absolute/);
  });

  it('does not rely on a hand-maintained list of things to hide', () => {
    /**
     * The regression that matters. If somebody replaces the inversion with an
     * enumeration again, the next page added to the product prints behind the
     * certificate and nobody finds out until they print one.
     */
    const hidesEverything = /body\s+\*\s*\{[^}]*visibility:\s*hidden/.test(RULES);
    expect(hidesEverything, 'the blanket hide is what makes the chrome list unnecessary').toBe(true);
  });

  it('still forces black ink and white paper, so dark mode cannot print white on white', () => {
    expect(RULES).toMatch(/html\s*,\s*\n?\s*body\s*\{[^}]*background:\s*#fff/);
    expect(RULES).toMatch(/html\s*,\s*\n?\s*body\s*\{[^}]*color:\s*#000/);
  });

  it('drops viewport heights, which are a trailing blank sheet on paper', () => {
    expect(RULES).toMatch(/html\s*,\s*\n?\s*body\s*\{[^}]*min-height:\s*0/);
  });

  it('asks for the documents own colours to be printed', () => {
    /* Their rules and totals are structural, not decorative — a transcript
       printed without them is a list of numbers with no table. */
    expect(RULES).toMatch(/print-color-adjust:\s*exact/);
  });

  it('is still the only print block in the stylesheet', () => {
    /**
     * Two sets of print rules is how they start disagreeing, and the file says
     * so itself at the one place a second block was declined.
     *
     * Counted with comments stripped — that declining note contains the words
     * `@media print`, so a naive count finds two and fails on its own
     * gravestone.
     */
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations.match(/@media print/g)).toHaveLength(1);
  });
});
