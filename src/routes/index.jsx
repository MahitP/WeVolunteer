import React from 'react';
import { Navigate, useParams } from 'react-router-dom';

/**
 * Route-level code splitting, and the route table itself.
 *
 * Every one of these was a static import, which put all 19 views plus the two
 * heaviest modals into a single entry chunk: 1,270 kB (333 kB gzipped), enough
 * for Vite to warn on every build. A student on school cellular downloaded the
 * admin dashboard, the organizer tools, the calendar and the messaging client
 * before they could see their own shifts.
 *
 * This was implemented once before (353a492) and then reverted wholesale by
 * 70cd700 — a commit titled `docs: auth audit Phase 1 findings and remediation
 * plan`, whose message says nothing about bundling. It removed the lazy imports
 * AND their Suspense boundaries together, i.e. a complete, clean revert of an
 * unrelated commit's work, which is the signature of an accidental commit from a
 * stale working tree rather than a considered rollback. Nothing in the history
 * records a problem with the splitting itself.
 *
 * The boundaries are unchanged by the move out of App.jsx. The shell — the
 * navigation, the notification bell, the theme toggle, the error boundary and
 * LoadingSkeleton — stays eager in App.jsx on purpose: it must render on the
 * first frame, and LoadingSkeleton is what the Suspense fallbacks are made of,
 * so lazy-loading it would be circular.
 */
const Login = React.lazy(() => import('../views/Login'));
const Welcome = React.lazy(() => import('../views/Welcome'));
const Signup = React.lazy(() => import('../views/Signup'));
const BrowseEvents = React.lazy(() => import('../views/BrowseEvents'));
const CreateEvent = React.lazy(() => import('../views/CreateEvent'));
const PublicProfile = React.lazy(() => import('../views/PublicProfile'));
const OrganizationPage = React.lazy(() => import('../views/OrganizationPage'));
const OrganizationForm = React.lazy(() => import('../views/OrganizationForm'));
const LogExternalHours = React.lazy(() => import('../views/LogExternalHours'));
const LoggedHours = React.lazy(() => import('../views/LoggedHours'));
const VolunteerDashboard = React.lazy(() => import('../views/VolunteerDashboard'));
const OrganizerDashboard = React.lazy(() => import('../views/OrganizerDashboard'));
const AdminDashboard = React.lazy(() => import('../views/AdminDashboard'));
const Notifications = React.lazy(() => import('../views/Notifications'));
const CalendarView = React.lazy(() => import('../views/CalendarView'));
const VolunteerProfile = React.lazy(() => import('../views/VolunteerProfile'));
const OrganizerProfile = React.lazy(() => import('../views/OrganizerProfile'));
const ResetPassword = React.lazy(() => import('../views/ResetPassword'));
const OAuthCallback = React.lazy(() => import('../views/OAuthCallback'));
const CertificateVerification = React.lazy(() => import('../views/CertificateVerification'));
const AdminImpact = React.lazy(() => import('../views/AdminImpact'));
const VolunteerPortfolio = React.lazy(() => import('../views/VolunteerPortfolio'));
const CheckInView = React.lazy(() => import('../views/CheckInView'));
const Messages = React.lazy(() => import('../views/Messages'));
const Settings = React.lazy(() => import('../views/Settings'));
const ErrorDashboard = React.lazy(() => import('../views/ErrorDashboard'));
const LegalCenter = React.lazy(() => import('../views/legal/LegalCenter'));
const LegalDocument = React.lazy(() => import('../views/legal/LegalDocument'));
const AboutUs = React.lazy(() => import('../views/AboutUs'));
const LegalEditor = React.lazy(() => import('../views/legal/LegalEditor'));
const OrganizerAgreement = React.lazy(() => import('../views/legal/OrganizerAgreement'));
const Appeal = React.lazy(() => import('../views/Appeal'));
const AdminAppeals = React.lazy(() => import('../views/AdminAppeals'));
const AdminAuditExplorer = React.lazy(() => import('../views/AdminAuditExplorer'));
const ImpactDashboard = React.lazy(() => import('../views/ImpactDashboard.jsx'));
const AdminRoster = React.lazy(() => import('../views/AdminRoster'));
const ModerationCenter = React.lazy(() => import('../views/ModerationCenter'));

