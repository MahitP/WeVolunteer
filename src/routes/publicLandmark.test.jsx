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

/**
 * The same rule from the other side: an APP route must NOT supply its own.
 *
 * ── Why this is the harder half ──
 *
 * A public route missing its `<main>` is visible — there is no skip target and
 * no main region, and the sweep says so. An app route with an EXTRA `<main>`
 * looks completely normal: the page renders, the skip link works, axe passes,
 * and the only symptom is that a screen reader's landmark list offers two
 * entries called "main" for one page. Nothing in the fast suite could see it.
 *
 * Three views had it. `OrganizerAgreement` and `StudentOrganizerAgreement` came
 * by it honestly — both were once allowlisted in `src/headingLevels.test.js` as
 * rendering outside the shell, which they never did; when that was corrected the
 * duplicated `h1` was fixed and the duplicated landmark was not, because a
 * heading guard reads headings. `WellyView`'s was labelled "Welly conversation",
 * which made it invisible to the runtime check too: that one asks whether two
 * landmarks of a role can be told APART, and these two could.
 *
 * ── Why a source scan, given the sweep now asserts this ──
 *
 * `a11y/sweep.aria.spec.js` catches it in a browser, which is the stronger
 * instrument and the one that found it. But it needs a database, a dev server
 * and about ten minutes, so in practice it runs occasionally and this runs on
 * every commit. The mistake is structural — a `<main>` where a `<div>` or a
 * labelled `<section>` belongs — so a structural check catches it at the moment
 * it is typed rather than whenever somebody next sweeps.
 */
describe('app routes leave the main landmark to the shell', () => {
  /** The `APP_ROUTES` array as source text. */
  function appRoutesBlock(source) {
    const start = source.indexOf('export const APP_ROUTES');
    expect(start, 'APP_ROUTES not found — has it been renamed?').toBeGreaterThan(-1);
    const end = source.indexOf('\n];', start);
    return source.slice(start, end);
  }

  const appComponents = componentsIn(appRoutesBlock(routesSource));

  /**
   * Comments legitimately name the element — several of these views explain at
   * length why they do NOT use one, and a scan that counted those would fail on
   * exactly the files that got it right for exactly the reason they got it right.
   */
  function withoutComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('finds the app routes at all', () => {
    expect(appComponents.length, 'no app route components resolved')
      .toBeGreaterThanOrEqual(20);
  });

  for (const component of appComponents) {
    if (DELEGATES.has(component)) continue;

    it(`${component} does not open a second <main>`, () => {
      const file = fileFor(component, routesSource);
      if (!file) return; // Not lazily imported; the public half covers the rest.

      const code = withoutComments(fs.readFileSync(file, 'utf8'));
      const opens = /<main[\s>]/.test(code) || /role=["']main["']/.test(code);

      expect(
        opens,
        `${component} is an APP route, so the shell has already opened the page's `
        + 'single `main` around it. A second one is a nested main landmark: the '
        + 'page looks right, axe passes, and a screen reader is offered two "main" '
        + 'entries for one page. Use a `<div>`, or a `<section aria-label="…">` if '
        + 'the region deserves a name of its own — see WellyView.',
      ).toBe(false);
    });
  }
});
