import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Reduced motion covers the whole "Interface motion" section of `index.css`.
 *
 * The same guard `wvMotionStyles.test.js` is for the brand's stylesheet and
 * `errorStyles.test.js` for the error pages. It checks both triggers, because
 * the app has both and a reader can hold either without the other:
 *
 *   `@media (prefers-reduced-motion: reduce)`   the operating system
 *   `:root[data-motion='reduce']`               the reader's own setting
 *
 * The blanket rules elsewhere in `index.css` already shorten every animation
 * under both, so a missing entry here rarely shows. That is exactly why it is
 * enforced: a rule that only holds because a different rule happens to cover
 * it stops holding the day that rule is narrowed, and nobody is looking then.
 */

const RAW = readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
const START = RAW.indexOf('   Interface motion\n');

/** The section, which runs from its header to the end of the file. */
const SECTION = RAW.slice(RAW.lastIndexOf('/*', START)).replace(/\/\*[\s\S]*?\*\//g, '');

/** Text of each balanced block that starts with `header`. */
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

/** Rules as [selectors[], body]. At-rule headers are skipped. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    out.push([selector.split(',').map(s => s.trim().replace(/\s+/g, ' ')), m[2]]);
  }
  return out;
}

const keyframes = blocksOf(SECTION, '@keyframes');
const osBlocks = blocksOf(SECTION, '@media (prefers-reduced-motion: reduce)');
let rest = SECTION;
for (const block of [...keyframes, ...osBlocks]) rest = rest.replace(block, '');

/** Something that moves or changes over time. `animation: none`, the play
 *  state and a `transition: none` are not. */
const MOVES = /(^|[;\s])(animation(-name)?|transition(-property)?)\s*:\s*(?!\s|none)/;
const ATTR = ":root[data-motion='reduce']";

/** Rules outside `@supports`/`@media` wrappers and inside them, alike. */
const appRules = rules(rest).filter(([sels]) => !sels.some(s => s.includes(ATTR)));
const attrRules = rules(rest).filter(([sels]) => sels.some(s => s.includes(ATTR)));
const osRules = osBlocks.flatMap(b => rules(b.slice(b.indexOf('{') + 1)));

const animated = [...new Set(
  appRules.filter(([, body]) => MOVES.test(body)).flatMap(([sels]) => sels)
)];

/** The reduced rule for a selector must take the movement away. */
const STOPS = /(animation|transition)\s*:\s*none|animation-name\s*:\s*none/;

describe('interface motion honours both reduced-motion triggers', () => {
  it('finds the section and its animated selectors, so this cannot pass vacuously', () => {
    expect(START, 'the "Interface motion" section header is missing').toBeGreaterThan(0);
    expect(animated.length, 'no animated selectors found — parser broken?').toBeGreaterThan(5);
    expect(osBlocks.length, 'no OS reduced-motion block in the section').toBeGreaterThan(0);
  });

  it.each(animated.map(s => [s]))('%s is stopped under prefers-reduced-motion', (selector) => {
    const covering = osRules.find(([sels, body]) => sels.includes(selector) && STOPS.test(body));
    expect(covering, `${selector} keeps moving for a reader whose OS asked it not to`).toBeTruthy();
  });

  it.each(animated.map(s => [s]))("%s is stopped under data-motion='reduce'", (selector) => {
    /* A view-transition pseudo-element hangs off the root itself, so its
       attribute form has no descendant space. */
    const want = selector.startsWith('::') ? `${ATTR}${selector}` : `${ATTR} ${selector}`;
    const covering = attrRules.find(([sels, body]) => sels.includes(want) && STOPS.test(body));
    expect(covering, `${selector} keeps moving for a reader who switched motion off here`).toBeTruthy();
  });
});
