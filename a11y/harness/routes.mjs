import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Parameter values that exist in the seeded database.
 *
 * Typed here rather than queried because a query needs a live connection and
 * this module is imported by a vitest guard that must not open one. They are
 * asserted against the running app by the sweep instead: a fixture that 404s
 * fails the route, which is the signal that a seed changed.
 *
 * The 13 parameterised routes these serve: /events/:id/edit, /checkin/:eventId,
 * /users/id/:id, /users/:handle, /users/:handle/badges,
 * /users/:handle/certificates, /users/:handle/hours, /organizations/:key,
 * /organizations/:key/edit, /organizations/invite/:token, /verify/:code,
 * /legal/:slug, /appeal/:token.
 */
export const FIXTURES = {
  /* Real values from the demo seed, read out of the database rather than
     guessed. The first version guessed — `id: '1'`, `handle: 'alex'`,
     `code: 'DEMOCERT1'` — and none of them existed: seeded ids are strings like
     `user-diana` and `event-softball`, and usernames are `dsorensen`,
     `jwhitfield`. Every one of those routes still returned HTTP 200, because
     React Router serves the shell either way, so the sweep measured a
     "not found" panel and reported it under the real route's name. That is worse
     than a skip: it looks like coverage. `walk.mjs` now detects it. */
  id: 'user-diana',
  eventId: 'event-softball',
  handle: 'dsorensen',
  code: 'WEV-8DLE-CNMH',
  slug: 'terms-of-service',
  /* No fixture is possible for these with the demo seed: `organizations` is
     empty, an appeal token is minted per decision, and an organization
     invitation token is 32 random bytes stored per club — so all three would
     have to be invented. Named here so the reason is recorded rather than
     looking like an oversight; walk.mjs reports them as unmeasured, which is the
     honest outcome.

     `token` is shared by `/appeal/:token` and `/organizations/invite/:token`,
     and both are unmeasurable for the same reason, so one placeholder is
     accurate for both. It stays a placeholder rather than becoming a real
     invitation link on purpose: seeding one would put a live bearer token into
     a committed fixture, which is the thing every other token in this codebase
     is arranged to avoid. The invitation page's own states are covered by
     `src/views/OrganizationInvite.test.jsx`, and its dialog inherits the shared
     `Modal` whose behaviour `dialogSemantics.test.jsx` pins. */
  key: 'no-seeded-organization',
  token: 'no-seeded-token'
};

const SRC = fs.readFileSync(path.join(ROOT, 'src/routes/index.jsx'), 'utf8');

/**
 * Which of the three route groups a path belongs to.
 *
 * This matters more than it looks. src/routes/index.jsx declares APP_ROUTES,
 * SIGNED_OUT_ROUTES and PUBLIC_ROUTES, and a SIGNED_OUT route redirects away the
 * moment somebody is authenticated. The first version of this harness signed in
 * before visiting everything, so /login, /signup and /welcome were measured
 * AFTER their redirect — i.e. the dashboard was audited three extra times and
 * the actual sign-in page, the one every unauthenticated visitor sees, was never
 * audited at all. The counts looked plausible, which is what made it dangerous.
 *
 * Parsed by slicing between the `export const X = [` markers rather than by
 * matching each entry, because an entry can span lines and carry nested objects.
 */
function groupOf() {
  const bounds = ['APP_ROUTES', 'SIGNED_OUT_ROUTES', 'PUBLIC_ROUTES']
    .map(name => ({ name, at: SRC.indexOf(`export const ${name} = [`) }))
    .filter(b => b.at >= 0)
    .sort((a, b) => a.at - b.at);

  const group = new Map();
  bounds.forEach((b, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1].at : SRC.length;
    const slice = SRC.slice(b.at, end);
    for (const m of slice.matchAll(/\{\s*path:\s*'([^']+)'/g)) {
      /* First declaration wins: ROUTES concatenates the arrays in this order and
         a duplicate path would resolve to the earlier one. */
      if (!group.has(m[1])) group.set(m[1], b.name);
    }
  });
  return group;
}

const GROUP = groupOf();

/**
 * Every route the table declares, with a URL that can actually be visited.
 *
 * Parsed from the route table for the same reason src/pageTitleCoverage.test.js
 * parses it: a route added tomorrow is swept the day it is added, not the day
 * somebody remembers this file. Splat routes are excluded — a catch-all is not
 * a page.
 */
export const ROUTES = [...SRC.matchAll(/\{\s*path:\s*'([^']+)'/g)]
  .map(m => m[1])
  .filter(p => !p.includes('*'))
  .map(routePath => {
    const parameterised = routePath.includes(':');
    const concrete = routePath.replace(
      /:([A-Za-z]+)/g,
      (whole, name) => (name in FIXTURES ? FIXTURES[name] : whole)
    );
    const group = GROUP.get(routePath) || 'APP_ROUTES';
    return {
      path: routePath,
      concrete,
      parameterised,
      group,
      /* A signed-out route cannot be measured while authenticated: it redirects.
         A public route is reachable either way and is worth measuring signed out,
         because that is how a shared link is opened. */
      signedOutOnly: group === 'SIGNED_OUT_ROUTES',
      reachableSignedOut: group !== 'APP_ROUTES'
    };
  });

/** Routes an authenticated sweep can actually measure. */
export const SIGNED_IN_ROUTES = ROUTES.filter(r => !r.signedOutOnly);

/** Routes an unauthenticated visitor can reach — sign-in, signup, legal, appeals. */
export const SIGNED_OUT_ROUTES = ROUTES.filter(r => r.reachableSignedOut);
