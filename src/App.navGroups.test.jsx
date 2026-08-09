import { describe, it, expect } from 'vitest';
import { navItemsFor, navSectionsFor } from './App';

/**
 * The rail's two priority tiers.
 *
 * ── What replaced grouping ──
 *
 * The rail used to sort itself into named groups, and by the end one group held
 * one entry: `Administration`, containing the administrative hub, with a hair rule
 * marking it off from Messages and Calendar.
 *
 * The mobile bar meanwhile took `navItemsFor(...).slice(0, 4)`, so for an
 * administrator the hub — their reason for being there — sat behind the `⋯` menu.
 * A count of how many entries precede yours is not a statement about priority, so
 * priority is declared instead: everything is primary unless it carries
 * `secondary`, and exactly Notifications and My profile carry it.
 *
 * ── What these tests are actually defending ──
 *
 * Not the labels. The properties that would break silently:
 *
 *   1. **The two tiers partition the flat list.** `navSectionsFor` is derived
 *      from `navItemsFor`, so every capability decision happens once. If somebody
 *      re-filters NAV a second time, an entry can become visible on the desktop
 *      rail and invisible in the mobile sheet, or the reverse — a page an
 *      administrator can reach on a phone and cannot find on a laptop. Worse, the
 *      mobile bar now draws `primary` and the sheet draws `secondary`, so an
 *      overlap renders twice and a gap is unreachable.
 *
 *   2. **Admin is primary, and stays primary.** That is the regression this file
 *      is named for on the mobile side: it is asserted for the roles that have it,
 *      and asserted absent from the overflow.
 *
 *   3. **The consolidation did not delete anything.** Six administrative pages
 *      left the rail for the hub. Deleting them would satisfy "absent from the
 *      rail" just as well, so absence is never asserted on its own here — every
 *      moved page is also checked to be offered by the hub, and openable by the
 *      owner, at the capability it always had.
 */

const USER = (role, extra = {}) => ({
  id: `user-${role}`, role, verified: true, withheld: [], ...extra,
});

const labelsOf = (section) => section.map(n => n.label);

