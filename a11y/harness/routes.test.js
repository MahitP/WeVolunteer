import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES, FIXTURES } from './routes.mjs';

/**
 * The inventory is derived, and this proves it stayed derived.
 *
 * src/pageTitleCoverage.test.js exists because tabForPath silently titled
 * unknown paths as the dashboard, three separate times, and a hand-written list
 * is what let each one hide. The same trap applies harder here: a route missing
 * from a sweep is not a wrong heading, it is a page nobody ever audited, and
 * nothing about a green run would say so.
 *
 * So the count is asserted against the route table itself rather than against a
 * number typed here, and every parameterised path must resolve to something
 * probeable. A skip would be the quiet failure: /appeal/:token and /verify/:code
 * are exactly the awkward ones somebody would skip, and they are also where
 * somebody contests a decision taken about them.
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/routes/index.jsx'), 'utf8'
);
const DECLARED = [...SRC.matchAll(/\{\s*path:\s*'([^']+)'/g)].map(m => m[1]);

describe('the accessibility route inventory', () => {
  it('found the route table at all', () => {
    /* Guards the guard: a moved or renamed file would make every assertion
       below pass against an empty list. */
    expect(DECLARED.length).toBeGreaterThan(40);
  });

  it('covers every declared route', () => {
    const covered = new Set(ROUTES.map(r => r.path));
    const missing = DECLARED.filter(p => !p.includes('*') && !covered.has(p));
    expect(missing, `routes declared but not swept: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives every parameterised route a concrete probeable path', () => {
    const unresolved = ROUTES
      .filter(r => r.parameterised)
      .filter(r => r.concrete.includes(':'));
    expect(unresolved.map(r => r.path),
      'a parameterised route with no fixture must FAIL, not skip').toEqual([]);
  });

  it('has a fixture for every distinct parameter name', () => {
    const names = new Set();
    for (const p of DECLARED) {
      for (const m of p.matchAll(/:([A-Za-z]+)/g)) names.add(m[1]);
    }
    const missing = [...names].filter(n => !(n in FIXTURES));
    expect(missing, `parameters with no fixture: ${missing.join(', ')}`).toEqual([]);
  });

  it('excludes catch-all routes, which are not pages', () => {
    expect(ROUTES.filter(r => r.path.includes('*'))).toEqual([]);
  });
});