/**
 * Views App.jsx routes itself rather than through a table below.
 *
 * `/` picks a dashboard per role and the two profile views are rendered both as
 * a route and as the profile overlay, so their elements cannot be built here.
 * The auth-flow screens (`/oauth/callback`, `/reset-password`) stay inline in
 * App.jsx too: they render *above* the session gate — see AUTH_FLOW_PATHS and
 * TD-9 — and that ordering is easier to keep correct with the tree it guards
 * spelled out in one place.
 */
export {
  AdminDashboard, VolunteerDashboard, OrganizerDashboard,
  VolunteerProfile, OrganizerProfile,
  OAuthCallback, ResetPassword,
};

/**
 * Sends /events/:id/edit to the event itself, which is where editing actually
 * happens (EventModal's edit mode). Kept as a redirect rather than deleted so
 * an organizer who bookmarked the URL lands somewhere useful instead of on a
 * 404 or, as before, on a form that quietly created a duplicate event.
 *
 * /events/:id/edit used to render a blank CreateEvent whose submit handler
 * called api.createEvent — so an organizer who reached it (bookmark, browser
 * autocomplete, back button, or guessing the URL from /events/new) saw an empty
 * form that PUBLISHED A SECOND EVENT instead of editing the one they asked for.
 * Nothing in the app ever linked here; editing lives in EventModal. This
 * redirects to the real event so the URL does the thing its path promises.
 */
function RedirectToEvent() {
  const { id } = useParams();
  return <Navigate to={id ? `/events?event=${encodeURIComponent(id)}` : '/events'} replace />;
}

/**
 * The authenticated shell's routes, as data.
 *
 * `requiredCap` replaces the role ternaries that were inline in App.jsx. It is a
 * rendering decision only — the API re-checks every request — but keeping it as
 * data means adding a role cannot miss a branch. A route with no `requiredCap`
 * had no role condition before and still has none.
 *
 * `requiresVerified` is the second, orthogonal condition `/events/new` carried:
 * an organizer who has not been approved yet holds `event.create` but must not
 * reach the form. Same flag name the NAV table in App.jsx already uses.
 *
 * Elements are declared without props. Every view that needs shell state gets it
 * from ROUTE_PROPS in App.jsx, which closes over that state; keeping it out of
 * here is what lets this file stay a table rather than a second copy of the
 * shell. `/` and `/profile` (a different component per role) and the `*`
 * catch-all remain in App.jsx.
 */
