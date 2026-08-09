/**
 * The Moderation Center — an index of administrative areas.
 *
 * ── What is actually worth asserting here ──
 *
 * Not that seven tiles render. That is a restatement of the array. The two
 * properties that can break in a way nobody notices are:
 *
 *   1. **A tile leads somewhere that exists.** A hub whose buttons 404 is worse
 *      than no hub: a dead tile reads as a permission problem, so the reader
 *      concludes their account is broken rather than that a link is. The
 *      `to` values are checked against the real route tables, so deleting or
 *      renaming a route fails here rather than in somebody's face.
 *   2. **The list matches what the reader can open.** The tiles are filtered by
 *      `can()`, which is presentation — every destination re-checks server-side.
 *      But a tile offered to somebody who will be refused is a promise the
 *      product cannot keep, and an administrator seeing the platform owner's
 *      tools is exactly the confusion this page exists to remove.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import ModerationCenter from './ModerationCenter';
import { APP_ROUTES } from '../routes/index.jsx';
import { can } from '../authz';

const USER = (role) => ({
  id: `${role}-1`, name: 'Test Person', email: 't@e.org', role,
  verified: true, emailVerified: true,
});

const renderFor = (role) => render(
  <MemoryRouter><ModerationCenter currentUser={USER(role)} /></MemoryRouter>
);

const tiles = () => within(screen.getByRole('list', { name: /administrative areas/i }))
  .queryAllByRole('link');

/**
 * Renders for one role, reads the tiles, and unmounts before returning.
 *
 * Every case that compares two roles used to render both into the same document
 * and then read `getAllByRole(...).at(-1)` to guess which tree it was looking
 * at. That is a test whose correctness depends on render order, which is
 * exactly the kind that starts passing for the wrong reason. Unmounting makes
 * each read unambiguous.
 */
function tilesFor(role) {
  const { unmount } = renderFor(role);
  const read = tiles().map(a => ({
    text: a.textContent, path: a.getAttribute('href').split('#')[0] || '/',
  }));
  unmount();
  return read;
}

describe('the Moderation Center', () => {
  it('offers an ordinary administrator only what an administrator holds', () => {
    renderFor('admin');
    const names = tiles().map(a => a.textContent);

    expect(names.some(n => n.includes('Reports'))).toBe(true);
    expect(names.some(n => n.includes('Appeals'))).toBe(true);
    expect(names.some(n => n.includes('Organizer requests'))).toBe(true);

    /* Every one of these is SUPER_ONLY. `can()` refuses them before it consults
       per-user grants, so an administrator cannot reach them by any route — and
       offering the tile would be the product advertising a refusal. */
    expect(names.some(n => n.includes('Administrators'))).toBe(false);
    expect(names.some(n => n.includes('Audit trail'))).toBe(false);
    expect(names.some(n => n.includes('Errors'))).toBe(false);
    expect(names.some(n => n.includes('Platform Impact'))).toBe(false);
  });

  it('offers the platform owner a strict superset of the administrator\'s tiles', () => {
    const adminPaths = tilesFor('admin').map(t => t.path);
    const owner = tilesFor('super_admin');
    const ownerPaths = owner.map(t => t.path);

    /* A SUPERSET, not merely a longer list. The owner losing a tile the
       administrator still has would be a capability table that had stopped
       being a hierarchy, and counting alone would not catch it. */
    for (const path of adminPaths) {
      expect(ownerPaths, `owner lost ${path}`).toContain(path);
    }
    expect(ownerPaths.length).toBeGreaterThan(adminPaths.length);

    for (const name of ['Administrators', 'Audit trail', 'Errors', 'Platform Impact']) {
      expect(owner.some(t => t.text.includes(name)), `owner should be offered ${name}`).toBe(true);
    }
  });

  it('offers a volunteer nothing at all', () => {
    renderFor('student');
    /* The list still renders, empty. That is deliberate rather than a missing
       empty state: a student cannot reach this route — `report.resolve` gates
       it in APP_ROUTES and `deniedRoute` refuses before the shell is built — so
       this state is unreachable in the product and exists only to prove the
       filter is not inverted. */
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  /**
   * The tile targets, checked against the real route tables.
   *
   * A fragment (`/#reports`) is a section of the dashboard rather than a route
   * of its own, so it is checked as "`/` is served" — `/` is declared in
   * App.jsx rather than APP_ROUTES, which is why it is allowed for explicitly
   * instead of being looked up.
   */
  it('points every tile at a route that exists', () => {
    render(<MemoryRouter><ModerationCenter currentUser={USER('super_admin')} /></MemoryRouter>);
    const declared = new Set(APP_ROUTES.map(r => r.path));

    for (const link of tiles()) {
      const to = link.getAttribute('href');
      const [path] = to.split('#');
      const target = path === '' ? '/' : path;
      if (target === '/') continue;
      expect(declared.has(target), `${to} is not a declared route`).toBe(true);
    }
  });

  /**
   * Every tile's capability must be one the route it points at actually
   * requires — otherwise the hub and the router disagree about who may open
   * something, and the reader is offered a tile that refuses them on arrival.
   */
  it('gates each tile on the capability its destination requires', () => {
    const byPath = new Map(APP_ROUTES.map(r => [r.path, r]));
    const adminPaths = new Set(tilesFor('admin').map(t => t.path));

    for (const { path } of tilesFor('super_admin')) {
      const route = byPath.get(path);
      if (!route) continue;
      expect(route.requiredCap, `${path} has no requiredCap`).toBeTruthy();
      /* An administrator is offered the tile iff they can open the route.
         Decided through `can()` rather than by naming roles, so the capability
         table stays the single source of truth and this cannot drift from it. */
      expect(adminPaths.has(path), `tile/route disagree for ${path}`)
        .toBe(can(USER('admin'), route.requiredCap));
    }
  });

  it('makes each tile a single link rather than a nest of them', () => {
    render(<MemoryRouter><ModerationCenter currentUser={USER('super_admin')} /></MemoryRouter>);
    /* One tab stop and one announcement per destination. An icon link beside a
       title link is two of each for the same place. */
    for (const link of tiles()) {
      expect(within(link).queryAllByRole('link')).toHaveLength(0);
      expect(link.textContent.trim().length).toBeGreaterThan(0);
    }
  });
});
