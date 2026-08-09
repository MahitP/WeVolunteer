import { describe, it, expect } from 'vitest';
import { navItemsFor, navSectionsFor } from './App';

/**
 * The rail's sections.
 *
 * ── Why the rail is grouped ──
 *
 * Flat, it reached eleven entries for the platform owner, ordered by when each
 * was added rather than by what it is for. Eleven undifferentiated rows is a list
 * read once and thereafter scanned by muscle memory — which is exactly when a
 * rarely-opened but consequential page, the audit trail, stops being noticed.
 *
 * ── What these tests are actually defending ──
 *
 * Not the labels. The two properties that would break silently:
 *
 *   1. **Sections and the flat list cannot disagree.** `navSectionsFor` is
 *      derived from `navItemsFor`, so every capability decision happens once. If
 *      somebody re-filters NAV a second time to build the sections, an entry can
 *      become visible on the desktop rail and invisible in the mobile "More"
 *      sheet, or the reverse — a page an administrator can reach on a phone and
 *      cannot find on a laptop. The partition test below is what catches that.
 *
 *   2. **The consolidation did not delete anything.** Six administrative pages
 *      left the rail for the Moderation Center. Deleting them would satisfy
 *      "absent from the rail" just as well, so absence is never asserted on its
 *      own here — every moved page is also checked to be offered by the hub, and
 *      openable by the owner, at the capability it always had.
 *
 * ── Why the rail was cut rather than grouped harder ──
 *
 * Grouping got eleven entries down to something readable, and that was the right
 * first move. It could not fix the underlying thing: the rail is the same list on
 * every page, so seven administrative rows sat permanently in front of an
 * audience that is mostly students. The pages are also related to each other in
 * ways a flat rail cannot show — an appeal is about a suspension that came out of
 * a report — and a hub page can say that.
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
      const { primary, groups, trailing } = navSectionsFor(user);

      const sectioned = [...primary, ...groups.flatMap(g => g.items), ...trailing];

      expect(sectioned.map(n => n.id).sort()).toEqual(flat.map(n => n.id).sort());
      /* And no entry appears twice, which `sort()` above would not catch on its own. */
      expect(new Set(sectioned.map(n => n.id)).size).toBe(sectioned.length);
    });

  /* ── Who sees which group ───────────────────────────────────────────────── */

  it('gives a student no groups at all', () => {
    const { groups } = navSectionsFor(USER('student'));
    expect(groups).toEqual([]);
  });

  it('gives an organizer no groups at all', () => {
    expect(navSectionsFor(USER('organizer')).groups).toEqual([]);
  });

  /**
   * The Moderation Center is the whole of Administration, for both roles.
   *
   * The group keeps its heading over a single entry deliberately — an
   * administrator and an owner have to be able to say "Administration →
   * Moderation Center" to each other and both be looking at the same thing, and
   * the heading is what marks that entry as a different kind of thing from
   * Messages and Calendar.
   */
  it('gives an administrator Administration, holding only the hub', () => {
    const { groups } = navSectionsFor(USER('admin'));
    expect(groups.map(g => g.label)).toEqual(['Administration']);
    expect(labelsOf(groups[0].items)).toEqual(['Moderation Center']);
  });

  it('gives the owner the same one group, not a longer rail', () => {
    const { groups } = navSectionsFor(USER('super_admin'));
    expect(groups.map(g => g.label)).toEqual(['Administration']);
    expect(labelsOf(groups[0].items)).toEqual(['Moderation Center']);
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
   * `My profile` is ungrouped but must not render in the ungrouped block at the
   * top, where it would sit above "Administration" and read as the most
   * important thing on the rail.
   */
  it('keeps My profile trailing rather than primary', () => {
    const { primary, trailing } = navSectionsFor(USER('student'));
    expect(labelsOf(trailing)).toEqual(['My profile']);
    expect(labelsOf(primary)).not.toContain('My profile');
  });

  /**
   * The mobile bottom bar takes `navItemsFor(...).slice(0, 4)`, so the first four
   * of the FLAT list have to be the everyday entries — not an administrative page
   * that happened to sort early. Pinned for the owner, who has the most entries
   * and is therefore the one this would go wrong for.
   */
  it('keeps the owner\'s first four flat entries everyday ones', () => {
    expect(navItemsFor(USER('super_admin')).slice(0, 4).map(n => n.label))
      .toEqual(['Dashboard', 'Opportunities', 'Calendar', 'Messages']);
  });

  /**
   * An empty group is dropped rather than rendered headless.
   *
   * A heading with nothing under it advertises a feature the reader does not
   * have, on every page, forever.
   */
  it('never returns a group with no entries', () => {
    for (const role of ['student', 'organizer', 'admin', 'super_admin', 'partner']) {
      for (const g of navSectionsFor(USER(role)).groups) {
        expect(g.items.length, `${role} got an empty ${g.label} group`).toBeGreaterThan(0);
      }
    }
  });
});
