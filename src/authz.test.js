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

  /**
   * `withheld` arrives on the /api/auth/me payload and is what stops the nav
   * offering an organizer the three entries they would be 403'd from while the
   * Organizer Agreement is unaccepted. See server/organizerAgreement.js.
   */
  describe('withheld capabilities', () => {
    const unaccepted = {
      id: 'u1',
      role: 'organizer',
      withheld: ['event.create', 'applicant.review', 'message.send'],
    };

    it('refuses a capability the role holds but the payload withholds', () => {
      expect(can({ id: 'u1', role: 'organizer' }, 'event.create')).toBe(true);
      expect(can(unaccepted, 'event.create')).toBe(false);
      expect(can(unaccepted, 'applicant.review')).toBe(false);
      expect(can(unaccepted, 'message.send')).toBe(false);
    });

    it('leaves the escape-hatch capabilities alone', () => {
      // The organizer still has to be able to sign in, reach their settings and
      // get to the agreement — the whole point of withholding a subset.
      expect(can(unaccepted, 'event.view')).toBe(true);
      expect(can(unaccepted, 'self.read')).toBe(true);
    });

    it('treats a payload with no withheld field as withholding nothing', () => {
      // Degrades to the ungated answer rather than hiding controls the server
      // would allow. A UX mirror must fail toward offering, never toward a
      // blank interface.
      expect(can({ id: 'u1', role: 'organizer' }, 'applicant.review')).toBe(true);
    });

    it('applies before the super_admin wildcard', () => {
      // Nothing withholds from a super_admin today. The ordering is asserted
      // anyway, because "it happens not to matter yet" is not a property worth
      // depending on — the same argument authz.js makes for the check's position.
      expect(can({ id: 'u1', role: 'super_admin', withheld: ['error.read'] }, 'error.read')).toBe(false);
    });
  });
});
