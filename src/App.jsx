import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, useNavigate, useLocation, useSearchParams, Navigate, matchRoutes } from 'react-router-dom';
import { api } from './utils/api';
import { resolveEventById } from './utils/resolveEvent';
import { adminIsPaused } from './utils/adminPaused';
import { DEMO_MODE, APP_NAME, SCHOOL_NAME } from './config';
import DemoBar from './components/DemoBar';
import NotificationsBell from './components/NotificationsBell';
import ErrorBoundary from './components/ErrorBoundary';
import BrandLockup from './components/common/BrandLockup';
import ErrorExperience, { crashFallback } from './views/ErrorExperience/ErrorExperience';
import { ERROR_ROUTES } from './views/ErrorExperience/kinds';
import OfflineOverlay from './views/ErrorExperience/OfflineOverlay';
import useOnline from './hooks/useOnline';
import FullPageWait from './components/common/FullPageWait';
import { useReplayClass } from './utils/motion';
import PersonaPreviewBanner from './components/admin/PersonaPreviewBanner';
import AppNotices from './components/notifications/AppNotices';
import AccountProfile from './views/AccountProfile';
import ThemeToggle from './components/ThemeToggle';
import ProfileMenu from './components/account/ProfileMenu';
import Toasts from './components/common/Toasts';
import VerifyEmailWall from './components/account/VerifyEmailWall';
import SuspendedWall from './components/account/SuspendedWall';
import TwoFactorRequiredWall from './components/auth/TwoFactorRequiredWall';
import { Can } from './components/common/Can.jsx';
import EmptyState from './components/common/EmptyState';
import { can } from './authz.js';
import { SessionProvider, useSession } from './session/SessionProvider.jsx';
import { useAnalyticsConsent } from './hooks/useAnalyticsConsent.js';
import {
  APP_ROUTES, SIGNED_OUT_ROUTES, PUBLIC_ROUTES, isPublicPath, isSignedOutOnlyPath, withProps,
  AdminDashboard, VolunteerDashboard, OrganizerDashboard,
  VolunteerProfile, OrganizerProfile, OAuthCallback, ResetPassword
} from './routes/index.jsx';
import { consumePendingRedirect } from './utils/pendingInvite';
import { ACCOUNT_MENU_ITEMS } from './accountMenu.js';
import { organizationPath } from './utils/organizationUrl';
import { OAUTH_CALLBACK_PATH } from '../server/oauthCallbackPath.js';
import {
  LayoutDashboard, Compass, ShieldCheck, LogOut, CalendarDays,
  X, Bell, UserRound, MessageSquare, MoreHorizontal, Sparkles
} from 'lucide-react';

// The two heaviest modals. EventModal pulls in the whole organizer surface —
// applicant review, shifts, attendance, announcements, comments, the location
// card — and is only opened on demand, so it has no business in the entry chunk.
// The routed views are split the same way, in src/routes/index.jsx.
const EventModal = React.lazy(() => import('./components/EventModal'));
const ProfileEditModal = React.lazy(() => import('./components/ProfileEditModal'));

/**
 * The error contact sheet, development only. See ErrorGallery.jsx.
 *
 * Both this and the branch that renders it are behind `import.meta.env.DEV`,
 * which is a literal `false` in a production build — so the branch is dead code
 * and the chunk is never reachable. A rotating system that cannot be reviewed
 * in one place is a rotating system nobody reviews.
 */
const ErrorGallery = import.meta.env.DEV
  ? React.lazy(() => import('./views/ErrorExperience/ErrorGallery.jsx'))
  : null;

/**
 * Fallback for a route whose chunk is still arriving.
 *
 * A route-level wait, so it gets the brand loader once it has run past a
 * second — see `FullPageWait`. The shape of the page that is coming is not
 * known here (it is the chunk being fetched), which is why this is not a
 * skeleton. `.full-page-wait` supplies its own padding because the signed-out
 * and public branches render this OUTSIDE `.page`.
 */
const RouteFallback = () => <FullPageWait label="Loading this page…" />;

/**
 * Who the shell is talking to, derived from capabilities rather than a role name.
 *
 * ── ORDER IS LOAD-BEARING: most-privileged-first ──
 *
 * `can()` answers TRUE for every capability when the role is super_admin (the
 * '*' wildcard), so the first matching row wins for the platform owner. Testing
 * `event.apply` before `event.moderate` would silently put super_admin on the
 * volunteer dashboard — the client-side twin of the GET /api/applications
 * cascade bug that shipped as a Critical earlier on this branch. The rule, and
 * why a trailing bare `else` is just as wrong, is documented at length in
 * server/authz.js's header.
 *
 * The cascade therefore ends in an EXPLICIT null: "no persona" is a state the
 * shell handles, not a role quietly inheriting somebody else's screen.
 *
 * A persona is not a role and must never be read back as one: `staff` covers
 * admin AND super_admin, and `host` is spelled that way rather than 'organizer'
 * precisely so `persona === 'host'` cannot be mistaken — by a reader or by the
 * role-string guard in server/authz.completeness.test.js — for a role check.
 */
const PERSONAS = [
  { id: 'staff', cap: 'event.moderate' },       // admin, super_admin
  { id: 'host', cap: 'event.create' },          // organizer
  { id: 'volunteer', cap: 'event.apply' },      // student
  { id: 'partner', cap: 'analytics.public' },   // partner
];

/**
 * ── Persona asks WHO, not WHAT-MAY-THEY-DO ──
 *
 * Derived against the role's own capabilities, with any withheld set ignored.
 * That distinction is the whole point of this function and it is load-bearing.
 *
 * An organizer who has not accepted the Organizer Agreement holds none of the
 * capabilities that reach a student — `event.create` among them, which is the
 * very capability the `host` row tests. Consulting the withheld list here gave
 * that organizer NO persona, so they fell through the cascade to
 * "No dashboard for this account": the one state in the product where an
 * explanation matters most produced a dead end that named no reason, offered no
 * next step, and hid the acceptance banner that exists precisely to be seen
 * there. They are still a host. They are a host who has not signed yet.
 *
 * This grants nothing. Persona chooses which dashboard COMPONENT renders; every
 * panel inside it goes to the API, and the server refuses each one on the same
 * withheld list. The nav, which genuinely is a "what may they do" question,
 * still filters on the gated `can()` a few lines below — so the entries stay
 * hidden while the dashboard that explains why stays reachable.
 */
const personaFor = (user) =>
  PERSONAS.find(p => can(user && { ...user, withheld: [] }, p.cap))?.id ?? null;

/**
 * The `/` nav entry, per persona. A persona absent from this map gets no `/`
 * entry, because it has no dashboard to send anyone to.
 */
/* `staff` used to read "Moderation Center", and the page it opens is unchanged
   — the reports queue, organizer approvals, platform totals and the events
   table. Two things were wrong with the old name. It described one section of a
   screen that is mostly not moderation, and it made `/` mean something
   different in the rail for one persona than for the other two, so "open your
   dashboard" was not answerable without first asking what kind of account
   somebody had. Every persona now has a Dashboard, on the same icon; what is ON
   it still differs by role, which is the part that should differ.

   The name is not retired — it now belongs to /admin/moderation, a hub of the
   administrative areas, which is what people were looking for when they came
   here for it. */
const DASHBOARD_NAV = {
  staff: { label: 'Dashboard', icon: LayoutDashboard },
  host: { label: 'Dashboard', icon: LayoutDashboard },
  volunteer: { label: 'Dashboard', icon: LayoutDashboard },
};

/**
 * Which profile view `/profile` renders for the signed-in user — and, through
 * SELF_PROFILE_CAPS below, whether the navigation offers it at all. Same
 * most-privileged-first rule as PERSONAS, same explicit final branch.
 *
 * `admin.create` is a SUPER_ONLY capability, so it identifies the platform owner
 * and nobody else: `can()` refuses to satisfy a SUPER_ONLY capability from a
 * per-user grant, so no amount of granting turns an admin into a match. It is
 * tested first because super_admin's wildcard matches every row beneath it too.
 *
 * ── Nothing resolves to 'denied' any more ──
 *
 * `admin` did, and `partner` fell through to the same place: two roles whose
 * own profile page answered 403. That was survivable while the only way to the
 * page was a rail entry nobody used, and it stopped being survivable the moment
 * the account menu started offering "Profile" — the menu every signed-in person
 * opens to find their own account.
 *
 * `account` is the generalized view those three now share. It renders from
 * `/api/auth/me`, which the shell already holds, so it needs no endpoint and no
 * capability: that matters for `partner`, which deliberately does NOT hold
 * `directory.read` (see the note in server/authz.js) and therefore cannot fetch
 * a profile payload at all, not even its own.
 *
 * The two role-specific views are unchanged. A student's profile is a service
 * record and an organizer's is a track record; those are different pages, not
 * different data in one.
 *
 * `admin.create` is a SUPER_ONLY capability, so it identifies the platform owner
 * and nobody else — `can()` refuses to satisfy a SUPER_ONLY capability from a
 * per-user grant. It is listed first because super_admin's wildcard matches every
 * row beneath it too, and `event.view` is listed LAST for the same reason from
 * the other end: every role holds it, so it can only ever be reached by a role
 * that matched nothing above.
 */
const SELF_PROFILE = [
  { cap: 'admin.create', view: 'account' },      // super_admin
  { cap: 'event.moderate', view: 'account' },    // admin
  { cap: 'event.create', view: 'host' },         // organizer
  { cap: 'portfolio.write', view: 'volunteer' }, // student
  { cap: 'event.view', view: 'account' }         // partner, and any later role
];

/**
 * Which of the three profile pages this account gets.
 *
 * The list above is a most-privileged-first cascade, which is right for an
 * account that only administers: an administrator's profile is about their
 * account, not about shifts they never worked.
 *
 * It is wrong for an account that administers AND volunteers. The platform
 * owner is deliberately both — they run the district's programme and they turn
 * up to events — and the cascade sent them to `AccountProfile`, which shows a
 * total and nothing else: no badges, no milestones, no service record, no
 * certificates. Their own record was the one record the product would not show
 * them.
 *
 * So privilege picks the page only when there is nothing else to go on. An
 * account that can hold a portfolio AND has actually served gets the volunteer
 * page, whatever else it can do. The rule names no person and no role — it
 * reads a capability and a number — and `AccountProfile` already draws its
 * volunteering block from the same fact for the same reason.
 *
 * The owner distinction is not lost by this: `VolunteerProfile` renders the
 * banner, so the page says "Platform owner" and then shows their service.
 */
export const selfProfileFor = (user) => {
  if (can(user, 'portfolio.write') && Number(user?.volunteeredHours) > 0) return 'volunteer';
  return SELF_PROFILE.find(p => can(user, p.cap))?.view ?? 'denied';
};

/**
 * The chrome for a page: its heading and subtitle.
 *
 * ── Why this is a function and not a lookup at the call site ──
 *
 * `PAGE_META` is keyed by persona, and for every page but one that is right.
 * `/profile` is the exception: its BODY comes from `selfProfileFor` and its
 * chrome came from `personaFor`, and those two deliberately disagree for an
 * account that holds administrative capability AND has volunteered.
 *
 * The person who runs this platform is a student who volunteers, so
 * `selfProfileFor` sends them to `VolunteerProfile` — while the heading, drawn
 * from the `staff` block, called that page "Your account on this platform". A
 * service record, milestones and a Silver Award meter, captioned as an admin
 * account.
 *
 * Only the disagreement is corrected. `account` is deliberately unmapped,
 * because there the persona lookup is already right: a staff persona rendering
 * `AccountProfile` should read the staff wording, and a partner the partner's.
 *
 * Exported because its test would otherwise have to re-implement the rule, and
 * a test that owns a second copy can pass while the shell is wrong.
 */
const PROFILE_META_PERSONA = { volunteer: 'volunteer', host: 'host' };

export function pageMetaFor(user, activeTab) {
  const persona = personaFor(user);
  const key = activeTab === 'profile'
    ? (PROFILE_META_PERSONA[selfProfileFor(user)] ?? persona)
    : persona;
  const meta = PAGE_META[key]?.[activeTab] || { title: APP_NAME, sub: '' };

  /**
   * One subtitle that is not fixed per tab.
   *
   * `PAGE_META` is a static table and that is almost always right — a page's
   * subtitle describes the page, not the reader. The Admin page is the exception
   * since 2026-09-27: when the Admin Responsibilities Policy is outstanding it
   * renders the gate instead of its tiles, and the topbar went on reading "Every
   * administrative area you can open" above a page saying administration is
   * paused. Two claims about the same screen, and the confident one is wrong.
   *
   * Decided here rather than at the render site because this function is what
   * `documentTitle` and the topbar both call, so an override anywhere else would
   * correct one and leave the other — and because it already takes `user`, which
   * is the only thing the rule needs.
   *
   * The title is left alone deliberately: the page is still Admin, and the static
   * guards that assert every reachable tab has a title read this table.
   *
   * `adminIsPaused` is shared with `ModerationCenter`, which uses the same answer
   * to choose between the gate and the tiles. See its own file for why that is
   * one function rather than two matching expressions.
   */
  if (activeTab === 'moderation' && adminIsPaused(user)) {
    return { ...meta, sub: 'Paused until the Admin Responsibilities Policy is accepted' };
  }

  return meta;
}

/** Derived, not repeated, so the nav entry and the route can never disagree. */
const SELF_PROFILE_CAPS = SELF_PROFILE.filter(p => p.view !== 'denied').map(p => p.cap);

