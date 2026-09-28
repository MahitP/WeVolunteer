import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every parameterised route says so when its parameter resolves to nothing.
 *
 * ── The failure this exists for ──
 *
 * React Router serves the shell for any path. So `/users/nobody` returns HTTP
 * 200, lands on exactly the requested URL, and renders "No profile here" — and
 * anything walking the routes to measure them records a healthy page under the
 * real route's name. The accessibility sweep did exactly that: six of twelve
 * parameterised routes were being measured on their not-found panel, and
 * `/certificates/:code` passed for months with two `h1` elements because the
 * panel it was measuring has one.
 *
 * `a11y/harness/walk.mjs` refuses to count a route that rendered a not-found
 * state, and it detects one by reading `data-error-kind`. That was
 * `ErrorExperience`'s attribute, so the check could only see views that say
 * "not found" with an `ErrorExperience` — and most of these say it with an
 * `EmptyState`. Those were invisible to it. That gap was recorded as the known
 * remaining exposure when the sweep's fixtures were fixed on 2026-09-03; this
 * file and `EmptyState`'s `notFound` prop close it.
 *
 * ── Why an inventory rather than a pattern ──
 *
 * "Does this view have a not-found branch" cannot be read off the source
 * reliably — `missing`, `not_found`, `invalid`, `err.status === 404` and a bare
 * `!data` all mean it, and a `404` in a comment means nothing. Guessing would
 * give a check that is quietly wrong in both directions.
 *
 * So every parameterised route is classified here by hand, and a separate case
 * fails if a route exists that nobody has classified. Adding a parameterised
 * route therefore forces the question this file is about, which is the only
 * moment anybody is in a position to answer it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..');
const ROUTES_FILE = path.join(HERE, 'index.jsx');
const routesSource = fs.readFileSync(ROUTES_FILE, 'utf8');

/** Every declared route path containing a `:param`, from the route table. */
const PARAMETERISED = [...routesSource.matchAll(/\{\s*path:\s*'([^']*:[^']*)'/g)]
  .map(m => m[1]);

/**
 * How each parameterised route answers a parameter that resolves to nothing.
 *
 * `marked` — the view renders a not-found state and flags it, so the sweep
 * discards the measurement instead of filing it under the route.
 *
 * `exempt` — the view has no not-found state to mark, with the reason. These
 * are the ones to re-read when this file next fails: an exemption that stops
 * being true is indistinguishable from a marker somebody forgot.
 */
const ROUTES = {
  '/users/:handle': { view: 'views/PublicProfile.jsx', marked: true },
  '/users/id/:id': { view: 'views/PublicProfile.jsx', marked: true },
  '/users/:handle/certificates': { view: 'views/PublicCertificates.jsx', marked: true },
  '/users/:handle/hours': { view: 'views/PublicServiceHistory.jsx', marked: true },
  '/organizations/:key': { view: 'views/OrganizationPage.jsx', marked: true },
  '/organizations/:key/edit': { view: 'views/OrganizationForm.jsx', marked: true },
  '/organizations/invite/:token': { view: 'views/OrganizationInvite.jsx', marked: true },
  '/legal/:slug': { view: 'views/legal/LegalDocument.jsx', marked: true },
  '/certificates/:code': { view: 'views/CertificateView.jsx', marked: true },
  '/verify/:code': { view: 'views/CertificateVerification.jsx', marked: true },

  '/users/:handle/badges': {
    view: 'views/BadgesPage.jsx',
    marked: true,
  },

  '/appeal/:token': {
    view: 'views/Appeal.jsx',
    exempt: 'The endpoint answers 404 for unknown, expired and spent alike, and '
      + 'the view deliberately gives all three one wording rather than telling a '
      + 'stranger which of the three a token was. Marking it would be a guess at '
      + 'which one happened.',
  },

  '/checkin/:eventId': {
    view: 'views/CheckInView.jsx',
    exempt: 'One panel covers "event not found" and "could not load", so the '
      + 'marker cannot be set without also claiming a network fault was a wrong '
      + 'address. Worth splitting; not worth guessing.',
  },

  '/events/:id/edit': {
    view: null,
    exempt: 'RedirectToEvent renders nothing — it resolves the id and navigates, '
      + 'so there is no panel to mark.',
  },
};

describe('a parameterised route that resolves to nothing says so', () => {
  it('finds the parameterised routes at all', () => {
    /* Without this the loops below iterate an empty list and the file passes
       while checking nothing — the way a guard stops guarding. */
    expect(PARAMETERISED.length, 'no parameterised routes resolved from the route table')
      .toBeGreaterThanOrEqual(10);
    expect(PARAMETERISED).toContain('/users/:handle');
  });

  it('classifies every parameterised route in the table', () => {
    const unclassified = [...new Set(PARAMETERISED)].filter(p => !ROUTES[p]);
    expect(
      unclassified,
      `Parameterised routes with no entry in this file: ${unclassified.join(', ')}. `
      + 'Decide what each renders when its parameter resolves to nothing. If it '
      + 'shows a not-found panel, pass `notFound` to its EmptyState (or set '
      + 'data-error-kind="404") and record it as marked; if it has no such state, '
      + 'record it as exempt with the reason. Left unclassified, the a11y sweep '
      + 'will measure the not-found panel and report it as coverage of the real page.',
    ).toEqual([]);
  });

  it('does not keep entries for routes that no longer exist', () => {
    /* An inventory nobody prunes turns into a list of claims about code that is
       gone, which is worse than no list: it reads as though it were checked. */
    const stale = Object.keys(ROUTES).filter(p => !PARAMETERISED.includes(p));
    expect(stale, `entries for routes not in the route table: ${stale.join(', ')}`)
      .toEqual([]);
  });

  const marked = Object.entries(ROUTES).filter(([, v]) => v.marked);

  it.each(marked)('%s flags its not-found state', (routePath, entry) => {
    const file = path.join(SRC, entry.view);
    expect(fs.existsSync(file), `${entry.view} does not exist`).toBe(true);
    const src = fs.readFileSync(file, 'utf8');

    /* Either spelling counts. `notFound` is the EmptyState prop; the raw
       attribute is what ErrorExperience and the hand-rolled panels set. A
       comment mentioning either would be a false pass, so both patterns are
       anchored to the syntax that actually renders something. */
    const hasProp = /\bnotFound(\s*=\s*\{|\s|\n|\/)/.test(src);
    const hasAttr = /data-error-kind\s*=/.test(src);

    expect(
      hasProp || hasAttr,
      `${entry.view} backs ${routePath} and is recorded as marking its not-found `
      + 'state, but neither `notFound` nor `data-error-kind` appears in it. The '
      + 'a11y sweep will measure that panel and report it as coverage of '
      + `${routePath}. Pass \`notFound\` to the EmptyState on the branch that `
      + 'means "this does not exist" — not to one that means "empty" or "could '
      + 'not load".',
    ).toBe(true);
  });
});
