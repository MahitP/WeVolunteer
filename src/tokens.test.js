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

/** Custom properties defined in index.css (`--name:` at a declaration site). */
function definedTokens() {
  const css = fs.readFileSync(CSS, 'utf8');
  return new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[1]));
}

/**
 * Every `var(--…)` reference under src/, with the file it appears in.
 *
 * This file is skipped: it carries no styling, and its own prose examples would
 * otherwise be reported as undefined tokens.
 */
function referencedTokens() {
  const SELF = path.basename(new URL(import.meta.url).pathname);
  const refs = new Map(); // token -> Set(relative file)
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(jsx?|css)$/.test(entry.name)) continue;
      if (entry.name === SELF) continue;
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
