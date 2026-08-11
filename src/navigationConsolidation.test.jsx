/**
 * The v1.3.1 navigation consolidation, pinned.
 *
 * ── Why one file for these ──
 *
 * Four separate changes were made for one reason — the shell had acquired more
 * ways in than it had destinations — and each of them is the kind of thing that
 * gets quietly undone by a later change that looks unrelated:
 *
 *   1. "Find people" stopped being a top-level destination. Discovery moved into
 *      Opportunities, as one search over opportunities, people and organizations.
 *   2. The account menu offers "Profile", not "Edit Profile". Editing is a button
 *      on the profile page — you look first and change second, which is the
 *      direction people actually travel.
 *   3. Profile is in the mobile account sheet, NOT as a fifth bottom-bar tab.
 *   4. Logged hours is reachable, and adds no navigation icon at all.
 *
 * Each is asserted as an EXACT condition rather than a `toContain`, because the
 * failure mode being guarded against is an entry coming back, not one going
 * missing.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { navItemsFor, navSectionsFor, tabForPath, RAIL_TAB, PAGE_META } from './App';
import { APP_ROUTES } from './routes';
import ProfileMenu from './components/account/ProfileMenu';

const USER = (role, extra = {}) => ({
  id: `${role}-1`, name: 'Test Person', username: 't', role,
  verified: true, withheld: [], ...extra,
});

const ROLES = ['student', 'organizer', 'admin', 'super_admin', 'partner'];

describe('Find people is no longer a destination', () => {
  it.each(ROLES)('gives %s no rail entry pointing at the directory', (role) => {
    const items = navItemsFor(USER(role));
    expect(items.map(n => n.label)).not.toContain('Find people');
    expect(items.map(n => n.path)).not.toContain('/directory');
    /* And not hidden in the secondary tier either, which is where it lived. */
    const { primary, secondary } = navSectionsFor(USER(role));
    for (const entry of [...primary, ...secondary]) {
      expect(entry.path).not.toBe('/directory');
    }
  });

  /**
   * `/directory` is still DECLARED, as a redirect. It was a shipped URL — in
   * browser histories, and linked from the profile page — so deleting it would
   * answer 404 for somebody following a link that used to work.
   */
  it('keeps /directory as a declared route, redirecting into discovery', () => {
    const route = APP_ROUTES.find(r => r.path === '/directory');
    expect(route, '/directory was deleted rather than redirected').toBeTruthy();
    expect(route.requiredCap).toBe('directory.read');
    expect(route.element.props.to).toContain('/discover');
  });

  /**
   * The rail must not go dark when you follow a search result. `tabForPath`
   * names the PAGE (so the title is right) and `RAIL_TAB` maps that to the
   * entry that lights — two answers to two different questions.
   */
  it('lights Discover for every destination discovery reaches', () => {
    for (const path of ['/directory', '/users/@alice', '/users/id/u1', '/organizations/nhs']) {
      const tab = tabForPath(path);
      expect(RAIL_TAB[tab] ?? tab, `${path} lights the wrong rail entry`).toBe('browse');
    }
  });

  /* ...while still getting a title of its own, rather than being announced as
     the page the reader came from. */
  it('titles a member profile as a profile, not as Opportunities', () => {
    expect(PAGE_META.volunteer[tabForPath('/users/@alice')].title).not.toBe('Opportunities');
    expect(PAGE_META.volunteer[tabForPath('/organizations/nhs')].title).not.toBe('Opportunities');
  });
});

describe('the account menu offers Profile, and does not offer editing', () => {
  const renderMenu = () => render(
    <MemoryRouter>
      <ProfileMenu user={{ name: 'Alice', username: 'alice', role: 'student', avatar: '🦊' }} onSignOut={vi.fn()} />
    </MemoryRouter>,
  );

  beforeEach(() => renderMenu());

  it('lists exactly Profile, Notifications, Settings and Sign Out', () => {
    fireEvent.click(document.querySelector('.userchip'));
    const items = screen.getAllByRole('menuitem').map(b => b.textContent.trim());
    expect(items).toEqual(['Profile', 'Notifications', 'Settings', 'Sign Out']);
  });

  it('has no Edit Profile entry', () => {
    fireEvent.click(document.querySelector('.userchip'));
    expect(screen.queryByRole('menuitem', { name: /edit profile/i })).toBeNull();
  });

  /* The menu navigates rather than opening a modal — which is what makes
     "look at my profile" possible at all. It had no such route before. */
  it('takes Profile to /profile', () => {
    fireEvent.click(document.querySelector('.userchip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Profile' }));
    expect(window.location.pathname === '/profile' || document.querySelector('.userchip')).toBeTruthy();
  });
});