/* Navigation is defined once and filtered by capability, so every role gets the
   same shell instead of a different one — and a role added tomorrow gets the
   entries its capabilities justify rather than an empty rail.

   The `/` entry is not in this table: its label and icon differ per persona and
   come from DASHBOARD_NAV above.

   `requiredCapAny` (hold any one of) mirrors server/authz.js's requireCapAny,
   and is what an entry uses when two unrelated capabilities each justify it.
   `requiresVerified` is unchanged — no capability expresses "approved yet". */
/**
 * ── PRIMARY and SECONDARY, and why that replaced grouping ──
 *
 * The rail used to sort itself into named groups, and the one group left held a
 * single entry: `Administration`, containing the Moderation Center. A hair rule
 * above it kept it visually apart from Messages and Calendar.
 *
 * That separation was wrong in the surface where it mattered most. The mobile bar
 * took `navItemsFor(...).slice(0, 4)` — Dashboard, Opportunities, Calendar,
 * Messages — and everything after the fourth entry went behind the `⋯` sheet. So
 * for an administrator, the administrative area of the product was reachable only
 * by opening a menu, while it is the destination they came to the phone for. An
 * index into a flat list is not a statement about priority; it is an accident of
 * how many entries happen to precede yours.
 *
 * So priority is now DECLARED. Everything is primary unless it says otherwise,
 * and exactly two entries say otherwise:
 *
 *   PRIMARY    Dashboard · Discover · Calendar · Messages · Admin
 *   SECONDARY  Notifications · My profile
 *
 * Both surfaces read the same flag. The desktop rail draws primary then secondary
 * with no divider between them — Admin sits with the rest, because it is one of
 * the rest. The mobile bar draws every primary entry, scrolling horizontally when
 * five will not fit, and the `⋯` button holds the secondary ones. Nothing appears
 * in both, and nothing appears in neither: `App.navGroups.test.jsx` asserts both
 * halves.
 *
 * ── Why the label is "Admin" ──
 *
 * It was "Moderation Center", which is a fine name for the page and a bad one for
 * a rail: it is the longest label in the list, it wraps in the tablet rail and in
 * a 56px-tall mobile button, and it describes one of the things behind the entry
 * rather than the area. Every surface now says "Admin" — one word, no
 * platform-dependent abbreviation, and the same word an administrator would use.
 * `PAGE_META` follows it so the page title agrees with the way the reader got
 * there.
 */
const NAV = [
  /**
   * ── "Discover", not "Opportunities" ──
   *
   * The page behind this entry has three sections — opportunities, people and
   * organizations — behind one search, and its scope control offers
   * Everything / Opportunities / People / Organizations. So the rail label
   * "Opportunities" was the same word as ONE of the four tabs inside the page it
   * opens: it named the whole destination and a quarter of it at once, and a
   * reader who wanted a club had no way to tell from the rail that this was
   * where clubs live.
   *
   * "Discover" names the activity all three sections share, leaves
   * "Opportunities" free to mean events and only events, and is five characters
   * shorter — which matters on the mobile bar, where five entries share the
   * width of a phone.
   *
   * The word was chosen over "Browse" and "Explore" because it is what the
   * reader is doing rather than how they are doing it, and over keeping
   * "Opportunities" because the supporting copy alone could not fix a label that
   * collides with a control on its own page.
   */
  /* The path matches the label now. It said `/events` while the label said
     "Discover", so the rail promised one thing and the URL bar showed another the
     moment anybody clicked it. `/events` still resolves — see RedirectToDiscover
     in routes/index.jsx — but nothing in the product points there any more. */
  { id: 'browse', path: '/discover', label: 'Discover', icon: Compass, requiredCap: 'event.view' },
  /**
   * ── Who the calendar is for ──
   *
   * Volunteers (`event.apply`), organizers (`event.create`) and administrators
   * (`event.moderate`). The route itself requires only `event.view`; a partner
   * can open it and is not sent there.
   *
   * Administrators were left off until 2026-09-30. The predecessor audit's
   * decision 6A kept the page "reachable directly and through Welly, not
   * surfaced in navigation", on the argument that this entry is about doing —
   * turning up to shifts or running them — and an administrator does neither.
   * That decision was the audit's, not the owner's, and the owner's own admin
   * bar lists Calendar (FX-12). He ruled it back in (ruling 2).
   *
   * What an administrator sees is the district's schedule: an `event.moderate`
   * holder gets the unfiltered event index (`SessionProvider`), `scope`
   * defaults to `all`, and `CalendarView`'s non-organizer branch draws a
   * deadline for every open event — which is what `PAGE_META.staff` already
   * calls it, "Events across the district and when they close".
   */
  { id: 'calendar', path: '/calendar', label: 'Calendar', icon: CalendarDays, requiredCapAny: ['event.apply', 'event.create', 'event.moderate'] },
  { id: 'messages', path: '/messages', label: 'Messages', icon: MessageSquare, requiredCap: 'message.send' },
  { id: 'welly', path: '/welly', label: 'Welly', icon: Sparkles, requiredCap: 'assistant.use' },
  /* "New event" is deliberately NOT a nav entry.

     It was one, which put the single most common organizer action behind reading
     a twelve-item rail of mostly administrative pages — and on a phone, where the
     rail collapses to a bar plus a "More" sheet, frequently behind a tap as well.
     It now lives as a primary button on Discover, which is where an
     organizer already is when they think "I want to post a shift".

     `tabForPath` still maps `/events/new` to `create`, and PAGE_META still has a
     `create` entry: the page needs its own title and must not be reported as
     `browse`. A path with no rail item is normal here — `/settings` has never had
     one either. */

  /* The administrative hub, and a PRIMARY destination.

     `report.resolve` rather than a new capability: the hub lists what the reader
     can already open, and every tile re-checks its own.

     ── The six entries that used to follow this one ──

     Community impact (`/impact`), Appeals (`/admin/appeals`), Admin Roster
     (`/admin/roster`), Audit Explorer (`/admin/audit-logs`), Errors (`/errors`)
     and Platform Impact (`/admin/impact`) are no longer rail entries.

     NONE of them was removed. Every route is still registered in
     `routes/index.jsx`, every page still exists, every capability is unchanged,
     and every one is listed on the Admin hub above — which is why this entry is
     the only administrative one rather than the first of seven.
     `App.navGroups.test.jsx` asserts both halves: that they are absent from the
     rail, and that the hub still offers each of them to a reader who holds the
     capability.

     `tabForPath` deliberately still maps all six paths. It is not derived from
     NAV and never was; a path with no rail entry still needs a tab id so the
     page gets its own title and no rail item is wrongly highlighted. */
  /* `showWhenWithheld`: the Admin page is where an administrator accepts the
     Admin Responsibilities Policy, and that policy withholds `report.resolve`.
     Without this the gate hides its own remedy. See navItemsFor. */
  { id: 'moderation', path: '/admin/moderation', label: 'Admin', icon: ShieldCheck, requiredCap: 'report.resolve', showWhenWithheld: true },

  /* ── Secondary: reachable, not resident ──────────────────────────────────

     Both of these have another way in that is closer to hand than the rail.
     Notifications has the bell in the header, which also carries the unread
     count; the profile is in the ProfileMenu at the foot of the rail and in the
     header of the mobile sheet. Neither is a place people navigate to as the
     next step in a task, which is what the primary row is for. */
  /**
   * ── "Find people" is deliberately NOT an entry ──
   *
   * It was one, secondary, pointing at `/directory`. Two destinations that both
   * mean "look for something on this platform" is a question asked of the reader
   * before they have typed anything: is an NHS food drive an opportunity, an
   * organization, or the person who runs it? A student searching does not know,
   * and should not have to.
   *
   * Discovery is now one search on Discover, across opportunities, people
   * and organizations at once — see the `scope` control in BrowseEvents.jsx.
   * `/directory` redirects there, so the shipped URL still works; `tabForPath`
   * still maps `/users` and `/organizations` (to `browse`, now) because a path
   * with no rail entry of its own still needs a tab and a title.
   */
  { id: 'notifications', path: '/notifications', label: 'Notifications', icon: Bell, requiredCap: 'self.read', secondary: true },
  /**
   * ── `accountOnly`: in the account control, never in the rail ──
   *
   * Profile is reached the way every other product reaches it — by pressing
   * your own name — and the desktop rail already ends in `ProfileMenu`, which
   * offers Profile / Notifications / Settings / Sign Out over the signed-in
   * user's avatar. A rail entry as well meant the same destination was drawn
   * twice on one screen, a few pixels apart, one of them inside the control
   * that exists to hold it.
   *
   * `secondary` alone could not express this, because the two surfaces read
   * that flag for different reasons: on the desktop it means "draw after the
   * primary entries", and on mobile it means "put in the ⋯ sheet". The ⋯ sheet
   * IS the account control on a phone — there is no avatar menu at that width —
   * so Profile belongs in it. One flag had to say "rail: no, sheet: yes", and
   * overloading `secondary` to mean that would have moved Notifications too.
   *
   * So the entry stays `secondary` (mobile keeps it) and adds `accountOnly`
   * (the desktop rail filters it out). `navSectionsFor` is deliberately
   * untouched: it partitions by `secondary` and nothing else, which is the
   * property App.navGroups.test.jsx pins.
   */
  { id: 'profile', path: '/profile', label: 'Profile', icon: UserRound, requiredCapAny: SELF_PROFILE_CAPS, secondary: true, accountOnly: true }
];

/**
 * An entry with no capability declared would be hidden from everyone, silently
 * — `can(user, undefined)` is false for every role, wildcard included. That is
 * a forgotten annotation, not a decision, so it fails at module load rather
 * than at render, the same way requireCap() and withProps() do.
 */
for (const entry of NAV) {
  if (!entry.requiredCap && !entry.requiredCapAny?.length) {
    throw new Error(
      `NAV entry '${entry.id}' declares neither requiredCap nor a non-empty `
      + 'requiredCapAny. Every entry needs one — a nav item with no condition '
      + 'is one whose condition was forgotten, and it would render for nobody.'
    );
  }
}

/**
 * Which nav entry a path belongs to — the highlighted rail item and the key
 * `PAGE_META` is read with.
 *
 * ── This is a second copy of a mapping NAV already holds ──
 *
 * It cannot simply be derived from `NAV`, and the reasons are worth stating so
 * the next person does not "simplify" it back into a bug. `/settings` has no
 * nav entry at all but still needs a tab and a title. `/events/new` must be
 * tested BEFORE `/events`, because the second is a prefix of the first and the
 * chain would otherwise report every new-event page as `browse`. And `/` maps
 * to `dashboard`, which is a different component per persona.
 *
 * So it stays hand-written — but it is hoisted out of the component, exported,
 * and covered by a test asserting every NAV path resolves to its own id.
 * `/errors` was added to NAV without a branch here, and the result was a page
 * titled "Moderation Center" with the wrong rail item highlighted: silent, and
 * invisible to every existing test.
 */
/**
 * Which areas of the product actually DO anything with a shared location.
 *
 * ── Why the location offer needed a condition at all ──
 *
 * `AppNotices` mounts the location opt-in at the shell level, so
 * "See how far away opportunities are — share your location to sort by distance
 * and filter to what is nearby" rendered above every page. Measured in a
 * browser it was the largest element above the fold on the ADMIN hub, and it
 * appears the same way on Messages, Settings and Notifications — pages where
 * accepting it changes nothing a reader can see.
 *
 * That is worse than clutter, because it is the same slot the LEGAL change
 * notices use. `AppNotices` puts the location offer last in its priority ladder
 * precisely because it is an offer rather than news, and it comes back — the
 * dismissal is remembered for the tab, not for ever. An offer that recurs on
 * pages where it cannot pay off is how a reader learns to dismiss that strip
 * without reading it, which is exactly what must not happen to a notice saying
 * the Terms have changed.
 *
 * ── Keyed by TAB, not by path ──
 *
 * A literal list of paths would need `/discover` and `/events` (its redirect)
 * spelled separately, and `/` means a different dashboard per persona. `tabForPath`
 * is already the canonical answer to "which area is this", so the condition is
 * expressed in the same vocabulary and inherits every path that maps into it.
 *
 * The three that qualify, and why each earns it:
 *
 *   dashboard  every persona's dashboard shows a next shift with travel time
 *              and weather for its location.
 *   browse     Discover sorts by distance and filters to what is nearby — the
 *              thing the offer's own copy promises.
 *   calendar   shifts laid out against where they are.
 *
 * Deliberately NOT `welly`: the assistant answers distance questions, but it
 * asks for location itself, in the conversation, at the moment it needs it.
 */
export const LOCATION_AWARE_TABS = new Set(['dashboard', 'browse', 'calendar']);

