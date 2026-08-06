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
vi.mock('./views/PrivacyNotice', () => stub('privacy'));
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

beforeEach(() => vi.clearAllMocks());

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

  it('admin: /messages is denied, /events is allowed', async () => {
    signedInAs(USER('admin'));
    const a = renderAt('/messages');
    await findErrorKind('403');
    a.unmount();

    signedInAs(USER('admin'));
    renderAt('/events');
    expect(await screen.findByTestId('browse')).toBeInTheDocument();
  });

  it('/profile is per role, and admin is redirected', async () => {
    signedInAs(USER('student'));
    const a = renderAt('/profile');
    expect(await screen.findByTestId('vol-profile')).toBeInTheDocument();
    a.unmount();

    signedInAs(USER('organizer'));
    const b = renderAt('/profile');
    expect(await screen.findByTestId('org-profile')).toBeInTheDocument();
    b.unmount();

    // admin has no profile view — SELF_PROFILE marks it 'denied', so this is a
    // capability refusal and now says so instead of bouncing.
    signedInAs(USER('admin'));
    renderAt('/profile');
    await findErrorKind('403');
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

describe('a permission refusal is not a takeover', () => {
  it('403 keeps the shell the reader needs to act on the advice', async () => {
    signedInAs(USER('student'));
    const { container } = renderAt('/events/new');

    await findErrorKind('403');
    expect(container.querySelector('.err').dataset.errorWeight).toBe('medium');
    // The navigation is how "ask your administrator" gets acted on.
    expect(container.querySelector('.app'), '403 removed the shell').toBeTruthy();
    expect(container.querySelector('.sidebar')).toBeTruthy();
  });
});