export const APP_ROUTES = [
  { path: '/events', element: <BrowseEvents />, requiredCap: 'event.view' },
  { path: '/events/new', element: <CreateEvent />, requiredCap: 'event.create', requiresVerified: true },
  { path: '/events/:id/edit', element: <RedirectToEvent /> },
  { path: '/checkin/:eventId', element: <CheckInView />, requiredCap: 'attendance.mark' },
  { path: '/calendar', element: <CalendarView />, requiredCap: 'event.view' },
  { path: '/notifications', element: <Notifications /> },
  { path: '/messages', element: <Messages />, requiredCap: 'message.send' },
  { path: '/portfolio', element: <VolunteerPortfolio />, requiredCap: 'portfolio.write' },
  /**
   * The member directory.
   *
   * `/users/:handle` carries the `@`. React Router does not allow a parameter
   * that spans only part of a segment, so the path cannot be written
   * `/users/@:username` — the `@` is part of the parameter's VALUE and is
   * stripped by the view. `/users/id/:id` is the fallback for an internal link
   * that holds an id and for the rare account with no username yet; it is
   * declared BEFORE the `:handle` route so that "id" is never read as a handle.
   *
   * All of these are authenticated app routes, not PUBLIC_ROUTES. "Public
   * profile" means visible to the school community somebody volunteers
   * alongside, not to the open internet: this platform's members are children,
   * and a signed-out, crawlable index of minors by name and area is not
   * something the word should be allowed to smuggle in.
   */
  /**
   * `/directory` is a REDIRECT now, not a page.
   *
   * Finding people and organizations was its own top-level destination, beside
   * Opportunities, which asked a student to decide which kind of thing they were
   * looking for before they had typed anything. Discovery now lives on
   * Opportunities as one search across all three — see the `scope` control in
   * BrowseEvents.jsx.
   *
   * Kept as a declared redirect rather than deleted because the path was
   * shipped: it is in browser histories, and PublicProfile linked to it. The
   * capability is unchanged, so somebody who could not reach the directory still
   * cannot reach what it redirects to.
   */
  { path: '/directory', element: <Navigate to="/events?find=people" replace />, requiredCap: 'directory.read' },
  { path: '/users/id/:id', element: <PublicProfile />, requiredCap: 'directory.read' },
  { path: '/users/:handle', element: <PublicProfile />, requiredCap: 'directory.read' },
  /* Declared BEFORE `/organizations/:key`, so "new" is never matched as a slug. */
  { path: '/organizations/new', element: <OrganizationForm />, requiredCap: 'organization.create', requiresVerified: true },
  { path: '/organizations/:key/edit', element: <OrganizationForm />, requiredCap: 'organization.manage.own' },
  { path: '/organizations/:key', element: <OrganizationPage />, requiredCap: 'directory.read' },
  /* Declared BEFORE `/hours`, so "external" is never matched as part of the log
     page — React Router ranks static segments first, but the ordering is stated
     rather than relied upon. */
  { path: '/hours/external', element: <LogExternalHours />, requiredCap: 'portfolio.write', requiresVerified: true },
  /**
   * The student's own volunteering history, WeVolunteer and external together.
   *
   * `portfolio.write` rather than a capability of its own: it is the same power
   * — a student's own service record — that `/portfolio` and `/hours/external`
   * are already gated on, and inventing a third name for it would mean three
   * things to keep in step. Deliberately NOT `requiresVerified`: reading your
   * own history is not a thing anybody needs approval for.
   */
  { path: '/hours', element: <LoggedHours />, requiredCap: 'portfolio.write' },
  { path: '/settings', element: <Settings /> },
  /**
   * Declared with NO `requiredCap`, deliberately.
   *
   * This is the screen an organizer uses to accept the Organizer Agreement, and
   * until they do they hold none of the capabilities that reach a student. Gating
   * it on any of those would gate it on the very thing accepting it grants — a
   * lockout, from the one page that undoes the lock. See
   * server/organizerAgreement.js.
   */
  { path: '/organizer-agreement', element: <OrganizerAgreement /> },
  /* Error triage. `error.read` is SUPER_ONLY, so `can()` refuses it before it
     consults per-user grants — no capability grant can reach this route, and
     the nav entry that points at it is hidden by the same capability. */
  { path: '/errors', element: <ErrorDashboard />, requiredCap: 'error.read' },
  /* The hub. `report.resolve` is the capability an ordinary administrator holds
     that makes any of this relevant to them; each tile then requires its own,
     and each destination refuses independently. */
  { path: '/admin/moderation', element: <ModerationCenter />, requiredCap: 'report.resolve' },
  { path: '/admin/appeals', element: <AdminAppeals />, requiredCap: 'appeal.review' },
  /* The community impact figures. `analytics.impact` is administrative — held by
     `admin` and `super_admin` and by nobody below — and it is the same word the
     nav entry and `GET /api/impact` name, so the rail, this guard and the server
     agree. The guard matters independently of the rail: hiding a nav entry is UX,
     and typing the URL is one keystroke. `deniedRoute` refuses this before the
     shell is built. */
  { path: '/impact', element: <ImpactDashboard />, requiredCap: 'analytics.impact' },
  { path: '/admin/audit-logs', element: <AdminAuditExplorer />, requiredCap: 'audit.read' },
  { path: '/admin/roster', element: <AdminRoster />, requiredCap: 'admin.create' },
  /**
   * The Legal Center editor.
   *
   * `/admin/legal` rather than `/legal/edit`, which would be captured by
   * `/legal/:slug` in PUBLIC_ROUTES and answer "no such legal document". The
   * `/admin/` prefix also puts it where the other owner-only pages already are.
   *
   * `requiredCap` is enforced here and again on every endpoint the page calls.
   * This one keeps a reader who typed the URL out of a shell they cannot use;
   * the server's is the one that matters.
   */
  { path: '/admin/legal', element: <LegalEditor />, requiredCap: 'legal.edit' },
  /**
   * The platform-wide impact figures. An AUTHENTICATED route, deliberately.
   *
   * It was briefly declared in PUBLIC_ROUTES below, carrying a `requiredCap`
   * that nothing in that table reads. Three things were wrong with that at
   * once: an anonymous visitor rendered the administrator's dashboard shell;
   * `isPublicPath` returned true for it, so an owner who clicked the nav entry
   * was dropped onto a page with no navigation and no way back; and the
   * capability was decoration, because only APP_ROUTES is gated on one.
   *
   * `analytics.platform` is the same capability the nav entry and the API
   * handler name, so the rail, the route and the server agree on one word.
   */
  { path: '/admin/impact', element: <AdminImpact />, requiredCap: 'analytics.platform' },
];