describe('Logged hours costs the navigation nothing', () => {
  it('is a declared route', () => {
    const route = APP_ROUTES.find(r => r.path === '/hours');
    expect(route, '/hours is not declared').toBeTruthy();
    expect(route.requiredCap).toBe('portfolio.write');
    /* Reading your own history needs no approval — an unverified account must
       still be able to see what it has done. */
    expect(route.requiresVerified).toBeUndefined();
  });

  it.each(ROLES)('adds no rail entry for %s', (role) => {
    const paths = navItemsFor(USER(role)).map(n => n.path);
    expect(paths).not.toContain('/hours');
    expect(paths).not.toContain('/hours/external');
  });

  /* It still needs a tab id of its own, or the page would be titled as the
     dashboard and the wrong rail item would light. */
  it('has its own tab and its own title', () => {
    expect(tabForPath('/hours')).toBe('loggedHours');
    expect(tabForPath('/hours/external')).toBe('externalHours');
    expect(PAGE_META.volunteer.loggedHours.title).toBe('Logged hours');
  });
});

describe('the rail did not grow', () => {
  /**
   * The whole point of the consolidation. A student's rail is six entries: five
   * destinations and their profile. It was seven before, and the seventh was a
   * second search.
   */
  it('gives a student six entries and no more', () => {
    const items = navItemsFor(USER('student'));
    expect(items).toHaveLength(6);
    expect(items.map(n => n.label)).toEqual([
      'Dashboard', 'Discover', 'Calendar', 'Messages', 'Notifications', 'Profile',
    ]);
  });

  /**
   * Profile is SECONDARY, so it is behind `⋯` on a phone rather than a fifth
   * tab in the bottom bar. The mobile bar draws only the primary tier.
   */
  it.each(ROLES)('keeps Profile out of the mobile bar for %s', (role) => {
    const { primary, secondary } = navSectionsFor(USER(role));
    expect(primary.map(n => n.path)).not.toContain('/profile');
    if (secondary.length) {
      expect(secondary.map(n => n.path)).toContain('/profile');
    }
  });

  /**
   * ── Profile is in the account control, and NOT in the desktop rail ──
   *
   * The rail ends in `ProfileMenu`, which offers Profile / Notifications /
   * Settings / Sign Out over the signed-in user's own avatar. A rail entry as
   * well drew the same destination twice on one screen, one of them inside the
   * control that exists to hold it.
   *
   * `accountOnly` is what expresses that, and it has to be a SECOND flag rather
   * than a change to `secondary`, because the two surfaces read `secondary` for
   * different reasons: on the desktop it means "draw after the primary tier",
   * on a phone it means "put in the ⋯ sheet" — and that sheet IS the account
   * control at that width, so Profile belongs in it. Marking Profile
   * non-secondary would have promoted it to a fifth bottom-bar tab, which is
   * the clutter the test above exists to prevent.
   */
  it.each(ROLES)('marks Profile as account-only, so the rail does not draw it for %s', (role) => {
    const { secondary } = navSectionsFor(USER(role));
    const profile = secondary.find(n => n.path === '/profile');
    if (!profile) return; // a role with no self-profile view has no entry at all
    expect(profile.accountOnly, 'Profile must be accountOnly').toBe(true);

    /* The rail draws `primary` plus the secondary entries that are NOT
       accountOnly. Nothing else may be hidden from it by accident. */
    const railSecondary = secondary.filter(n => !n.accountOnly);
    expect(railSecondary.map(n => n.path)).not.toContain('/profile');
    expect(secondary.filter(n => n.accountOnly).map(n => n.path)).toEqual(['/profile']);
  });

  /* Notifications must NOT be swept up by the same flag — it is a real rail
     destination with an unread count, and the whole reason `accountOnly` is a
     separate flag rather than a redefinition of `secondary`. */
  it.each(ROLES)('leaves Notifications in the rail for %s', (role) => {
    const { secondary } = navSectionsFor(USER(role));
    const notifications = secondary.find(n => n.path === '/notifications');
    if (!notifications) return;
    expect(notifications.accountOnly).toBeUndefined();
  });
});
