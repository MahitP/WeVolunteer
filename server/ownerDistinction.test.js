import { describe, it, expect } from 'vitest';
import { distinctionFor } from './profileSerializer.js';

/**
 * The owner's distinction is shown to every member who opens an owner's
 * profile, so it is a published statement about who runs the platform.
 *
 * It said "Runs WeVolunteer for the district." Under Posture B (decided
 * 2026-09-28) WeVolunteer is operated independently — no district has signed
 * anything — so that sentence claimed an arrangement that does not exist, and
 * every published claim binds the operator personally.
 */
describe('the platform owner distinction', () => {
  it('does not say the platform is run for a district', () => {
    const d = distinctionFor('super_admin');
    for (const text of [d.blurb, d.description]) {
      expect(text).not.toMatch(/district/i);
    }
  });
});
