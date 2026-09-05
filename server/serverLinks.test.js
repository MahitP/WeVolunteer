import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { CLIENT_ROUTE_PATTERNS, EXCLUDED_CLIENT_ROUTES } from './clientRoutes.js';

/**
 * Guards against a SERVER-generated link that points at no client route.
 *
 * ── Why this exists beside `src/internalLinks.test.js` rather than inside it ──
 *
 * That test already makes this argument, and makes it well: a dead internal
 * link is normally cosmetic, and the ones that are not are the ones inside a
 * flow where somebody is being asked to rely on the product. It scans `src/`
 * for `href="/…"` and `to="/…"`.
 *
 * The server hands people URLs too, and none of them are written that way. They
 * are `link:` fields on notification content and `${APP_URL}/…` template
 * literals in `email.js` — so every destination the product mails or notifies
 * somebody with was outside the only guard that checks destinations exist. Three
 * were broken at once when this was written:
 *
 *   • `${APP_URL}/accept-invitation?token=…` — the administrator invitation
 *     email. `/accept-invitation` was not a declared route, so EVERY
 *     administrator invitation this platform ever sent ended on "Page not
 *     found". The token hashing, the expiry, the single-use flag and the
 *     promote-and-audit transaction were all finished and tested.
 *
 *   • `ADMIN_PROMOTED`'s `link: '/admin'` — the notification a person receives
 *     at the moment they become an administrator. `/admin` is not a route
 *     either; the areas live under `/admin/moderation` and friends. So the first
 *     thing a new administrator pressed was a 404.
 *
 *   • `alerting.js`'s backup-failure email, also `/admin` — the one message that
 *     fires when the database holding every student's service record has no
 *     backup.
 *
 * All three had the same shape: correct feature, correct security posture,
 * destination that does not exist, and no test able to see it. Hence a second
 * scan rather than a widened first one — the two look at different files, in
 * different projects, for differently-written links.
 *
 * ── Validated against `clientRoutes.js`, which is already kept in step ──
 *
 * The obvious source of truth is `src/routes/index.jsx`, and a server test must
 * not import it: it pulls React, `react-router-dom` and every `lazy()`
 * component reference into the server project to read a list of strings. That
 * is the exact reasoning `clientRoutes.js` was created for.
 *
 * So the resolvable set is `CLIENT_ROUTE_PATTERNS` together with the keys of
 * `EXCLUDED_CLIENT_ROUTES`. That union is provably every path the client
 * declares, because `clientRoutes.test.js` fails the build on any declared path
 * that is in neither — which is what makes it safe to check against here
 * instead of against the table itself. Excluded routes are included in the
 * union deliberately: exclusion is a statement about what an error report may
 * NAME, not about whether the page exists.
 */

const SERVER = path.join(process.cwd(), 'server');

/** Every declared client path, however its error reports are classified. */
const RESOLVABLE = [...CLIENT_ROUTE_PATTERNS, ...Object.keys(EXCLUDED_CLIENT_ROUTES)];

/** Whether a concrete path matches a declared `:param` pattern, segment-wise. */
function matchesPattern(pathname, pattern) {
  const segments = pathname.split('?')[0].split('#')[0].split('/').filter(Boolean);
  const parts = pattern.split('/').filter(Boolean);
  if (parts.length !== segments.length) return false;
  return parts.every((part, i) => part.startsWith(':') || part === segments[i]);
}

function serverFiles(dir = SERVER, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      serverFiles(full, found);
      continue;
    }
    if (!/\.js$/.test(entry.name)) continue;
    if (/\.test\.js$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

/**
 * A template hole becomes a `:param` segment.
 *
 * `${APP_URL}/organizations/${slug}` is one path with one unknown, and the
 * unknown occupies exactly one segment — the same assumption the router makes.
 * Collapsing it to `:x` lets a parameterised server link be checked against a
 * parameterised route pattern instead of being skipped, which is the difference
 * between this catching `/organizations/invite/${token}` and not.
 *
 * A hole that spans a `/` would be mis-read by this, and that is acceptable: no
 * link in this codebase is built that way, and the failure mode is a loud false
 * positive on a line somebody is already editing, not a silent miss.
 */
const normalise = (raw) => raw.replace(/\$\{[^}]*\}/g, ':x');

