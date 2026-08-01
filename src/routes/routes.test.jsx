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

  it('names only real capabilities', () => {
    for (const r of ROUTES.filter(r => r.requiredCap)) {
      // can() denies unknown capabilities, so a super_admin being denied proves a typo.
      expect(can({ id: 'x', role: 'super_admin' }, r.requiredCap), `bad cap on ${r.path}`).toBe(true);
    }
  });

  it('lets a super_admin reach every gated route', () => {
    for (const r of ROUTES.filter(r => r.requiredCap)) {
      expect(can({ id: 'x', role: 'super_admin' }, r.requiredCap)).toBe(true);
    }
  });

  it('gates organizer-only routes against students', () => {
    const create = ROUTES.find(r => r.path === '/events/new');
    expect(create?.requiredCap).toBeTruthy();
    expect(can({ id: 'x', role: 'student' }, create.requiredCap)).toBe(false);
    expect(can({ id: 'x', role: 'organizer' }, create.requiredCap)).toBe(true);
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
