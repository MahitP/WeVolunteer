import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Design-token guard.
 *
 * A `var(--token)` reference to a custom property that `index.css` never
 * defines does not fail loudly: CSS marks the declaration invalid at
 * computed-value time, so the element silently inherits instead of rendering
 * the intended value. That is invisible in review and invisible in the browser
 * unless you happen to know what the colour should have been.
 *
 * This test makes that failure mode a build-time error. Every custom property
 * referenced anywhere under src/ must be defined in src/index.css.
 *
 * There is deliberately NO allowlist. If you are adding a token, define it in
 * index.css; if you are referencing one, use a name that exists. An exception
 * list here would just recreate the class of bug this test exists to catch.
 */

const SRC = path.join(process.cwd(), 'src');
const CSS = path.join(SRC, 'index.css');

/**
 * The stylesheets a token may be DEFINED in.
 *
 * `index.css` is the application's styling layer and still owns every app
 * token. `wvMotion.css` is the brand's motion, kept beside the geometry it
 * animates rather than in `index.css`, and it defines the `--wv-*` curves,
 * durations and distances the frozen motion system is expressed in. Both are
 * real stylesheets shipped by `main.jsx`, so a token defined in either is
 * defined; a token defined in neither is still the silent-inheritance bug this
 * guard exists to catch.
 */
const CSS_FILES = [CSS, path.join(SRC, 'components/common/wvMotion.css')];

/** Custom properties defined in those stylesheets (`--name:` at a declaration site). */
function definedTokens() {
  const css = CSS_FILES.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  return new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[1]));
}

/**
 * Every `var(--…)` reference under src/, with the file it appears in.
 *
 * Test files are skipped: they carry no styling, and their own prose examples
 * (e.g. a guard test's docstring saying `var(--x)` to illustrate what it
 * checks) would otherwise be reported as undefined tokens. This used to skip
 * only this file, but any test file's comments can hit the same false
 * positive — noHardcodedColors.test.js's docstring literally contains
 * `var(--x)` as prose, not a real reference, and was being flagged as if it
 * were one.
 */
function referencedTokens() {
  const refs = new Map(); // token -> Set(relative file)
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(jsx?|css)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.jsx')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        const rel = path.relative(process.cwd(), full);
        if (!refs.has(m[1])) refs.set(m[1], new Set());
        refs.get(m[1]).add(rel);
      }
    }
  };
  walk(SRC);
  return refs;
}

describe('design tokens', () => {
  it('defines every custom property referenced under src/', () => {
    const defined = definedTokens();
    const referenced = referencedTokens();

    const undefinedRefs = [...referenced.entries()]
      .filter(([token]) => !defined.has(token))
      .map(([token, files]) => `${token} (used in ${[...files].sort().join(', ')})`)
      .sort();

    expect(undefinedRefs).toEqual([]);
  });

  it('finds the token definitions and references it is meant to scan', () => {
    // Guards the guard: if the regexes silently stopped matching, the test
    // above would pass vacuously against an empty set.
    expect(definedTokens().size).toBeGreaterThan(30);
    expect(referencedTokens().size).toBeGreaterThan(20);
  });
});