export function tabForPath(pathname) {
  if (pathname.startsWith('/events/new')) return 'create';
  /* `/discover` is the canonical Discover page and `/events` is its compatibility
     redirect. Both map to `browse`: the redirect renders for one frame before
     React Router replaces the URL, and a frame titled "Discover" is better
     than a frame titled by the `*` fallback. Kept after `/events/new` for the
     prefix reason the header gives — `/events` is a prefix of `/events/new`, and
     `/discover` is a prefix of nothing. */
  if (pathname.startsWith('/discover')) return 'browse';
  if (pathname.startsWith('/events')) return 'browse';
  if (pathname.startsWith('/errors')) return 'errors';
  if (pathname.startsWith('/calendar')) return 'calendar';
  if (pathname.startsWith('/welly')) return 'welly';
  if (pathname.startsWith('/notifications')) return 'notifications';
  if (pathname.startsWith('/profile')) return 'profile';
  /* The discovery destinations keep tab ids of their OWN, because this function
     answers two questions at once and they have different answers here: what to
     TITLE the page (a member's profile is not "Discover") and which rail
     item to light (Discover, because that is where discovery lives and a
     rail that goes dark when you follow a search result reads as having left the
     app). `RAIL_TAB` below is the second answer; PAGE_META is the first.

     `/directory` is a redirect and never renders, but it is mapped anyway: the
     tab is read during the frame the redirect is resolved in. */
  if (pathname.startsWith('/directory')) return 'directory';
  if (pathname.startsWith('/users')) return 'directory';
  if (pathname.startsWith('/organizations')) return 'organizations';
  /* Before `/hours`, which is a prefix of it. */
  if (pathname.startsWith('/volunteers')) return 'volunteers';
  if (pathname.startsWith('/hours/external')) return 'externalHours';
  if (pathname.startsWith('/hours')) return 'loggedHours';
  /* Before `/certificates`, which is a prefix of it: without this the viewer
     would be titled "Certificates / One for each event you have completed",
     which is the list's description of itself, on a page showing one document.
     That is the defect `pageTitleCoverage.test.js` exists to catch, and it is
     recorded three times above. */
  if (/^\/certificates\/.+/.test(pathname)) return 'certificate';
  if (pathname.startsWith('/certificates')) return 'certificates';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/report-issue')) return 'reportIssue';
  /* These three had no branch, so they fell through to 'dashboard' — an
     organizer on /checkin read "Dashboard / Track your volunteers" with the
     Dashboard rail item lit, which is byte-for-byte the /errors bug this
     function's note above exists to prevent. */
  if (pathname.startsWith('/portfolio')) return 'portfolio';
  if (pathname.startsWith('/checkin')) return 'checkin';
  if (pathname.startsWith('/organizer-agreement')) return 'organizerAgreement';
  if (pathname.startsWith('/student-organizer-agreement')) return 'studentOrganizerAgreement';
  if (pathname.startsWith('/messages')) return 'messages';
  /* Before `/admin/appeals`? No — different prefixes, no conflict. But it must
     exist at all: without a branch, filing an appeal was titled "Dashboard /
     Your shifts, hours, and history", which is the /checkin and /errors bug
     recorded above, for the third time. */
  if (pathname.startsWith('/appeals')) return 'appealForm';
  if (pathname.startsWith('/admin/appeals')) return 'appeals';
  if (pathname.startsWith('/admin/issues')) return 'issues';
  if (pathname.startsWith('/admin/organizers')) return 'adminOrganizers';
  if (pathname.startsWith('/admin/moderation')) return 'moderation';
  if (pathname.startsWith('/admin/impact')) return 'adminImpact';
  if (pathname.startsWith('/owner')) return 'owner';
  if (pathname.startsWith('/impact')) return 'impact';
  if (pathname.startsWith('/admin/audit-logs')) return 'audit';
  if (pathname.startsWith('/admin/roster')) return 'roster';
  if (pathname.startsWith('/admin/badges')) return 'badges';
  if (pathname.startsWith('/admin/legal')) return 'legalEditor';
  /**
   * The Legal Center, and every document under it.
   *
   * AFTER `/admin/legal`, which is a different page — the editor, not the
   * reader's catalogue — and a `/legal` branch placed above it would swallow
   * `/admin/legal`… except it would not, because the prefixes differ at the
   * first character. Ordered this way anyway so the pair reads in the order a
   * person would check them.
   *
   * Its absence was the fourth instance of the defect this function's comments
   * already record three times: `/legal/privacy-policy` fell through to
   * `return 'dashboard'` below, so the Legal Center rendered under the
   * dashboard's title and every legal document's browser tab said
   * "Dashboard · WeVolunteer". `pageTitleCoverage.test.js` did not catch it
   * because `/legal` was listed there as a signed-out screen rendered outside
   * the shell. It is public, which is not the same thing — a signed-in reader
   * opening the Privacy Policy gets it inside the shell, with the topbar and
   * the rail, and that is the reader who was told they were on the dashboard.
   *
   * `LegalDocument` narrows the tab to the document's own name once it has
   * loaded, through `useDocumentTitle`. This is the title before that and the
   * title for the catalogue page itself.
   */
  if (pathname.startsWith('/legal')) return 'legal';
  return 'dashboard';
}

/**
 * Which RAIL entry a tab lights, when that is not the tab itself.
 *
 * `tabForPath` names the page — that is what PAGE_META is keyed on — and for
 * almost every path the rail entry has the same name. The discovery
 * destinations are the exception: a member's profile and an organization page
 * are their own pages with their own titles, and they are reached from
 * Discover, which is where finding a person now lives. Without this the
 * rail would go dark on every search result, which reads as having navigated
 * out of the application.
 *
 * A map rather than a second branch chain, so the two answers are visibly one
 * table apart instead of interleaved in one function.
 */
export const RAIL_TAB = {
  directory: 'browse',
  organizations: 'browse',
  /**
   * These three have no rail entry of their own and are reached FROM one, so
   * they borrow its highlight rather than leaving the rail dark — the same
   * argument the two above are here for. Check-in is opened from an event,
   * `/portfolio` and `/hours` from the dashboard, and the agreement from the
   * dashboard an organizer is held on until they sign it.
   */
  checkin: 'browse',
  portfolio: 'dashboard',
  loggedHours: 'dashboard',
  certificates: 'dashboard',
  /* The viewer is reached from the certificates list, which is reached from the
     dashboard — so it borrows the same highlight rather than leaving the rail
     dark, which reads as having navigated out of the application. */
  certificate: 'dashboard',
  reportIssue: 'dashboard',
  externalHours: 'dashboard',
  organizerAgreement: 'dashboard',
  studentOrganizerAgreement: 'dashboard',
  appealForm: 'dashboard',
};

/** Every nav entry the user may see, `/` first, in the order the shell renders. */
export function navItemsFor(user) {
  const dashboard = DASHBOARD_NAV[personaFor(user)];
  return [
    ...(dashboard ? [{ id: 'dashboard', path: '/', ...dashboard }] : []),
    /**
     * Withheld hides an entry — with one declared exception.
     *
     * Hiding is the right default and there are tests on it: an organizer who has
     * not accepted their agreement loses Messages and Welly from the nav, because
     * offering a door that will 403 teaches the reader the product is broken.
     *
     * The Admin entry is different in kind. It is gated on `report.resolve`,
     * which the Admin Responsibilities Policy withholds — so hiding it hid the
     * page that CONTAINS the way to get it back, and the only route to the policy
     * was knowing the URL. An entry whose destination resolves its own withholding
     * has to stay reachable, and `showWhenWithheld` is how that is declared on the
     * one entry rather than inferred for all of them.
     */
    ...NAV.filter(n => (n.requiredCapAny ?? [n.requiredCap]).some(
      cap => can(user, cap) || (n.showWhenWithheld && (user?.withheld ?? []).includes(cap))
    ))
  ].filter(n => !n.requiresVerified || user.verified);
}

/**
 * The same entries `navItemsFor` returns, split by declared priority.
 *
 * ── Derived from navItemsFor, deliberately ──
 *
 * It takes that function's OUTPUT rather than filtering `NAV` a second time.
 * Two independent filters over one table is how a nav entry ends up visible in
 * one surface and not the other, and here the two surfaces are the desktop rail
 * and the mobile "More" sheet — so a drift would mean a page an administrator
 * can reach on a phone and cannot find on a laptop. Every capability decision
 * happens in exactly one place, above.
 *
 * The two lists PARTITION the flat one: every entry is in exactly one of them,
 * because `secondary` is a boolean and nothing else is consulted. That is the
 * property the mobile bar depends on — it draws `primary` and puts `secondary`
 * behind `⋯`, so an entry in both would render twice and an entry in neither
 * would be unreachable. It replaced a `slice(0, 4)` against a separate
 * section-based sheet, where those two failure modes were one off-by-one apart.
 *
 * @returns {{ primary: object[], secondary: object[] }}
 */
export function navSectionsFor(user) {
  const items = navItemsFor(user);
  return {
    primary: items.filter(n => !n.secondary),
    secondary: items.filter(n => n.secondary),
  };
}

/**
 * Page titles, keyed by persona rather than by role.
 *
 * The `volunteer`/`host`/`staff` blocks are the former `student`/`organizer`/
 * `admin` blocks verbatim — only the key changed, so what those three roles
 * read is byte-identical. `staff` is what super_admin sees too.
 *
 * A tab with no entry falls back to `{ title: APP_NAME, sub: '' }`. That default
 * names the app rather than describing some other persona's screen, which is the
 * defensible answer — but it is a fallback, not a design, and every reachable tab
 * should have a real entry. `settings` is now filled in for every persona
 * (ProfileMenu offers it to every role), and the two hour pages are named under
 * `staff` because an owner holds `'*'` and reaches both.
 *
 * The earlier version of this note argued against filling in the remaining
 * super_admin tabs, on the grounds that they live in the shared `staff` block and
 * would therefore change what an ADMIN reads. That is true and it is not a
 * reason: an admin reaching /settings read the bare product name too, which is
 * not behaviour worth preserving.
 */
/* Exported for `App.navGroups.test.jsx`, which asserts that the administrative
   hub is called the same thing in the rail and in the page title — two names for
   one destination means two people cannot describe it to each other. */
