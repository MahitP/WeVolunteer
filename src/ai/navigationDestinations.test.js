import { describe, it, expect } from 'vitest';
import { DESTINATIONS, resolveNavigation } from './navigation.js';
import { CLIENT_ROUTE_PATTERNS } from '../../server/clientRoutes.js';

/**
 * Where Welly's navigation actually sends people.
 *
 * ── The defect ──
 *
 * `applications` pointed at `/discover?find=applications`. `find` is a SCOPE,
 * and `BrowseEvents` accepts `all | events | people | organizations` — anything
 * else falls back to `all` without a word. So Welly announced "Navigating to
 * Your Applications" and delivered the generic Discover page.
 *
 * Reachable: the `navigate` intent fires on an explicit phrasing ("take me
 * to…", "open…", "go to the … page"), and every one of those for applications
 * resolved to that path. The ordinary phrasing "show my applications" routes to
 * the `my_applications` TOOL instead and was never affected — which is why this
 * survived: the common case answers with data and never consults the
 * destination table.
 *
 * ── What is asserted ──
 *
 * Every destination's path has to be somewhere the router can actually land,
 * and any query string it carries has to be one the target page understands.
 * Written over the whole table rather than over `applications`, so the next
 * destination added has to answer the same question.
 */

/** The path without its query string or fragment. */
const basePath = (p) => String(p).split(/[?#]/)[0];

describe('every Welly destination', () => {
  it('has some destinations, so the cases below are not scanning an empty set', () => {
    expect(Object.keys(DESTINATIONS ?? {}).length).toBeGreaterThan(3);
  });

  it('points at a path the application actually serves', () => {
    /**
     * Checked against `server/clientRoutes.js` rather than the route table,
     * because that is the canonical list — it is what `serverLinks.test.js`
     * validates server-emitted destinations against, and it includes the paths
     * App.jsx renders directly (`/`, `/profile`) which never appear in
     * `APP_ROUTES`.
     */
    const served = new Set(CLIENT_ROUTE_PATTERNS);
    for (const [key, dest] of Object.entries(DESTINATIONS)) {
      const base = basePath(dest.path);
      expect(
        served.has(base),
        `"${key}" points at ${dest.path}, and ${base} is not a path this app serves`,
      ).toBe(true);
    }
  });

  it('carries no query string the destination page would ignore', () => {
    /**
     * `find` is the only query key any destination uses today, and
     * `BrowseEvents` reads exactly four values for it. A destination that
     * invents a fifth is the defect this file was written for: the page renders,
     * nothing filters, and the announcement was wrong.
     */
    const BROWSE_SCOPES = new Set(['all', 'events', 'people', 'organizations']);
    for (const [key, dest] of Object.entries(DESTINATIONS)) {
      const query = String(dest.path).split('?')[1];
      if (!query) continue;
      for (const [k, v] of new URLSearchParams(query)) {
        /* Only `find` is checked, and deliberately: it is the one key whose
           accepted values live in a list this test can read
           (`SCOPES` in BrowseEvents). Other keys belong to other pages —
           `?section=` is read by Settings — and asserting against a hardcoded
           list of those would be a second copy of their parsing. */
        if (k !== 'find') continue;
        expect(
          BROWSE_SCOPES.has(v),
          `"${key}" asks Discover for scope "${v}", which it does not accept and will silently ignore`,
        ).toBe(true);
      }
    }
  });

  it('sends an explicit request about applications somewhere that holds them', () => {
    /* The production path, end to end: the phrasing the `navigate` intent
       matches, through the resolver, to a destination that is not Discover. */
    const nav = resolveNavigation('take me to my applications', {
      id: 'u1', role: 'student', verified: true, withheld: [],
    });
    expect(nav, 'the phrasing stopped resolving at all').toBeTruthy();
    expect(nav.path).not.toMatch(/^\/discover/);
    expect(basePath(nav.path)).toBe('/');
  });
});
