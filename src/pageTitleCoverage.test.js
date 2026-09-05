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
  '/login', '/signup', '/welcome', '/about', '/privacy',
  '/appeal', '/reset-password', '/oauth/callback', '/verify',
  /**
   * The administrator-invitation acceptance screen.
   *
   * Exempt for the reason `/verify` and `/appeal` are, and NOT for the reason
   * `/legal` wrongly was: it carries no `shellWhenSignedIn`, so `isPublicPath`
   * answers true in BOTH session states and App.jsx serves it standalone
   * before the session branches. It therefore never reaches `PAGE_META` and has
   * no shell title to get wrong — it sets its own tab title with
   * `useDocumentTitle` and owns its own `h1`.
   *
   * The distinction the `/legal` note above draws is the one to check before
   * adding anything else here: a route that DOES reach `PAGE_META` and is
   * described wrongly is the defect this file exists to catch, not an exemption.
   */
  '/accept-invitation',
]);

/**
 * `/legal` was on the list above, and it was the fourth instance of the defect
 * this file exists to catch.
 *
 * PUBLIC is not the same as OUTSIDE THE SHELL. A signed-out reader gets the
 * Legal Center on its own, but a signed-in one gets it inside the shell with
 * the topbar and the rail — and `tabForPath` had no `/legal` branch, so it fell
 * through to `return 'dashboard'`. Every legal document's browser tab said
 * "Dashboard · WeVolunteer", measured live on `/legal/accessibility-statement`,
 * which is a WCAG 2.4.2 failure on the pages a reader is most likely to have
 * opened in a background tab to compare against another.
 *
 * Removing it from the exemption is what makes the case below cover it. The
 * exemption is for routes that genuinely never reach `PAGE_META`; a route that
 * reaches it and is described wrongly is the thing being tested.
 */


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

/**
 * The gap every case above left open: a PUBLIC route, opened by somebody who is
 * SIGNED IN.
 *
 * The suite's `OUTSIDE_THE_SHELL` exemption rests on "no topbar, no rail, so no
 * title to get wrong". That is true of the topbar heading. It is NOT true of the
 * browser tab, and the difference is worth stating precisely, because it is the
 * reason three of these shipped at once:
 *
 * `App.jsx` sets `document.title` from `tabForPath` in an effect placed
 * deliberately ABOVE its early returns — including the public-route return —
 * so that the hook order cannot vary between renders. The effect therefore runs
 * for a standalone public page too, and `tabForPath` ends `return 'dashboard'`.
 * A signed-out reader is unaffected (`pageMetaFor` with no account yields the
 * bare product name), which is exactly why this stayed invisible: every one of
 * these pages is correct in the session most people test them in.
 *
 * Measured live on 2026-09-06, signed in, against the merged tree:
 *
 * | path                     | `<h1>`                          | browser tab               |
 * |--------------------------|---------------------------------|---------------------------|
 * | `/verify/WEV-UENF-2DM9`  | Verified Certificate            | Dashboard · WeVolunteer   |
 * | `/about`                 | About WeVolunteer               | Dashboard · WeVolunteer   |
 * | `/appeal/:token`         | This link does not work any more| Dashboard · WeVolunteer   |
 *
 * `/verify` is the worst of the three by some distance. It is the page students
 * are told to hand to an admissions office, so it is the tab most likely to be
 * open in a stranger's browser next to several others — and a WCAG 2.4.2 (Page
 * Titled, Level A) failure on the one page whose whole job is to be trusted by
 * an outsider. `/appeal` is the second worst for a different reason: somebody
 * contesting a decision made about them was told they were on a dashboard.
 *
 * Two ways to be correct, and this accepts either, because which one is right
 * depends on whether the title is a property of the ROUTE or of the ANSWER:
 *
 *   1. a `tabForPath` branch, when the path alone names the page; or
 *   2. `useDocumentTitle` inside the view, when it does not — `/verify` is a
 *      search box, a verdict, or a rate-limit notice at the same URL.
 *
 * Asserted from source rather than by rendering for the reason the block above
 * gives: the question is whether the assignment exists at all.
 */
describe('public routes name their own tab for a signed-in reader', () => {
  const PUBLIC_BLOCK = ROUTES_SRC.slice(
    ROUTES_SRC.indexOf('export const PUBLIC_ROUTES = ['),
    ROUTES_SRC.indexOf('export function isPublicPath'),
  );

  /* `shellWhenSignedIn` routes get the shell, the topbar and a `tabForPath`
     branch checked by the cases above; they are a different shape and are not
     what this describes. A `<Navigate>` element renders for one frame on its way
     somewhere else and has no page to title, which is the `/directory`
     precedent `tabForPath` already records. */
  const STANDALONE = [...PUBLIC_BLOCK.matchAll(
    /\{\s*path:\s*'([^']+)'\s*,\s*element:\s*<(\w+)[^>]*\/>\s*(,\s*shellWhenSignedIn:\s*true)?\s*\}/g,
  )]
    .map(([, path, component, shell]) => ({ path, component, shell: Boolean(shell) }))
    .filter(r => !r.shell && r.component !== 'Navigate');

  it('finds the public routes, so this cannot pass by finding none', () => {
    /* The vacuity guard, for the same reason the suite already has one: these
       are regexes over source, and a formatting change would silently empty
       them while every `it.each` below reported success. */
    expect(STANDALONE.length).toBeGreaterThan(3);
    expect(STANDALONE.map(r => r.path)).toContain('/verify/:code');
    expect(STANDALONE.map(r => r.path)).toContain('/about');
  });

  it.each(STANDALONE)('$path ($component) is not titled "Dashboard"', (route) => {
    /* `route.path`, not a destructured `path` — this file imports node's `path`
       module, and destructuring here shadows it exactly where the view's source
       file has to be resolved. */
    const probe = route.path.replace(/\/:[^/]+/g, '') || '/';
    if (tabForPath(probe) !== 'dashboard') return;

    /* No route-level branch, so the view must name its own tab. */
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/views', `${route.component}.jsx`),
      'utf8',
    );

    expect(
      /useDocumentTitle\s*\(/.test(source),
      `${route.path} has no branch in tabForPath, so App.jsx titles it "Dashboard `
      + `· WeVolunteer" for a signed-in reader, and ${route.component}.jsx does not `
      + 'call useDocumentTitle to correct it. Give it a tabForPath branch if the '
      + 'path names the page, or call useDocumentTitle if the title depends on '
      + 'what the page found.',
    ).toBe(true);
  });
});
