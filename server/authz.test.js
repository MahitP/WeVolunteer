import { describe, it, expect, vi } from 'vitest';
import { can, principalFor, requireCapAny, CAPABILITIES, ROLES, ALL_CAPABILITIES, SUPER_ONLY } from './authz.js';

const p = (role, extra = {}) => principalFor({ id: 'u1', role, ...extra });

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

describe('can()', () => {
  it('grants a capability the role holds', () => {
    expect(can(p('organizer'), 'attendance.mark')).toBe(true);
  });

  it('denies a capability the role lacks', () => {
    expect(can(p('student'), 'attendance.mark')).toBe(false);
    expect(can(p('organizer'), 'organizer.approve')).toBe(false);
  });

  it('grants everything to super_admin, including super-only capabilities', () => {
    expect(can(p('super_admin'), 'organizer.approve')).toBe(true);
    expect(can(p('super_admin'), 'error.read')).toBe(true);
    expect(can(p('super_admin'), 'impersonation.start')).toBe(true);
  });

  it('denies super-only capabilities to admin', () => {
    expect(can(p('admin'), 'error.read')).toBe(false);
    expect(can(p('admin'), 'impersonation.start')).toBe(false);
  });

  it('denies unknown capabilities to everyone, super_admin included', () => {
    expect(can(p('super_admin'), 'not.a.real.capability')).toBe(false);
    expect(can(p('admin'), 'error.raed')).toBe(false);      // typo must not silently pass
  });

  it('denies when the principal is missing or roleless', () => {
    expect(can(null, 'event.view')).toBe(false);
    expect(can({ userId: 'u1' }, 'event.view')).toBe(false);
    expect(can(p('nonsense_role'), 'event.view')).toBe(false);
  });

  it('honours a per-user grant for a capability the role lacks', () => {
    const withGrant = { ...p('organizer'), grants: ['service.verify.external'] };
    expect(can(withGrant, 'service.verify.external')).toBe(true);
    expect(can(p('organizer'), 'service.verify.external')).toBe(false);  // without the grant
  });

  it('never lets a grant confer a super-only capability', () => {
    const sneaky = { ...p('admin'), grants: ['impersonation.start'] };
    expect(can(sneaky, 'impersonation.start')).toBe(false);
  });

  it('uses effectiveRole, not actualRole, when impersonating', () => {
    const impersonating = {
      ...p('super_admin'), effectiveRole: 'student', impersonating: true, actorId: 'dev1'
    };
    expect(can(impersonating, 'organizer.approve')).toBe(false);
    expect(can(impersonating, 'event.apply')).toBe(true);
  });
});

describe('capability tables', () => {
  it('lists exactly the five roles', () => {
    expect(ROLES).toEqual(['student', 'organizer', 'admin', 'super_admin', 'partner']);
  });

  it('gives every role except super_admin an explicit array', () => {
    for (const role of ROLES) {
      if (role === 'super_admin') { expect(CAPABILITIES[role]).toEqual(['*']); continue; }
      expect(Array.isArray(CAPABILITIES[role])).toBe(true);
      expect(CAPABILITIES[role]).not.toContain('*');
    }
  });

  it('includes super-only capabilities in ALL_CAPABILITIES', () => {
    for (const cap of SUPER_ONLY) expect(ALL_CAPABILITIES).toContain(cap);
  });

  it('has no duplicate capability within a role', () => {
    for (const role of ROLES) {
      const caps = CAPABILITIES[role];
      expect(new Set(caps).size).toBe(caps.length);
    }
  });
});

describe('principalFor()', () => {
  it('defaults effectiveRole to actualRole and aal to 1', () => {
    const pr = principalFor({ id: 'u1', role: 'student' });
    expect(pr).toMatchObject({
      userId: 'u1', actualRole: 'student', effectiveRole: 'student',
      actorId: null, aal: 1, impersonating: false
    });
    expect(pr.grants).toEqual([]);
  });
});

describe('requireCapAny()', () => {
  it('returns a middleware function named capabilityGate', () => {
    const mw = requireCapAny(['event.moderate', 'event.edit.own']);
    expect(mw.name).toBe('capabilityGate');
  });

  it('passes when the principal holds one of the listed capabilities', () => {
    const mw = requireCapAny(['event.moderate', 'event.edit.own']);
    const req = { principal: p('organizer') }; // holds event.edit.own, not event.moderate
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes when the principal holds several of the listed capabilities', () => {
    const mw = requireCapAny(['event.edit.own', 'applicant.review']);
    const req = { principal: p('organizer') }; // holds both
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('403s when the principal holds none of the listed capabilities', () => {
    const mw = requireCapAny(['event.moderate', 'event.edit.own']);
    const req = { principal: p('student') };
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401s when there is no principal', () => {
    const mw = requireCapAny(['event.moderate', 'event.edit.own']);
    const req = {};
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access token required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes super_admin via the wildcard even though it holds neither listed capability by name', () => {
    const mw = requireCapAny(['event.moderate', 'event.edit.own']);
    const req = { principal: p('super_admin') };
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('throws at module load time (not per request) on an unknown capability', () => {
    expect(() => requireCapAny(['event.moderate', 'not.a.real.capability'])).toThrow();
  });

  it('throws on an empty array', () => {
    expect(() => requireCapAny([])).toThrow();
  });
});

describe('module hygiene', () => {
  it('does not import a database module', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('./authz.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+['"]\.\/db\.js['"]/);
  });
});