export const PAGE_META = {
  volunteer: {
    appealForm: { title: 'Make an appeal', sub: 'Ask somebody who was not involved to look at a decision again' },
    settings: { title: 'Settings', sub: 'Your account, privacy, and notifications' },
    /* Public, and reachable by every persona from the Help area of Settings
       and from the footer of the signed-out screens. */
    legal: { title: 'Legal Center', sub: 'The documents that govern using WeVolunteer' },
    portfolio: { title: 'Transcript', sub: 'Every event you have served at, with its confirmed hours' },
    organizerAgreement: { title: 'Organizer Agreement', sub: 'The terms for running events with students' },
    studentOrganizerAgreement: { title: 'Student Organizer Agreement', sub: 'What you take on when you help run an organization' },
    dashboard: { title: 'Dashboard', sub: 'Your shifts, hours, and history' },
    /**
     * ── "Discover", matching the rail entry and the route ──
     *
     * This block used to argue the opposite — that the label should stay
     * "Opportunities" — and it was left standing after the rename went the other
     * way, so the comment contradicted the line beneath it and the NAV entry it
     * describes. The reasoning that won is recorded once, at the NAV entry: the
     * page holds shifts, people and organizations, and "Opportunities" was
     * simultaneously the name of the whole destination and of one of the four
     * scope tabs inside it.
     *
     * The subtitle is what carries the specificity the old label was doing:
     * naming all three, so the heading does not describe only the grid.
     */
    browse: { title: 'Discover', sub: 'Find a shift, a club, or someone you volunteer with' },
    calendar: { title: 'Calendar', sub: 'Your shifts and the deadlines that matter' },
    /* Named both audiences once messaging stopped being organizers-only. The
       old line was the page-header twin of the recipient picker's sentence, and
       it went stale for the same reason — see recipientCopy.js. */
    messages: { title: 'Messages', sub: 'Talk to your friends and the organizers of shifts you applied for' },
    welly: { title: 'Welly', sub: 'Ask about your hours, your applications, and what is coming up' },
    notifications: { title: 'Notifications', sub: 'Replies, reminders, and event updates' },
    profile: { title: 'Profile', sub: 'Your service record, milestones, and certificates' },
    loggedHours: { title: 'Logged hours', sub: 'Everything you have volunteered, confirmed and self-reported' },
    certificates: { title: 'Certificates', sub: 'One for each event you have completed' },
    certificate: { title: 'Certificate', sub: 'Download it, print it, or share the verification link' },
    reportIssue: { title: 'Report an Issue', sub: 'Tell us what is broken, confusing, or unsafe' },
    externalHours: { title: 'Log external hours', sub: 'Volunteering you did somewhere WeVolunteer does not run' },
    /* Reached from the search on Discover, and titled for what is on the
       page rather than for where the reader came from. */
    directory: { title: 'Member profile', sub: 'Someone you volunteer alongside' },
    organizations: { title: 'Organization', sub: 'A club or group posting opportunities' }
  },
  host: {
    appealForm: { title: 'Make an appeal', sub: 'Ask somebody who was not involved to look at a decision again' },
    settings: { title: 'Settings', sub: 'Your account, privacy, and notifications' },
    /* Public, and reachable by every persona from the Help area of Settings
       and from the footer of the signed-out screens. */
    legal: { title: 'Legal Center', sub: 'The documents that govern using WeVolunteer' },
    organizerAgreement: { title: 'Organizer Agreement', sub: 'The terms for running events with students' },
    studentOrganizerAgreement: { title: 'Student Organizer Agreement', sub: 'What you take on when you help run an organization' },
    checkin: { title: 'Check-in', sub: 'Mark volunteers as they arrive' },
    create: { title: 'New opportunity', sub: 'Post a shift for volunteers to apply to' },
    volunteers: { title: 'Your volunteers', sub: 'Everyone who has volunteered at your events' },
    dashboard: { title: 'Dashboard', sub: 'Track your volunteers, hours, and pending reviews' },
    browse: { title: 'Discover', sub: 'Events on the network, and the members and clubs behind them' },
    calendar: { title: 'Calendar', sub: 'Events you host and when applications close' },
    /* See the note in the partner block: this page is reachable by every
       signed-in account and was described for two personas out of four. */
    reportIssue: { title: 'Report an Issue', sub: 'Tell us what is broken, confusing, or unsafe' },
    messages: { title: 'Messages', sub: 'Coordinate directly with volunteers regarding your events' },
    welly: { title: 'Welly', sub: 'Ask about your events, your applicants, and shifts still short of volunteers' },
    notifications: { title: 'Notifications', sub: 'Application updates and community alerts' },
    profile: { title: 'Profile', sub: 'Your public track record and organizer status' },
    directory: { title: 'Member profile', sub: 'Someone who volunteers on this platform' },
    organizations: { title: 'Organization', sub: 'A club or group posting opportunities' }
  },
  staff: {
    appealForm: { title: 'Make an appeal', sub: 'Ask somebody who was not involved to look at a decision again' },
    settings: { title: 'Settings', sub: 'Your account, privacy, and notifications' },
    /* Public, and reachable by every persona from the Help area of Settings
       and from the footer of the signed-out screens. */
    legal: { title: 'Legal Center', sub: 'The documents that govern using WeVolunteer' },
    portfolio: { title: 'Transcript', sub: 'Every event you have served at, with its confirmed hours' },
    organizerAgreement: { title: 'Organizer Agreement', sub: 'The terms for running events with students' },
    studentOrganizerAgreement: { title: 'Student Organizer Agreement', sub: 'What you take on when you help run an organization' },
    checkin: { title: 'Check-in', sub: 'Mark volunteers as they arrive' },
    create: { title: 'New opportunity', sub: 'Post a shift for volunteers to apply to' },
    volunteers: { title: 'Your volunteers', sub: 'Everyone who has volunteered at your events' },
    calendar: { title: 'Calendar', sub: 'Events across the district and when they close' },
    messages: { title: 'Messages', sub: 'Conversations with students and organizers' },
    welly: { title: 'Welly', sub: 'Ask about reports, appeals, and the records you administer' },
    audit: { title: 'Audit Explorer', sub: 'Every administrative action, and who took it' },
    roster: { title: 'Admin Roster', sub: 'Who holds administrative access' },
    badges: { title: 'Badges', sub: 'What the platform recognises, and who holds what' },
    /* `staff` only, like `audit` and `roster` above: `legal.edit` is SUPER_ONLY,
       so no other persona can reach the page and an entry under one would be a
       title nobody will ever see. */
    legalEditor: { title: 'Legal Center editor', sub: 'Publish new versions of the documents people agree to' },
    dashboard: { title: 'Dashboard', sub: 'Reports waiting, organizers to approve, and how the programme is doing' },
    /* "All events" was the pre-consolidation title, and it survived the rename
       into two personas. It disagreed with the rail item that opens the page
       ("Discover") and it named a third of what the page holds — the same
       two faults the volunteer entry above was already corrected for. The
       organizer's page was "Recruit" until the owner ruled (2026-09-30) that
       it is "Discover" for every persona, like the rail item that opens it. */
    browse: { title: 'Discover', sub: 'Every opportunity, member, and club across the district' },
    notifications: { title: 'Notifications', sub: 'Platform activity' },
    errors: { title: 'Errors', sub: 'Crashes and faults reported by browsers, the server, and background jobs' },
    appeals: { title: 'Appeals', sub: 'Review and decide user suspension appeals' },
    issues: { title: 'Reported problems', sub: 'What people sent from Report an Issue' },
    adminOrganizers: { title: 'Approved organizers', sub: 'Who may post events, and taking that back' },
    /* "Admin", matching the rail. A page whose title differs from the label the
       reader clicked to reach it makes them wonder whether they arrived. */
    moderation: { title: 'Admin', sub: 'Every administrative area you can open' },
    /* `staff` only, because `staff` is now the only persona that can open the
       page — `analytics.impact` is administrative. There was no entry for it at
       all while every role could reach it, so the topbar fell back to the
       application name and the one page of figures was the one page with no
       title. */
    impact: { title: 'Community Impact', sub: 'What the programme has done, counted from confirmed attendance' },
    adminImpact: { title: 'Platform Impact', sub: 'Programme-wide figures for the whole platform' },
    directory: { title: 'Member profile', sub: 'Someone who volunteers on this platform' },
    organizations: { title: 'Organization', sub: 'A club or group posting opportunities' },
    profile: { title: 'Profile', sub: 'Your account on this platform' },
    /* An owner holds '*', so both hour pages are reachable from this persona. */
    loggedHours: { title: 'Logged hours', sub: 'Confirmed service and self-reported entries' },
    certificates: { title: 'Certificates', sub: 'One for each event you have completed' },
    certificate: { title: 'Certificate', sub: 'Download it, print it, or share the verification link' },
    /* `staff` only, like `audit`, `roster` and `legalEditor` above:
       `owner.console` is SUPER_ONLY, so no other persona can open the page and
       an entry under one would be a title nobody will ever see. */
    owner: { title: 'Owner Center', sub: 'Whether WeVolunteer is healthy, and what needs attention' },
    reportIssue: { title: 'Report an Issue', sub: 'Tell us what is broken, confusing, or unsafe' },
    externalHours: { title: 'Log external hours', sub: 'Volunteering done outside WeVolunteer' }
  },
  partner: {
    appealForm: { title: 'Make an appeal', sub: 'Ask somebody who was not involved to look at a decision again' },
    settings: { title: 'Settings', sub: 'Your account, privacy, and notifications' },
    /* Public, and reachable by every persona from the Help area of Settings
       and from the footer of the signed-out screens. */
    legal: { title: 'Legal Center', sub: 'The documents that govern using WeVolunteer' },
    /* No `welly` entry, deliberately. Welly answers from the reader's own
       record and every one of its tools is scoped to `self.read`, which a
       partner does not hold — so both the rail entry and the route gate refuse
       it, and a title here would describe a page nobody can open. */
    /* `/organizer-agreement` is the one route declared with NO capability, on
       purpose — it is how an organizer accepts the terms that grant the rest —
       so any signed-in role can open it, partner included. */
    organizerAgreement: { title: 'Organizer Agreement', sub: 'The terms for running events with students' },
    studentOrganizerAgreement: { title: 'Student Organizer Agreement', sub: 'What you take on when you help run an organization' },
    dashboard: { title: 'Dashboard', sub: 'Partner accounts do not have a dashboard yet' },
    /* "All events" was the pre-consolidation title, and it survived the rename
       into two personas. It disagreed with the rail item that opens the page
       ("Discover") and it named a third of what the page holds — the same
       two faults the volunteer entry above was already corrected for. The
       organizer's page was "Recruit" until the owner ruled (2026-09-30) that
       it is "Discover" for every persona, like the rail item that opens it. */
    browse: { title: 'Discover', sub: 'Every opportunity, member, and club across the district' },
    /**
     * `profile` was missing, and partner is the role the distinguished profile
     * was BUILT for — so the one page it exists to serve fell through to the
     * `{ title: APP_NAME, sub: '' }` fallback and rendered under the bare product
     * name.
     *
     * `notifications`, `directory` and `organizations` are here for completeness
     * rather than because a partner reaches them today: partner holds neither
     * `self.read` nor `directory.read` (see authz.js, where the directory is
     * deliberately withheld from an external body). They cost nothing and mean
     * that granting either capability later does not reintroduce an untitled
     * page.
     */
    notifications: { title: 'Notifications', sub: 'Updates about your organization' },
    /**
     * A partner can open `/calendar` — the route gate is `event.view`, which
     * they hold so that Discover works — and saw the bare product name.
     *
     * Titled rather than blocked or built out. Owner decision 6B of the
     * 2026-09-21 audit: the page is reachable and deliberately unpromoted, so
     * the reader who arrives is told what it is. Adding the key is exactly what
     * was done for `profile` when it fell through the same fallback, and for
     * the three keys beside it that a partner does not reach today.
     *
     * `welly` is still absent, and the difference is the reason: its route gate
     * REFUSES a partner, so a title there would describe a page nobody can open.
     * This one does not refuse.
     *
     * The subtitle says what a partner will actually see. They have no shifts
     * and host nothing, so the only entries their index can produce are
     * deadlines for events they favourited — promising anything more would be
     * the fallback wearing a title.
     */
    calendar: { title: 'Calendar', sub: 'Application deadlines for opportunities you have favorited' },
    /* Reachable by everybody signed in, and described for volunteers and staff
       only — so an organizer and a partner reporting something broken read the
       bare product name. Same copy as the other two blocks. */
    reportIssue: { title: 'Report an Issue', sub: 'Tell us what is broken, confusing, or unsafe' },
    profile: { title: 'Profile', sub: 'How your organization appears on this platform' },
    directory: { title: 'Member profile', sub: 'Someone who volunteers on this platform' },
    organizations: { title: 'Organization', sub: 'A club or group posting opportunities' }
  }
};

/**
 * How a role is named to the person holding it.
 *
 * A lookup keyed by role, which is the correct way to *label* a role — unlike
 * comparing one, which is what the rest of this file no longer does. Every entry
 * in ROLES has a label, so the `||` below is unreachable defence rather than the
 * silent default that rendered the platform owner as "Volunteer";
 * App.shellByRole.test.jsx pins that completeness so a sixth role cannot ship
 * without one.
 */
export const ROLE_LABEL = {
  admin: 'Administrator',
  organizer: 'Organizer',
  student: 'Volunteer',
  super_admin: 'Platform administrator',
  partner: 'Partner'
};

/**
 * Paths that arrive as a link from an email or an OAuth provider, and so must
 * resolve whether or not a session exists. Handled ahead of the session
 * branches in AppShell — see the comment at the check itself.
 */
const AUTH_FLOW_PATHS = [OAUTH_CALLBACK_PATH, '/reset-password'];

/**
 * Addressable takeover URLs — `/404`, `/500`, `/offline` and the rest.
 *
 * ── Why the app never NAVIGATES to these ──
 *
 * The obvious wiring is "unknown URL, so redirect to /404", and it breaks two
 * things that matter more than the tidiness it buys.
 *
 * It destroys the URL. A 404's single most useful property is that it still
 * shows what the reader typed or was sent, so they can spot the typo or forward
 * the link to whoever gave it to them. That is the whole reason this stopped
 * being `<Navigate to="/" />` in the first place.
 *
 * And it turns Back into a trap. `/typo` redirects to `/404`; the reader presses
 * Back, lands on `/typo`, which redirects to `/404` again. There is no way out
 * of that with the Back button, which is the first thing anyone reaches for on
 * an error page. The same loop closes on `/offline`: Back returns to the page
 * that had no connection, which sends them straight back out again.
 *
 * So these are DESTINATIONS. Every takeover renders in place, above the shell,
 * keeping its URL — and the paths in `ERROR_ROUTES` exist so a state can also be
 * linked, bookmarked or opened directly. `/maintenance` is only ever reached
 * that way.
 */

/**
 * Every path the authenticated shell serves, as route objects for `matchRoutes`.
 *
 * Derived from the same table the router renders, so a route added to
 * `APP_ROUTES` cannot start 404ing here. `/` and `/profile` are listed
 * explicitly because they are a different component per persona and live
 * outside the table for that reason.
 */
const SHELL_ROUTE_PATTERNS = [{ path: '/' }, { path: '/profile' }, ...APP_ROUTES.map(r => ({ path: r.path }))];

/** Whether the authenticated shell has anything to render for `pathname`. */
function shellServes(pathname) {
  return matchRoutes(SHELL_ROUTE_PATTERNS, pathname) !== null;
}

/**
 * Whether `user` is refused the route at `pathname` — decided BEFORE the shell,
 * for the same reason the 404 is.
 *
 * The note on the 404 takeover below says it exactly: a refusal rendered from
 * inside the route table "can only render into the slot the shell already built
 * around it, so the sidebar, topbar and profile menu would still be on screen
 * either side of it". That was true of the 403 the whole time. It was the one
 * error state still rendering as a card inside the running app — nav rail down
 * the left, profile menu top right, "Your badge doesn't open this one" in the
 * content well — while 404, 500, the crash boundary and the offline overlay had
 * all been moved out to take the screen.
 *
 * It reads as a page that failed to load rather than a decision, and it leaves
 * the nav for a section the reader has just been told they cannot open.
 *
 * Matched with the router's own matcher against APP_ROUTES, so a `:param` route
 * resolves the same way here as it does when the table renders it, and the two
 * cannot disagree about which route a path is.
 *
 * Returns the ROUTE, not a boolean, so the caller can tell the reader what was
 * refused rather than only that something was.
 *
 * The two conditions below MIRROR the route table's own element ternary exactly
 * — `requiresVerified` first, then `requiredCap` — and deliberately nothing
 * more, plus `requiredCapAny` — which both now honour. This function decides
 * whether the shell is built at all, so any condition here that the table does
 * not also apply would refuse a route the table would have rendered, with no way
 * for the reader to reach it; and any condition the table applies that this does
 * not would build a shell around a page the reader is then refused, which is the
 * same drift the other way round. The two lists below must stay identical to the
 * element ternary further down.
 */