/**
 * Destinations the server hands to a person, as `{ path, file, line, kind }`.
 *
 * Two forms, because the server writes links two ways:
 *
 *   `link: '/settings?section=security'`   in-app notification content
 *   `${APP_URL}/verify/${code}`            an absolute URL for an email
 *
 * Values that are not literals — `link: payload.link`, `link: null`, and the
 * `event:<id>` scheme the notification list resolves client-side rather than
 * navigating to — are skipped. A test that guessed at a runtime value would
 * produce false failures, which is how a guard gets deleted.
 */
function serverLinks() {
  const links = [];
  for (const file of serverFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const at = { file: path.relative(process.cwd(), file), line: i + 1 };

      /* Notification `link:` fields, single- or double-quoted literals. */
      for (const m of line.matchAll(/\blink:\s*['"](\/[^'"]*)['"]/g)) {
        links.push({ path: m[1], kind: 'notification link', ...at });
      }
      /* Ternary arms — `payload.x ? `/a/${x}` : '/a'` — carry a literal too. */
      for (const m of line.matchAll(/\?\s*`(\/[^`]*)`\s*:/g)) {
        links.push({ path: normalise(m[1]), kind: 'notification link', ...at });
      }
      for (const m of line.matchAll(/:\s*['"](\/[a-z][^'"]*)['"]\s*$/g)) {
        if (/\blink:/.test(line)) continue; // already taken above
        if (!/\?/.test(line)) continue;     // only the else-arm of a ternary
        links.push({ path: m[1], kind: 'notification link', ...at });
      }
      /* Absolute URLs built for email and alerting. */
      for (const m of line.matchAll(/\$\{(?:APP_URL|appUrl)\}(\/[A-Za-z0-9@:_\-./${}]*)/g)) {
        links.push({ path: normalise(m[1]), kind: 'emailed URL', ...at });
      }
    });
  }
  return links;
}

describe('server-generated links', () => {
  const links = serverLinks();

  it('finds links at all, so the scan cannot silently pass', () => {
    // The same reasoning as internalLinks.test.js and the router-stack walk in
    // authz.completeness.test.js: a scan that reports success over an empty set
    // is worse than no scan, because it looks like coverage.
    expect(links.length).toBeGreaterThan(10);
  });

  it('sees both of the forms the server writes links in', () => {
    // If a refactor changes how emails build URLs, or moves notification
    // content, this fails rather than quietly covering one form only.
    const kinds = new Set(links.map(l => l.kind));
    expect([...kinds].sort()).toEqual(['emailed URL', 'notification link']);
  });

  it('every notified and emailed destination resolves to a declared route', () => {
    const dangling = links
      .filter(l => l.path !== '/')
      .filter(l => !RESOLVABLE.some(pattern => matchesPattern(l.path, pattern)))
      .map(l => `${l.path} — ${l.kind} at ${l.file}:${l.line}`);

    expect(
      dangling,
      'these are dead links in mail and in-app notifications: the product sends '
      + 'somebody to a path the client does not declare, and they get the '
      + 'unknown-URL 404. Fix the link, or declare the route in '
      + 'src/routes/index.jsx and allow it in server/clientRoutes.js.'
    ).toEqual([]);
  });

  it('keeps the administrator invitation email pointing at a real screen', () => {
    // Named explicitly rather than left to the sweep. This is the link whose
    // breakage was the incident, and the sweep goes quiet the moment somebody
    // rewrites the line into an expression it cannot read.
    const email = readFileSync(path.join(SERVER, 'email.js'), 'utf8');
    const match = email.match(/\$\{APP_URL\}(\/accept-invitation)\?token=/);
    expect(match, 'the admin invitation email no longer links to /accept-invitation').toBeTruthy();
    expect(RESOLVABLE).toContain('/accept-invitation');
  });

  it('finds the notification content module where it expects it', () => {
    // The `link:` half of the scan is almost entirely one file. If it moves, the
    // sweep above would still pass over the remaining handful and report
    // coverage it does not have.
    const content = path.join(SERVER, 'services', 'notificationContent.js');
    expect(statSync(content).isFile()).toBe(true);
    const found = links.filter(l => l.file.endsWith('services/notificationContent.js'));
    expect(found.length, 'no notification links were extracted at all').toBeGreaterThan(10);
  });
});
