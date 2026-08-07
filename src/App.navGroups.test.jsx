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
 *   2. **The Platform group stays owner-only.** Its three entries are SUPER_ONLY
 *      capabilities. A group is a promise about who sees it, and a heading that
 *      appears for an administrator would be a false one.
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
   * An administrator gets Administration and NOT Platform.
   *
   * The single-entry Administration group keeps its heading deliberately — an
   * administrator and an owner have to be able to say "Administration → Appeals"
   * to each other and both be looking at the same thing. A rail that reshapes
   * itself by item count makes that conversation impossible.
   */
  it('gives an administrator Administration only', () => {
    const { groups } = navSectionsFor(USER('admin'));
    expect(groups.map(g => g.label)).toEqual(['Administration']);
    expect(labelsOf(groups[0].items)).toEqual(['Appeals']);
  });

  it('gives the owner both groups, Platform last', () => {
    const { groups } = navSectionsFor(USER('super_admin'));
    expect(groups.map(g => g.label)).toEqual(['Administration', 'Platform']);
    expect(labelsOf(groups[1].items)).toEqual(['Admin Roster', 'Audit Explorer', 'Errors']);
  });

  /**
   * The Platform group is SUPER_ONLY, asserted against the capability table
   * rather than by naming roles.
   *
   * `admin.create`, `audit.read` and `error.read` are all in `SUPER_ONLY`, which
   * `can()` consults BEFORE per-user grants — so no grant can put an
   * administrator in this section. Reading it from the table means the test
   * follows the kernel if the kernel changes, instead of pinning today's answer.
   */
  it('puts nothing in Platform that an administrator could ever hold', async () => {
    const { SUPER_ONLY } = await import('./authz');
    const { groups } = navSectionsFor(USER('super_admin'));
    const platform = groups.find(g => g.id === 'platform');

    for (const item of platform.items) {
      const caps = item.requiredCapAny ?? [item.requiredCap];
      expect(caps.every(c => SUPER_ONLY.includes(c)),
        `${item.label} is in Platform but ${caps.join('/')} is not SUPER_ONLY`).toBe(true);
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
      .toEqual(['Moderation Center', 'Opportunities', 'Calendar', 'Messages']);
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
