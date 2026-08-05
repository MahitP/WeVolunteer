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
const VolunteerPortfolio = React.lazy(() => import('../views/VolunteerPortfolio'));
const CheckInView = React.lazy(() => import('../views/CheckInView'));
const Messages = React.lazy(() => import('../views/Messages'));
const Settings = React.lazy(() => import('../views/Settings'));
const ErrorDashboard = React.lazy(() => import('../views/ErrorDashboard'));
const PrivacyNotice = React.lazy(() => import('../views/PrivacyNotice'));
const LegalCenter = React.lazy(() => import('../views/legal/LegalCenter'));
const LegalDocument = React.lazy(() => import('../views/legal/LegalDocument'));

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
  { path: '/settings', element: <Settings /> },
  /* Error triage. `error.read` is SUPER_ONLY, so `can()` refuses it before it
     consults per-user grants — no capability grant can reach this route, and
     the nav entry that points at it is hidden by the same capability. */
  { path: '/errors', element: <ErrorDashboard />, requiredCap: 'error.read' },
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
export const PUBLIC_ROUTES = [
  { path: '/verify/:code', element: <CertificateVerification /> },
  { path: '/privacy', element: <PrivacyNotice /> },
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
  { path: '/legal/:slug', element: <LegalDocument /> },
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