/**
 * What a visitor with no session can reach. No capabilities apply: there is no
 * principal to hold one. The `*` catch-all that sends everything else to
 * /welcome stays in App.jsx with the branch it belongs to.
 */
export const SIGNED_OUT_ROUTES = [
  /**
   * `/` is DECLARED, not left to the catch-all.
   *
   * It used to work by accident. The signed-out catch-all was
   * `<Navigate to="/welcome" replace />`, so every unmatched path — including
   * the root — landed on the welcome page. `2b015d3` replaced that redirect
   * with a real 404, correctly: a blanket redirect made a typo'd link
   * indistinguishable from a working one, which is the whole reason the error
   * experience exists. But `/` had never been a route in its own right, so it
   * went down with the redirect and the front door started answering 404.
   *
   * Restoring the redirect would undo the fix. Declaring the root is what makes
   * both true at once: `/` is a real page, and `*` still means "no such page".
   *
   * Same element as `/welcome` rather than a redirect to it. A redirect would
   * cost a render and, worse, leave a freshly signed-in user sitting on
   * `/welcome` — which is not an authenticated route, so the shell would answer
   * their own front door with a 404.
   */
  { path: '/', element: <Welcome /> },
  { path: '/welcome', element: <Welcome /> },
  { path: '/login', element: <Login /> },
  { path: '/signup', element: <Signup /> },
];

/**
 * Reachable in any session state, because the link is handed to someone outside
 * the app: a certificate's verification code is printed on the certificate, and
 * the privacy notice is linked from the signup form — which is read by somebody
 * deciding whether to create an account, i.e. precisely when they have none.
 *
 * `isPublicPath` below is what actually makes these reachable, and it is derived
 * from this array rather than restated. It used to be `currentPath.startsWith(
 * '/verify/')` in App.jsx: a second, hardcoded copy of this list, so a route
 * added here was silently unreachable — it would fall through to the signed-out
 * catch-all and answer 404 while looking correctly declared.
 */
