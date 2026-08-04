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
import { MemoryRouter } from 'react-router-dom';
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

// jsdom does not implement Element.scrollTo; the mobile-nav effect calls it
// whenever the active tab changes (i.e. after every redirect).
Element.prototype.scrollTo = () => {};

beforeEach(() => vi.clearAllMocks());

describe('authenticated route table', () => {
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

  it('renders certificate verification for a signed-in user', async () => {
    signedInAs(USER('student'));
    renderAt('/verify/ABC123');
    expect(await screen.findByTestId('cert')).toBeInTheDocument();
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
