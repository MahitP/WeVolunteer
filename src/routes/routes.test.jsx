import { describe, it, expect } from 'vitest';
import { ROUTES } from './index.jsx';
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
