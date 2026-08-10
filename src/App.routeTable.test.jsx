/**
 * What each declared route resolves to, and with which props.
 *
 * The route table (src/routes/index.jsx) declares elements without props, and
 * App.jsx clones them with a per-path prop map. That split is what keeps the
 * table readable as data, but it also means a dropped prop is a silent
 * regression: the view mounts and renders wrong instead of failing to compile.
 * Every routed view is stubbed here to record the prop names it was handed, so
 * losing one fails a test.
 *
 * The capability gates are asserted the same way — by which view actually
 * renders — because that, not `can()` in isolation, is what a user experiences.
 * `routes/routes.test.jsx` covers the table's own invariants; this file covers
 * the wiring around it.
 */
import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from './App';
import { api } from './utils/api';
import { findErrorKind } from './testUtils/errorExperience';

vi.mock('./utils/api');
vi.mock('./services/socket', () => ({
  connectSocket: vi.fn(), disconnectSocket: vi.fn(), getSocket: vi.fn(),
  subscribeSocket: vi.fn(), unsubscribeSocket: vi.fn(),
  emitTypingStart: vi.fn(), emitTypingStop: vi.fn()
}));

const stub = (name) => ({
  default: (props) => <div data-testid={name} data-props={Object.keys(props).sort().join(',')} />
});
vi.mock('./views/BrowseEvents', () => stub('browse'));
vi.mock('./views/CreateEvent', () => stub('create'));
vi.mock('./views/CalendarView', () => stub('calendar'));
vi.mock('./views/Messages', () => stub('messages'));
vi.mock('./views/Notifications', () => stub('notifications'));
vi.mock('./views/Settings', () => stub('settings'));
vi.mock('./views/VolunteerPortfolio', () => stub('portfolio'));
vi.mock('./views/CheckInView', () => stub('checkin'));
vi.mock('./views/VolunteerDashboard', () => stub('vol-dash'));
vi.mock('./views/OrganizerDashboard', () => stub('org-dash'));
vi.mock('./views/AdminDashboard', () => stub('admin-dash'));
vi.mock('./views/VolunteerProfile', () => stub('vol-profile'));
vi.mock('./views/OrganizerProfile', () => stub('org-profile'));
vi.mock('./views/Welcome', () => stub('welcome'));
vi.mock('./views/Login', () => stub('login'));
vi.mock('./views/Signup', () => stub('signup'));
vi.mock('./views/CertificateVerification', () => stub('cert'));
vi.mock('./views/ErrorDashboard', () => stub('error-dash'));
vi.mock('./views/ImpactDashboard', () => stub('impact'));
// Eager shell chrome that talks to the (auto-mocked) api — not what this checks.
vi.mock('./components/ThemeToggle', () => ({ default: () => <div data-testid="theme" /> }));
vi.mock('./components/NotificationsBell', () => ({ default: () => <div data-testid="bell" /> }));
vi.mock('./components/account/ProfileMenu', () => ({ default: () => <div data-testid="profile-menu" /> }));

const USER = (role, extra = {}) => ({
  id: `${role}-1`, name: 'Test', email: 't@e.org', username: 't', role,
  verified: true, emailVerified: true, hasPassword: true, avatar: '🧑', skills: [], ...extra
});

function signedInAs(user) {
  api.getMe.mockResolvedValue(user);
  api.fetchEventsProgressive.mockResolvedValue([]);
  api.fetchApplications.mockResolvedValue([]);
  api.fetchFavorites.mockResolvedValue([]);
  api.fetchNotifications.mockResolvedValue({ unreadCount: 0, notifications: [] });
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
);

/** Reports the router's current location, so "did it redirect?" is assertable. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="where" data-path={loc.pathname} data-search={loc.search} />;
}

// jsdom does not implement Element.scrollTo; the mobile-nav effect calls it
// whenever the active tab changes (i.e. after every redirect).
Element.prototype.scrollTo = () => {};

beforeEach(() => {
  vi.clearAllMocks();

  /**
   * `vi.mock('./utils/api')` automocks every export to a `vi.fn()` returning
   * `undefined`, and the two `/privacy` redirect tests land on the REAL
   * LegalDocument (it is deliberately not stubbed — the assertion is that the
   * redirect resolves to the registry document). Its mount effect runs
   * `api.fetchLegalDocument(slug).then(…)`, which threw
   *
   *     TypeError: Cannot read properties of undefined (reading 'then')
   *
   * from inside a React passive effect, i.e. outside any test's control. Vitest
   * surfaced it as an unhandled error and warned that the run "might cause false
   * positive tests" — the suite reported green with two live exceptions in it.
   *
   * A promise that never settles is the honest stand-in: these tests assert on
   * the router's location, never on the document, so "still loading" is exactly
   * the state they mean. Resolving instead would land a state update after the
   * assertions and trade the unhandled error for an act() warning.
   */
  api.fetchLegalDocument.mockReturnValue(new Promise(() => {}));
});