describe('navSectionsFor', () => {
  /* ── The partition property ─────────────────────────────────────────────── */

  /**
   * Every entry lands in exactly one section, and no entry is invented or lost.
   *
   * This is the test that makes the other assertions worth trusting: a grouping
   * that silently dropped an entry would still produce plausible-looking
   * sections, and no label assertion below would notice.
   */
  it.each(['student', 'organizer', 'admin', 'super_admin', 'partner'])(
    'partitions %s\'s entries exactly, losing and inventing none', (role) => {
      const user = USER(role);
      const flat = navItemsFor(user);
      const { primary, secondary } = navSectionsFor(user);

      const sectioned = [...primary, ...secondary];

      expect(sectioned.map(n => n.id).sort()).toEqual(flat.map(n => n.id).sort());
      /* And no entry appears twice, which `sort()` above would not catch on its
         own. The mobile bar draws `primary` and the sheet draws `secondary`, so a
         duplicate is a destination rendered in two places at once. */
      expect(new Set(sectioned.map(n => n.id)).size).toBe(sectioned.length);
    });

  /* ── Which tier each entry is in ─────────────────────────────────────────── */

  /**
   * The three entries that are deliberately NOT primary, and the reason each one
   * can afford not to be: Notifications has the header bell (which also carries
   * the unread count), the profile is in the rail's own ProfileMenu and in the
   * mobile sheet's header, and Find people is a destination you go to rather
   * than one you pass through on the way to finishing something.
   *
   * Find people (v1.3) was placed here rather than in the primary row on that
   * last argument: the primary row is the five destinations a task moves
   * between, and displacing one of them for the directory would have cost more
   * than it bought. Order matters — it sits ABOVE Notifications because the
   * secondary tier is read top-down and the directory is the one entry with no
   * second way in.
   */
  it.each(['student', 'organizer', 'super_admin'])(
    'gives %s exactly Find people, Notifications and My profile as secondary', (role) => {
      const { secondary } = navSectionsFor(USER(role));
      expect(labelsOf(secondary)).toEqual(['Find people', 'Notifications', 'My profile']);
    });

  /* An ordinary administrator has no self-profile VIEW — `SELF_PROFILE` resolves
     `event.moderate` to 'denied', because no profile page has ever existed for
     that role — so the entry is filtered out by capability rather than by tier.
     Unchanged by this redesign, and asserted so that a future profile page for
     admins lands here rather than silently in the primary row. */
  it('gives an administrator Find people and Notifications as secondary', () => {
    expect(labelsOf(navSectionsFor(USER('admin')).secondary)).toEqual(['Find people', 'Notifications']);
  });

  /**
   * The regression this file is named for.
   *
   * `Admin` is the fifth entry, and while the mobile bar was `slice(0, 4)` that
   * put the administrative area of the product behind a menu on every phone. It
   * is primary for both roles that have it, on every surface.
   */
  it.each(['admin', 'super_admin'])('makes Admin primary for %s', (role) => {
    const { primary, secondary } = navSectionsFor(USER(role));
    expect(labelsOf(primary)).toContain('Admin');
    expect(labelsOf(secondary), 'Admin is in the overflow again').not.toContain('Admin');
  });

  it('gives the owner the five primary destinations in order', () => {
    expect(labelsOf(navSectionsFor(USER('super_admin')).primary))
      .toEqual(['Dashboard', 'Opportunities', 'Calendar', 'Messages', 'Admin']);
  });

  /**
   * And nobody without the capability sees it, which is the boundary the removed
   * "Administration" rule used to draw visually. Absence carries that on its own.
   */
  it.each(['student', 'organizer', 'partner'])('offers %s no Admin entry at all', (role) => {
    const { primary, secondary } = navSectionsFor(USER(role));
    expect(labelsOf([...primary, ...secondary])).not.toContain('Admin');
  });

  /**
   * One name for one destination, across every surface.
   *
   * It was "Moderation Center" in the rail and in the page title — the longest
   * label in the list, wrapping in the tablet rail and in a 56px mobile button.
   * A per-breakpoint abbreviation would have been worse: two names for one place
   * means two people cannot describe it to each other.
   */
  it('calls the administrative hub "Admin" everywhere', async () => {
    const railLabel = navItemsFor(USER('admin')).find(n => n.id === 'moderation').label;
    expect(railLabel).toBe('Admin');

    const { PAGE_META } = await import('./App');
    for (const persona of Object.keys(PAGE_META)) {
      const meta = PAGE_META[persona].moderation;
      if (meta) expect(meta.title, `${persona} calls it something else`).toBe('Admin');
    }
  });

  /* ── The consolidation, asserted from both ends ──────────────────────────── */

  /**
   * ── The six pages that left the rail ──
   *
   * They were REMOVED FROM THE NAVIGATION, not removed. This is the half of that
   * sentence a test can get wrong in the expensive direction: deleting the pages
   * would also make this assertion pass, and nobody would notice until an owner
   * went looking for the audit trail.
   *
   * So it is asserted against ModerationCenter's own table, which is what the
   * hub renders — the pages have to be absent from the rail AND offered by the
   * hub, and the second half is what makes the first half safe.
   */
  const MOVED = [
    { label: 'Community impact', to: '/impact' },
    { label: 'Appeals', to: '/admin/appeals' },
    { label: 'Admin Roster', to: '/admin/roster' },
    { label: 'Audit Explorer', to: '/admin/audit-logs' },
    { label: 'Errors', to: '/errors' },
    { label: 'Platform Impact', to: '/admin/impact' },
  ];

  it.each(MOVED)('keeps $label off the rail entirely', ({ label }) => {
    for (const role of ['student', 'organizer', 'admin', 'super_admin', 'partner']) {
      expect(labelsOf(navItemsFor(USER(role))), `${role} still has a ${label} rail entry`)
        .not.toContain(label);
    }
  });

  it.each(MOVED)('still offers $label from the Moderation Center', async ({ to }) => {
    const { AREAS } = await import('./views/ModerationCenter.jsx');
    expect(AREAS.map(a => a.to), `nothing on the hub leads to ${to}`).toContain(to);
  });

  /**
   * And the owner can actually open every one of them.
   *
   * The tile table is filtered by `can(user, area.cap)`, so a tile whose
   * capability nobody holds is as unreachable as a deleted page while looking
   * present in the source. This reads the capabilities the hub declares and
   * checks the owner against the real kernel.
   */
  it('leaves every moved page reachable by the owner', async () => {
    const { AREAS } = await import('./views/ModerationCenter.jsx');
    const { can } = await import('./authz');
    const owner = USER('super_admin');

    for (const { to } of MOVED) {
      const area = AREAS.find(a => a.to === to);
      expect(can(owner, area.cap), `the owner cannot open ${to} (${area.cap})`).toBe(true);
    }
  });

  /**
   * The SUPER_ONLY pages stayed SUPER_ONLY.
   *
   * Moving a page off the rail and onto a hub must not change who can open it.
   * `admin.create`, `audit.read` and `error.read` are in `SUPER_ONLY`, which
   * `can()` consults BEFORE per-user grants — so no grant reaches them. Read
   * from the table rather than by naming roles, so the test follows the kernel
   * instead of pinning today's answer.
   */
  it('did not widen the pages that were owner-only on the rail', async () => {
    const { SUPER_ONLY, can } = await import('./authz');
    const { AREAS } = await import('./views/ModerationCenter.jsx');
    const admin = USER('admin');

    for (const to of ['/admin/roster', '/admin/audit-logs', '/errors', '/admin/impact']) {
      const area = AREAS.find(a => a.to === to);
      expect(SUPER_ONLY, `${to} is no longer behind a SUPER_ONLY capability`).toContain(area.cap);
      expect(can(admin, area.cap), `an administrator can now open ${to}`).toBe(false);
    }
  });

  /* ── Placement ──────────────────────────────────────────────────────────── */

  /**
   * `My profile` renders last in the rail.
   *
   * It used to carry a `trailing` flag for this, because it was ungrouped and
   * would otherwise have sat ABOVE "Administration" and read as the most
   * important thing on the page. With the group gone, `secondary` does the same
   * job: secondary entries render after primary ones, and the profile is the last
   * of them because it is last in the NAV table.
   */
  it('renders My profile last', () => {
    const { primary, secondary } = navSectionsFor(USER('student'));
    expect(labelsOf(secondary).at(-1)).toBe('My profile');
    expect(labelsOf(primary)).not.toContain('My profile');
  });

  /**
   * The mobile bar draws every primary entry, so the primary tier is what has to
   * stay everyday-plus-Admin rather than acquiring an administrative sub-page
   * that happened to sort early. Pinned for the owner, who has the most entries.
   */
  it("keeps the owner's primary tier to the five destinations", () => {
    expect(navSectionsFor(USER('super_admin')).primary).toHaveLength(5);
  });
});
