/**
 * What the sign-in screens do to somebody who is already signed in.
 *
 * ── The defect ──
 *
 * `/login`, `/signup` and `/welcome` are declared in SIGNED_OUT_ROUTES and
 * nowhere else, so for an authenticated reader they were not routes at all:
 * `shellServes()` found nothing, the unknown-URL takeover fired, and the app
 * answered its own front door with "Page not found".
 *
 * Signing in does not delete those URLs. They live in bookmarks, in browser
 * autocomplete, in the link somebody pastes into a group chat, and in the
 * muscle memory of anybody who has ever typed the site's name and pressed
 * enter. A 404 on the sign-in page, while signed in, does not read as "you are
 * already here" — it reads as the account being broken, and it is the kind of
 * thing a fifteen-year-old reports as "the site is down".
 *
 * ── Why the rule is DERIVED and not a list ──
 *
 * `isSignedOutOnlyPath` reads SIGNED_OUT_ROUTES rather than restating its
 * paths. A hardcoded `['/login', '/signup', '/welcome']` is a second copy of a
 * table that already exists, and the copy is what goes stale: the next
 * signed-out screen would 404 for exactly the same reason, and nothing here
 * would notice. The table-derived case below is the test for that, and it is
 * the one worth keeping.
 *
 * ── What must NOT redirect ──
 *
 * `/reset-password` and `/oauth/callback` are handled above the session gate
 * (AUTH_FLOW_PATHS, TD-9) precisely because they must work while a stale
 * session is still in memory — a password reset bumps `token_version`, so the
 * tab holding the emailed link usually still believes it is signed in.
 * Redirecting those to the dashboard would break account recovery for the
 * people who need it most, which is why they get their own cases here rather
 * than being left to the fact that they are not in the table.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { SIGNED_OUT_ROUTES, isSignedOutOnlyPath } from './routes/index.jsx';
import { api } from './utils/api';

vi.mock('./utils/api');
vi.mock('./services/socket', () => ({
  connectSocket: vi.fn(), disconnectSocket: vi.fn(), getSocket: vi.fn(),
  subscribeSocket: vi.fn(), unsubscribeSocket: vi.fn(),
  emitTypingStart: vi.fn(), emitTypingStop: vi.fn()
}));

const stub = (name) => ({ default: () => <div data-testid={name} /> });
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
vi.mock('./views/ResetPassword', () => stub('reset-password'));
vi.mock('./views/OAuthCallback', () => stub('oauth-callback'));
vi.mock('./components/ThemeToggle', () => ({ default: () => <div data-testid="theme" /> }));
vi.mock('./components/NotificationsBell', () => ({ default: () => <div data-testid="bell" /> }));

const USER = (role = 'student') => ({
  id: `${role}-1`, name: 'Test Person', email: 't@e.org', username: 't', role,
  verified: true, emailVerified: true, hasPassword: true, avatar: '🧑', skills: [],
});

function signedInAs(user) {
  api.getMe.mockResolvedValue(user);
  api.fetchEventsProgressive.mockResolvedValue([]);
  api.fetchApplications.mockResolvedValue([]);
  api.fetchFavorites.mockResolvedValue([]);
  api.fetchNotifications.mockResolvedValue({ unreadCount: 0, notifications: [] });
}

function signedOut() {
  api.getMe.mockRejectedValue(new Error('unauthenticated'));
  api.fetchEventsProgressive.mockResolvedValue([]);
  api.fetchApplications.mockResolvedValue([]);
  api.fetchFavorites.mockResolvedValue([]);
  api.fetchNotifications.mockResolvedValue({ unreadCount: 0, notifications: [] });
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
);

Element.prototype.scrollTo = () => {};

beforeEach(() => vi.clearAllMocks());

describe('a signed-in reader on a signed-out screen', () => {
  /**
   * Derived from the table, so a signed-out screen added later is covered the
   * day it is added rather than the day somebody remembers this file.
   *
   * `/` is excluded because the authenticated shell serves it — it is the
   * dashboard — so it never reaches the redirect at all.
   */
  const signedOutOnly = SIGNED_OUT_ROUTES.map(r => r.path).filter(p => p !== '/');

  it.each(signedOutOnly)('sends an authenticated reader from %s to their dashboard', async (path) => {
    signedInAs(USER('student'));
    renderAt(path);

    expect(await screen.findByTestId('vol-dash')).toBeInTheDocument();
    /* The specific failure this replaced. Asserted by the absence of the error
       takeover as well as the presence of the dashboard, because a takeover
       renders INSTEAD of the shell — so "the dashboard is here" and "the 404 is
       not" are two different claims and only both together mean it is fixed.

       Matched on `.err-title` rather than on the copy: the 404 wording is one
       of three themes picked per render (see errorCopy.js), so any string
       assertion here would be flaky in a way that looks like a routing bug. */
    expect(document.querySelector('.err-title')).toBeNull();
  });

  it('sends an administrator to the administrative dashboard, not a volunteer one', async () => {
    signedInAs(USER('admin'));
    renderAt('/login');

    expect(await screen.findByTestId('admin-dash')).toBeInTheDocument();
  });

  /**
   * No loop. `/` is a real authenticated route, so the redirect lands somewhere
   * that does not redirect again — the property that makes this safe rather
   * than a browser hang. Asserted by the dashboard still being on screen after
   * the router has settled.
   */
  it('does not bounce between the redirect and its destination', async () => {
    signedInAs(USER('student'));
    renderAt('/welcome');

    expect(await screen.findByTestId('vol-dash')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('vol-dash')).toBeInTheDocument());
    expect(screen.queryByTestId('welcome')).not.toBeInTheDocument();
  });

  /**
   * An unknown URL is still unknown. The redirect must not have widened into
   * "anything the shell does not serve goes to the dashboard", which would make
   * a typo indistinguishable from a working link — the whole reason the error
   * experience exists.
   */
  it('still answers 404 for a URL that is genuinely not a page', async () => {
    signedInAs(USER('student'));
    renderAt('/nope-not-a-page');

    await waitFor(() => expect(document.querySelector('.err-title')).not.toBeNull());
    expect(screen.queryByTestId('vol-dash')).not.toBeInTheDocument();
  });
});

