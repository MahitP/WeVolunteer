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
 * The 12 parameterised routes these serve: /events/:id/edit, /checkin/:eventId,
 * /users/id/:id, /users/:handle, /users/:handle/badges,
 * /users/:handle/certificates, /users/:handle/hours, /organizations/:key,
 * /organizations/:key/edit, /verify/:code, /legal/:slug, /appeal/:token.
 */
export const FIXTURES = {
  id: '1',
  eventId: '1',
  handle: 'alex',
  key: '1',
  code: 'DEMOCERT1',
  slug: 'terms',
  token: 'demo-appeal-token'
};

const SRC = fs.readFileSync(path.join(ROOT, 'src/routes/index.jsx'), 'utf8');

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
    return { path: routePath, concrete, parameterised };
  });
