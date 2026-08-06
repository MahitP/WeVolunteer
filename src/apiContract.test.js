/**
 * Every `api.X(...)` a component calls must actually exist on the api object.
 *
 * ── The bug this exists to prevent ──
 *
 * `src/views/AdminAppeals.jsx` called `api.get(...)`, `api.patch(...)` and
 * `api.post(...)`. `src/utils/api.js` exports one named method per endpoint
 * (`fetchLegalDocuments`, `updateApplicationStatus`, …) plus a raw `apiFetch`
 * escape hatch — it has never had generic HTTP verbs. So every one of those calls
 * threw `api.get is not a function`, and the entire appeals queue rendered
 * "Could not load the queue".
 *
 * That surface is where a suspended student's appeal is read and decided, so it
 * failing silently is a child-safety problem rather than a cosmetic one. It reached
 * the branch because nothing connects the two files: `api.js` is a plain object, the
 * views destructure nothing from it, and a typo in a method name is indistinguishable
 * from a method that has not been written yet until the code runs.
 *
 * ── Why a static guard rather than a render test ──
 *
 * A render test for AdminAppeals would have caught this one view. It would not catch
 * the next one, and the failure mode is per-call-site rather than per-view: a view
 * can render perfectly and still throw the first time a button reaches an endpoint
 * nobody wired up. This asserts the whole contract at once, in the same spirit as
 * the three `src/` guards over CSS — a mismatch fails the build rather than waiting
 * for somebody to click the right button.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { api } from './utils/api.js';

const SRC = path.join(process.cwd(), 'src');

/**
 * The file that DEFINES `api` is not scanned for calls to it.
 *
 * Its own doc comments name the methods they document — including the ones this
 * guard exists to have caught — so scanning it reports prose as a call site.
 *
 * Comments are not stripped from the files that ARE scanned, deliberately. A regex
 * comment-stripper cannot tell `//` in a comment from `//` in a URL literal, and
 * deleting real code would turn this guard's false-POSITIVE problem into a false-
 * negative one, which is the dangerous direction. A method named in a comment
 * elsewhere will fail this test; the fix is to reword the comment, and the failure is
 * loud and harmless.
 */
const DEFINITION_FILE = path.join(SRC, 'utils', 'api.js');

/** Every `api.<name>(` reference in shipped (non-test) code, with where it came from. */
function referencedApiMethods() {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.jsx?$/.test(entry.name)) continue;
      if (/\.test\.jsx?$/.test(entry.name)) continue;
      if (full === DEFINITION_FILE) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(/\bapi\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
        if (!found.has(m[1])) found.set(m[1], new Set());
        found.get(m[1]).add(path.relative(process.cwd(), full));
      }
    }
  };
  walk(SRC);
  return found;
}

describe('the api client contract', () => {
  const referenced = referencedApiMethods();

  it('finds api calls to check, so a broken walker cannot pass silently', () => {
    // Guards the guard: an empty map would make every assertion below vacuous.
    expect(referenced.size).toBeGreaterThan(30);
  });

  it('defines every method the app calls', () => {
    const missing = [...referenced.entries()]
      .filter(([name]) => typeof api[name] !== 'function')
      .map(([name, files]) => `api.${name}() — called from ${[...files].join(', ')}`);

    expect(
      missing,
      'these calls throw "is not a function" the moment the code path runs'
    ).toEqual([]);
  });
});
