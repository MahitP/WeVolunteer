import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { tabForPath, PAGE_META } from './App.jsx';

/**
 * Every route the shell renders is titled for the page it is showing.
 *
 * ── The bug, three times ──
 *
 * `tabForPath` ends `return 'dashboard'`, so a path with no branch is silently
 * titled with the DASHBOARD's heading and subtitle, and lights the Dashboard
 * rail entry. It looks like a working page. It reads as though you never
 * navigated.
 *
 * That has now happened three times, and the function's own comments record the
 * first two: `/errors` ("the /errors bug this function's note above exists to
 * prevent") and then `/checkin`, `/portfolio` and `/organizer-agreement`, where
 * an organizer on the check-in screen read "Dashboard / Track your volunteers".
 * The third was `/appeals/new`: somebody contesting a decision taken about them
 * was shown "Dashboard / Your shifts, hours, and history".
 *
 * A comment did not stop the third one, so this is the test that does. It reads
 * the route table rather than a hand-written list, so a route added tomorrow is
 * covered the day it is added and not the day somebody remembers this file.
 */

const ROUTES_SRC = fs.readFileSync(path.join(process.cwd(), 'src/routes/index.jsx'), 'utf8');

/**
 * Concrete paths only. A parameterised path (`/users/:handle`) cannot be probed
 * without inventing a parameter, and `tabForPath` matches on prefix anyway, so
 * the parent segment is what actually decides the title.
 */
const CONCRETE = [...ROUTES_SRC.matchAll(/\{\s*path:\s*'([^']+)'/g)]
  .map(m => m[1])
  .filter(p => !p.includes(':') && !p.includes('*'));

/**
 * Paths that are legitimately the dashboard.
 *
 * `/` IS the dashboard. Everything else has to say what it is.
 */
const IS_ACTUALLY_THE_DASHBOARD = new Set(['/']);

/**
 * Signed-out screens, which render outside the shell entirely — no topbar, no
 * rail, so no title to get wrong. They are in the route table but never reach
 * `PAGE_META`.
 */
const OUTSIDE_THE_SHELL = new Set([
  '/login', '/signup', '/welcome', '/about', '/legal', '/privacy',
  '/appeal', '/reset-password', '/oauth/callback', '/verify',
]);

describe('every shell route is titled for itself', () => {
  it('finds routes to check, so this file cannot pass by finding none', () => {
    /* The vacuity guard. If the route-table regex stops matching — a quoting
       change in `routes/index.jsx` would do it — every `it.each` below iterates
       an empty list and the file reports success while testing nothing. */
    expect(CONCRETE.length).toBeGreaterThan(15);
    expect(CONCRETE).toContain('/appeals/new');
    expect(CONCRETE).toContain('/settings');
  });

  it.each(
    CONCRETE.filter(p => !IS_ACTUALLY_THE_DASHBOARD.has(p) && !OUTSIDE_THE_SHELL.has(p)),
  )('%s does not silently fall through to the dashboard', (route) => {
    /**
     * The whole defect in one assertion. `tabForPath` returning `'dashboard'`
     * for a path that is not the dashboard means the reader is told they are
     * somewhere they are not.
     */
    expect(
      tabForPath(route),
      `${route} has no branch in tabForPath, so it renders under the dashboard's `
      + 'title and lights the dashboard rail entry',
    ).not.toBe('dashboard');
  });

  it('gives every persona a title for each tab it can reach', () => {
    /**
     * A tab that exists in `tabForPath` but not in `PAGE_META` renders an
     * undefined title — a blank topbar rather than a wrong one. Checked per
     * persona because the object is keyed that way and a page reachable by an
     * organizer but described only for volunteers is the same defect wearing a
     * different hat.
     */
    const tabs = new Set(
      CONCRETE.filter(p => !OUTSIDE_THE_SHELL.has(p)).map(tabForPath),
    );
    const missing = [];
    for (const [persona, entries] of Object.entries(PAGE_META)) {
      for (const tab of tabs) {
        // Not every persona reaches every page; only complain when the page is
        // described for SOME persona and not this one, which is the drift case.
        const describedSomewhere = Object.values(PAGE_META).some(e => e[tab]);
        if (describedSomewhere && !entries[tab]) missing.push(`${persona}.${tab}`);
      }
    }
    /* Capability-gated admin pages are legitimately absent for a volunteer, so
       this asserts on the pages every signed-in account can reach. */
    const universal = missing.filter(m => /\.(appealForm|settings|notifications)$/.test(m));
    expect(universal, 'a page anybody can reach is undescribed for some persona').toEqual([]);
  });

  it('describes the appeal form, which anybody signed in may need', () => {
    /* Named explicitly because it is the case that got through, and because
       "you may contest a decision about you" is not a capability — every
       persona has to be able to reach it and be told where they are. */
    for (const [persona, entries] of Object.entries(PAGE_META)) {
      expect(entries.appealForm, `${persona} has no title for the appeal form`).toBeTruthy();
      expect(entries.appealForm.title).not.toBe('Dashboard');
    }
  });
});

describe('the table is actually applied', () => {
  /**
   * Every case above checks that PAGE_META HAS a title for each route. None of
   * them checked that anything ever used one — and for several releases nothing
   * did: `document.title` was never assigned, so every browser tab said
   * "WeVolunteer" while this file passed, because a complete table and a wrong
   * title are not the same claim.
   *
   * That is the failure mode this whole suite is meant to guard against, so it
   * is worth naming: a test of the DATA is not a test of the EFFECT, and the
   * gap between them is invisible from inside the data.
   *
   * Asserted against the source rather than by rendering, because reaching this
   * through a mount needs a router, a session and a dozen mocks — and the thing
   * in doubt is whether the assignment exists at all, which the source answers
   * directly.
   */
  const APP_SRC = fs.readFileSync(path.join(process.cwd(), 'src/App.jsx'), 'utf8');

  it('writes the page title to document.title', () => {
    expect(
      /document\.title\s*=/.test(APP_SRC),
      'nothing assigns document.title — every browser tab shows the same name, '
      + 'and a screen reader announces the same name on every navigation'
    ).toBe(true);
  });

  it('takes it from PAGE_META rather than a second hardcoded list', () => {
    /* A literal string here would drift from the table these cases check. */
    expect(APP_SRC).toMatch(/const documentTitle = pageMetaFor\(/);
  });

  it('keeps the product name in the tab', () => {
    /* "Settings" alone identifies nothing among a dozen open tabs. */
    expect(APP_SRC).toMatch(/\$\{documentTitle\} · \$\{APP_NAME\}/);
  });
});
