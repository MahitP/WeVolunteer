/**
 * What each of the five roles actually gets from the shell.
 *
 * Every surface here used to branch on `currentUser.role` with an unscoped
 * `else`, so introducing super_admin — the role this whole branch exists to
 * enable — produced an empty navigation rail, no profile page, a "Volunteer"
 * label on the platform owner, and OrganizerDashboard (whose fetchOrganizerStats
 * 403s and is swallowed) for both new roles.
 *
 * Two things are asserted, and the first matters as much as the second:
 *
 *   1. student, organizer and admin get EXACTLY what they got before — same nav
 *      entries in the same order, same dashboards, same /profile outcomes, same
 *      page titles. The conversion to capabilities was not allowed to move any
 *      of them, and a diff-free refactor is only diff-free if something checks.
 *   2. super_admin and partner get a deliberate result rather than whatever the
 *      last `else` happened to be.
 *
 * `App.routeTable.test.jsx` covers the route table's props and gates; this file
 * covers the per-role shell around it.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import App, { navItemsFor, ROLE_LABEL } from './App';
import ProfileMenu from './components/account/ProfileMenu';
import { ROLES } from './authz.js';
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
vi.mock('./views/CertificateVerification', () => stub('cert'));
vi.mock('./components/ThemeToggle', () => ({ default: () => <div data-testid="theme" /> }));
vi.mock('./components/NotificationsBell', () => ({ default: () => <div data-testid="bell" /> }));

const USER = (role, extra = {}) => ({
  id: `${role}-1`, name: 'Test Person', email: 't@e.org', username: 't', role,
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
// whenever the active tab changes.
Element.prototype.scrollTo = () => {};

beforeEach(() => vi.clearAllMocks());

/** The sidebar's entries, in render order. */
const sidebarLabels = () =>
  [...document.querySelectorAll('.sidebar .nav .nav-item span:first-of-type')].map(el => el.textContent);

describe('navigation, per role', () => {
  /**
   * The unchanged three, pinned entry-for-entry and in order — the slice at 4
   * that splits primary from "More" on mobile makes the ORDER load-bearing, not
   * just the set.
   */
  it.each([
    ['student', ['Dashboard', 'Opportunities', 'Calendar', 'Messages', 'Notifications', 'My profile']],
    ['organizer', ['Dashboard', 'Opportunities', 'Calendar', 'Messages', 'New event', 'Notifications', 'My profile']],
    ['admin', ['Review queue', 'Opportunities', 'Notifications']]
  ])('%s is unchanged by the conversion', (role, expected) => {
    expect(navItemsFor(USER(role)).map(n => n.label)).toEqual(expected);
  });

  it('super_admin gets a populated rail, not an empty shell', () => {
    const items = navItemsFor(USER('super_admin'));
    expect(items.map(n => n.label)).toEqual([
      'Review queue', 'Opportunities', 'Calendar', 'Messages', 'New event',
      'Notifications', 'Errors', 'My profile'
    ]);
    // The bug: `roles.includes('super_admin')` was false for every entry.
    expect(items.length).toBeGreaterThan(0);
  });

  /**
   * `Errors` is the only SUPER_ONLY entry in the rail, and the ordering above is
   * not incidental. `navItems.slice(0, 4)` is the mobile primary row, so an
   * entry inserted earlier would push `Messages` behind "More" for the platform
   * owner — a nav regression that no assertion about the SET would catch.
   */
  it('adds Errors without disturbing the mobile primary row', () => {
    const labels = navItemsFor(USER('super_admin')).map(n => n.label);
    expect(labels.slice(0, 4)).toEqual(['Review queue', 'Opportunities', 'Calendar', 'Messages']);
    expect(labels.indexOf('Errors')).toBeGreaterThan(3);
  });

  /**
   * The gate that matters. `error.read` is SUPER_ONLY, so `can()` refuses it
   * before consulting per-user grants — this asserts the consequence rather
   * than the mechanism, because the consequence is what a user experiences.
   */
  it.each([['student'], ['organizer'], ['admin'], ['partner']])(
    '%s is never offered the error dashboard',
    (role) => {
      expect(navItemsFor(USER(role)).map(n => n.label)).not.toContain('Errors');
    }
  );

  it('partner gets only what analytics.public/event.view justify', () => {
    // No dashboard entry, because partner has no dashboard to be sent to —
    // an entry pointing at a page that says "nothing here" is worse than none.
    expect(navItemsFor(USER('partner')).map(n => n.label)).toEqual(['Opportunities']);
  });

  it('an unverified organizer still loses New event', () => {
    expect(navItemsFor(USER('organizer', { verified: false })).map(n => n.label))
      .not.toContain('New event');
  });

  it('renders the resolved entries into the sidebar', async () => {
    signedInAs(USER('super_admin'));
    renderAt('/');
    await screen.findByTestId('admin-dash');
    expect(sidebarLabels()).toEqual([
      'Review queue', 'Opportunities', 'Calendar', 'Messages', 'New event',
      'Notifications', 'Errors', 'My profile'
    ]);
  });

  it('leaves the admin sidebar exactly as it was', async () => {
    signedInAs(USER('admin'));
    renderAt('/');
    await screen.findByTestId('admin-dash');
    expect(sidebarLabels()).toEqual(['Review queue', 'Opportunities', 'Notifications']);
  });
});

