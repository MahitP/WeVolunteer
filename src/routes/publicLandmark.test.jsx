import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every PUBLIC route's view supplies its own `<main>`.
 *
 * ── The gap this closes ──
 *
 * A signed-in page gets its landmark and its "Skip to main content" link from
 * the app shell. A public route does not: `PUBLIC_ROUTES` renders the element
 * bare, with nothing above it. So the landmark has to come from the view itself,
 * and `AboutUs` was the one that did not have it — the page that explains what
 * this platform is, and who runs it, had no main region for a screen-reader user
 * to jump to and no skip target at all. Its siblings `LegalCenter` and
 * `CertificateVerification` both had one, which is what made it a slip rather
 * than a decision.
 *
 * ── Why a source scan ──
 *
 * Rendering each public view would mean a fixture, a router and a mocked API per
 * route, and the next public route added would be covered by none of them. The
 * mistake is structural — a `<div>` where a `<main>` belongs — so the check is
 * structural too, and it covers the route nobody remembers to test.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..');
const ROUTES_FILE = path.join(HERE, 'index.jsx');

/** The `PUBLIC_ROUTES` array as source text. */
function publicRoutesBlock(source) {
  const start = source.indexOf('export const PUBLIC_ROUTES');
  expect(start, 'PUBLIC_ROUTES not found — has it been renamed?').toBeGreaterThan(-1);
  const end = source.indexOf('\n];', start);
  return source.slice(start, end);
}

/** `{ path: '/about', element: <AboutUs /> }` → `AboutUs`. */
function componentsIn(block) {
  return [...block.matchAll(/element:\s*<(\w+)\s*\/?>/g)].map(m => m[1]);
}

/** Where a lazily-imported component's file lives. */
function fileFor(component, routesSource) {
  const m = routesSource.match(
    new RegExp(`const ${component} = React\\.lazy\\(\\(\\) => import\\('([^']+)'\\)`)
  );
  if (!m) return null;
  const rel = m[1].replace(/^\.\.\//, '');
  for (const ext of ['.jsx', '.js', '/index.jsx']) {
    const candidate = path.join(SRC, rel + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const routesSource = fs.readFileSync(ROUTES_FILE, 'utf8');
const components = componentsIn(publicRoutesBlock(routesSource));

/**
 * Views that legitimately render no landmark of their own because they are
 * redirects or delegate entirely to another component that has one. Each needs a
 * reason; an empty list is the healthy state.
 */
const DELEGATES = new Set(['Navigate', 'RedirectToDiscover']);

describe('public routes carry their own main landmark', () => {
  it('finds the public routes at all', () => {
    /* If this collapses the per-route cases below vanish and the file passes
       while checking nothing — the way a guard stops guarding. */
    expect(components.length, 'no public route components resolved').toBeGreaterThanOrEqual(3);
  });

  for (const component of components) {
    if (DELEGATES.has(component)) continue;

    it(`${component} renders a <main>`, () => {
      const file = fileFor(component, routesSource);
      expect(file, `could not locate the source file for ${component}`).toBeTruthy();

      const source = fs.readFileSync(file, 'utf8');
      expect(
        /<main[\s>]/.test(source) || /role=["']main["']/.test(source),
        `${component} is a PUBLIC route, so nothing above it supplies a landmark. `
        + 'Its root element must be a `<main>` (see LegalCenter for the shape) — '
        + 'without one there is no main region and no skip target on a page a '
        + 'signed-out visitor can reach.'
      ).toBe(true);
    });
  }
});
