import { describe, it, expect } from 'vitest';
import { can } from './authz.js';

describe('client can()', () => {
  it('mirrors server decisions for a student', () => {
    const user = { id: 'u1', role: 'student' };
    expect(can(user, 'event.apply')).toBe(true);
    expect(can(user, 'organizer.approve')).toBe(false);
  });

  it('grants everything to super_admin', () => {
    expect(can({ id: 'u1', role: 'super_admin' }, 'error.read')).toBe(true);
  });

  it('denies when there is no user', () => {
    expect(can(null, 'event.view')).toBe(false);
  });

  it('denies an unknown capability', () => {
    expect(can({ id: 'u1', role: 'admin' }, 'made.up')).toBe(false);
  });
});
