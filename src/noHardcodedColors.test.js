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

// #abc, #aabbcc, #aabbccdd, rgb(...), rgba(...), hsl(...), hsla(...)
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/g;

function offenders() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.jsx?$/.test(entry.name)) continue;
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.jsx')) continue;

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
