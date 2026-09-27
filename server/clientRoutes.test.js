/**
 * The allowlist's two structural guarantees.
 *
 * Neither is about behaviour, and both fail the build:
 *
 *   1. `clientRoutes.js` imports nothing. A React import here would be a React
 *      import in the server process, and would break `errorReporter.js`'s own
 *      zero-dependency property.
 *   2. Every client route is classified — allowed, or excluded with a reason.
 *      A route added later and left unclassified reports as `unknown`, silently,
 *      and `unknown` is indistinguishable from hostile input on a dashboard.
 *      Failing the build makes a new route a decision instead of a default.
 *
 * The client route table is read as TEXT, never imported: `src/routes/index.jsx`
 * pulls in React and `react-router-dom`, and importing it to inspect nine
 * strings is exactly what this whole arrangement exists to avoid. Same technique
 * the three `src/` guards use.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLIENT_ROUTE_PATTERNS, EXCLUDED_CLIENT_ROUTES, UNKNOWN_ROUTE } from './clientRoutes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const read = (rel) => readFileSync(path.join(repo, rel), 'utf8');

describe('clientRoutes.js is plain data', () => {
  it('imports nothing at all', () => {
    const src = read('server/clientRoutes.js');
    const imports = [...src.matchAll(/^\s*import\s.+$/gm)].map(m => m[0].trim());
    expect(
      imports,
      'clientRoutes.js must stay dependency-free — a React or Express import here '
      + 'reaches the server process and breaks errorReporter.js\'s zero-import property'
    ).toEqual([]);
    expect(src).not.toMatch(/require\s*\(/);
  });

  /**
   * The one literal this file may not import, checked instead.
   *
   * `OAUTH_CALLBACK_PATH` is the single source of truth for the OAuth callback
   * route — `App.jsx` routes on it and `config.js` refuses to boot a production
   * server whose `OAUTH_REDIRECT_URI` does not end at it. This file cannot
   * import it, because the test above forbids importing anything at all, and
   * that invariant is load-bearing for `errorReporter.js`.
   *
   * So the two are kept in step here rather than by a shared reference. A rename
   * of the route that missed this list would not be a 404 — the SPA fallback
   * serves the page either way — it would silently downgrade every error report
   * from the callback page to `unknown`, on the one route whose query string
   * carries a live authorization code and whose failures therefore matter most.
   */
  it('agrees with OAUTH_CALLBACK_PATH, which it is not allowed to import', async () => {
    const { OAUTH_CALLBACK_PATH } = await import('./oauthCallbackPath.js');
    const { CLIENT_ROUTE_PATTERNS } = await import('./clientRoutes.js');
    expect(
      CLIENT_ROUTE_PATTERNS,
      'the OAuth callback route was renamed without updating CLIENT_ROUTE_PATTERNS'
    ).toContain(OAUTH_CALLBACK_PATH);
  });

  it('exports patterns and nothing that could act as a router', () => {
    expect(Array.isArray(CLIENT_ROUTE_PATTERNS)).toBe(true);
    expect(Object.isFrozen(CLIENT_ROUTE_PATTERNS)).toBe(true);
    for (const p of CLIENT_ROUTE_PATTERNS) {
      expect(typeof p, `${p} is not a string`).toBe('string');
      expect(p.startsWith('/'), `${p} is not a path`).toBe(true);
      // A pattern carrying a query or fragment would mean a value got in.
      expect(p, `${p} carries a query or fragment`).not.toMatch(/[?#]/);
    }
    expect(new Set(CLIENT_ROUTE_PATTERNS).size, 'duplicate pattern').toBe(CLIENT_ROUTE_PATTERNS.length);
    expect(UNKNOWN_ROUTE).toBe('unknown');
  });
});

/**
 * Every path the client can route to, extracted from the source rather than
 * imported. Covers `src/routes/index.jsx`'s three tables and the routes declared
 * directly in `src/App.jsx`, because a crash on `/reset-password` is just as
 * reportable as one on `/settings`.
 */
function declaredClientPaths() {
  const paths = new Set();

  for (const m of read('src/routes/index.jsx').matchAll(/\bpath:\s*'([^']+)'/g)) {
    paths.add(m[1]);
  }
  for (const m of read('src/App.jsx').matchAll(/<Route\s+path="([^"]+)"/g)) {
    paths.add(m[1]);
  }
  // The catch-all is not a destination; it is what renders when nothing matched.
  paths.delete('*');
  return [...paths];
}

describe('every client route has an error-reporting classification', () => {
  it('finds the route tables at all', () => {
    // If the extraction silently found nothing, the guard below would pass while
    // checking nothing — the failure mode that makes a guard worse than none.
    const declared = declaredClientPaths();
    expect(declared.length).toBeGreaterThan(8);
    expect(declared).toContain('/settings');
    expect(declared).toContain('/login');
  });

  it('classifies every declared path as allowed or explicitly excluded', () => {
    const allowed = new Set(CLIENT_ROUTE_PATTERNS);
    const unclassified = declaredClientPaths().filter(
      p => !allowed.has(p) && !Object.prototype.hasOwnProperty.call(EXCLUDED_CLIENT_ROUTES, p)
    );

    expect(
      unclassified,
      'client route(s) with no error-reporting classification. Add the pattern to '
      + 'CLIENT_ROUTE_PATTERNS in server/clientRoutes.js, or add it to '
      + 'EXCLUDED_CLIENT_ROUTES with a one-line reason why its reports must say '
      + '"unknown". A new route is a new potential PII channel and this is the '
      + 'moment to decide which it is.'
    ).toEqual([]);
  });

  it('every exclusion carries a non-empty justification', () => {
    for (const [route, reason] of Object.entries(EXCLUDED_CLIENT_ROUTES)) {
      expect(typeof reason, `${route} has no reason`).toBe('string');
      expect(reason.trim().length, `${route}'s reason is empty`).toBeGreaterThan(10);
    }
  });

  it('no pattern is both allowed and excluded', () => {
    const overlap = CLIENT_ROUTE_PATTERNS.filter(
      p => Object.prototype.hasOwnProperty.call(EXCLUDED_CLIENT_ROUTES, p)
    );
    expect(overlap, 'a route cannot be both allowed and excluded').toEqual([]);
  });
});