/**
 * Legacy `/legal/*` names that were published before the registry's slugs were.
 *
 * The comment on `/legal` below argues against an alias LAYER, and that argument
 * still stands: there is one canonical name per document, it comes from
 * `server/legalDocuments.js`, and nothing in the product should be linking to a
 * second one. These are not a second naming scheme — they are two URLs that were
 * genuinely shipped. The signup consent block linked `/legal/terms` and
 * `/legal/guidelines`, both of which 404'd inside the flow where somebody is
 * being asked to agree to them, so they went out in emails and browser history
 * before the links were corrected to the canonical slugs.
 *
 * A redirect rather than a second route to the same view, so the reader ends up
 * on the canonical URL and the address bar agrees with the registry.
 *
 * This map is CLOSED. A new document gets its registry slug and nothing else;
 * an entry belongs here only when a URL was already published under it.
 * `legalContent.test.js` asserts every target below is a registered slug.
 */
export const LEGAL_SLUG_ALIASES = Object.freeze({
  terms: 'terms-of-service',
  guidelines: 'community-guidelines',
});

export const PUBLIC_ROUTES = [
  { path: '/verify/:code', element: <CertificateVerification /> },
  /**
   * `/privacy` redirects to the registry document rather than rendering its own page.
   *
   * There were two privacy pages. `/legal/privacy-policy` serves the published
   * document out of `server/legalDocuments.js`, hash-verified on every read and
   * carrying the version an acceptance record points at. `/privacy` rendered
   * `PrivacyNotice.jsx`, a hand-written page assembled from `src/config.js` values
   * that predates the registry — and the Privacy Policy's own specification block
   * says it supersedes that view as the source of truth.
   *
   * That view is now deleted. It survived the redirect landing here as an unused
   * `React.lazy` import, which still pulled a second, diverging privacy page into
   * the bundle and left it one line away from being routed again.
   *
   * The consequence was not cosmetic. `PRIVACY_URL` defaulted to `/privacy`, and
   * that is the link inside the signup consent block, so the person being asked to
   * acknowledge how their information is handled was sent to the page that is NOT
   * the document their acceptance is recorded against.
   *
   * Kept as a redirect rather than deleted because it is a published URL — it is
   * the historical value of `PRIVACY_URL` and may exist in an email or a bookmark —
   * and `replace` so it does not trap the back button.
   */
  { path: '/privacy', element: <Navigate to="/legal/privacy-policy" replace /> },
  /**
   * The Legal Center, public for the same reason and more sharply.
   *
   * The signup consent block links to the Terms and the Community Guidelines,
   * and it is read by somebody who is deciding whether to create an account —
   * i.e. precisely when they have none. Those two links pointed at
   * `/legal/terms` and `/legal/guidelines`, neither of which was ever declared
   * here, so both answered 404 inside the consent flow.
   *
   * The paths use the registry's canonical slugs (`terms-of-service`,
   * `community-guidelines`) rather than the short aliases the form used. An
   * alias layer would be a second naming scheme to keep in step with
   * `server/legalDocuments.js`, and the whole point of deriving the catalogue
   * from the registry is that there is one name per document.
   */
  { path: '/legal', element: <LegalCenter /> },
  /* The legacy short names, redirected. Declared from LEGAL_SLUG_ALIASES above
     so the alias and its target cannot drift apart, and so a test can assert
     every target is a slug the registry actually publishes. A static segment
     outranks `/legal/:slug` in the router's own ranking, so these win. */
  ...Object.entries(LEGAL_SLUG_ALIASES).map(([alias, slug]) => ({
    path: `/legal/${alias}`,
    element: <Navigate to={`/legal/${slug}`} replace />,
  })),
  { path: '/legal/:slug', element: <LegalDocument /> },
  /**
   * About Us — public, and deliberately not under `/legal`.
   *
   * It is reached from the same Help area of Settings and it sits beside the
   * Legal Center in the reader's mind, but it is not a document anybody is held
   * to and it carries no version. Putting it at `/legal/about` would also
   * collide with `/legal/:slug`, where the parameter is matched against the
   * registry — a reader following that URL would get "no such legal document"
   * for a page that exists.
   *
   * Public because the people most likely to want it are the ones deciding
   * whether to sign up: a parent, or a student sent a link by an organizer.
   */
  { path: '/about', element: <AboutUs /> },
  { path: '/appeal/:token', element: <Appeal /> },
];

