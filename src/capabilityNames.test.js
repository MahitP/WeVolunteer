import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { ALL_CAPABILITIES } from './authz.js';

/**
 * Every capability name the client declares must be one that exists.
 *
 * ── The failure ──
 *
 * `can()` denies an unknown capability, deliberately and before the
 * `super_admin` wildcard, so a typo cannot resolve true for the owner. The cost
 * of that safety is that a typo cannot resolve true for *anybody* either:
 *
 *   { id: 'browse', path: '/events', requiredCap: 'event.veiw' }
 *
 * is not an error. It is a navigation item invisible to every user and a route
 * that redirects everyone to `/`. Nothing throws and nothing logs.
 *
 * `src/App.jsx`'s `NAV` loop throws at module load if an entry declares
 * **neither** `requiredCap` nor a non-empty `requiredCapAny`. That catches the
 * omission, not the typo.
 *
 * ── 🔴 How much this actually adds, measured rather than assumed ──
 *
 * **Mostly not much, and saying so is the point.** Every one of the 20
 * declaration sites was typo'd in turn and the client suite run against each.
 * **19 of 20 already fail** without this file — `App.shellByRole.test.jsx` and
 * `routes/routes.test.jsx` assert which roles see which items and reach which
 * routes, so a name that denies everyone breaks those assertions.
 *
 * The one that does not fail is `SELF_PROFILE`'s
 * `{ cap: 'event.moderate', view: 'denied' }`. A typo there is currently
 * **harmless**: entries marked `denied` are filtered out of
 * `SELF_PROFILE_CAPS`, and `selfProfileFor` falls through to `?? 'denied'` — and
 * `admin` holds neither `event.create` nor `portfolio.write`, so the fallthrough
 * lands on the same answer. Nothing observable changes, which is exactly why no
 * behavioural test catches it.
 *
 * So this file is kept for two narrower reasons, not the broad one:
 *
 *   1. **That harmless site becomes harmful if the capability table changes.**
 *      Grant `admin` `event.create` — a plausible future edit, since organizers
 *      have it — and the typo'd entry stops denying, so an admin silently gets
 *      the `host` profile view the comment says has never existed. The guard
 *      makes the typo impossible rather than conditionally harmless.
 *   2. **The failure message.** A behavioural test says an element was not in the
 *      document; this names the file, the line, the bad string and the valid set.
 *      That is the difference between ten minutes and one.
 *
 * It is the client mirror of Guard 4 in `server/authz.completeness.test.js`,
 * which exists for the same reason server-side — but Guard 4 guards a real gap,
 * and this one mostly guards a message. Do not cite this file as the reason
 * client capability names are safe; the behavioural tests are.
 */

const SRC = path.join(process.cwd(), 'src');
const KNOWN = new Set(ALL_CAPABILITIES);

/**
 * Capability-name literals in one source file.
 *
 * Three shapes, because the client declares them three ways: `requiredCap: 'x'`
 * on a nav entry or route, `requiredCapAny: ['x', 'y']` for a route that several
 * capabilities can reach, and `cap: 'x'` in the `PERSONAS` and `SELF_PROFILE`
 * tables that decide which dashboard and profile a person gets.
 *
 * Kept as a function over a string so the self-test below can drive it with the
 * exact bug. Reading a regex and believing it is how three role checks got past
 * a guard earlier in this project.
 */
export function findDeclaredCapabilities(src) {
  const found = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\*|\/\/)/.test(line)) return;   // prose is not a declaration

    for (const m of line.matchAll(/\b(?:requiredCap|cap)\s*:\s*'([^']+)'/g)) {
      found.push({ line: i + 1, name: m[1] });
    }
    for (const m of line.matchAll(/\brequiredCapAny\s*:\s*\[([^\]]*)\]/g)) {
      for (const c of m[1].matchAll(/'([^']+)'/g)) found.push({ line: i + 1, name: c[1] });
    }
  });
  return found;
}

function clientFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.jsx?$/.test(entry.name) || /\.test\.jsx?$/.test(entry.name)) continue;
      files.push(full);
    }
  };
  walk(SRC);
  return files;
}

describe('the detector', () => {
  it('finds each declaration shape and ignores prose', () => {
    expect(findDeclaredCapabilities("  { id: 'browse', requiredCap: 'event.view' }")[0].name)
      .toBe('event.view');
    expect(findDeclaredCapabilities("  { cap: 'event.moderate', view: 'denied' },")[0].name)
      .toBe('event.moderate');
    expect(findDeclaredCapabilities("  requiredCapAny: ['event.apply', 'event.create']").map(f => f.name))
      .toEqual(['event.apply', 'event.create']);

    // The bug: one character off, and silently denied to everyone.
    const typo = findDeclaredCapabilities("  { requiredCap: 'event.veiw' }");
    expect(typo).toHaveLength(1);
    expect(KNOWN.has(typo[0].name)).toBe(false);

    // Prose mentioning one is not a declaration.
    expect(findDeclaredCapabilities("   * requiredCap: 'made.up.capability' is denied to all")).toEqual([]);
    expect(findDeclaredCapabilities("// cap: 'nonsense' was the old shape")).toEqual([]);
  });

  it('scans a non-trivial number of real declarations', () => {
    const total = clientFiles().reduce(
      (n, f) => n + findDeclaredCapabilities(readFileSync(f, 'utf8')).length, 0
    );
    // Guards the guard: a regex that silently stops matching would otherwise let
    // this whole file pass over an empty set and report success.
    expect(total, 'found no capability declarations at all — the detector is broken').toBeGreaterThan(10);
  });
});

describe('every capability the client declares exists', () => {
  it('finds no unknown capability name anywhere in src/', () => {
    expect(KNOWN.size, 'ALL_CAPABILITIES is empty').toBeGreaterThan(10);

    const offenders = [];
    for (const file of clientFiles()) {
      const rel = path.relative(process.cwd(), file);
      for (const { line, name } of findDeclaredCapabilities(readFileSync(file, 'utf8'))) {
        if (!KNOWN.has(name)) {
          offenders.push(
            `${rel}:${line}: '${name}' is not a capability. can() denies unknown names, so this `
            + 'is not an error at runtime — it is a nav item invisible to every user and a route '
            + `that redirects everyone. Known: ${[...KNOWN].sort().join(', ')}`
          );
        }
      }
    }

    expect(offenders, 'client capability declaration(s) naming a capability that does not exist').toEqual([]);
  });
});
