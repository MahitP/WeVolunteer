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
 *
 * A value that CANNOT be written down belongs in `fixtures.mjs`, which asks the
 * running application at walk time and whose answer `walk.mjs` merges over this
 * table. Every name still needs an entry here — the guard requires one, and a
 * placeholder that names its own absence is how the two unresolvable ones are
 * already recorded.
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
  /* NOT a code, on purpose, and it must never be replaced by one that looks
     like a code. `generateCode` in server/certificates.js builds a certificate
     code from `crypto.randomBytes`, so it is different in every scratch
     database and no literal can survive a reseed — two consecutive ones gave
     `WEV-3CVD-ZJS6` and `WEV-5U93-8FP9`. The literal that used to sit here,
     `WEV-8DLE-CNMH`, had therefore never resolved: `/verify/WEV-8DLE-CNMH`
     answered 200, landed on exactly that path and rendered "Invalid
     Certificate", which the sweep measured and reported as coverage of the
     public verification page. `fixtures.mjs` resolves the real one from
     `/api/certificates` at walk time; this placeholder is what stands if that
     lookup finds nothing, and it renders a panel `walk.mjs` can recognise, so
     the route is reported unmeasured rather than silently audited. */
  code: 'no-live-certificate-code',
  slug: 'terms-of-service',
  /**
   * No fixture is possible for these with the demo seed.
   *
   * `organizations` is empty, an appeal token is minted per decision, and an
   * organization invitation token is 32 random bytes stored per club — so all
   * three would have to be invented. Named here so the reason is recorded
   * rather than looking like an oversight; walk.mjs reports them as unmeasured,
   * which is the honest outcome.
   *
   * `token` is shared by `/appeal/:token` and `/organizations/invite/:token`,
   * and both are unresolvable for the same reason, so one placeholder is
   * accurate for both — which is why it is not named after either.
   *
   * It stays a placeholder rather than becoming a real invitation link on
   * purpose. `fixtures.mjs` is the right home for a value that has to be asked
   * of the running application, and an organization key genuinely belongs there
   * the day the demo seed gains a club — but an invitation token does not:
   * resolving one would put a live bearer credential into the walk, which is
   * the thing every other token in this codebase is arranged to avoid. The
   * invitation page's own states are covered by
   * `src/views/OrganizationInvite.test.jsx`.
   *
   * `/organizations/:key` IS now partly measured despite the placeholder,
   * because that path is served to a signed-out reader as well and the
   * placeholder lands on its "this page needs an account" state — which owns an
   * `h1` precisely so the sweep has something to measure there.
   */
  key: 'no-seeded-organization',
  token: 'no-seeded-token'
};

/**
 * A route path with its parameters filled in.
 *
 * Pure, and takes the values as an argument, so the same substitution serves
 * two callers that must not share a dependency: `ROUTES` below builds its
 * `concrete` from the typed table alone — no server, no database, which is what
 * lets `routes.test.js` import this module — while `walk.mjs` calls it again
 * with whatever `fixtures.mjs` resolved from the running application layered on
 * top. One implementation, so the URL the guard checks and the URL the sweep
 * visits cannot drift apart.
 *
 * A null or empty override is ignored rather than substituted, so a lookup that
 * found nothing falls back to the typed placeholder instead of navigating to
 * `/verify/null`.
 */
/**
 * Query strings a route needs before it renders the page it names.
 *
 * ── Why this exists, and why FIXTURES could not cover it ──
 *
 * `FIXTURES` fills `:param` SEGMENTS. `/accept-invitation` has none: the
 * administrator-invitation token arrives in the QUERY, because that is the URL
 * `sendAdminInvitationEmail` has always built. So the sweep visited the path
 * bare, the page rendered its "this invitation link is incomplete" branch, and
 * the walk would have reported that panel as coverage of the acceptance screen
 * — the same false-coverage failure `/verify/:code` was fixed for, and worse
 * than a skip because it produces numbers that look like coverage.
 *
 * The view now marks that branch with `data-error-kind="404"`, so `walk.mjs`
 * reports the route UNMEASURED rather than lying about it. This map is the half
 * that makes it measured instead of merely honest.
 *
 * ── Why a literal token is correct here, unlike a certificate code ──
 *
 * `code` cannot be written down: `generateCode` draws from
 * `crypto.randomBytes`, so every reseed mints a different one and the literal
 * that used to sit in FIXTURES had never resolved. An invitation token is
 * different — not because it is predictable, but because
 * `AcceptInvitation` does not VALIDATE it before rendering. The token is only
 * sent when somebody presses the button, deliberately: it is single-use, and a
 * mail prefetcher or a URL scanner must not be able to burn it. So any
 * non-empty value renders the real decision screen, which is the page that
 * needs measuring.
 *
 * That is a property of the view, so it is stated here rather than assumed:
 * `AcceptInvitation.test.jsx` pins it with "never accepts on mount, however
 * valid the token looks".
 */
export const QUERY = {
  '/accept-invitation': '?token=a11y-sweep-token-not-redeemed',
};

export function concreteFor(routePath, overrides = {}) {
  const filled = routePath.replace(/:([A-Za-z]+)/g, (whole, name) => {
    const live = overrides[name];
    if (live) return String(live);
    return name in FIXTURES ? FIXTURES[name] : whole;
  });
  /* Appended AFTER substitution, so a route could carry both a parameter and a
     query without the query being scanned for `:name`. */
  return filled + (QUERY[routePath] ?? '');
}

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
    const concrete = concreteFor(routePath);
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
