import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROUTES, SIGNED_OUT_ROUTES, PUBLIC_ROUTES } from './index.jsx';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_JSX = readFileSync(path.join(SRC, 'App.jsx'), 'utf8');

/**
 * A capability written on a route must be a capability the route is behind.
 *
 * ── The class of mistake ──
 *
 * There are three route tables and only ONE of them is gated. `APP_ROUTES` is
 * filtered through `deniedRoute()` in App.jsx; `PUBLIC_ROUTES` and
 * `SIGNED_OUT_ROUTES` render their element directly, because their whole
 * purpose is to be reachable without a session. So a `requiredCap` written on an
 * entry in either of those two tables is *decoration*: it reads exactly like
 * every other gated route in the file, it passes review, the app boots, every
 * existing test stays green — and the requirement silently does not apply.
 *
 * The same is true one level down. `deniedRoute` honours `requiredCap` and
 * `requiresVerified` and deliberately nothing else — its own comment says so and
 * explains why — while the NAV table in the same file also supports
 * `requiredCapAny`. Those two vocabularies sitting side by side in one file is
 * the trap: `requiredCapAny` on an `APP_ROUTES` entry would be just as
 * decorative as a `requiredCap` in `PUBLIC_ROUTES`, and it is the more likely
 * mistake, because a developer copying a NAV entry has no reason to suspect the
 * key is not universal.
 *
 * `routes.test.jsx` already asserts that every declared capability NAME is real.
 * That is a different property, and it is the one that makes this gap easy to
 * miss: a decorative `requiredCap` names a perfectly real capability.
 *
 * ── Why this is derived rather than listed ──
 *
 * Asserting today's route list would catch nothing tomorrow. Guard 2 below reads
 * the enforcement function's own source and requires that every gate key any
 * route actually uses appears in it. Add a new key to a table and forget to
 * teach `deniedRoute` about it, and this fails — which is the regression that
 * matters, because that is the direction the mistake travels.
 *
 * Recorded in CHANGELOG under v1.2c: an entry claimed `/admin/impact` had once
 * shipped in `PUBLIC_ROUTES` carrying a `requiredCap`. It had not — no release
 * ever carried it — but the hazard the entry described was real and, until this
 * file, entirely unguarded.
 */

/** Keys that express an access condition on a route entry. */
const GATE_KEYS = ['requiredCap', 'requiredCapAny', 'requiresVerified'];

/** The ungated tables, by the name they are declared under. */
const UNGATED_TABLES = [
  ['PUBLIC_ROUTES', PUBLIC_ROUTES],
  ['SIGNED_OUT_ROUTES', SIGNED_OUT_ROUTES]
];

/**
 * The body of `deniedRoute`, which is the only thing that gates `APP_ROUTES`.
 *
 * Extracted by source scan rather than by calling it, because the property under
 * test is "which keys does this function look at", and that is a fact about the
 * text. Calling it could only demonstrate the keys a chosen fixture happens to
 * exercise.
 */
function deniedRouteBody() {
  const start = APP_JSX.indexOf('function deniedRoute(');
  if (start === -1) return null;

  // Brace-match from the opening brace so the scan cannot silently read a
  // truncated body if the function grows or moves.
  const open = APP_JSX.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < APP_JSX.length; i++) {
    if (APP_JSX[i] === '{') depth++;
    else if (APP_JSX[i] === '}') {
      depth--;
      if (depth === 0) return APP_JSX.slice(open, i + 1);
    }
  }
  return null;
}

describe('route gating cannot become decorative', () => {
  /**
   * Guard 0 — the scan can see what it claims to scan.
   *
   * Without this, a rename of `deniedRoute` turns every assertion below into a
   * pass over an empty string. The repository's other static guards each carry
   * an equivalent self-check for the same reason.
   */
  it('finds the enforcement function and the tables it is meant to scan', () => {
    expect(deniedRouteBody(), 'deniedRoute() not found in App.jsx — this guard is scanning nothing').toBeTruthy();
    expect(APP_ROUTES.length).toBeGreaterThan(0);
    expect(PUBLIC_ROUTES.length).toBeGreaterThan(0);
    expect(SIGNED_OUT_ROUTES.length).toBeGreaterThan(0);
    // At least one route must actually declare a gate, or guard 2 is vacuous.
    expect(APP_ROUTES.some(r => GATE_KEYS.some(k => k in r))).toBe(true);
  });

  /**
   * Guard 1 — no access condition may be declared on a table that has no gate.
   *
   * These tables render `route.element` directly. Anything here that looks like
   * a requirement is a requirement nobody applies.
   */
  for (const [name, table] of UNGATED_TABLES) {
    it(`${name} declares no access conditions, because nothing enforces them`, () => {
      const offenders = table
        .filter(route => GATE_KEYS.some(key => key in route))
        .map(route => `${route.path} declares ${GATE_KEYS.filter(k => k in route).join(', ')}`);

      expect(
        offenders,
        `${name} is rendered without any capability check, so these conditions would `
        + 'silently not apply. Move the route to APP_ROUTES, or drop the condition.'
      ).toEqual([]);
    });
  }

  /**
   * Guard 2 — every gate key APP_ROUTES uses is one deniedRoute actually reads.
   *
   * This is the future-proofing half. `requiredCapAny` is the live example: it is
   * valid on a NAV entry in the same file and inert on a route, and nothing else
   * in the codebase would report the difference.
   */
  it('APP_ROUTES uses only gate keys that deniedRoute() enforces', () => {
    const body = deniedRouteBody();
    const used = GATE_KEYS.filter(key => APP_ROUTES.some(route => key in route));
    const unenforced = used.filter(key => !body.includes(`route.${key}`));

    expect(
      unenforced,
      'APP_ROUTES declares these conditions but deniedRoute() never reads them, so '
      + 'they are decorative. Either enforce them in deniedRoute() or stop declaring them.'
    ).toEqual([]);
  });

  /**
   * Guard 3 — a gated path may not also be reachable as a public one.
   *
   * `routes.test.jsx` already forbids duplicate paths across the concatenated
   * table, which covers the exact-match case. This covers the one it cannot see:
   * a public route whose pattern *matches* a gated path, which would shadow the
   * gate without ever being a duplicate of it.
   */
  it('no public route pattern shadows a gated route path', () => {
    const toRegex = pattern => new RegExp(
      '^' + pattern.replace(/:[^/]+/g, '[^/]+').replace(/\//g, '\\/') + '$'
    );

    const shadowed = [];
    for (const pub of PUBLIC_ROUTES) {
      const re = toRegex(pub.path);
      for (const app of APP_ROUTES) {
        if (app.path !== pub.path && re.test(app.path)) {
          shadowed.push(`${pub.path} (public) matches ${app.path} (gated)`);
        }
      }
    }

    expect(shadowed, 'a public route pattern would render before the gated one').toEqual([]);
  });
});