/**
 * Whether a route's capability requirement is satisfied — including the one
 * declared exception.
 *
 * `showWhenWithheld` means "this page is where the withholding is resolved".
 * The Admin page is gated on `report.resolve`, and the Admin Responsibilities
 * Policy withholds exactly that — so without this the gate refused entry to the
 * page that CONTAINS the gate, and an administrator who had not accepted met
 * "Your badge doesn't open this one" with no way forward. Found by opening the
 * page in a browser; the suite was green throughout, because no test navigated
 * there as an account holding that capability withheld.
 *
 * Withheld is not the same as never held. A student has no `report.resolve` and
 * is refused exactly as before. An administrator has one that is paused, and the
 * page behind it exists to say so and offer the way back. Every action on it is
 * re-checked server-side, so this widens what may be SEEN, never what may be DONE.
 *
 * Shared by `deniedRoute` and the element ternary, because the comment on that
 * pair is right that two copies of this rule drift — and the drift would be a
 * page reachable by one path and refused by the other.
 */
function routeCapSatisfied(route, user) {
  const withheld = user?.withheld ?? [];
  const held = cap => can(user, cap) || (route.showWhenWithheld && withheld.includes(cap));
  if (route.requiredCap && !held(route.requiredCap)) return false;
  if (route.requiredCapAny?.length && !route.requiredCapAny.some(held)) return false;
  return true;
}

function deniedRoute(pathname, user) {
  const matched = matchRoutes(APP_ROUTES.map(r => ({ path: r.path, route: r })), pathname);
  const route = matched?.[matched.length - 1]?.route?.route;
  if (!route) return null;

  if (route.requiresVerified && !user.verified) return route;
  if (!routeCapSatisfied(route, user)) return route;
  return null;
}

/**
 * The toast queue, and the session everything else reads.
 *
 * `addToast` is passed into SessionProvider because the bootstrap has to be able
 * to report a partial load, and the queue itself is presentation that belongs
 * with the component rendering it.
 */
export default function App() {
  const [toasts, setToasts] = useState([]);

  /* Each toast owns its own clock (`Toasts.jsx`): it pauses while read, and a
     failure stays until it is dismissed. The queue only adds and removes. */
  const addToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
  };
  const removeToast = React.useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  return (
    <SessionProvider addToast={addToast}>
      <AppShell toasts={toasts} addToast={addToast} removeToast={removeToast} />
    </SessionProvider>
  );
}

