import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrowseEvents from './BrowseEvents';

/**
 * Who is offered "Create event" on Opportunities.
 *
 * ── Why this file exists ──
 *
 * Posting an opportunity used to be a nav entry ("New event"). It was removed:
 * it put the single most common organizer action behind reading a twelve-item
 * rail of mostly administrative pages, and on a phone — where the rail collapses
 * to four items plus a "More" sheet — often behind a tap as well.
 *
 * Moving an affordance moves its tests with it, and that is the part worth being
 * careful about. `App.shellByRole.test.jsx` used to carry two assertions that are
 * genuinely about authorization rather than about navigation:
 *
 *   - an UNVERIFIED organizer is not offered event creation;
 *   - an organizer with `event.create` WITHHELD (the Organizer Agreement not yet
 *     accepted) is not offered it either.
 *
 * Once the nav entry is gone, both of those pass in that file for free — the
 * label is absent for everybody. Deleting them there without landing them here
 * would have quietly dropped the only coverage that an organizer who has not
 * signed the agreement cannot post. So they are here, against the button.
 *
 * ── What this does NOT claim ──
 *
 * That any of it is a security boundary. It is not. `/events/new` re-checks the
 * capability and the verified flag, and every server route behind it checks
 * again on every request. This file is about not showing somebody a button that
 * will refuse them — which is a product defect, not a vulnerability.
 */

/* Opportunities is the discovery hub as of v1.3.1, so it also reaches the
   directory. Both of those are mocked to empty: this file is about one button,
   and a search that never resolves would make every assertion here depend on
   something it is not testing. */
vi.mock('../utils/api', () => ({
  api: {
    fetchEventsFiltered: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    fetchRecommendations: vi.fn().mockResolvedValue([]),
    fetchOrganizations: vi.fn().mockResolvedValue({ organizations: [] }),
    searchDirectory: vi.fn().mockResolvedValue({ users: [], organizations: [] }),
  },
}));

vi.mock('../contexts/LocationContext', () => ({
  useLocationContext: () => ({ location: null, requestLocation: vi.fn() }),
}));

const USER = (role, extra = {}) => ({
  id: `user-${role}`, role, verified: true, withheld: [], volunteeredHours: 0, ...extra,
});

const renderFor = (currentUser) => render(
  <MemoryRouter>
    <BrowseEvents currentUser={currentUser} onViewDetails={() => {}} onEventsSeen={() => {}} />
  </MemoryRouter>,
);

const createLink = () => screen.queryByRole('link', { name: /create event/i });

describe('the Create event action on Opportunities', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /* ── Offered ───────────────────────────────────────────────────────────── */

  it.each(['organizer', 'super_admin'])('is offered to a verified %s', (role) => {
    renderFor(USER(role));
    expect(createLink()).toBeInTheDocument();
  });

  /**
   * An ordinary administrator is NOT offered it, and that is not an oversight.
   *
   * `admin` holds `event.moderate` but not `event.create` — administrators
   * moderate the platform, they do not host shifts on it. super_admin sees the
   * button only through the `'*'` wildcard.
   *
   * Written as its own case rather than folded into the negative list below,
   * because "the admin cannot post events" reads like a bug to somebody skimming
   * and this is where they will look.
   */
  it('is not offered to an ordinary administrator, who does not hold event.create', () => {
    renderFor(USER('admin'));
    expect(createLink()).not.toBeInTheDocument();
  });

  it('points at the create route', () => {
    renderFor(USER('organizer'));
    expect(createLink()).toHaveAttribute('href', '/events/new');
  });

  /* ── Withheld ──────────────────────────────────────────────────────────── */

  /**
   * A student holds `event.apply`, never `event.create`. The most ordinary case
   * and the one that would be most obviously wrong on screen.
   */
  it('is not offered to a student', () => {
    renderFor(USER('student'));
    expect(createLink()).not.toBeInTheDocument();
  });

  /**
   * An organizer whose account is not yet approved.
   *
   * `requiresVerified` is a separate flag rather than a capability because no
   * capability expresses "approved yet" — so it has to be checked separately
   * here, exactly as the route does, and a test that only covered the capability
   * would miss it entirely.
   */
  it('is not offered to an unverified organizer', () => {
    renderFor(USER('organizer', { verified: false }));
    expect(createLink()).not.toBeInTheDocument();
  });

  /**
   * An organizer who has not accepted the Organizer Agreement.
   *
   * `withheld` is how that pause is expressed: the role still HOLDS
   * `event.create`, and `can()` returns false for it anyway. This is the case a
   * naive `role === 'organizer'` check would get wrong, which is most of why the
   * button asks `can()` instead.
   */
  it('is not offered to an organizer with event.create withheld', () => {
    renderFor(USER('organizer', { withheld: ['event.create'] }));
    expect(createLink()).not.toBeInTheDocument();
  });

  /**
   * No user at all — the loading frame before the session resolves.
   *
   * `can(undefined, …)` is false, so this is already true; asserted because the
   * alternative (a button flashing for an instant on every page load, for
   * everybody) is the kind of thing nobody notices in review.
   */
  it('is not offered before a session exists', () => {
    renderFor(null);
    expect(createLink()).not.toBeInTheDocument();
  });
});
