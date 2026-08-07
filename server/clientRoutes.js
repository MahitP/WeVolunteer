/**
 * The client route patterns an error report is allowed to name.
 *
 * ── This is an allowlist for error reporting. It is NOT a second router. ──
 *
 * It decides nothing about what the application serves or how it navigates —
 * `src/routes/index.jsx` and `src/App.jsx` own that, and always will. The only
 * question this file answers is: *which strings may be written into
 * `error_groups.route`?* Keeping those two jobs apart is what lets this list be
 * conservative. A route can be deliberately left out of it, and the application
 * is entirely unaffected; the reports for that route simply say `unknown`.
 *
 * ── Why the patterns are here and not read from APP_ROUTES ──
 *
 * `APP_ROUTES` lives in `src/routes/index.jsx`, which imports React and
 * `react-router-dom` and holds `lazy()` component references. `errorReporter.js`
 * imports nothing but `node:crypto` and this file — the property that lets it be
 * driven by a test without booting anything, and the same one `server/reauth.js`
 * has. Importing the client route table into the server would pull React into
 * the server process to read nine strings.
 *
 * So the server owns plain data and a build-failing guard keeps it in step —
 * the shape `server/sensitiveActions.js` already uses to be safe in both the
 * server and the browser bundle, and `src/capabilityNames.test.js` already uses
 * to stop a client declaration drifting from a server list.
 *
 * ── Why storing the PATTERN is the whole privacy mechanism ──
 *
 * A client sends the route it thinks it was on. That string carries whatever the
 * URL carried: `/events?q=<a home address>`, `/reset-password?token=<a live
 * token>`, `/verify/<a certificate code>`. None of it is ever stored, because
 * the stored value is the matched pattern and not the input. `/verify/:code` is
 * therefore safe to allow: the code cannot survive matching.
 *
 * ── Zero imports, and it must stay that way ──
 *
 * No React, no react-router-dom, no Express, no `db`. Data only. A file that
 * holds nothing but strings cannot acquire a runtime dependency by accident, and
 * `clientRoutes.test.js` fails the build if one appears.
 */

/** What a route that matched nothing is recorded as. Never the raw path. */
export const UNKNOWN_ROUTE = 'unknown';

/**
 * Approved patterns, in the client's own `:param` syntax.
 *
 * A `:param` segment matches exactly one path segment and is stored as the
 * literal `:param` text, so the value that occupied it is discarded rather than
 * recorded.
 *
 * The signed-out routes are here on purpose and are not an oversight. The intake
 * endpoint is unauthenticated precisely so that a crash on the login screen is
 * visible — "requiring auth would hide exactly the failures that lock people
 * out" — and leaving `/login` off this list would report every one of those as
 * `unknown`, which defeats the reason the endpoint accepts them at all.
 *
 * `/reset-password` and `/oauth/callback` are the two paths whose query strings
 * carry live secrets (a reset token; an OAuth `code` and `state`). They are
 * still allowed, because the query string is dropped before matching and only
 * the pattern is stored. If that ordering is ever weakened, these two are the
 * entries to reconsider first.
 */
export const CLIENT_ROUTE_PATTERNS = Object.freeze([
  // Shell routes declared in src/App.jsx rather than the route table.
  '/',
  '/profile',
  '/oauth/callback',
  '/reset-password',

  // src/routes/index.jsx — APP_ROUTES
  '/events',
  '/events/new',
  '/events/:id/edit',
  '/checkin/:eventId',
  '/calendar',
  '/impact',
  '/notifications',
  '/messages',
  '/portfolio',
  '/settings',
  /* The Organizer Agreement acceptance screen. A literal path carrying no
     parameter, so it says nothing about who was reading it. */
  '/organizer-agreement',
  /* Allowed, not excluded. The path is a literal with no parameter, so it can
     carry no value about anybody. And a crash ON the triage screen is the one
     failure that must never report as `unknown`: it is the tool used to find
     every other failure, so a blind spot here hides all of them. */
  '/errors',
  '/admin/appeals',
  '/admin/audit-logs',
  '/admin/roster',

  // src/routes/index.jsx — SIGNED_OUT_ROUTES
  '/welcome',
  '/login',
  '/signup',

  // src/routes/index.jsx — PUBLIC_ROUTES
  '/verify/:code',
  /* Allowed. A literal path with no parameter, so it can carry nothing about
     anybody — and it is read by people who have no account yet, which makes a
     crash here one that costs a signup rather than an inconvenience. */
  '/privacy',
  /* The Legal Center. Allowed for the same reason as `/privacy`, and the
     `:slug` parameter is safe under the rule this file is built on: the stored
     value is the matched PATTERN, so the slug cannot survive matching. It would
     be harmless even if it did — a policy slug is public and identical for every
     reader, so it says nothing about who was reading it. */
  '/legal',
  '/legal/:slug',
  '/appeal/:token',
]);

/**
 * Routes deliberately kept OUT of the allowlist, each with the reason.
 *
 * The mechanism matters more than the current contents. A route added to the
 * client and left unclassified fails the build (`clientRoutes.test.js`), and the
 * author then has to choose: allow it, or record here why its reports should say
 * `unknown` instead. That choice is the point — a new route is a new potential
 * PII channel, and this is the moment somebody looks at it.
 *
 * Empty today: every current client route is safe to name, because a pattern
 * cannot carry a value. A future route whose *path shape itself* is sensitive —
 * one that reveals a diagnosis, a disciplinary process, or anything true about a
 * person merely by existing — belongs here rather than above.
 *
 * Keyed by the exact `path` string as it appears in the client route table.
 */
export const EXCLUDED_CLIENT_ROUTES = Object.freeze({
  // '/example/:id': 'why this route must report as unknown',
});