describe('a signed-out reader on a signed-out screen', () => {
  it.each([
    ['/login', 'login'],
    ['/signup', 'signup'],
    ['/welcome', 'welcome'],
    ['/', 'welcome'],
  ])('still reaches %s', async (path, testId) => {
    signedOut();
    renderAt(path);

    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });
});

/**
 * The account-recovery flows are covered by `App.authRoutes.test.jsx` (C1/C2),
 * which predates this file and tests them far more thoroughly than a
 * re-statement here would — including the `?reset=` link shape the email
 * actually sends, a truncated link, and that the OAuth code is really
 * exchanged. What is asserted here instead is the RULE, one level down: that
 * `isSignedOutOnlyPath` does not claim those paths, so no refactor of App.jsx's
 * branches can quietly pull them into the redirect.
 */
describe('isSignedOutOnlyPath', () => {
  it('claims every signed-out screen', () => {
    for (const { path } of SIGNED_OUT_ROUTES) {
      expect(isSignedOutOnlyPath(path), `${path} should be recognised`).toBe(true);
    }
  });

  /**
   * The auth-flow paths must never be claimed by this predicate. This is the
   * unit-level statement of the recovery cases above: those assert the
   * behaviour through the whole shell, this asserts the rule itself, so a
   * refactor of App.jsx's branches cannot quietly move them into scope.
   */
  it.each(['/reset-password', '/oauth/callback', '/legal', '/verify/abc', '/discover', '/nope'])(
    'does not claim %s', (path) => {
      expect(isSignedOutOnlyPath(path)).toBe(false);
    }
  );

  it('ignores a query string when matching', () => {
    expect(isSignedOutOnlyPath('/login?mode=signup')).toBe(true);
  });
});
