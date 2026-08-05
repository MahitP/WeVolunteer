/**
 * Every route in `APP_ROUTES` has an entry in App.jsx's prop map, and vice versa.
 *
 * ── Why this is a build failure and not a runtime one ──
 *
 * `withProps` already throws for a route with no prop-map entry, and that is
 * genuinely useful — but only for the route somebody is looking at. It fires at
 * RENDER, on one path, in whatever session state the reader happens to be in. A
 * route added to the table and forgotten in the map is therefore invisible until
 * someone navigates to it, which for a capability-gated page can mean until the
 * one person who holds that capability tries.
 *
 * `App.routeTable.test.jsx` pins the paths that exist today, and its own header
 * admits the consequence: it "stops protecting anything the moment a tenth route
 * is added and its prop entry forgotten". This file is that protection. It is
 * derived from the table rather than listing paths, so it cannot go stale.
 *
 * ── Why it reads source instead of importing ──
 *
 * `appRouteProps` is declared inside `AppShell` because every value in it closes
 * over shell state and handlers. There is nothing to import. So this parses the
 * file, which is the same approach `authz.completeness.test.js`,
 * `tokens.test.js` and `errorStyles.test.js` take for the same reason.
 *
 * Comments are stripped before anything is parsed. This repository has been
 * bitten three times by a structural assertion that was satisfied by prose —
 * a doc comment mentioning `'/settings'` would otherwise count as a declaration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { APP_ROUTES } from './index.jsx';

const SOURCE = readFileSync(path.join(process.cwd(), 'src', 'App.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The top-level keys of the `appRouteProps` object literal.
 *
 * Brace-matched rather than regex-sliced: the values contain nested objects and
 * arrow functions with their own braces, and a non-greedy `\{[\s\S]*?\}` stops
 * at the first inner one — which would silently report only the keys before the
 * first nested value and pass while covering almost nothing.
 */
function routePropKeys(source) {
  const start = source.indexOf('const appRouteProps = {');
  if (start === -1) throw new Error('appRouteProps not found in App.jsx — this guard needs updating');

  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { end = i; break; }
  }

  const body = source.slice(open + 1, end);
  const keys = [];
  depth = 0;
  let line = '';
  for (const char of body) {
    if (char === '{' || char === '[' || char === '(') depth++;
    else if (char === '}' || char === ']' || char === ')') depth--;
    // Only a key at depth 0 belongs to this object rather than to a value.
    if (depth === 0) {
      line += char;
      const m = line.match(/(?:^|,)\s*'([^']+)'\s*:\s*$/);
      if (m) { keys.push(m[1]); line = ''; }
    }
  }
  return keys;
}

describe('APP_ROUTES and the shell prop map stay in step', () => {
  const declared = routePropKeys(SOURCE);
  const routed = APP_ROUTES.map((r) => r.path);

  it('finds the map at all, so this cannot pass vacuously', () => {
    // A parser that returns [] would report "no missing entries" for ever.
    expect(declared.length, 'parsed no keys out of appRouteProps').toBeGreaterThan(5);
  });

  /**
   * The direction the plan cares about: a route that renders with every prop
   * silently absent, or throws at the moment a user reaches it.
   */
  it('declares props for every routed path', () => {
    const missing = routed.filter((p) => !declared.includes(p));
    expect(
      missing,
      'in APP_ROUTES with no entry in appRouteProps — withProps will throw when '
      + 'somebody navigates there. Use {} if the view takes no shell props.'
    ).toEqual([]);
  });

  /**
   * The other direction, which is how the map rots: a route is renamed or
   * removed and its props are left behind, so the next reader believes a path
   * exists that does not.
   */
  it('declares props for nothing that is not a route', () => {
    const orphans = declared.filter((p) => !routed.includes(p));
    expect(orphans, 'in appRouteProps but not in APP_ROUTES — dead entries').toEqual([]);
  });

  it('has no duplicate keys, which would silently shadow', () => {
    const dupes = declared.filter((p, i) => declared.indexOf(p) !== i);
    expect([...new Set(dupes)]).toEqual([]);
  });
});