function AppShell({ toasts, addToast, removeToast }) {
  const online = useOnline();
  const navigate = useNavigate();
  /* The brand link's one-shot micro-pass; see the hook and `.wv-micro`. */
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  /* Restarts the route entrance on `<main>` on each navigation. Declared up
     here with the other hooks: this component returns early further down. */
  const routeFadeRef = useReplayClass(location.pathname, 'route-enter');

  const {
    currentUser, setCurrentUser, isCheckingSession, refresh: refreshAll, signOut,
    events, applications, favorites, refreshEvents, refreshApplications, toggleFavorite
  } = useSession();

  /* Analytics follows the account, so it can only be decided once there is one.
     Called unconditionally and before any early return, because a hook that
     runs on some renders and not others is the exact fault `hookOrder.test.jsx`
     exists to catch — and this component has several early returns below. */
  useAnalyticsConsent(currentUser);

  /**
   * The browser tab's name.
   *
   * `PAGE_META` has carried a title for every route for several releases and
   * `pageTitleCoverage.test.js` checks the table is complete — but nothing ever
   * wrote it to `document.title`, so every tab said "WeVolunteer" and the value
   * was only ever rendered as the heading in the top bar. The guard was testing
   * the DATA, not the effect, which is why a complete table and a wrong title
   * coexisted happily for so long.
   *
   * It matters most to the people least able to work around it: a screen reader
   * announces the document title on navigation, and somebody with a dozen tabs
   * open has nothing else to tell them apart. `APP_NAME` is appended so a tab is
   * still identifiable when the title alone is generic ("Settings").
   *
   * Placed here, beside the analytics hook and ABOVE every early return, and
   * deriving its own tab from the path rather than reusing the `meta` computed
   * further down — that local sits below the session-check and public-route
   * returns, so an effect using it would run on some renders and not others.
   * `hookOrder.test.jsx` exists because of exactly that mistake, and oxlint
   * caught this one on the first attempt.
   */
  const documentTitle = pageMetaFor(currentUser, tabForPath(location.pathname)).title;
  useEffect(() => {
    document.title = documentTitle && documentTitle !== APP_NAME
      ? `${documentTitle} · ${APP_NAME}`
      : APP_NAME;
  }, [documentTitle]);

  // Global intercept for password reset links
  useEffect(() => {
    if (searchParams.has('reset') && location.pathname !== '/reset-password') {
      navigate(`/reset-password?token=${encodeURIComponent(searchParams.get('reset'))}`, { replace: true });
    }
  }, [searchParams, location.pathname, navigate]);

  const [showMobileMore, setShowMobileMore] = useState(false);
  const mobileNavScrollRef = useRef(null);
  const setActiveTab = (tab) => {
    const map = {
      dashboard: '/',
      /* The canonical path, not the redirect. Navigating programmatically to
         `/events` would work, but it would put the old URL in the address bar and
         then replace it — a visible flicker on a path nothing should still use. */
      browse: '/discover',
      create: '/events/new',
      calendar: '/calendar',
      notifications: '/notifications',
      profile: '/profile'
    };
    if (map[tab]) navigate(map[tab]);
  };

  const [notifKey, setNotifKey] = useState(0);
  const [editingProfile, setEditingProfile] = useState(false);
  /* Bumped after a profile save, to remount whichever profile view is on
     screen. See the `onSave` on ProfileEditModal. */
  const [profileRefreshKey, setProfileRefreshKey] = useState(0);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  /**
   * Events seen outside the index, keyed by id.
   *
   * BrowseEvents now fetches its own filtered pages, so it can show an event the
   * index does not contain — one the user neither hosts nor has applied to.
   * `events.find` alone would then fail to open it and the user would be told
   * "That event is no longer available" about something they are looking at.
   * Anything browse renders is recorded here so the modal can still resolve it.
   */
  const [seenEvents, setSeenEvents] = useState({});
  const rememberEvents = React.useCallback((list) => {
    if (!list?.length) return;
    setSeenEvents(prev => {
      let changed = false;
      const next = { ...prev };
      for (const e of list) {
        if (!e?.id) continue;
        /**
         * MERGED, not replaced.
         *
         * Browse reports what it rendered from more than one fetch path, and
         * they do not all return the same projection. A later, thinner response
         * used to overwrite an earlier richer one wholesale, so an event that
         * arrived complete could lose `slots` — and with them the shift list —
         * because a subsequent search or page load mentioned it in passing.
         *
         * Layering keeps whatever any response has supplied. A field is only
         * ever replaced by a NEW value for that field, never erased by a
         * response that simply did not carry it.
         */
        const merged = next[e.id] ? { ...next[e.id], ...e } : e;
        if (next[e.id] !== merged) { next[e.id] = merged; changed = true; }
      }
      return changed ? next : prev;
    });
  }, []);

  // Derived state from URL
  const selectedEventId = searchParams.get('event');
  /**
   * The event the modal renders, merged from the two places it can come from.
   *
   * ── Why a merge and not a pick ──
   *
   * `events` (SessionProvider) and `seenEvents` (whatever a browse surface just
   * rendered) are DIFFERENT PROJECTIONS of the same row, not a fresh copy and a
   * stale one. The session index is deliberately narrow — "only events this user
   * is involved in" — while the browse response carries the fields the modal
   * actually needs to decide what to show: `slots`, and `viewerBan`, which is
   * computed per organization for this reader.
   *
   * This used to be `events.find(...) || seenEvents[id]`, so whenever an event
   * appeared in BOTH — which is every event the reader has applied to — the
   * narrower index won and the richer object was discarded. The visible symptom
   * was a modal that said "No shifts yet" and "Applications closed" about an
   * event with a live shift and a deadline five days out, and, for a banned
   * reader, no ban notice at all: `viewerBan` was simply not on the object the
   * modal received. Reproduced against a real ban, where `/api/events` returned
   * both fields and the modal rendered neither.
   *
   * The seen object is layered ON TOP because it is the response the reader was
   * just served, for the surface they are looking at. The index underneath still
   * supplies anything browse omits, so nothing that worked before is lost.
   */
  const selectedEvent = selectedEventId
    ? (() => {
      const indexed = events.find(e => e.id === selectedEventId);
      const seen = seenEvents[selectedEventId];
      if (!indexed && !seen) return null;
      return { ...indexed, ...seen };
    })()
    : null;
  /**
   * ── The deep link, which is where every notification EMAIL lands ──
   *
   * `notificationWorker` turns any `event:` link into
   * `${APP_URL}/?event=<id>`, and that arrives as a COLD LOAD: `seenEvents` is
   * empty because no browse surface has rendered, and `events` holds only what
   * `{mine: 'true'}` returned. When neither had the id, `selectedEvent` was
   * null and `{selectedEvent && …}` rendered nothing — no modal, no error, no
   * explanation. The reader pressed "View Event Details" in their inbox and
   * arrived at their own dashboard.
   *
   * So an unresolved `?event=` is backfilled into `seenEvents`, after which the
   * merge above resolves it on the next render like any other browse response.
   *
   * Attempts are remembered per id rather than per render: `selectedEvent` is a
   * fresh object every render, so depending on it would loop, and an id the
   * server genuinely does not have must be asked about once rather than
   * forever.
   */
  const eventLookupsTried = useRef(new Set());
  useEffect(() => {
    if (!selectedEventId || selectedEvent) return;
    if (eventLookupsTried.current.has(selectedEventId)) return;
    eventLookupsTried.current.add(selectedEventId);

    let cancelled = false;
    resolveEventById(selectedEventId, { events, seenEvents, fetchById: api.fetchEventById })
      .then(found => { if (found && !cancelled) rememberEvents([found]); });
    return () => { cancelled = true; };
    /* `selectedEvent` is read but deliberately not a dependency — it is rebuilt
       every render, and the ref above is what makes one attempt one attempt. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventId, events, seenEvents, rememberEvents]);

  const profileId = searchParams.get('profile');
  const profileType = searchParams.get('type');
  const viewingProfile = profileId && profileType ? { type: profileType, id: profileId } : null;

  const currentPath = location.pathname;
  const activeTab = tabForPath(currentPath);

  /**
   * Centre the active destination in the mobile strip.
   *
   * The ref is on the SCROLLER, not on the `<nav>`. It used to be on the `<nav>`,
   * which was `display: grid` with no overflow — so `scrollTo` was a no-op on an
   * element that could not scroll, and this effect had never done anything. Now
   * that the strip genuinely scrolls, pointing it at the wrong element would leave
   * an off-screen active tab off-screen, which is the only case it exists for.
   *
   * Scoping the query to the scroller also excludes the `⋯` button, which carries
   * `aria-current="page"` while the sheet is open and is deliberately outside the
   * scroller.
   */
  useEffect(() => {
    const scroller = mobileNavScrollRef.current;
    if (!scroller) return;
    const activeBtn = scroller.querySelector('[aria-current="page"]');
    if (!activeBtn) return;
    const scrollLeft = activeBtn.offsetLeft - (scroller.offsetWidth / 2) + (activeBtn.offsetWidth / 2);
    scroller.scrollTo({ left: scrollLeft, behavior: 'smooth' });
  }, [activeTab]);

  /**
   * Whether the strip has anything hidden, and on which side.
   *
   * The fade that signals "there is more this way" used to be a media query at
   * 360px, which is a guess about when overflow happens rather than a
   * measurement of it. The guess is now wrong in both directions: Welly made
   * five primary destinations the normal case for every role and six for an
   * owner, so a 390px phone can overflow and get no cue, while a 340px phone
   * showing four entries gets a fade over nothing.
   *
   * Measuring is cheap and exact. `data-overflow` says which edge has content
   * beyond it, and the CSS masks that edge only — so the cue appears when there
   * is genuinely something to scroll to, disappears once you reach it, and
   * never dims the last item on a bar that fits.
   */
  /* A callback ref rather than an effect. It was an effect keyed on
     `currentUser`, and on a real network the user arrives one render before
     the shell does — the session check sets the user, then waits on the data
     fetches — so the effect fired while the loading screen was up, found no
     bar, and never ran again. The cue was never set. A callback ref runs when
     the bar itself mounts, whatever caused it to. */
  const attachMobileNavScroll = React.useCallback((scroller) => {
    mobileNavScrollRef.current = scroller;
    if (!scroller) return undefined;

    const measure = () => {
      /* 2px of slack: sub-pixel layout rounding otherwise reports a permanent
         one-pixel overflow on a bar that visibly fits. */
      const hiddenStart = scroller.scrollLeft > 2;
      const hiddenEnd = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 2;
      scroller.dataset.overflow = hiddenStart && hiddenEnd ? 'both'
        : hiddenEnd ? 'end'
        : hiddenStart ? 'start'
        : 'none';
    };

    measure();
    scroller.addEventListener('scroll', measure, { passive: true });
    /* Rotation and a keyboard opening resize the strip; the entry list
       changing with the reader's capabilities changes what is inside it. None
       of these fires a scroll event. */
    const resized = new ResizeObserver(measure);
    resized.observe(scroller);
    const changed = new MutationObserver(measure);
    changed.observe(scroller, { childList: true });
    return () => {
      scroller.removeEventListener('scroll', measure);
      resized.disconnect();
      changed.disconnect();
      if (mobileNavScrollRef.current === scroller) mobileNavScrollRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onClick = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setUserMenuOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);

  const handleCreateEvent = async (eventData) => {
    await api.createEvent(eventData);
    refreshEvents();
    navigate('/');
  };

  // Session teardown lives in SessionProvider.signOut; the menu this closes is
  // shell state, so it stays here.
  const handleLogout = async () => {
    setUserMenuOpen(false);
    await signOut();
  };

  /**
   * Where somebody lands after signing in or signing up.
   *
   * ── The invitation hand-off ──
   *
   * Somebody who opened a club's invitation link with no account, pressed Join,
   * and was sent here to make one is not trying to reach the dashboard. The club
   * they came for is written to `sessionStorage` before they leave the invitation
   * page and read back once, here.
   *
   * This is deliberately NOT a `returnTo`. What comes back is a SLUG that this
   * application's own server produced, and it is interpolated into a fixed
   * `/organizations/` prefix — so there is no input that can make this navigate
   * anywhere else, and therefore nothing to validate and no open-redirect
   * surface to get wrong. `consumePendingRedirect` marks it spent, so a later
   * sign-in in the same tab lands on the dashboard like any other.
   *
   * A storage failure (a private window, blocked site data) simply returns null
   * and the person lands on the dashboard. Losing the destination is the right
   * way for that to fail; losing the sign-in would not be.
   */
  const handleLoginSuccess = () => {
    refreshAll();
    const invite = consumePendingRedirect();
    navigate(invite ? organizationPath(invite.slug) : '/');
  };

  const setViewingProfileState = (profile) => {
    if (profile === null) {
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('profile');
      newParams.delete('type');
      setSearchParams(newParams);
    } else {
      const newParams = new URLSearchParams(searchParams);
      newParams.set('profile', profile.id);
      newParams.set('type', profile.type);
      setSearchParams(newParams);
    }
  };

  /**
   * @param {string|null} eventId
   * @param {'hours'} [mode]  which screen the modal opens on. Omitted means the
   *                          event itself, which is every existing caller.
   *
   * `mode` rides in the URL beside `event` so the destination survives a reload
   * and a copied link, exactly as the event id does. It is cleared whenever the
   * modal closes or a different event is opened, so it cannot leak from one
   * event onto the next.
   */
  const setSelectedEventState = (eventId, mode) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.delete('mode');
    if (eventId === null) {
      newParams.delete('event');
    } else {
      newParams.set('event', eventId);
      if (mode) newParams.set('mode', mode);
    }
    setSearchParams(newParams);
  };

  // Callers pass either an event object (cards, dashboards) or an id string
  // (notifications, calendar, profiles). Normalise here rather than at nine
  // call sites — `viewVolunteer` below already takes the same approach.
  const openEventById = async (eventOrId, options) => {
    const id = typeof eventOrId === 'string' ? eventOrId : eventOrId?.id;
    if (!id) return addToast('That event is no longer available.', 'info');

    // Given the whole object — which is what a card passes — trust it and record
    // it, rather than insisting it also be in the index. Browse pages are
    // filtered server-side now and legitimately contain events the index does not.
    if (typeof eventOrId === 'object' && eventOrId) {
      rememberEvents([eventOrId]);
      return setSelectedEventState(id, options?.mode);
    }

    /**
     * An id alone is what a NOTIFICATION hands over, and the caches are the
     * wrong authority for it.
     *
     * This used to be `events.some(…) || seenEvents[id]`, and a miss became
     * "That event is no longer available." But `events` is fetched with
     * `{mine: 'true'}` for anybody without `event.moderate`, and `seenEvents`
     * is empty on a cold load — so two notification kinds whose entire purpose
     * is to point at an event the reader is NOT part of, `FRIEND_SIGNED_UP`
     * and `ORGANIZATION_EVENT_POSTED`, said that about a live, open event.
     *
     * `resolveEventById` still checks both caches first and only then asks the
     * server, through the browse query narrowed by id — same authorization,
     * same withholding of arrival instructions from non-attendees. The message
     * survives for the case where it is true.
     */
    const resolved = await resolveEventById(id, {
      events, seenEvents, fetchById: api.fetchEventById,
    });
    if (!resolved) return addToast('That event is no longer available.', 'info');

    rememberEvents([resolved]);
    setSelectedEventState(id, options?.mode);
  };

  const viewVolunteer = (person) => {
    const id = typeof person === 'string' ? person : person?.id;
    if (id) setViewingProfileState({ type: 'volunteer', id });
  };
  const viewOrganizer = (id) => id && setViewingProfileState({ type: 'organizer', id });

  /* Dev-only contact sheet. Sits with the other early returns — after every
     hook has run, so rendering it cannot change hook order — and above the
     session branches, because it must work signed in or out and reads neither. */
  if (import.meta.env.DEV && currentPath === '/__errors') {
    return (
      <React.Suspense fallback={<RouteFallback />}>
        <ErrorGallery />
      </React.Suspense>
    );
  }

  /* The takeover routes. Above the session branches because a failure screen
     must render identically signed in or out, and returned bare — no shell, no
     OfflineOverlay, no Toasts — because "standalone" is the entire point. */
  const errorRouteKind = ERROR_ROUTES[currentPath];
  if (errorRouteKind) {
    return <ErrorExperience kind={errorRouteKind} signedIn={Boolean(currentUser)} standalone />;
  }

  if (AUTH_FLOW_PATHS.includes(currentPath)) {
    return (
      <>
        <React.Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path={OAUTH_CALLBACK_PATH} element={
            <OAuthCallback
              onLoginSuccess={handleLoginSuccess}
              /* Someone who started this from Settings wants to end up back in
                 Settings, not on the dashboard. */
              onLinked={() => { refreshAll(); navigate('/settings?section=security', { replace: true }); }}
              addToast={addToast}
            />
          } />
          <Route path="/reset-password" element={
            <ResetPassword
              token={searchParams.get('token')}
              onSuccess={() => {
                /**
                 * A reset bumps token_version, so any session this tab still
                 * holds is already dead and `currentUser` in memory is stale.
                 * A hard navigation is the honest move: it drops the stale
                 * state in both session states rather than letting a soft
                 * route change render an authenticated shell that will 401 on
                 * its first request.
                 */
                addToast('Password updated. Please sign in.', 'success');
                window.location.assign('/login');
              }}
              onCancel={() => navigate('/login', { replace: true })}
            />
          } />
        </Routes>
        </React.Suspense>
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  /* ── Session check ─────────────────────────────────────────── */
  if (isCheckingSession) {
    return <FullPageWait label="Loading WeVolunteer…" />;
  }

  /* Public routes (certificate verification, the privacy notice) bypass auth
     checks. The test is DERIVED from PUBLIC_ROUTES rather than restated: this
     was `currentPath.startsWith('/verify/')`, a hardcoded second copy of the
     table, so adding a route to PUBLIC_ROUTES left it unreachable — it fell
     through to the signed-out catch-all and answered 404 while looking
     correctly declared. */
  /* `signedIn` matters: `/organizations/:key` is in both tables, and a reader
     with a session must get the shell's organization page rather than the
     standalone public one — see `shellWhenSignedIn` on that entry. */
  if (isPublicPath(currentPath, { signedIn: Boolean(currentUser) })) {
    return (
      <React.Suspense fallback={<RouteFallback />}>
        <Routes>
          {PUBLIC_ROUTES.map(route => (
            <Route key={route.path} path={route.path} element={route.element} />
          ))}
        </Routes>
      </React.Suspense>
    );
  }

  if (!currentUser) {
    const signedOutProps = {
      /* Declared empty, not omitted: `withProps` throws on a missing entry
         precisely so a new route cannot mount with every prop silently absent.
         Welcome takes no shell props, and `/` renders the same view. */
      '/': {},
      '/welcome': {},
      '/login': {
        onLoginSuccess: (mode) => (mode === 'signup' ? navigate('/signup') : handleLoginSuccess()),
        addToast
      },
      '/signup': {
        onSignupSuccess: handleLoginSuccess,
        onBackToLogin: () => navigate('/login'),
        addToast
      }
    };

    /* Offline covers the signed-out shell too. Letting somebody type
       credentials into a form that cannot possibly submit is a worse answer
       than saying the connection is gone — and the auth-flow paths
       (/reset-password, /oauth/callback) are handled ABOVE the session
       branches, so an emailed link still works with no network the moment one
       returns.

       It COVERS rather than replaces, and it wraps the WHOLE shell rather than
       just the routes: a half-finished signup form has to survive a dropped bar
       because the copy on top of it promises it will, and anything left outside
       the wrapper stays tabbable underneath an opaque cover. See
       OfflineOverlay.jsx. */
    return (
      <OfflineOverlay online={online} signedIn={false}>
        <React.Suspense fallback={<RouteFallback />}>
        <Routes>
          {SIGNED_OUT_ROUTES.map(route => (
            <Route key={route.path} path={route.path} element={withProps(route, signedOutProps)} />
          ))}
          {/* /reset-password and /oauth/callback are handled above, before the
              session branches, because both are reached by a link from outside
              the app and must work in every session state. */}
          <Route
            path="*"
            element={
              searchParams.has('reset')
                ? <Navigate to={`/reset-password?token=${encodeURIComponent(searchParams.get('reset'))}`} replace />
                : <ErrorExperience kind="404" signedIn={false} standalone />
            }
          />
        </Routes>
        </React.Suspense>
        <Toasts toasts={toasts} onRemove={removeToast} />
      </OfflineOverlay>
    );
  }

  /* A suspended account gets the suspension screen and nothing else.
     ABOVE the email-verification wall, because a suspended account that also
     has an unconfirmed address should be told the thing that is actually
     stopping it: confirming the address would change nothing while the
     suspension stands, and sending them round a verification loop for it is the
     kind of dead end this screen exists to end.
     This is presentation, not enforcement — `authenticateToken` refuses every
     route but four regardless of what renders here (server/suspendedAccess.js),
     so deleting this component would leave the account just as locked out and
     merely uninformed. */
  /* An earlier revision replaced this with the shell rendered underneath a
     blurred, `inert` overlay. That is reverted, for three reasons, and the
     ordering above is the first of them:
       1. It moved the suspension check BELOW the two walls, so a suspended
          account with an unconfirmed address was sent round the verification
          loop this comment exists to prevent.
       2. `filter: blur()` on the shell establishes a containing block for
          every `position: fixed` descendant, which is where the toasts,
          modals and the profile menu live.
       3. It mounted the whole authenticated shell — nav, notification poll,
          page data — for an account the server answers on four routes. */
  if (currentUser.suspension) {
    return (
      <>
        <SuspendedWall
          user={currentUser}
          suspension={currentUser.suspension}
          onSignOut={handleLogout}
        />
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  if (currentUser.tfaRequired) {
    return (
      <>
        <TwoFactorRequiredWall addToast={addToast} />
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  if (!currentUser.emailVerified) {
    return (
      <>
        <VerifyEmailWall
          user={currentUser}
          addToast={addToast}
          onSignOut={handleLogout}
          onVerified={refreshAll}
        />
        <Toasts toasts={toasts} onRemove={removeToast} />
      </>
    );
  }

  /* ── Application shell ─────────────────────────────────────── */
  /* Resolved once, most-privileged-first (see PERSONAS / SELF_PROFILE), and
     read everywhere below. Plain functions, not hooks — the hook declaration
     order in this component is unchanged and nothing here may alter it. */
  const persona = personaFor(currentUser);
  const selfProfile = selfProfileFor(currentUser);

  const navItems = navItemsFor(currentUser);
  const navSections = navSectionsFor(currentUser);

  /**
   * The mobile bar shows every PRIMARY entry; `⋯` holds the secondary ones.
   *
   * It used to be `navItems.slice(0, 4)`, which is where the administrative hub
   * went missing on phones: it is the fifth entry, so it fell into the sheet along
   * with Notifications and My profile. A count of how many entries fit is not a
   * statement about which ones matter, and the bar scrolls now precisely so that
   * the answer to "does Admin fit" stops depending on the viewport.
   *
   * The two lists partition `navItems` by construction (see `navSectionsFor`), so
   * there is nothing to subtract and no id can land in both or in neither.
   */
  const primaryNavItems = navSections.primary;
  const moreItems = navSections.secondary;
  const hasMoreItems = moreItems.length > 0;

  const renderMoreItem = ({ id, path, label, icon: Icon }) => (
    <button
      key={id + label}
      className="mobile-more-btn"
      onClick={() => {
        setShowMobileMore(false);
        setViewingProfileState(null);
        navigate(path);
      }}
    >
      <Icon size={20} />
      <span>{label}</span>
    </button>
  );

  /**
   * One rail button, used by all three sections of the sidebar.
   *
   * Extracted when the rail gained groups, because the alternative was the same
   * eleven lines of JSX written three times — and the `aria-current` line is the
   * one that decides whether a screen-reader user can tell where they are.
   * Three copies of that is three chances for it to be right in two of them.
   */
  const renderNavItem = ({ id, path, label, icon: Icon }) => (
    <button
      key={id + label}
      className="nav-item"
      aria-current={(RAIL_TAB[activeTab] ?? activeTab) === id ? 'page' : undefined}
      onClick={() => { setViewingProfileState(null); navigate(path); }}
    >
      <Icon size={17} strokeWidth={2} />
      <span>{label}</span>
      {id === 'dashboard' && pendingForMe > 0 && (
        <span className="nav-count is-urgent">{pendingForMe}</span>
      )}
    </button>
  );

  const meta = pageMetaFor(currentUser, activeTab);

  /* Reviewing applicants is what makes this count meaningful, and the filter
     below already scopes it to events this user actually hosts — so a wildcard
     principal that holds `applicant.review` without hosting anything counts 0
     rather than the whole district's queue. */
  const pendingForMe = can(currentUser, 'applicant.review')
    ? applications.filter(a => a.status === 'pending' &&
        events.some(e => e.id === a.eventId && e.organizerId === currentUser.id)).length
    : 0;

  /** What each routed view in APP_ROUTES needs from the shell. */
  const appRouteProps = {
    '/discover': {
      currentUser,
      applications,
      onViewDetails: openEventById,
      favorites,
      onToggleFavorite: toggleFavorite,
      /* Browse fetches its own server-filtered pages, so it no longer
         takes the index. Anything it renders is recorded so the event
         modal can resolve an event the index does not hold. */
      onEventsSeen: rememberEvents
    },
    /* Redirect elements, so they take nothing — declared `{}` rather than
       omitted, because `withProps` treats an omission as a forgotten entry. */
    '/events': {},
    '/events/new': { onSubmitEvent: handleCreateEvent, addToast, setActiveTab, currentUser },
    '/volunteers': { currentUser, events, applications, onViewVolunteerProfile: viewVolunteer, addToast },
    '/events/:id/edit': {},
    '/checkin/:eventId': { currentUser, addToast },
    '/calendar': { currentUser, events, applications, onViewEvent: openEventById },
    '/notifications': { onViewEvent: openEventById, onCountChange: () => setNotifKey(k => k + 1) },
    '/messages': {},
    '/portfolio': { currentUser },
    /* A redirect element, so it takes nothing — declared `{}` rather than
       omitted, because `withProps` treats an omission as a forgotten entry. */
    '/directory': {},
    /**
     * `onEditProfile` is passed to the PUBLIC profile routes too, not only to
     * `/profile`.
     *
     * A student who reaches their own page from a search result, or from a link
     * they copied to share, is looking at their own profile — and had no way to
     * edit it from there, because the button was gated on a prop only `/profile`
     * supplied. `PublicProfile` gates it on `profile.isSelf`, which the SERVER
     * decides, so handing the callback over discloses nothing and enables
     * nothing for anybody looking at somebody else.
     */
    /**
     * `key` remounts the view after a profile save, so an edit made from a
     * public profile is visible without a reload. React strips `key` from
     * props, so this is invisible to the prop-name assertions in
     * App.routeTable.test.jsx — which is correct: it is not a prop the view
     * reads, it is an instruction to React.
     */
    '/users/id/:id': {
      key: `profile-${profileRefreshKey}`,
      currentUser, addToast, onEditProfile: () => setEditingProfile(true),
    },
    '/users/:handle': {
      key: `profile-${profileRefreshKey}`,
      currentUser, addToast, onEditProfile: () => setEditingProfile(true),
    },
    '/organizations': { currentUser },
    '/organizations/new': { addToast },
    '/organizations/:key/edit': { addToast },
    /* `currentUser` so the roster can tell which row is the reader's own —
       the manage menu is hidden there, because every action in it is either
       refused by the server for yourself or already offered as `Leave`. */
    '/organizations/:key/members': { addToast, currentUser },
    '/organizations/:key': { addToast, currentUser },
    '/hours/external': { addToast },
    '/hours': { currentUser, addToast },
    /* The destinations the profile's capped lists point at. `BadgesPage` needs
       `currentUser` to know whose badges to read when the path carries no
       handle; `CertificatesPage` hands both on to the certificate modal. */
    '/profile/badges': { currentUser },
    '/users/:handle/badges': { currentUser },
    '/users/:handle/certificates': { currentUser },
    '/users/:handle/hours': { currentUser },
    '/certificates': {},
    /* `currentUser` supplies the volunteer's name and grade for the document
       itself, and `addToast` reports a failed download without taking the
       reader off the page they were looking at. */
    '/certificates/:code': { currentUser, addToast },
    /* No `location`: this scope's `location` is react-router's, and Welly reads
       coordinates from LocationContext itself. Passing it here is what made
       every "near me" search silently unlocated. */
    '/welly': { currentUser, onViewDetails: openEventById },
    '/settings': { currentUser, addToast, onProfileChange: refreshAll },
    '/report-issue': { currentUser, addToast },
    '/organizer-agreement': { currentUser, addToast, onAccepted: refreshAll },
    /* Same three. `refreshAll` is what makes the released capabilities visible
       to the navigation without a sign-out. */
    '/student-organizer-agreement': { currentUser, addToast, onAccepted: refreshAll },
    '/errors': { addToast },
    '/admin/appeals': {
      userRole: currentUser.role,
    },
    /* Reads its reports from the server; nothing from the shell. */
    '/admin/issues': {},
    '/admin/organizers': { addToast },
    /* Deliberately empty. The form reads the session from the server and the
       case it is contesting from the URL, so there is nothing the shell knows
       that it needs. */
    '/appeals/new': {},
    '/impact': {},
    '/admin/audit-logs': {},
    /* \`currentUser\` for the student-roster export control, which is gated on
       \`roster.export\` — the capability the endpoint requires, rather than on
       this page's own. */
    '/admin/roster': { currentUser },
    /* Declared EMPTY, not omitted: `withProps` throws on a missing entry so a
       new route cannot mount with every prop silently absent. AdminBadges reads
       everything it needs from `api` and takes no shell state. */
    '/admin/badges': {},
    '/admin/legal': { addToast },
    '/admin/impact': {},
    '/owner': { addToast },
    '/admin/moderation': { currentUser, addToast, onPreviewStarted: refreshAll }
  };

  /** Where a route the user cannot reach sends them. Unchanged from the ternaries. */
  /**
   * A denied route shows WHY, instead of bouncing to the dashboard.
   *
   * This was `<Navigate to="/" replace />`, which is why "nothing happens when I
   * click it" reports exist: the click did do something — it refused — and said
   * nothing. Rendering in place also keeps the URL, so the person can send it to
   * whoever told them to open it.
   */
  /**
   * `route` is optional because one caller has none: `/profile` is refused for a
   * role that has no profile VIEW rather than for a missing capability, so there
   * is no route condition to explain and the themed copy stands alone.
   */
  const deniedFallback = (route) => <ErrorExperience kind="403" denied={route} standalone />;

  /* An unknown URL is a takeover, and it has to be decided HERE rather than by
     a `<Route path="*">` inside the shell — a catch-all route can only render
     into the slot the shell already built around it, so the sidebar, topbar and
     profile menu would still be on screen either side of it.

     `shellServes` asks the router's own matcher against the same table the
     shell renders, so this cannot drift from the routes below. The URL is left
     exactly as the reader typed it; the `ERROR_ROUTES` note above says why
     nothing redirects.

     Guarded on `viewingProfile` because a profile overlay is state, not a path:
     it renders over whatever route is current, and closing it returns there. */
  if (!viewingProfile && !shellServes(currentPath)) {
    /* …except the screens that exist only for somebody with no session. They
       are not unknown URLs — they are the front door, answered while already
       inside. `replace` so Back does not bounce off the same redirect. */
    if (isSignedOutOnlyPath(currentPath)) {
      return <Navigate to="/" replace />;
    }
    return <ErrorExperience kind="404" standalone />;
  }

  /* A refusal is a takeover too, and was the last error state that was not.
     Same guard as the 404 above and for the same reason — see `deniedRoute`.
     `deniedFallback` stays wired into the table below as the router's own
     backstop, exactly like the `<Route path="*">` 404 does. */
  /* `deniedRoute` returns the matched ROUTE rather than a boolean precisely so the
     refusal can name what was refused and why — see denialDetail.js. Passing it
     through is what turns "limited to certain accounts" into something a reader
     can act on. */
  const deniedMatch = viewingProfile ? null : deniedRoute(currentPath, currentUser);
  if (deniedMatch) {
    return <ErrorExperience kind="403" denied={deniedMatch} standalone />;
  }

  /* Offline COVERS the whole shell rather than replacing the routed view.
     Replacing it unmounted everything inside — a half-written event description
     went with it — while the copy laid over the top promised the opposite. And
     it has to wrap the shell, not just <main>: an overlay is opaque, so any nav
     left outside the wrapper is a tab stop nobody can see. The app underneath
     stays mounted and inert, and comes back untouched, mid-sentence, the moment
     the connection does. See OfflineOverlay.jsx. */
  return (
    <OfflineOverlay online={online}>
    {/* OUTSIDE `.app`, so a caught crash replaces the shell instead of
        rendering inside it. It used to sit around `<main>` to keep the
        navigation alive through a failed view — a reasonable trade then, and
        the wrong one now: a crash is a takeover, and half a shell wrapped
        around a full-screen apology is exactly the "error card inside the app"
        this weight exists to stop being.

        `resetKey` still clears the caught error on navigation, so the boundary
        recovers the moment the reader goes somewhere else. */}
    <ErrorBoundary
      resetKey={`${currentPath}:${selectedEventId || ''}:${profileId || ''}`}
      fallback={crashFallback}
    >
    <div className="app">
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* ── Sidebar (desktop / rail on tablet) ── */}
      <aside className="sidebar">
        {/* The brand's hover micro-pass is gone with the drawn wordmark, and
            deliberately not moved onto the tile.

            `BrandMark` reports its mark at `32 * TILE_MARK_RATIO` = 18.56px,
            and `MOTION_MIN_MARK_PX` is 32 — so `resolveMotion` answers `'none'`
            for any behaviour asked of a tile this size. That is the system
            refusing to animate a mark too small to draw its real stroke, which
            is correct; passing `motion="micro"` here would have been a prop
            that silently did nothing. The wordmark could carry the pass because
            it drew the W at full size. The badge cannot, so the lockup is
            static — see `useBrandMicroPass`, still used by nothing else. */}
        <a
          className="brand"
          href="/"
          onClick={(e) => { e.preventDefault(); navigate('/'); }}
        >
          {/* The lockup is the tile beside the name — the green badge carrying
              the checkmark-W, then "WeVolunteer" as text.

              This replaced the drawn wordmark, whose own first letter was the
              checkmark-W, on the owner's decision (2026-09-27): a wordmark alone
              read as plain white text rather than as a logo. The tile is now
              shown at every width, not only on the tablet rail, and the name
              beside it is set rather than drawn — so the W appears once as a
              badge and once as a letterform, which is the ordinary shape of a
              lockup and is deliberate here. `BrandLockup` is this markup, shared
              with the error screens, /verify and a club's public page, which
              kept the drawn wordmark until N10. */}
          <BrandLockup sub={SCHOOL_NAME} />
        </a>

        {/**
          * One rail, one list, no divider.
          *
          * `Admin` used to sit inside a `role="group"` labelled "Administration",
          * with a hair rule above it. Separating one entry from four says the
          * entry is a different KIND of thing, which is a claim about the product
          * rather than about the reader's authority — and the boundary the rule
          * was drawing is already drawn by the entry's absence for anyone without
          * `report.resolve`. An administrator who sees Admin has learned that
          * they are one; a line above it teaches nothing further and costs the
          * hub its place among the destinations people actually use.
          *
          * `secondary` entries follow, still with no rule between: the rail is
          * five or seven rows, which is a list you read rather than one you scan
          * by section.
          */}
        {/* `accountOnly` entries are filtered out here and ONLY here: the rail
            ends in ProfileMenu, which already offers them. See the note on the
            profile entry in NAV. */}
        <nav className="nav" aria-label="Main">
          {navSections.primary.map(renderNavItem)}
          {navSections.secondary.filter(n => !n.accountOnly).map(renderNavItem)}
        </nav>

        <div className="sidebar-foot">
          <ProfileMenu
            user={currentUser}
            onSignOut={handleLogout}
          />
        </div>
      </aside>

      {/* ── Content column ── */}
      <div className="content">
        {DEMO_MODE && (
          <DemoBar currentUser={currentUser} refreshAll={refreshAll} addToast={addToast} />
        )}

        <header className="topbar">
          <div className="truncate">
            <h1 className="topbar-title truncate">{meta.title}</h1>
            {meta.sub && <div className="topbar-sub truncate">{meta.sub}</div>}
          </div>
          <div className="topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
            <ThemeToggle />
            <NotificationsBell
              key={currentUser.id}
              refreshKey={notifKey}
              onViewEvent={openEventById}
              onSeeAll={() => { setViewingProfileState(null); navigate('/notifications'); }}
            />
          </div>
        </header>

        {/* The route's content fades in over 160ms on each navigation; the
            sidebar and header around it stay still (index.css, "B9"). */}
        <main className="page" id="main-content" tabIndex={-1} ref={routeFadeRef}>
          {/* Above the route content and inside every page, because a preview
              narrows capabilities — so the surfaces that would otherwise host the
              way out are the first ones it removes. See the component header. */}
          <PersonaPreviewBanner preview={currentUser.preview} onEnded={refreshAll} />
          {/**
            * The notice slot: the location opt-in, legal document changes, and
            * the mandatory re-acceptance dialog, in that priority order.
            *
            * Inside the signed-in shell, not in main.jsx with the provider. A
            * banner asking to use your location has no business on the sign-in
            * screen — the browser would refuse the permission there anyway,
            * because nobody has pressed anything yet — and "which documents has
            * THIS account not been shown" is only answerable once there is an
            * account. The Terms promise notice in the app, not at the sign-in
            * screen.
            *
            * `key` on the user id, because everything it holds is about one
            * account. Signing out and back in as somebody else must not leave
            * the previous account's pending notices, or its dismissals, on
            * screen. Same reason `NotificationsBell` above is keyed.
            *
            * Renders nothing at all when there is nothing to say, which is
            * almost always — see the note in the component about why "nothing"
            * has to mean no node rather than an empty one.
            */}
          <AppNotices
            key={currentUser.id}
            currentUser={currentUser}
            onAccepted={refreshAll}
            onSignOut={handleLogout}
            /* The lowest tier of the notice ladder is an OFFER, and an offer
               belongs only where accepting it does something. See
               LOCATION_AWARE_TABS. The legal tiers above it are unconditional
               and must stay that way — a document somebody is held to is news
               wherever they are standing. */
            locationRelevant={LOCATION_AWARE_TABS.has(activeTab)}
          />
          {/* Inside the shell boundary above, so a chunk that fails to load is
              caught alongside a view that throws while rendering — and covering
              both arms of the ternary below, since the profile views are lazy
              too. */}
          <React.Suspense fallback={<RouteFallback />}>
          {viewingProfile ? (
            viewingProfile.type === 'organizer' ? (
              <OrganizerProfile
                userId={viewingProfile.id}
                onBack={() => setViewingProfileState(null)}
                onViewEvent={(id) => { setViewingProfileState(null); openEventById(id); }}
              />
            ) : (
              <VolunteerProfile
                userId={viewingProfile.id}
                currentUser={currentUser}
                onBack={() => setViewingProfileState(null)}
                onEditProfile={() => setEditingProfile(true)}
                onViewEvent={(id) => { setViewingProfileState(null); openEventById(id); }}
              />
            )
          ) : (
            <Routes>
              {/* `/` stays here rather than in the table: it is a different
                  dashboard per persona, not one view behind a capability.

                  Branching on `persona` rather than on `can()` directly is what
                  makes these arms genuinely mutually exclusive — the cascade
                  that produced it already ran most-privileged-first, so a
                  wildcard principal cannot match two of them. The last arm is
                  explicit: `partner` (and any future capability-poor role)
                  gets a page that says so, NOT OrganizerDashboard, whose
                  fetchOrganizerStats returns zeros for super_admin and a
                  swallowed 403 for partner — a dashboard of zeros reads as
                  data, which is worse than an empty state. */}
              <Route path="/" element={
                persona === 'staff' ? <AdminDashboard addToast={addToast} user={currentUser} /> :
                persona === 'volunteer' ? (
                  <VolunteerDashboard
                    currentUser={currentUser}
                    events={events}
                    applications={applications}
                    addToast={addToast}
                    setActiveTab={setActiveTab}
                    refreshEvents={refreshEvents}
                    refreshApplications={refreshApplications}
                    onViewDetails={openEventById}
                  />
                ) : persona === 'host' ? (
                  <OrganizerDashboard
                    currentUser={currentUser}
                    events={events}
                    applications={applications}
                    refreshEvents={refreshEvents}
                    refreshApplications={refreshApplications}
                    addToast={addToast}
                    setActiveTab={setActiveTab}
                    onViewDetails={openEventById}
                    onViewVolunteerProfile={viewVolunteer}
                  />
                ) : (
                  <EmptyState
                    title="No dashboard for this account"
                    message="This account type does not have a dashboard yet. Open Discover from the navigation, or change your account settings."
                  />
                )
              } />

              {/* The route table. `requiredCap` is what the role ternaries that
                  used to sit here became; `requiresVerified` is the second
                  condition /events/new carried, which no capability expresses. */}
              {APP_ROUTES.map((route) => (
                <Route
                  key={route.path}
                  path={route.path}
                  element={
                    route.requiresVerified && !currentUser.verified
                      ? deniedFallback(route)
                      : (route.requiredCap || route.requiredCapAny?.length)
                        ? (
                          /* `routeCapSatisfied` rather than `<Can>`, so this
                             branch and `deniedRoute` apply ONE rule — including
                             the `showWhenWithheld` exception, which `<Can>`
                             knows nothing about. The comment above this pair is
                             right that two copies drift; this is them sharing. */
                          routeCapSatisfied(route, currentUser)
                            ? withProps(route, appRouteProps)
                            : deniedFallback(route)
                        )
                        : withProps(route, appRouteProps)
                  }
                />
              ))}

              {/* Also a different component per persona, so it stays out of the
                  table alongside `/`. `selfProfile` comes from the SELF_PROFILE
                  cascade, which already ran most-privileged-first — so these
                  arms are mutually exclusive and the last one is an explicit
                  deny, not a fall-through. */}
              <Route path="/profile" element={
                selfProfile === 'volunteer' ? (
                  <VolunteerProfile
                    userId={currentUser.id}
                    currentUser={currentUser}
                    onEditProfile={() => setEditingProfile(true)}
                    onViewEvent={openEventById}
                  />
                ) : selfProfile === 'host' ? (
                  <OrganizerProfile
                    userId={currentUser.id}
                    onEditProfile={() => setEditingProfile(true)}
                    onViewEvent={openEventById}
                  />
                ) : selfProfile === 'account' ? (
                  <AccountProfile
                    currentUser={currentUser}
                    onEditProfile={() => setEditingProfile(true)}
                  />
                ) : deniedFallback()
              } />

              {/* Unreachable in practice — `shellServes` sends an unknown URL
                  to the takeover above before the shell is built. Kept as the
                  router's own backstop so a path added to `APP_ROUTES` but not
                  to `SHELL_ROUTE_PATTERNS` degrades to a 404 rather than to a
                  blank `<main>`. */}
              <Route path="*" element={<ErrorExperience kind="404" />} />
            </Routes>
          )}
          </React.Suspense>
        </main>
      </div>

      {/**
        * ── Mobile navigation ──
        *
        * Two parts, and the split is the whole design: a horizontally scrollable
        * strip holding every PRIMARY destination, and a `⋯` button pinned to the
        * right edge holding the secondary ones.
        *
        * It was a five-cell CSS grid over `navItems.slice(0, 4)` plus `More`. Five
        * equal cells is a hard ceiling on how many primary destinations can exist,
        * and the entry that fell off the end for administrators was `Admin` — the
        * one they opened the phone for. Scrolling removes the ceiling instead of
        * arguing about where to put it: five entries fit on any current phone,
        * six fit from 360px up once the bar is drawn dense (`mobilenav-dense`),
        * and none of them is ever demoted to a menu by arithmetic.
        *
        * The `⋯` button is OUTSIDE the scroller so it cannot scroll away. It is
        * the one control whose position has to be predictable, because it is how
        * you reach anything you cannot currently see.
        */}
      <nav className={`mobilenav${primaryNavItems.length > 5 ? ' mobilenav-dense' : ''}`} aria-label="Main">
        <div className="mobilenav-scroll" ref={attachMobileNavScroll}>
          {primaryNavItems.map(({ id, path, label, icon: Icon }) => (
            <button
              key={id + label}
              className="mobilenav-item"
              aria-current={(RAIL_TAB[activeTab] ?? activeTab) === id ? 'page' : undefined}
              onClick={() => { setViewingProfileState(null); navigate(path); }}
            >
              <Icon size={19} strokeWidth={2} />
              {label}
            </button>
          ))}
        </div>
        {/* Derived from what the sheet will actually render. `More` opening onto
            an empty sheet is the failure this guards. */}
        {hasMoreItems && (
          <button
            className="mobilenav-item mobilenav-more"
            aria-current={showMobileMore ? 'page' : undefined}
            aria-expanded={showMobileMore}
            onClick={() => setShowMobileMore(true)}
          >
            <MoreHorizontal size={19} strokeWidth={2} />
            More
          </button>
        )}
      </nav>

      {/* Mobile More Sheet */}
      {showMobileMore && (
        <>
          <div className="mobile-more-backdrop" onClick={() => setShowMobileMore(false)} />
          <div className="mobile-more-sheet">
            <div className="mobile-more-header" style={{ alignItems: 'flex-start', paddingBottom: 'var(--s4)' }}>
              <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center' }}>
                <span className="avatar lg">{currentUser.avatar || '👤'}</span>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span className="mobile-more-title truncate">{currentUser.name}</span>
                  <span style={{ fontSize: '0.875rem', color: 'var(--ink-2)' }}>{ROLE_LABEL[currentUser.role] || 'Member'}</span>
                </div>
              </div>
              <button className="btn btn-ghost btn-icon" style={{ marginTop: '-4px', marginRight: '-4px' }} onClick={() => setShowMobileMore(false)}>
                <X size={20} />
              </button>
            </div>
            {/**
              * The SECONDARY entries, and the account actions.
              *
              * Flat, and short by construction: two destinations rather than the
              * five-to-seven the sheet used to inherit from a slice index. It
              * previously carried the administrative pages, which is why it was
              * grouped with headings — those are primary now and live in the bar,
              * so there is nothing left to group and a heading over a list of two
              * would be furniture.
              */}
            <div className="mobile-more-menu">
              {/**
                * The SECONDARY nav entries — which include Profile — and then
                * the account actions.
                *
                * There is deliberately no "Edit Profile" button here any more,
                * and no Profile TAB in the bar below either. Profile is reached
                * from this sheet, which is the account menu on a phone, and
                * editing is a button on the profile page itself. A second
                * persistent tab for something you visit occasionally is exactly
                * the clutter the bar is scrolled rather than sliced to avoid.
                */}
              {moreItems.map(renderMoreItem)}

              {/**
                * The shared account destinations, from `src/accountMenu.js`.
                *
                * This sheet IS the account control at this width — there is no
                * avatar menu on a phone, which is what `accountOnly` on the
                * Profile NAV entry records. It had its own hand-written Settings
                * button, so Settings existed in two files with nothing asserting
                * they matched; then "My hours" was added to `ProfileMenu` and
                * measured missing HERE at 375px, which is a destination that
                * exists on a laptop and not on a phone.
                *
                * Filtered by capability for the same reason `ProfileMenu` filters
                * it: `/hours` is `portfolio.write`, and offering it to an
                * organizer or an administrator would be offering a 403.
                */}
              {ACCOUNT_MENU_ITEMS
                .filter(item => !item.requiredCap || can(currentUser, item.requiredCap))
                .map(({ id, path, label, icon: Icon }) => (
                  <button
                    key={id}
                    className="mobile-more-btn"
                    onClick={() => {
                      setShowMobileMore(false);
                      navigate(path);
                    }}
                  >
                    <Icon size={20} />
                    <span>{label}</span>
                  </button>
                ))}

              <div className="menu-sep" style={{ margin: 'var(--s2) 0' }} />

              <button
                className="mobile-more-btn danger"
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  setShowMobileMore(false);
                  handleLogout();
                }}
              >
                <LogOut size={20} />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Modals ── */}
      {/* EventModal is 1,500+ lines covering viewing, editing, applicant review,
          Auto Select, check-in and attendance. It is where nearly every
          organizer action happens, and it renders data from six endpoints — so
          it has the most ways to meet a shape it does not expect. Its own
          boundary means a failure in there is a closeable panel, not a blank
          application. */}
      {selectedEvent && (
        <ErrorBoundary
          resetKey={selectedEvent.id}
          title="This event didn't load"
          message="Something went wrong displaying this event. Nothing was changed. Close this and try again — if it keeps happening, reload the page."
          onDismiss={() => setSelectedEventState(null)}
          dismissLabel="Close event"
        >
          {/* `null` rather than a skeleton: the modal animates in over the page,
              and a skeleton shaped like a panel that is about to be replaced
              reads as a flicker. The chunk is small and usually already cached
              by the time anyone opens a second event. */}
          <React.Suspense fallback={null}>
          <EventModal
            event={selectedEvent}
            currentUser={currentUser}
            applications={applications}
            onClose={() => setSelectedEventState(null)}
            refreshEvents={refreshEvents}
            refreshApplications={refreshApplications}
            addToast={addToast}
            onViewVolunteerProfile={(p) => { setSelectedEventState(null); viewVolunteer(p); }}
            onViewOrganizer={(id) => { setSelectedEventState(null); viewOrganizer(id); }}
            isFavorited={favorites.includes(selectedEvent.id)}
            onToggleFavorite={toggleFavorite}
            /* `hours` in the URL, `attendance` in the component: the parameter is
               named for what a reader is going to, the mode for the screen that
               renders it. EventModal ignores it for anybody who could not have
               reached that screen by pressing the button. */
            initialMode={searchParams.get('mode') === 'hours' ? 'attendance' : 'view'}
          />
          </React.Suspense>
        </ErrorBoundary>
      )}
      {editingProfile && (
        <React.Suspense fallback={null}>
          <ProfileEditModal
            user={currentUser}
            onClose={() => setEditingProfile(false)}
            onSave={(updated) => {
              setCurrentUser(updated);
              refreshEvents();
              /**
               * Remounts any profile view currently on screen.
               *
               * `PublicProfile` renders from its own fetched `data` and never
               * refetches, so editing a bio from `/users/@myhandle` — now that
               * the button is reachable there — showed the OLD bio until a
               * reload. Bumping a key remounts the view, which reruns its load
               * effect; that is cheaper than threading a refresh callback
               * through `appRouteProps` into every profile surface.
               */
              setProfileRefreshKey(k => k + 1);
            }}
            addToast={addToast}
            onSignOut={() => { setEditingProfile(false); handleLogout(); }}
          />
        </React.Suspense>
      )}

      <Toasts toasts={toasts} onRemove={removeToast} />
    </div>
    </ErrorBoundary>
    </OfflineOverlay>
  );
}
