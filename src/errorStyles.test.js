import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { THEME_IDS } from './views/ErrorExperience/themes/index.js';

/**
 * Static guards over the error experience's stylesheet.
 *
 * These are in the same family as `tokens.test.js`, `noHardcodedColors.test.js`
 * and `noDanglingClasses.test.js`: things that fail silently in a browser and
 * are invisible in review, turned into build failures.
 *
 * ── Why the reduced-motion check is generalised ──
 *
 * The previous version named the four animated classes by hand. That worked for
 * exactly as long as there was one theme. With six — and a seventh always
 * possible — a hand-written list is a guard that silently stops covering the
 * thing it was written for: the new theme animates, nobody adds it to the list,
 * and the only protection a vestibular-sensitive reader has is a comment.
 *
 * So this derives the list instead. Every `.err-*` selector that declares an
 * animation must be disabled under `prefers-reduced-motion`. Adding an animated
 * theme without an opt-out fails the build.
 */

const SRC = path.join(process.cwd(), 'src');
const CSS_RAW = readFileSync(path.join(SRC, 'index.css'), 'utf8');

/**
 * Comments have to go before anything is parsed.
 *
 * `([^{}]+)\{` treats everything between the previous `}` and the next `{` as
 * the selector, which silently includes the comment above the rule. The first
 * run of this file reported selectors named `/* ── Board ── *​/` and passed
 * `.err-board-loose` through unchecked — a guard that looked like it was
 * working while covering nothing.
 */
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/** Rules as [selectorText, body]. At-rule headers are skipped; their inner
 *  rules are matched on their own by the same pass. */
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

/** The text of every `prefers-reduced-motion: reduce` block, braces balanced. */
function reducedMotionBlocks(css) {
  const QUERY = '@media (prefers-reduced-motion: reduce)';
  const blocks = [];
  for (let i = css.indexOf(QUERY); i !== -1; i = css.indexOf(QUERY, i + 1)) {
    let depth = 0;
    let end = css.indexOf('{', i);
    for (let j = end; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { end = j; break; }
    }
    blocks.push(css.slice(i, end + 1));
  }
  return blocks;
}

describe('reduced motion covers the whole error experience', () => {
  const blocks = reducedMotionBlocks(CSS);

  it('has a reduced-motion block at all', () => {
    expect(blocks.length, 'no reduced-motion block anywhere').toBeGreaterThan(0);
  });

  /**
   * Every animated `.err-*` selector, derived from the stylesheet rather than
   * listed. `animation: none` is excluded — that is an opt-out, not motion.
   */
  const animated = rules(CSS)
    .filter(([selector, body]) =>
      selector.includes('.err')
      && /(^|[;\s])animation(-name)?\s*:/.test(body)
      && !/animation\s*:\s*none/.test(body))
    .map(([selector]) => selector);

  it('finds the animated selectors at all, so this cannot pass vacuously', () => {
    // If the parser breaks, the loop below runs zero times and reports success.
    expect(animated.length, 'no animated .err selectors found — parser broken?')
      .toBeGreaterThan(8);
  });

  it.each(animated.map((s) => [s]))('%s is disabled for reduced motion', (selector) => {
    const covering = blocks.find((b) => b.includes(selector));
    expect(
      covering,
      `${selector} keeps animating for a reader who asked it not to`
    ).toBeTruthy();
    expect(covering).toContain('animation: none');
  });
});

describe('error classes and rules stay in step', () => {
  /**
   * Every `err-*` class referenced from JSX under src/.
   *
   * Scanning `className="…"` attributes is not enough here: several of these
   * are built in template literals with a conditional inside
   * (`` `err-board-sheet${isAnomaly ? ' err-board-held' : ''}` ``), and an
   * attribute-scoped regex stops at the first quote inside the expression. That
   * silently under-reports, which made both directions of this check fail
   * against classes that were in fact perfectly wired.
   *
   * So: strip comments, then take `err-*` tokens anywhere in the source.
   * Comments are stripped rather than trusted because several of these files
   * discuss their own class names in prose, which would otherwise count as a
   * reference and mask a genuinely dangling class.
   *
   * The lookbehind excludes `--err-i`, a custom property rather than a class.
   */
  const TOKEN = /(?<![-\w])err-[a-z0-9]+(?:-[a-z0-9]+)*/g;

  function referenced() {
    const found = new Map();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx$/.test(entry.name) || /\.test\.jsx$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const m of src.matchAll(TOKEN)) {
          if (!found.has(m[0])) found.set(m[0], new Set());
          found.get(m[0]).add(path.relative(process.cwd(), full));
        }
      }
    };
    walk(SRC);
    return found;
  }

  const refs = referenced();

  /**
   * `err-t` is the stem of `` `err-t-${theme.id}` ``, which no scanner can
   * resolve. The six real classes are asserted against the registry below, so
   * the stem is dropped here rather than allowlisted as a class.
   */
  const DYNAMIC_STEMS = new Set(['err-t']);

  /**
   * Classes composed at runtime, so no scanner can see the finished name.
   * Asserted explicitly below against the source of truth — the theme registry
   * — rather than allowlisted away.
   *
   * `err-panel-{tone}` used to be here too, for a prop whose two other values
   * no caller ever passed. An allowlist that exists to keep unreachable code
   * green is the guard working around the codebase instead of checking it, so
   * the variants went rather than the entry.
   */
  const COMPOSED = new Set(THEME_IDS.map((id) => `err-t-${id}`));
  const staticRefs = [...refs].filter(([cls]) => !DYNAMIC_STEMS.has(cls));

  it('finds the classes at all', () => {
    // If the scan breaks, both assertions below pass vacuously.
    expect(staticRefs.length, 'no err-* classes found — the scan is broken')
      .toBeGreaterThan(12);
  });

  it('every err-* class in JSX has a rule', () => {
    const dangling = staticRefs
      .filter(([cls]) => !new RegExp(`\\.${cls}\\s*[,{:[.\\s]`).test(CSS))
      .map(([cls, files]) => `${cls} (${[...files].join(', ')})`);
    expect(dangling, 'these class names style nothing').toEqual([]);
  });

  it.each([...COMPOSED].map((c) => [c]))('%s is composed at runtime and has a rule', (cls) => {
    expect(
      new RegExp(`\\.${cls}\\b`).test(CSS),
      `${cls} is applied at runtime but styles nothing`
    ).toBe(true);
  });

  it('every err-* rule is still referenced from JSX', () => {
    const defined = new Set([...CSS.matchAll(/\.(err-[a-z0-9-]+)/g)].map((m) => m[1]));
    const unused = [...defined].filter((cls) => !refs.has(cls) && !COMPOSED.has(cls));
    expect(unused, 'dead rules — remove them or restore the reference').toEqual([]);
  });
});
