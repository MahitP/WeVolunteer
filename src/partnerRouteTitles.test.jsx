import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PAGE_META, tabForPath } from './App.jsx';
import { APP_ROUTES } from './routes/index.jsx';
import { CAPABILITIES } from '../server/authz.js';

/**
 * A page a role can actually open has to be titled for that role.
 *
 * ── The gap this closes, and the one it does not ──
 *
 * `PAGE_META` is keyed by persona and a missing entry falls back to
 * `{ title: APP_NAME, sub: '' }`, so the page renders under the bare product
 * name. That is a recorded defect, not a theory: the partner `profile` entry was
 * added for exactly this, and its note says "the one page it exists to serve fell
 * through to the `{ title: APP_NAME, sub: '' }` fallback and rendered under the
 * bare product name".
 *
 * `pageTitleCoverage.test.js` already checks the pages every signed-in account
 * reaches. It cannot see this class, because it asks whether a tab is described
 * for SOME persona and then only enforces the universal ones — so a route whose
 * capability a partner happens to hold, described for three personas and not for
 * theirs, passes.
 *
 * This derives reachability from the two authorities instead: the route's own
 * `requiredCap` and the role's capability set. `/calendar` requires `event.view`,
 * which every role holds including partner — see owner decision 6B.
 *
 * ── What it deliberately does not assert ──
 *
 * That the page is USEFUL, or that it should be in anybody's navigation. Those
 * are the two halves of owner decision 6 and they are answered in `App.jsx`
 * beside the entries themselves. This asserts only that a reader who arrives
 * is told what they are looking at.
 *
 * Decided during the 2026-09-21 audit (owner decision 6B).
 */

/** The persona cascade in App.jsx, most privileged first. */
const PERSONA_BY_CAP = [
  ['staff', 'event.moderate'],
  ['host', 'event.create'],
  ['volunteer', 'event.apply'],
  ['partner', 'analytics.public'],
];

const holds = (role, cap) => {
  const set = new Set(CAPABILITIES[role] || []);
  return set.has('*') || set.has(cap);
};

const personaOf = (role) => PERSONA_BY_CAP.find(([, cap]) => holds(role, cap))?.[0] ?? null;

/** Routes whose body lives outside the titled shell. */
const OUTSIDE_THE_SHELL = new Set(['/login', '/register', '/reset-password', '/oauth/callback']);

describe('every role is told what page it is on', () => {
  it('finds routes to check, so this cannot pass by finding none', () => {
    const concrete = APP_ROUTES.filter(r => !r.path.includes(':'));
    expect(concrete.length).toBeGreaterThan(10);
  });

  it('titles each concrete route for every role whose capability opens it', () => {
    const missing = [];
    for (const route of APP_ROUTES) {
      if (route.path.includes(':') || OUTSIDE_THE_SHELL.has(route.path)) continue;
      const tab = tabForPath(route.path);
      if (!tab) continue;

      for (const role of Object.keys(CAPABILITIES)) {
        const persona = personaOf(role);
        if (!persona) continue;

        /* Reachable when the route names no capability, or names one this role
           holds. `requiredCapAny` is satisfied by any member. */
        const reachable = route.requiredCap
          ? holds(role, route.requiredCap)
          : (route.requiredCapAny
            ? route.requiredCapAny.some(c => holds(role, c))
            : true);
        if (!reachable) continue;

        if (!PAGE_META[persona]?.[tab]) missing.push(`${role} (${persona}) -> ${route.path} [${tab}]`);
      }
    }

    expect(
      [...new Set(missing)],
      'a role can open this page and is shown the bare product name instead of a title'
    ).toEqual([]);
  });
});

describe('the partner calendar, specifically', () => {
  it('is titled rather than falling back to the product name', () => {
    const meta = PAGE_META.partner.calendar;
    expect(meta, 'a partner opening /calendar is shown the bare product name').toBeTruthy();
    expect(meta.title).toBeTruthy();
    expect(meta.title).not.toBe('WeVolunteer');
    expect(meta.sub, 'an untitled subtitle is the fallback wearing a title').toBeTruthy();
  });

  it('is still absent from the partner rail', () => {
    /* Titling a page is not promoting it. Owner decision 6B kept the route
       reachable and unpromoted; `App.shellByRole.test.jsx` pins the rail itself,
       and this asserts the two halves are not confused for each other. */
    const src = readFileSync(path.resolve(__dirname, './App.jsx'), 'utf8');
    const navEntry = src.match(/id: 'calendar'[^\n]*\n/)?.[0] ?? '';
    expect(navEntry).toMatch(/requiredCapAny: \['event\.apply', 'event\.create'\]/);
  });
});
