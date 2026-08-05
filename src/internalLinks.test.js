import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { ROUTES } from './routes/index.jsx';

/**
 * Guards against an internal link that points at no route.
 *
 * ── The incident ──
 *
 * The signup consent block rendered "Read the Terms" and "Read the Guidelines"
 * pointing at `/legal/terms` and `/legal/guidelines`. Neither path was ever
 * declared in the route table, so both answered 404. It shipped, passed every
 * test, and was found by reading the diff.
 *
 * A dead link is normally cosmetic. This one was not, for two reasons. It sat
 * inside a *consent* flow — the single moment the product asks somebody to rely
 * on a document — so the failure was "agree to terms you cannot read". And a
 * checkbox asserting agreement beside a link to nothing is a misrepresentation
 * about the availability of the terms, which is a different category of problem
 * from a broken nav item.
 *
 * ── Why this is a static scan and not a render test ──
 *
 * Rendering every view and clicking every link needs a session, a server and a
 * fixture per role, and it would still only cover the links that happen to be
 * reachable in the state the test set up. The bug above was in a branch of a form
 * that only renders after a role is chosen.
 *
 * A regex over the source has the opposite trade: it cannot tell whether a link
 * is reachable, but it sees every one of them. For "does this path exist" that is
 * the right instrument — and the failure it prevents is exactly the one that got
 * through.
 *
 * ── Derived from the route table, never restated ──
 *
 * The resolvable set is computed from `ROUTES`. Listing the valid paths here
 * would make this a second copy of the route table, and a second copy is how
 * `isPublicPath` came to be a hardcoded `startsWith('/verify/')` that silently
 * made every newly-added public route unreachable.
 */

const SRC = path.join(process.cwd(), 'src');

/**
 * Paths served by App.jsx directly rather than through the route table, each
 * with the reason it is not in `ROUTES`.
 *
 * This IS a hand-maintained list, and it is small on purpose. Anything added
 * here is a path the route table does not know about, which is exactly the
 * situation the test exists to catch — so an entry needs a reason, and the
 * reason needs to be that the path genuinely cannot live in a table.
 */
const SHELL_PATHS = Object.freeze({
  '/profile': 'rendered both as a route and as the profile overlay, so its element cannot be built in the table (see routes/index.jsx)',
  '/oauth/callback': 'AUTH_FLOW_PATHS — renders above the session gate, inline in App.jsx (TD-9)',
  '/reset-password': 'AUTH_FLOW_PATHS — renders above the session gate, inline in App.jsx (TD-9)',
  '/__errors': 'the error-experience gallery, mounted only under import.meta.env.DEV',
});

/** Every `.js`/`.jsx` file under src/, tests excluded. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { sourceFiles(full, found); continue; }
    if (!/\.jsx?$/.test(entry.name)) continue;
    if (/\.test\.jsx?$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

/**
 * Internal link targets, as `{ path, file, line }`.
 *
 * Matches `href="/…"` and `to="/…"` with a literal value. A template literal or
 * an expression (`to={`/events/${id}`}`) is skipped: its value is not knowable
 * statically, and a test that guessed would produce false failures, which is how
 * a guard gets deleted. The parameterised links in this codebase are built from
 * ids and point at paths this test already sees a literal example of.
 */
function internalLinks() {
  const links = [];
  for (const file of sourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:href|to)=["'](\/[^"'{}]*)["']/g)) {
        links.push({
          path: m[1],
          file: path.relative(process.cwd(), file),
          line: i + 1,
        });
      }
    });
  }
  return links;
}

/** Whether a concrete path matches a declared `:param` pattern, segment-wise. */
function matchesPattern(pathname, pattern) {
  const segments = pathname.split('?')[0].split('#')[0].split('/').filter(Boolean);
  const parts = pattern.split('/').filter(Boolean);
  if (parts.length !== segments.length) return false;
  return parts.every((part, i) => part.startsWith(':') || part === segments[i]);
}

describe('internal links', () => {
  const declared = ROUTES.map(r => r.path);
  const shell = Object.keys(SHELL_PATHS);
  const links = internalLinks();

  const resolves = (href) => {
    const clean = href.split('?')[0].split('#')[0];
    if (clean === '/') return true;
    return [...declared, ...shell].some(pattern => matchesPattern(clean, pattern));
  };

  it('finds links at all, so the scan cannot silently pass', () => {
    // If a refactor changes how links are written, this test must fail loudly
    // rather than reporting success over an empty set — the same reasoning as the
    // router-stack walk in authz.completeness.test.js.
    expect(links.length).toBeGreaterThan(5);
  });

  it('every internal href and to= resolves to a declared route', () => {
    const dangling = links
      .filter(l => !resolves(l.path))
      .map(l => `${l.path} (${l.file}:${l.line})`);

    expect(
      dangling,
      'these links render as 404s. Declare the route in src/routes/index.jsx, '
      + 'or fix the link. If the path is served by App.jsx outside the route '
      + 'table, add it to SHELL_PATHS in this file with the reason.'
    ).toEqual([]);
  });

  it('keeps the two signup consent links pointing at real documents', () => {
    // Named explicitly rather than left to the sweep above. These are the two
    // links whose breakage was the incident, and the sweep would go quiet the
    // moment somebody replaced them with an expression it cannot read.
    const signup = readFileSync(path.join(SRC, 'views', 'Signup.jsx'), 'utf8');
    for (const slug of ['terms-of-service', 'community-guidelines']) {
      expect(signup, `the signup consent block must link to /legal/${slug}`)
        .toContain(`href="/legal/${slug}"`);
      expect(declared.some(p => matchesPattern(`/legal/${slug}`, p))).toBe(true);
    }
  });

  it('declares no shell path that the route table already covers', () => {
    // A shell entry that duplicates a real route is a stale exemption, and a
    // stale exemption is how this guard stops guarding.
    const redundant = shell.filter(p => declared.some(pattern => matchesPattern(p, pattern)));
    expect(redundant, 'these SHELL_PATHS entries are now declared routes — remove them').toEqual([]);
  });
});