describe('the `/` dashboard, per role', () => {
  it.each([
    ['student', 'vol-dash'],
    ['organizer', 'org-dash'],
    ['admin', 'admin-dash'],
    // The whole point of the branch: the platform owner reaches the admin
    // dashboard rather than being trapped in whichever branch was tested first.
    ['super_admin', 'admin-dash']
  ])('%s lands on %s', async (role, testId) => {
    signedInAs(USER(role));
    renderAt('/');
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  /**
   * Not OrganizerDashboard. It calls fetchOrganizerStats, which 403s for a
   * partner and is swallowed — leaving a dashboard of zeros that reads as
   * data. An empty state that says so is the honest result, and there is no
   * partner analytics view in the client to send them to yet.
   */
  it('partner gets an explicit no-dashboard state, never the organizer one', async () => {
    signedInAs(USER('partner'));
    renderAt('/');
    expect(await screen.findByText(/No dashboard for this account/i)).toBeInTheDocument();
    expect(screen.queryByTestId('org-dash')).not.toBeInTheDocument();
  });
});

describe('/profile, per role', () => {
  it.each([
    ['student', 'vol-profile'],
    ['organizer', 'org-profile']
  ])('%s still reaches %s', async (role, testId) => {
    signedInAs(USER(role));
    renderAt('/profile');
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  it.each([['admin'], ['partner']])('%s is still redirected away', async (role) => {
    signedInAs(USER(role));
    renderAt('/profile');
    // Redirected to `/`, which is the dashboard for admin and the empty state
    // for partner — either way, not a profile.
    await waitFor(() => {
      expect(screen.queryByTestId('vol-profile')).not.toBeInTheDocument();
      expect(screen.queryByTestId('org-profile')).not.toBeInTheDocument();
    });
  });

  /**
   * A page, not a redirect loop — which is what `denied` gave the platform
   * owner before. It is deliberately NOT the organizer view: both profile
   * endpoints filter by role in SQL (`role = 'student'`, `role IN
   * ('organizer','admin')`), so either real view would render a 404 for a
   * super_admin. Widening those queries is a server change.
   */
  it('super_admin gets a real page instead of being bounced to `/`', async () => {
    signedInAs(USER('super_admin'));
    renderAt('/profile');
    expect(await screen.findByText(/No service record for this account/i)).toBeInTheDocument();
    expect(screen.queryByTestId('admin-dash')).not.toBeInTheDocument();
  });
});

describe('page titles', () => {
  it.each([
    ['student', 'Dashboard'],
    ['organizer', 'Dashboard'],
    ['admin', 'Review queue'],
    ['super_admin', 'Review queue'],
    ['partner', 'Dashboard']
  ])('%s reads "%s" on the dashboard', async (role, title) => {
    signedInAs(USER(role));
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
  });

  it('partner is told why the dashboard is empty in the subtitle too', async () => {
    signedInAs(USER('partner'));
    renderAt('/');
    expect(await screen.findByText(/Partner accounts do not have a dashboard yet/i)).toBeInTheDocument();
  });
});

describe('role labels', () => {
  /**
   * The fallback used to be `|| 'Volunteer'`, so any role without an entry was
   * announced to its holder as a volunteer. Completeness is what makes the
   * fallback unreachable; pinning it against ROLES is what keeps a sixth role
   * from shipping without a label.
   */
  it('App.jsx names every role in ROLES', () => {
    expect(ROLES.filter(r => !ROLE_LABEL[r])).toEqual([]);
  });

  it.each([
    ['student', 'Student'],
    ['organizer', 'Organizer'],
    ['admin', 'Administrator'],
    ['super_admin', 'Platform administrator'],
    ['partner', 'Partner']
  ])('the sidebar chip calls %s "%s"', (role, label) => {
    render(
      <MemoryRouter>
        <ProfileMenu user={USER(role)} onEditProfile={() => {}} onSignOut={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('still says "Pending approval" for an unapproved organizer', () => {
    render(
      <MemoryRouter>
        <ProfileMenu user={USER('organizer', { verified: false })} onEditProfile={() => {}} onSignOut={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
  });

  it('the mobile sheet calls super_admin the platform administrator, not a volunteer', async () => {
    signedInAs(USER('super_admin'));
    renderAt('/');
    await screen.findByTestId('admin-dash');

    fireEvent.click(screen.getByRole('button', { name: /More/i }));
    // Scoped to the sheet: the sidebar chip (ProfileMenu, asserted above)
    // carries its own copy of the label, so an unscoped query matches twice.
    const sheet = within(document.querySelector('.mobile-more-sheet'));
    expect(sheet.getByText('Platform administrator')).toBeInTheDocument();
    expect(sheet.queryByText('Volunteer')).not.toBeInTheDocument();
  });
});

describe('the session bootstrap', () => {
  const paramsFromFirstLoad = () => api.fetchEventsProgressive.mock.calls[0][0].params;

  /**
   * `role === 'admin' ? {} : { mine: 'true' }` handed super_admin the narrow,
   * self-scoped index — the review queue it lands on cannot work from that.
   */
  it.each([
    ['student', { mine: 'true' }],
    ['organizer', { mine: 'true' }],
    ['admin', {}],
    ['super_admin', {}],
    ['partner', { mine: 'true' }]
  ])('%s fetches the event index with %o', async (role, params) => {
    signedInAs(USER(role));
    renderAt('/');
    await waitFor(() => expect(api.fetchEventsProgressive).toHaveBeenCalled());
    expect(paramsFromFirstLoad()).toEqual(params);
  });

  it.each([
    ['student', true],
    ['organizer', false],
    ['admin', false],
    ['super_admin', true],
    ['partner', false]
  ])('%s fetching favourites: %s', async (role, expected) => {
    signedInAs(USER(role));
    renderAt('/');
    await waitFor(() => expect(api.fetchApplications).toHaveBeenCalled());
    await waitFor(() => expect(api.fetchFavorites.mock.calls.length > 0).toBe(expected));
  });
});
