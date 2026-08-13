import React from 'react';
import { describe, it, expect } from 'vitest';
import { ROUTES, withProps } from './index.jsx';
import { can } from '../authz.js';

describe('route table', () => {
  it('declares a path and element for every route', () => {
    expect(ROUTES.length).toBeGreaterThan(10);
    for (const r of ROUTES) {
      expect(typeof r.path, JSON.stringify(r)).toBe('string');
      expect(r.element).toBeTruthy();
    }
  });

  it('has no duplicate paths', () => {
    const paths = ROUTES.map(r => r.path);
    expect(new Set(paths).size).toBe(paths.length);
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
