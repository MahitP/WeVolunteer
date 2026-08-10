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
  '/admin/impact',
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
  /* The administrative hub. A literal path with no parameter, and it fetches
     nothing — so a report from here says only that somebody opened the index. */
  '/admin/moderation',
  '/admin/appeals',
  '/admin/audit-logs',
  '/admin/roster',
  /* The Legal Center editor. A literal path with no parameter, and the document
     being edited is chosen inside the page rather than in the URL — so a report
     from here names the editor and never which policy was open. */
  '/admin/legal',

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
  /* The two legacy short names (LEGAL_SLUG_ALIASES in src/routes/index.jsx).
     Literal paths that redirect to the canonical slug; allowed for the same
     reason `/legal/:slug` is. They are listed rather than folded into that
     pattern because they are static segments and the router ranks them that
     way — a report from one of them names the URL the reader actually used,
     which is the thing worth knowing about a link that should not exist. */
  '/legal/terms',
  '/legal/guidelines',
  '/legal/:slug',
  /* About Us. Allowed for the same reason as `/privacy`: a literal path with no
     parameter, read by people who do not have an account yet. */
  '/about',
  '/appeal/:token',

  /* ── v1.3, the member directory ──────────────────────────────────────────
   *
   * All five are allowed, and the reasoning is the one this whole file rests
   * on: the STORED value is the matched pattern, never the input. `/users/@ana`
   * is stored as `/users/:handle`, so the username — which on this platform
   * belongs to a child — cannot survive matching. That is exactly the case
   * `/verify/:code` and `/appeal/:token` already make for a live token.
   *
   * The second question is whether the path SHAPE is itself sensitive: does the
   * mere existence of a report from this route say something true about a
   * person? It does not. "Somebody was looking at somebody's profile" names
   * neither party once the parameter is gone, and it is a page every member can
   * open about every other member.
   *
   * `/hours/external` is worth a moment's thought and lands the same way: it is
   * a literal path with no parameter, and it says a volunteer opened the form —
   * not what they logged, who for, or how many hours.
   *
   * `/hours` is the same answer again. It is the page a student's own service
   * history is shown on, and a crash report from it carries the path and
   * nothing else: no hours, no organization, no dates, and not even which
   * student — the reporter attaches no identity. "Somebody opened their own
   * hours" is not a fact about a person.
   */
  '/directory',
  '/hours',
  '/users/id/:id',
  '/users/:handle',
  '/organizations/new',
  '/organizations/:key/edit',
  '/organizations/:key',
  '/hours/external',
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
