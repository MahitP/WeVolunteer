import React from 'react';
import { describe, it, expect } from 'vitest';
import { ROUTES, APP_ROUTES, SIGNED_OUT_ROUTES, PUBLIC_ROUTES, withProps } from './index.jsx';
import { can } from '../authz.js';

describe('route table', () => {
  it('declares a path and element for every route', () => {
    expect(ROUTES.length).toBeGreaterThan(10);
    for (const r of ROUTES) {
      expect(typeof r.path, JSON.stringify(r)).toBe('string');
      expect(r.element).toBeTruthy();
    }
  });

  /**
   * No duplicates WITHIN a table.
   *
   * It used to be across the concatenation, which was the same assertion while
   * every path lived in exactly one table. `/organizations/:key` is now in two:
   * `APP_ROUTES` serves it to a member as their club's page, `PUBLIC_ROUTES`
   * serves it to a stranger as the club's public address, and App.jsx picks
   * between them on the session — see `shellWhenSignedIn` and Guard 4 in
   * `routeGating.guard.test.js`, which is what stops that split from becoming
   * decorative.
   *
   * Per-table is the assertion that still catches the real mistake: two entries
   * in ONE table with the same path, where the second is dead code the router
   * will never reach.
   */
  it('has no duplicate paths within a table', () => {
    for (const [name, table] of [
      ['APP_ROUTES', APP_ROUTES],
      ['SIGNED_OUT_ROUTES', SIGNED_OUT_ROUTES],
      ['PUBLIC_ROUTES', PUBLIC_ROUTES],
    ]) {
      const paths = table.map(r => r.path);
      const duplicated = paths.filter((path, i) => paths.indexOf(path) !== i);
      expect(duplicated, `${name} declares the same path twice`).toEqual([]);
    }
  });

  /**
   * And a path in two tables is only ever the deliberate session split.
   *
   * Any other cross-table duplicate is a route that renders one thing for a
   * signed-out reader and a different thing for a member with no flag saying
   * so, which is exactly the confusion the flag exists to make visible.
   */
  it('shares a path across tables only where the split is declared', () => {
    const publicPaths = new Set(PUBLIC_ROUTES.map(r => r.path));
    const undeclared = APP_ROUTES
      .filter(r => publicPaths.has(r.path))
      .filter(r => !PUBLIC_ROUTES.find(p => p.path === r.path)?.shellWhenSignedIn)
      .map(r => r.path);

    expect(
      undeclared,
      'these paths are in both APP_ROUTES and PUBLIC_ROUTES without shellWhenSignedIn, '
      + 'so the public one wins for every reader including members',
    ).toEqual([]);
  });

  /* Both forms of the gate, so a route declared with `requiredCapAny` is not
     quietly exempt from the typo check by not matching the filter. */
  const capsOf = (r) => [r.requiredCap, ...(r.requiredCapAny || [])].filter(Boolean);

  it('names only real capabilities', () => {
    for (const r of ROUTES) {
      for (const cap of capsOf(r)) {
        // can() denies unknown capabilities, so a super_admin being denied proves a typo.
        expect(can({ id: 'x', role: 'super_admin' }, cap), `bad cap ${cap} on ${r.path}`).toBe(true);
      }
    }
  });

  it('lets a super_admin reach every gated route', () => {
    for (const r of ROUTES.filter(r => capsOf(r).length)) {
      expect(capsOf(r).some(c => can({ id: 'x', role: 'super_admin' }, c)), r.path).toBe(true);
    }
  });

  it('gates organizer-only routes against students', () => {
    const create = ROUTES.find(r => r.path === '/events/new');
    const caps = capsOf(create);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.some(c => can({ id: 'x', role: 'student' }, c))).toBe(false);
    expect(caps.some(c => can({ id: 'x', role: 'organizer' }, c))).toBe(true);
  });

  it('opens /events/new to a Student Organizer, and to nobody else who is a student', () => {
    /**
     * The rank is a per-person GRANT, not a role capability — so this is the
     * one place the client's `can()` has to read `grants` for the page to be
     * reachable at all. A student with no grant is refused by the same table.
     */
    const create = ROUTES.find(r => r.path === '/events/new');
    const caps = capsOf(create);
    const helper = { id: 'x', role: 'student', grants: ['organization.event.create'] };
    expect(caps.some(c => can(helper, c))).toBe(true);
    expect(caps.some(c => can({ id: 'x', role: 'student', grants: [] }, c))).toBe(false);
  });

  it('opens /checkin to a Student Organizer, exactly as the server does', () => {
    /**
     * This route table used to be stricter than both the affordance and the
     * API. `EventModal` shows Check-in on
     * `attendance.mark || organization.event.manage.own`, and
     * `attendanceRoutes.js` gates the endpoints with `requireCapAny` over the
     * same pair — while this entry required `attendance.mark` alone.
     *
     * A Student Organizer holds `organization.event.manage.own` and not
     * `attendance.mark`, so running their own club's event meant pressing a
     * button they had been shown and receiving a full-screen 403 for a request
     * the server would have allowed.
     */
    const checkin = ROUTES.find(r => r.path === '/checkin/:eventId');
    const caps = capsOf(checkin);
    const helper = { id: 'x', role: 'student', grants: ['organization.event.manage.own'] };

    expect(caps.some(c => can(helper, c)), 'a Student Organizer is refused check-in').toBe(true);
    /* Still gated: a student with no grant has no business here. */
    expect(caps.some(c => can({ id: 'x', role: 'student', grants: [] }, c))).toBe(false);
    /* And the role the page was originally written for is unaffected. */
    expect(caps.some(c => can({ id: 'x', role: 'organizer' }, c))).toBe(true);
  });
});

describe('withProps', () => {
  const route = { path: '/thing', element: <div /> };

  it('clones the element with the props declared for its path', () => {
    const cloned = withProps(route, { '/thing': { currentUser: 'u', addToast: 'f' } });
    expect(cloned.props).toEqual({ currentUser: 'u', addToast: 'f' });
  });

  it('accepts a deliberately empty declaration', () => {
    // `{}` is how a route says "this view needs no shell props" — it must pass,
    // which is why the check below is own-property and not truthiness.
    expect(() => withProps(route, { '/thing': {} })).not.toThrow();
    expect(withProps(route, { '/thing': {} }).props).toEqual({});
  });

  it('throws for a path with no entry, instead of cloning with no props', () => {
    // The silent failure this replaces: cloneElement(el, undefined) is legal and
    // produces an element with every prop missing, so the view renders wrong
    // rather than failing. The message must name the path and the fix, because
    // whoever hits it just added a route and does not yet know this map exists.
    expect(() => withProps(route, { '/other': {} })).toThrow(/No props declared for route '\/thing'/);
    expect(() => withProps(route, { '/other': {} })).toThrow(/use \{\} if the view genuinely takes no shell props/);
  });

  it('throws for an inherited key rather than treating it as declared', () => {
    // A prototype-chain hit ('constructor', 'toString') is not a declaration.
    expect(() => withProps({ path: 'toString', element: <div /> }, {})).toThrow(/No props declared/);
  });
});