/**
 * Whether a path is served without a session.
 *
 * Segment-wise, not `startsWith`: a prefix test on `/privacy` would also match
 * `/privacy-settings`, and on `/verify` would match `/verifyx`. `:param`
 * matches exactly one segment, which is the same rule the router applies and
 * the same one `server/clientRoutes.js` uses for its allowlist.
 */
export function isPublicPath(pathname) {
  const segments = String(pathname || '').split('?')[0].split('/').filter(Boolean);
  return PUBLIC_ROUTES.some(({ path }) => {
    const pattern = path.split('/').filter(Boolean);
    if (pattern.length !== segments.length) return false;
    return pattern.every((seg, i) => seg.startsWith(':') || seg === segments[i]);
  });
}

/**
 * Whether `pathname` is a screen that exists only for a visitor with no session.
 *
 * Signing in does not make `/login` disappear — it is still a URL, in a
 * bookmark, in an autocomplete entry, in a link somebody pasted into a group
 * chat. Before this, an authenticated reader who opened one was answered with
 * a 404: the path is not in APP_ROUTES, so the shell had nothing to render and
 * the unknown-URL takeover fired. "Page not found" for the sign-in page, while
 * signed in, reads as the account being broken.
 *
 * DERIVED from SIGNED_OUT_ROUTES rather than restated as a list of paths. The
 * signed-out table is the definition of "a screen for somebody with no
 * session", and a second copy is the thing that goes stale — the same argument
 * `isPublicPath` makes for deriving itself from PUBLIC_ROUTES.
 *
 * `/` is in that table too and is deliberately NOT special-cased here: the
 * authenticated shell serves `/` (it is the dashboard), so the caller's
 * `shellServes` test has already claimed it and this is never asked.
 *
 * The auth-flow paths — `/reset-password`, `/oauth/callback` — are NOT here and
 * must never be. They are handled above the session gate (see AUTH_FLOW_PATHS
 * and TD-9) precisely because they have to work while a stale session is still
 * in memory: a password reset bumps `token_version`, so the tab holding the
 * link often still believes it is signed in. Redirecting those to the dashboard
 * would break account recovery for exactly the people who need it.
 */
export function isSignedOutOnlyPath(pathname) {
  const path = String(pathname || '').split('?')[0];
  return SIGNED_OUT_ROUTES.some(r => r.path === path);
}

/** Every declared route, for the table-wide invariants in routes.test.jsx. */
export const ROUTES = [...APP_ROUTES, ...SIGNED_OUT_ROUTES, ...PUBLIC_ROUTES];

/**
 * A route's element, cloned with the shell props that route needs.
 *
 * The tables above declare elements without props because the props close over
 * App.jsx's state and handlers; App.jsx supplies a per-path map. The hazard is
 * that `React.cloneElement(el, undefined)` is perfectly legal and clones with
 * NO props at all — so a path present in a table but missing from the map
 * mounts a view with every prop silently absent. It renders wrong; nothing
 * throws, nothing warns. App.routeTable.test.jsx pins the paths that exist
 * today, which means it stops protecting anything the moment a tenth route is
 * added and its prop entry forgotten.
 *
 * So "missing" must be distinguishable from "deliberately empty": a route that
 * genuinely takes no shell props declares `{}` (as '/events/:id/edit' already
 * does), and an omission throws here. Own-property, not truthiness — `{}` is
 * truthy but so is nothing, and a declared-empty entry must pass.
 *
 * Lives beside the tables rather than inside App.jsx because it is pure, and
 * because that is what makes the guard directly testable.
 */
export function withProps(route, propsByPath) {
  if (!Object.hasOwn(propsByPath, route.path)) {
    throw new Error(
      `No props declared for route '${route.path}'. Add an entry to the route's `
      + 'prop map in App.jsx — use {} if the view genuinely takes no shell props.'
    );
  }
  return React.cloneElement(route.element, propsByPath[route.path]);
}
