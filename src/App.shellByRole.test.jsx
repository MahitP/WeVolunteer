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
import App, { navItemsFor, navSectionsFor, ROLE_LABEL, tabForPath } from './App';
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

/**
 * `distinction` is included because the server always sends it.
 *
 * `formatUserResponse` derives it from `users.role` on every `/api/auth/me`
 * (see `distinctionFor` in server/profileSerializer.js), so a fixture that
 * carried a role WITHOUT it would be a shape the server cannot produce — and the
 * shell would be tested against a payload that does not exist. Derived here from
 * the same role for the same reason, rather than pinned per test.
 */
const DISTINCTION = {
  super_admin: { kind: 'owner', label: 'Platform owner', blurb: 'Runs WeVolunteer for the district.' },
  partner: { kind: 'partner', label: 'Community partner', blurb: 'An outside organization that works with WeVolunteer.' },
};

const USER = (role, extra = {}) => ({
  id: `${role}-1`, name: 'Test Person', email: 't@e.org', username: 't', role,
  verified: true, emailVerified: true, hasPassword: true, avatar: '🧑', skills: [],
  distinction: DISTINCTION[role] ?? null, highlights: [], ...extra
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

/**
 * The rail highlight and the page title both key off `tabForPath`, which is a
 * hand-written second copy of a mapping `NAV` already holds. It cannot be
 * derived — `/settings` has no nav entry, and `/events/new` must be matched
 * before `/events` — so it is guarded instead.
 *
 * `/errors` shipped in NAV with no branch in that chain: the page rendered
 * correctly, titled "Moderation Center", with the wrong rail item highlighted. No
 * existing test noticed, because every one of them asserted the route or the
 * capability rather than what the shell said the reader was looking at.
 */
describe('every nav entry knows which page it is', () => {
  it.each(navItemsFor({ id: 'x', role: 'super_admin', verified: true }).map((n) => [n.id, n.path]))(
    '%s resolves its own path to itself',
    (id, path) => {
      expect(tabForPath(path)).toBe(id);
    }
  );

  it('falls back to the dashboard for anything unrecognised', () => {
    expect(tabForPath('/nope')).toBe('dashboard');
    expect(tabForPath('/')).toBe('dashboard');
  });

  /* Prefix order is load-bearing: `/events` is a prefix of `/events/new`. The
     canonical Discover path is `/discover`; `/events` still maps to `browse`
     because its compatibility redirect renders for a frame before the URL is
     replaced, and that frame must not be titled by the `*` fallback. */
  it('does not let a shorter path swallow a longer one', () => {
    expect(tabForPath('/events/new')).toBe('create');
    expect(tabForPath('/events')).toBe('browse');
    expect(tabForPath('/discover')).toBe('browse');
  });
});

describe('navigation, per role', () => {
  /**
   * The unchanged three, pinned entry-for-entry and in order — the slice at 4
   * that splits primary from "More" on mobile makes the ORDER load-bearing, not
   * just the set.
   */
  /**
   * `Community impact` left the student and organizer rails, and this pin was
   * updated deliberately rather than relaxed.
   *
   * `analytics.impact` was held by every signed-in role, and the NAV comment said
   * so as an intent: "the student quoting a figure on a college application and
   * the organizer writing a grant report are looking at the same page". The
   * capability is administrative now — the figures are an internal view of how
   * the programme is doing, which is the same conclusion that deleted the public
   * impact page instead of re-gating it.
   *
   * These lists are exact rather than a `toContain`, so the entry cannot come
   * back unnoticed.
   */
  it.each([
    ['student', ['Dashboard', 'Discover', 'Calendar', 'Messages', 'Notifications', 'Profile']],
    ['organizer', ['Dashboard', 'Discover', 'Calendar', 'Messages', 'Notifications', 'Profile']],
    /**
     * Admin GAINED `Messages`, and this pin was updated deliberately rather than
     * relaxed.
     *
     * It previously read `['Moderation Center', 'Opportunities', 'Notifications',
     * 'Appeals']` because admin did not hold `message.send` — and that was correct
     * at the time for a reason worth keeping on the record: the capability was
     * granted once before and reverted, because `conversations` was
     * `(event_id, student_id, organizer_id)` all NOT NULL and an admin who opened
     * one was not a participant. The nav entry would have led to an empty inbox.
     *
     * Migration 018 gave the table `admin_student` / `admin_organizer` kinds with
     * membership in `conversation_participants`, so the entry now leads somewhere.
     *
     * `Messages` lands third, inside `navItems.slice(0, 4)` — the mobile primary
     * row — which is the right place for it: reaching a person is a moderation
     * action, not an afterthought behind "More".
     */
    /**
     * No `Audit Explorer`, and no `Admin Roster`.
     *
     * Both were briefly here while the Audit Explorer shipped, because
     * `audit.read` was still an administrator capability. M1c moved it to
     * SUPER_ONLY: a trail recording what administrators did to students, and to
     * each other, is not a thing administrators read about one another.
     * `Admin Roster` is gated on `admin.create`, which has always been
     * super-only.
     *
     * This list is exact rather than a `toContain`, so the entry cannot return
     * unnoticed — which is exactly how it got here the first time.
     */
    ['admin', ['Dashboard', 'Discover', 'Messages', 'Admin', 'Notifications', 'Profile']]
  ])('%s nav is what its capabilities justify', (role, expected) => {
    expect(navItemsFor(USER(role)).map(n => n.label)).toEqual(expected);
  });

  /**
   * The owner's rail is now the same length as an ordinary volunteer's, plus the
   * hub. Six administrative pages moved to the Moderation Center — they were not
   * deleted, and `App.navGroups.test.jsx` is where that half is asserted, tile by
   * tile, against ModerationCenter's own table.
   */
  it('super_admin gets a populated rail, not an empty shell', () => {
    const items = navItemsFor(USER('super_admin'));
    expect(items.map(n => n.label)).toEqual([
      /* primary */ 'Dashboard', 'Discover', 'Calendar', 'Messages', 'Admin',
      /* secondary */ 'Notifications', 'Profile'
    ]);
    // The bug: `roles.includes('super_admin')` was false for every entry.
    expect(items.length).toBeGreaterThan(0);
  });

  /**
   * The administrative entry is IN the mobile primary row, which is the reverse
   * of what this test used to assert.
   *
   * It used to read "keeps the administrative entry out of the mobile primary
   * row", and pinned `labels.indexOf('Moderation Center') > 3`. That was the
   * defect, written down as a requirement: the bar was `navItems.slice(0, 4)`, so
   * anything past the fourth entry was reachable only through the `⋯` sheet — and
   * what sat there for administrators was the administrative area of the product.
   *
   * The bar now draws every primary entry and scrolls, so there is no fourth-place
   * cliff to keep anything behind. What has to hold instead: `Admin` is primary,
   * `Messages` did not get pushed out of primary to make room, and the overflow
   * holds only the two entries that have another way in.
   */
  it('keeps the administrative entry IN the mobile primary row', () => {
    const { primary, secondary } = navSectionsFor(USER('super_admin'));

    expect(primary.map(n => n.label))
      .toEqual(['Dashboard', 'Discover', 'Calendar', 'Messages', 'Admin']);
    expect(secondary.map(n => n.label), 'Admin is behind the ⋯ menu again')
      .not.toContain('Admin');
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

  it('partner gets only what event.view justifies', () => {
    // No dashboard entry, because partner has no dashboard to be sent to —
    // an entry pointing at a page that says "nothing here" is worse than none.
    //
    // And no `Community impact`: the figures are an internal view of how the
    // programme is doing, and a partner is an external organization — the
    // audience the deleted public impact page served. `analytics.public` is still
    // registered and still reads nothing, which is where a figure chosen FOR a
    // partner would go.
    //
    // `Profile` IS here as of v1.3.1. A partner used to have no self-profile view
    // at all — `SELF_PROFILE` matched nothing and `/profile` answered 403 — which
    // stopped being tolerable when the account menu started offering Profile to
    // everybody. It resolves to the generalized account page, which is built from
    // `/api/auth/me` and so needs no `directory.read`.
    expect(navItemsFor(USER('partner')).map(n => n.label)).toEqual(['Discover', 'Profile']);
  });

  /**
   * "New event" is no longer a nav entry at all — it is a primary button on
   * Opportunities, where an organizer already is when they want to post a shift.
   *
   * These two cases are kept as a NEGATIVE pin rather than deleted, because the
   * property they defend is still real: the create affordance must not reappear
   * in the rail without somebody deciding to put it there. The POSITIVE half of
   * the coverage they used to carry — that an unverified organizer, and an
   * organizer with `event.create` withheld, are not offered the action — moved to
   * `src/views/BrowseEvents.createAction.test.jsx`, which is where the affordance
   * now lives. Deleting these without moving that would have quietly dropped the
   * only tests that a suspended-in-all-but-name organizer cannot post.
   */
  it('does not offer event creation from the rail, for anybody', () => {
    for (const role of ['student', 'organizer', 'admin', 'super_admin']) {
      expect(navItemsFor(USER(role)).map(n => n.label), `${role} rail`)
        .not.toContain('New event');
    }
  });

  it('renders the resolved entries into the sidebar', async () => {
    signedInAs(USER('super_admin'));
    renderAt('/');
    await screen.findByTestId('admin-dash');
    /* One list, no divider: `Admin` renders among the destinations rather than
       under an "Administration" heading of its own.

       Profile is deliberately ABSENT. The rail ends in `ProfileMenu`, which
       offers Profile / Notifications / Settings / Sign Out over the signed-in
       user's own avatar — a rail entry as well drew the same destination twice
       on one screen, one of them inside the control that exists to hold it. The
       entry carries `accountOnly` and is filtered out here and only here; it is
       still in the mobile ⋯ sheet, which IS the account control at that width. */
    expect(sidebarLabels()).toEqual([
      'Dashboard', 'Discover', 'Calendar', 'Messages', 'Admin',
      'Notifications'
    ]);
    expect(sidebarLabels(), 'Profile belongs to the account menu').not.toContain('Profile');
  });

  it('renders the admin rail, including the Messages entry 018 made real', async () => {
    signedInAs(USER('admin'));
    renderAt('/');
    await screen.findByTestId('admin-dash');
    /* Profile absent for the same reason as above — the account menu holds it. */
    expect(sidebarLabels()).toEqual([
      'Dashboard', 'Discover', 'Messages', 'Admin', 'Notifications',
    ]);
  });

  /**
   * The rendered counterpart of the capability move.
   *
   * `navItemsFor` is pure and already covered above; this asserts the same thing
   * through the actual shell, because the nav is filtered in one place and
   * rendered in another, and only one of those is what a user sees.
   */
  it('does not show an administrator the owner-only entries', async () => {
    signedInAs(USER('admin'));
    renderAt('/');
    await screen.findByTestId('admin-dash');
    expect(sidebarLabels()).not.toContain('Audit Explorer');
    expect(sidebarLabels()).not.toContain('Admin Roster');
    expect(sidebarLabels()).not.toContain('Errors');
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

  /**
   * ── The organizer whose capabilities are withheld ──
   *
   * An organizer who has not accepted the Organizer Agreement holds none of the
   * capabilities that reach a student, `event.create` included — and
   * `event.create` is the capability the `host` persona row tests.
   *
   * Deriving the persona from the GATED `can()` therefore gave them no persona
   * at all and dropped them on "No dashboard for this account": a dead end
   * naming no reason and offering no next step, which also hid the acceptance
   * banner OrganizerDashboard renders for exactly this state. Found by driving
   * the real flow in a browser, not by any test — hence this one.
   *
   * They are still a host. They are a host who has not signed yet.
   */
  it('an organizer with withheld capabilities still reaches the organizer dashboard', async () => {
    signedInAs(USER('organizer', {
      withheld: ['event.create', 'applicant.review', 'message.send'],
    }));
    renderAt('/');

    expect(await screen.findByTestId('org-dash')).toBeInTheDocument();
    expect(screen.queryByText(/No dashboard for this account/i)).not.toBeInTheDocument();
  });

  it('still hides the nav entries those withheld capabilities gate', async () => {
    // The other half, and the reason persona and nav must answer DIFFERENT
    // questions: the dashboard that explains the pause stays reachable while the
    // controls that would 403 stay hidden. One test passing without the other
    // means the distinction collapsed.
    const labels = navItemsFor(USER('organizer', {
      withheld: ['event.create', 'message.send'],
    })).map(n => n.label);

    /* `New event` is no longer in the rail for anybody, so asserting its absence
       here would prove nothing about the withheld set. The equivalent assertion —
       that a withheld `event.create` also removes the Create event BUTTON — lives
       in `BrowseEvents.createAction.test.jsx`, which is where the affordance is. */
    expect(labels).not.toContain('Messages');
    expect(labels).toContain('Discover');
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
   * A page, not a redirect loop — which is what `denied` gave the platform owner
   * before, and not the empty state that replaced it either.
   *
   * It is deliberately NOT one of the two role-specific profile views: both of
   * their endpoints filter by role in SQL (`role = 'student'`,
   * `role IN ('organizer','admin')`), so either would render a 404 dressed as a
   * profile for a super_admin. `AccountProfile` is built from `/api/auth/me`,
   * which the shell already holds, so it needs no endpoint and no widening of
   * the two that exist — and that is also what makes it work for `partner`,
   * which deliberately holds no `directory.read`.
   */
  it('super_admin gets a real page instead of being bounced to `/`', async () => {
    signedInAs(USER('super_admin'));
    renderAt('/profile');
    /* The distinguished presentation, derived from role and from nothing else —
       no name is compared anywhere in it. */
    /* Twice, deliberately: the pill beside the name and the heading of the
       distinguished panel. `getAllByText` rather than a narrower query, because
       the assertion is that the presentation rendered at all. */
    expect(await screen.findAllByText(/Platform owner/i)).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: /edit profile/i })).toBeInTheDocument();
    expect(screen.queryByTestId('admin-dash')).not.toBeInTheDocument();
    /* And not either of the record-based views, which would 404 for this role. */
    expect(screen.queryByTestId('org-profile')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vol-profile')).not.toBeInTheDocument();
  });

  /**
   * The role that had no profile at all, and the reason it matters now.
   *
   * `partner` matched nothing in `SELF_PROFILE` and fell through to `denied`, so
   * `/profile` answered 403. That was survivable while the only route to the
   * page was a rail entry; the account menu now says "Profile", and a 403 from
   * your own account is not an answer.
   */
  it('partner gets the generalized account profile, not a refusal', async () => {
    signedInAs(USER('partner'));
    renderAt('/profile');
    expect(await screen.findAllByText(/Community partner/i)).not.toHaveLength(0);
    expect(screen.queryByTestId('vol-profile')).not.toBeInTheDocument();
  });

  /**
   * An administrator's profile, for the same reason.
   *
   * `event.moderate` resolved to `denied` too — the comment where it did said
   * "no profile view has ever existed" — and one does now.
   */
  it('admin gets the generalized account profile', async () => {
    signedInAs(USER('admin'));
    renderAt('/profile');
    expect(await screen.findByRole('button', { name: /edit profile/i })).toBeInTheDocument();
    /* No distinguished banner: an administrator is staff, not the platform and
       not an outside organization. */
    expect(screen.queryAllByText(/Platform owner/i)).toHaveLength(0);
    expect(screen.queryAllByText(/Community partner/i)).toHaveLength(0);
  });
});

describe('page titles', () => {
  it.each([
    ['student', 'Dashboard'],
    ['organizer', 'Dashboard'],
    ['admin', 'Dashboard'],
    ['super_admin', 'Dashboard'],
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

  /**
   * ── The mobile bar, as rendered ──
   *
   * `navSectionsFor` is asserted directly in `App.navGroups.test.jsx`. These two
   * check that the SHELL actually draws it that way, because the regression being
   * guarded was a rendering decision (`navItems.slice(0, 4)`) rather than a data
   * one — the tier information was always available and simply not used.
   */
  it('draws every primary destination in the mobile bar, Admin included', async () => {
    signedInAs(USER('super_admin'));
    renderAt('/');
    await screen.findByTestId('admin-dash');

    const bar = within(document.querySelector('.mobilenav'));
    for (const label of ['Dashboard', 'Discover', 'Calendar', 'Messages', 'Admin']) {
      expect(bar.getByRole('button', { name: new RegExp(`^${label}$`) }),
        `${label} is missing from the mobile bar`).toBeInTheDocument();
    }

    /* The scroller is what makes five fit without a fifth-place cliff. Its
       absence would silently reinstate the ceiling, because the buttons would
       still all render — just crushed or clipped. */
    expect(document.querySelector('.mobilenav .mobilenav-scroll')).toBeTruthy();
    /* And `⋯` is outside it, so it cannot scroll out of reach. */
    expect(document.querySelector('.mobilenav-scroll .mobilenav-more')).toBeNull();
    expect(document.querySelector('.mobilenav > .mobilenav-more')).toBeTruthy();
  });

  it('puts Admin in the bar and NOT in the overflow sheet', async () => {
    signedInAs(USER('super_admin'));
    renderAt('/');
    await screen.findByTestId('admin-dash');

    fireEvent.click(screen.getByRole('button', { name: /More/i }));
    const sheet = within(document.querySelector('.mobile-more-sheet'));

    /* The reported defect, stated as an assertion: reaching the administrative
       area of the product must not require opening a menu. */
    expect(sheet.queryByText('Admin'), 'Admin is behind the ⋯ menu again').toBeNull();

    /* The sheet still holds the secondary destinations — "not in the overflow"
       must not have been achieved by dropping them from the shell entirely. */
    expect(sheet.getByText('Notifications')).toBeInTheDocument();
    expect(sheet.getByText('Profile')).toBeInTheDocument();
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