describe('authenticated route table', () => {
  /**
   * The other half of the root-route claim. Declaring `/` as a signed-out route
   * must not shadow the authenticated dashboard — react-router ranks by
   * specificity rather than declaration order, but the two tables are assembled
   * in different places and only a test says so.
   */
  it.each([['student', 'vol-dash'], ['organizer', 'org-dash'], ['admin', 'admin-dash']])(
    '%s: the root is their dashboard, never a 404',
    async (role, testId) => {
      signedInAs(USER(role));
      renderAt('/');
      expect(await screen.findByTestId(testId)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  );

  it('student: /events gets every prop it had before', async () => {
    signedInAs(USER('student'));
    renderAt('/events');
    const el = await screen.findByTestId('browse');
    expect(el.dataset.props).toBe(
      'applications,currentUser,favorites,onEventsSeen,onToggleFavorite,onViewDetails'
    );
  });

  it('student: /calendar, /messages, /portfolio, /settings, /notifications resolve', async () => {
    for (const [path, id, props] of [
      ['/calendar', 'calendar', 'applications,currentUser,events,onViewEvent'],
      ['/messages', 'messages', ''],
      ['/portfolio', 'portfolio', 'currentUser'],
      ['/settings', 'settings', 'addToast,currentUser,onProfileChange'],
      ['/notifications', 'notifications', 'onCountChange,onViewEvent']
    ]) {
      signedInAs(USER('student'));
      const view = renderAt(path);
      const el = await screen.findByTestId(id);
      expect(el.dataset.props, path).toBe(props);
      view.unmount();
    }
  });

  /**
   * These assert the 403 PAGE now, not the dashboard.
   *
   * The outcome under test is unchanged — a student still cannot reach either
   * route — but the presentation is, deliberately: a denial used to render
   * `<Navigate to="/" />`, which is why "nothing happens when I click it"
   * reports exist. The assertion is also stronger than it was. Denied and
   * "unknown path" BOTH used to land on the dashboard, so the two were
   * indistinguishable here; 403 and 404 now tell them apart.
   */
  it('student: /events/new and /checkin are denied, with a reason', async () => {
    signedInAs(USER('student'));
    const a = renderAt('/events/new');
    await findErrorKind('403');
    expect(screen.queryByTestId('vol-dash')).not.toBeInTheDocument();
    a.unmount();

    signedInAs(USER('student'));
    renderAt('/checkin/evt-1');
    await findErrorKind('403');
  });

  it('verified organizer: /events/new renders the form with its props', async () => {
    signedInAs(USER('organizer'));
    renderAt('/events/new');
    const el = await screen.findByTestId('create');
    expect(el.dataset.props).toBe('addToast,onSubmitEvent,setActiveTab');
  });

  it('unverified organizer: /events/new is still refused', async () => {
    signedInAs(USER('organizer', { verified: false }));
    renderAt('/events/new');
    await findErrorKind('403');
    expect(screen.queryByTestId('org-dash')).not.toBeInTheDocument();
  });

  it('organizer: /checkin/:eventId renders the scanner', async () => {
    signedInAs(USER('organizer'));
    renderAt('/checkin/evt-1');
    const el = await screen.findByTestId('checkin');
    expect(el.dataset.props).toBe('currentUser');
  });

  /**
   * Admin now REACHES `/messages`, and the flip was deliberate.
   *
   * This asserted a 403 because admin did not hold `message.send`. That was right
   * while it lasted: the capability had been granted once and reverted, because
   * `conversations` was `(event_id, student_id, organizer_id)` all NOT NULL, so an
   * administrator who opened a thread was not a participant and the route led to
   * an empty inbox. A 403 was the more honest of the two wrong answers.
   *
   * Migration 018 added the `admin_student` / `admin_organizer` kinds with
   * membership in `conversation_participants`, and
   * `server/routes.adminMessaging.test.js` proves an admin can now open a thread,
   * send, and be read by the other party. So the route leads somewhere, and
   * refusing it would withhold a working feature.
   *
   * `/events` is kept in the same case as the control: it proves the render path
   * works for this role, so a failure above is about the capability rather than
   * about the harness.
   */
  it('admin: /messages and /events both render', async () => {
    signedInAs(USER('admin'));
    const a = renderAt('/messages');
    expect(await screen.findByTestId('messages')).toBeInTheDocument();
    a.unmount();

    signedInAs(USER('admin'));
    renderAt('/events');
    expect(await screen.findByTestId('browse')).toBeInTheDocument();
  });

  /**
   * `/profile` is per role, and every role now HAS one.
   *
   * An administrator used to reach a 403 here: `SELF_PROFILE` resolved
   * `event.moderate` to 'denied', on the accurate grounds that no profile page
   * had ever been built for the role. That stopped being tolerable when the
   * account menu started offering "Profile" — the entry every signed-in person
   * opens to find their own account — so the generalized `AccountProfile` now
   * serves the roles that have no record-based view of their own.
   */
  it('/profile is per role, and every role gets one', async () => {
    signedInAs(USER('student'));
    const a = renderAt('/profile');
    expect(await screen.findByTestId('vol-profile')).toBeInTheDocument();
    a.unmount();

    signedInAs(USER('organizer'));
    const b = renderAt('/profile');
    expect(await screen.findByTestId('org-profile')).toBeInTheDocument();
    b.unmount();

    signedInAs(USER('admin'));
    const c = renderAt('/profile');
    expect(await screen.findByRole('button', { name: /edit profile/i })).toBeInTheDocument();
    /* And not either record-based view, whose endpoints filter by role in SQL. */
    expect(screen.queryByTestId('vol-profile')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-profile')).not.toBeInTheDocument();
    c.unmount();
  });

  it('/events/:id/edit redirects to the event on browse', async () => {
    signedInAs(USER('organizer'));
    renderAt('/events/evt-9/edit');
    expect(await screen.findByTestId('browse')).toBeInTheDocument();
  });

  it('unknown path renders 404 rather than silently becoming the dashboard', async () => {
    signedInAs(USER('student'));
    renderAt('/nope');
    await findErrorKind('404');
    // The old behaviour made a broken link indistinguishable from a working one.
    expect(screen.queryByTestId('vol-dash')).not.toBeInTheDocument();
  });
});

describe('signed-out and public routes', () => {
  it('renders login with its props', async () => {
    api.getMe.mockResolvedValue(null);
    renderAt('/login');
    const el = await screen.findByTestId('login');
    expect(el.dataset.props).toBe('addToast,onLoginSuccess');
  });

  it('renders signup with its props', async () => {
    api.getMe.mockResolvedValue(null);
    renderAt('/signup');
    const el = await screen.findByTestId('signup');
    expect(el.dataset.props).toBe('addToast,onBackToLogin,onSignupSuccess');
  });

  it('shows a signed-out visitor 404 rather than sending them to welcome', async () => {
    api.getMe.mockResolvedValue(null);
    renderAt('/nope');
    await findErrorKind('404');
    expect(screen.queryByTestId('welcome')).not.toBeInTheDocument();
  });

  /**
   * The front door is not an unknown route.
   *
   * `/` used to work by accident: the signed-out catch-all was
   * `<Navigate to="/welcome" replace />`, so the root fell through to a blanket
   * redirect. `2b015d3` replaced that redirect with a real 404 — correctly,
   * which is what the test directly above asserts — and `/` went down with it,
   * because it had never been a route of its own. The front door answered 404
   * to every signed-out visitor.
   *
   * Both claims are asserted together on purpose. They pull against each other,
   * and the obvious repair for either one breaks the other.
   */
  it('shows a signed-out visitor the welcome page at the root, not a 404', async () => {
    api.getMe.mockResolvedValue(null);
    renderAt('/');
    expect(await screen.findByTestId('welcome')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * A visitor with no session gets nothing at `/impact`.
   *
   * Worth pinning separately from the per-role refusals below, because this page
   * has a history of being reachable without one: its predecessor was served at
   * `/community` with no session at all, and the platform view was briefly
   * declared in `PUBLIC_ROUTES` carrying a `requiredCap` that nothing in that
   * table reads — so an anonymous visitor rendered the administrator's shell. The
   * community figures are administrative now, and `/impact` is an APP_ROUTES
   * entry, which is the only table a capability means anything in.
   */
  it('shows a signed-out visitor nothing at /impact', async () => {
    api.getMe.mockResolvedValue(null);
    renderAt('/impact');
    await findErrorKind('404');
    expect(screen.queryByTestId('impact')).not.toBeInTheDocument();
  });

  /**
   * The error dashboard, denied by the route and not merely hidden by the nav.
   *
   * Hiding a nav entry is UX; typing the URL is one keystroke. `error.read` is
   * SUPER_ONLY, so `can()` refuses it before it consults per-user grants — no
   * `user_capabilities` row can reach this and `capability.grant` is not a path
   * to it. Asserted per role rather than once, because the failure mode is one
   * role slipping through, not all of them.
   */
  it.each([['student'], ['organizer'], ['admin'], ['partner']])(
    '%s is refused /errors even by typing the URL',
    async (role) => {
      signedInAs(USER(role));
      renderAt('/errors');
      await findErrorKind('403');
      expect(screen.queryByTestId('error-dash')).not.toBeInTheDocument();
    }
  );

  it('super_admin reaches /errors with the props the view needs', async () => {
    signedInAs(USER('super_admin'));
    renderAt('/errors');
    const el = await screen.findByTestId('error-dash');
    // `withProps` clones with the map's entry; a missing entry mounts the view
    // with every prop silently absent rather than throwing.
    expect(el.dataset.props).toBe('addToast');
  });

  /**
   * The community impact figures, denied by the ROUTE and not merely missing
   * from the rail.
   *
   * These were readable by every signed-in account — `analytics.impact` was held
   * by student, organizer, admin and partner. They are administrative now: an
   * internal view of how the programme is doing, for the reader accountable for
   * it. Hiding the nav entry is UX and typing the URL is one keystroke, so this
   * asserts the guard that runs before the shell is built, per role, because the
   * failure mode is one role slipping through rather than all of them.
   *
   * `partner` is included deliberately: it is the external-organization account,
   * the audience the deleted `/api/public/impact` served.
   */
  it.each([['student'], ['organizer'], ['partner']])(
    '%s is refused /impact even by typing the URL',
    async (role) => {
      signedInAs(USER(role));
      renderAt('/impact');
      await findErrorKind('403');
      expect(screen.queryByTestId('impact')).not.toBeInTheDocument();
    }
  );

  it.each([['admin'], ['super_admin']])('%s reaches /impact', async (role) => {
    signedInAs(USER(role));
    renderAt('/impact');
    expect(await screen.findByTestId('impact')).toBeInTheDocument();
  });

  it('renders certificate verification for a signed-in user', async () => {
    signedInAs(USER('student'));
    renderAt('/verify/ABC123');
    expect(await screen.findByTestId('cert')).toBeInTheDocument();
  });

  /**
   * The privacy notice must be readable with NO session — that is the whole
   * point of it. Someone deciding whether to hand over a child's name, email,
   * grade and school reads it before they have an account, and the signup form
   * links to it from the signed-out shell.
   *
   * This is also the regression test for how it was nearly unreachable. The
   * public-route branch in App.jsx tested `currentPath.startsWith('/verify/')`
   * — a hardcoded second copy of PUBLIC_ROUTES — so a route added to the table
   * fell through to the signed-out catch-all and answered 404 while looking
   * perfectly declared. The check is derived from the table now, and asserting
   * BOTH public routes here is what keeps it derived.
   */
  /**
   * `/privacy` now REDIRECTS to the registry document rather than rendering its own
   * page, and these two tests changed with it.
   *
   * There were two privacy pages: `/legal/privacy-policy`, which serves the
   * published document out of `server/legalDocuments.js` hash-verified on every
   * read, and `/privacy`, a hand-written page built from `src/config.js` values that
   * predates the registry. `PRIVACY_URL` defaulted to the second one, and that is
   * the link inside the signup consent block — so the person being asked to
   * acknowledge how their information is handled was sent to the page that is NOT
   * the document their acceptance is recorded against.
   *
   * The route is kept as a redirect rather than removed because it is a published
   * URL that may exist in a bookmark or an email. What is asserted here is that it
   * still resolves, and that it lands on the registry document — for a signed-out
   * visitor as well as a signed-in one, since the consent block is read by somebody
   * who has no account yet.
   */
  it('redirects a signed-out visitor from /privacy to the registry document', async () => {
    api.getMe.mockResolvedValue(null);
    render(
      <MemoryRouter initialEntries={['/privacy']}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getByTestId('where').dataset.path).toBe('/legal/privacy-policy'));
  });

  it('redirects a signed-in user from /privacy too', async () => {
    signedInAs(USER('student'));
    render(
      <MemoryRouter initialEntries={['/privacy']}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getByTestId('where').dataset.path).toBe('/legal/privacy-policy'));
  });
});

/**
 * Losing the connection covers the app; it does not throw it away.
 *
 * `OfflineOverlay` has its own unit tests for the mechanism. These assert the
 * WIRING, which is the half that fails silently: the first version chose
 * between the experience and the routed view with a ternary in this file, and
 * every test here stayed green while a dropped bar destroyed whatever the
 * reader had typed. The claim is per-shell because the two shells wire it
 * separately and only one of them being right is the likely regression.
 */
describe('going offline', () => {
  const setOnline = (value) => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
    fireEvent(window, new Event(value ? 'online' : 'offline'));
  };

  afterEach(() => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  });

  it('covers the signed-out shell without unmounting the form behind it', async () => {
    api.getMe.mockResolvedValue(null);
    renderAt('/signup');
    const form = await screen.findByTestId('signup');

    act(() => setOnline(false));
    await findErrorKind('offline');
    // Same node, not a re-mounted one: anything typed into it is still there.
    expect(screen.getByTestId('signup')).toBe(form);

    act(() => setOnline(true));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByTestId('signup')).toBe(form);
  });

  it('covers the authenticated shell, nav and all, without unmounting the view', async () => {
    signedInAs(USER('student'));
    renderAt('/events');
    const view = await screen.findByTestId('browse');

    act(() => setOnline(false));
    await findErrorKind('offline');
    expect(screen.getByTestId('browse')).toBe(view);

    /* The shell is covered too, not just <main>. An overlay is opaque, so any
       nav left outside it is a tab stop nobody can see. */
    const covered = document.querySelector('.err-offline-under');
    expect(covered.contains(view)).toBe(true);
    expect(covered.querySelector('.app'), 'the shell is outside the cover').toBeTruthy();
    expect(covered.hasAttribute('inert')).toBe(true);
  });
});

/**
 * The takeover architecture.
 *
 * ── What is actually being claimed ──
 *
 * "Fullscreen" is not a CSS assertion. The visual weight is covered by
 * `ErrorExperience.test.jsx`; what matters here is structural and only
 * observable against the real App: when a catastrophic failure renders, the
 * application shell must not be in the document AT ALL. Not hidden, not
 * covered, not behind a z-index — absent. A sidebar that is merely painted over
 * is still a list of tab stops between the reader and the way out.
 *
 * The counterpart claim matters just as much: 403 is NOT a takeover, and the
 * shell has to survive it, because "ask your school administrator" is advice
 * the reader acts on with the navigation.
 */
const SHELL_SELECTORS = ['.app', '.sidebar', '.topbar', '.mobilenav', '[data-testid="profile-menu"]'];

function shellPresent(container) {
  return SHELL_SELECTORS.filter((sel) => container.querySelector(sel) !== null);
}

describe('catastrophic failures take over the whole screen', () => {
  it.each([
    ['/404', '404'],
    ['/500', '500'],
    ['/crash', 'crash'],
    ['/chunk', 'chunk'],
    ['/offline', 'offline'],
    ['/maintenance', 'maintenance'],
  ])('%s renders the %s experience with no application shell', async (path, kind) => {
    signedInAs(USER('student'));
    const { container } = renderAt(path);

    await findErrorKind(kind);
    expect(container.querySelector('.err').dataset.errorWeight).toBe('immersive');
    expect(shellPresent(container), `${path} left shell chrome on the page`).toEqual([]);
  });

  it('takes over for a signed-out visitor too, with the same weight', async () => {
    api.getMe.mockResolvedValue(null);
    const { container } = renderAt('/500');

    await findErrorKind('500');
    expect(container.querySelector('.err').dataset.errorWeight).toBe('immersive');
    expect(shellPresent(container)).toEqual([]);
  });

  /**
   * The regression this replaces: the 404 used to be a `<Route path="*">` INSIDE
   * the shell, so an unknown URL rendered a full-screen apology with the
   * sidebar, topbar and profile menu still around it.
   */
  it('an unknown URL takes over instead of rendering inside the shell', async () => {
    signedInAs(USER('student'));
    const { container } = renderAt('/no-such-page');

    await findErrorKind('404');
    expect(shellPresent(container), 'unknown URL still rendered inside the shell').toEqual([]);
  });

  /**
   * The URL is the payload. Redirecting to `/404` would destroy the one piece
   * of information the reader needs — and make Back a loop, since the original
   * URL would redirect straight out again.
   */
  it('leaves the unknown URL in the address bar rather than redirecting', async () => {
    signedInAs(USER('student'));
    render(
      <MemoryRouter initialEntries={['/no-such-page?ref=email']}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    );

    await findErrorKind('404');
    expect(screen.getByTestId('where').dataset.path).toBe('/no-such-page');
    expect(screen.getByTestId('where').dataset.search).toBe('?ref=email');
  });
});

/**
 * A permission refusal IS a takeover.
 *
 * ── This reverses an earlier decision, deliberately ──
 *
 * This block used to assert the opposite: that a 403 keeps the shell, on the
 * reasoning that "the navigation is how 'ask your administrator' gets acted on".
 * That is a real argument and it is why the refusal was left rendering as a card
 * inside `<main>`, as the only error state that did.
 *
 * It was overruled by what it looked like in use. The reader saw the nav rail,
 * the topbar and their own profile menu still on screen, framing a message
 * saying this area is not for them — which reads as a page that failed to load
 * rather than a decision that was made, and leaves live navigation for the
 * section they have just been refused. The product owner asked for every error
 * state to take the screen, naming this one specifically, twice.
 *
 * The argument it replaces is answered rather than discarded: `ErrorExperience`
 * carries its own recovery action, so "where do I go now" is still on screen —
 * it is one deliberate link instead of a whole shell that implies the refusal
 * was incidental.
 *
 * The 403's `errorWeight` stays `medium`. Weight is about how alarming the copy
 * is allowed to be, and being refused a page is still not an emergency; it is
 * only the chrome that changed.
 */
describe('a permission refusal is a takeover', () => {
  /**
   * This test used to assert `medium` on the line below while the two lines
   * under it asserted the shell was gone — the contradiction that hid the
   * defect. It said, correctly, that a refusal replaces the shell, and then
   * pinned the sizing written for a refusal that sits INSIDE one.
   *
   * The rendered result was a takeover wearing in-shell dimensions:
   * `min-height: 0` and a 0.64× scene on an empty viewport, so the whole
   * composition sat in the top-left corner above roughly 55% dead space with a
   * visible seam where the clipped wash ended. Every assertion here passed
   * throughout.
   */
  it('403 replaces the shell, like every other error state', async () => {
    signedInAs(USER('student'));
    const { container } = renderAt('/events/new');

    await findErrorKind('403');
    expect(
      container.querySelector('.err').dataset.errorWeight,
      'a refusal that replaces the shell must be sized like one that replaces '
      + 'the shell — the two assertions below are the other half of this claim'
    ).toBe('immersive');
    expect(container.querySelector('.app'), '403 kept the shell').toBeNull();
    expect(container.querySelector('.sidebar')).toBeNull();
  });

  /**
   * An unverified organizer reaching /events/new is refused by
   * `requiresVerified`, which no capability expresses — so it is a separate
   * branch in `deniedRoute` and a separate way to keep the shell by accident.
   */
  it('takes over for an unverified account on a verified-only route', async () => {
    signedInAs(USER('organizer', { verified: false }));
    const { container } = renderAt('/events/new');

    await findErrorKind('403');
    expect(container.querySelector('.app'), '403 kept the shell').toBeNull();
  });

  /** A route the reader CAN reach must still render inside the shell. */
  it('does not take over a route the reader is allowed to open', async () => {
    signedInAs(USER('organizer'));
    const { container } = renderAt('/events/new');

    await waitFor(() => expect(container.querySelector('.app')).toBeTruthy());
    expect(container.querySelector('.sidebar')).toBeTruthy();
  });
});
