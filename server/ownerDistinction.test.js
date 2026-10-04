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

/**
 * Two owners, two profiles (FX-09, FX-10).
 *
 * The owner asked that the two owner accounts "get different profile pages":
 * his own "look like a student's profile" — "keep that badge", because he is a
 * student who shows his hours to colleges — and the platform's account a
 * special owner profile. The distinction was a function of role alone, so both
 * read "the person responsible for how the platform works", which is untrue of
 * an account. Identity is the email the ownership allowlist names. Layout stays
 * history-driven (App.ownerProfile.test.jsx); this is the words.
 */
describe('the two owner accounts', () => {
  it('gives the founder the owner badge, described as the founder', () => {
    const d = distinctionFor('super_admin', 'mahitp.16@gmail.com');
    expect(d.label).toBe('Platform owner');
    expect(d.description).toMatch(/founder/i);
    expect(d.description).toMatch(/student volunteer/i);
  });

  it('describes the platform account as an account, not a person', () => {
    const d = distinctionFor('super_admin', 'wevolunteer.platform@gmail.com');
    expect(d.label).toBe('Platform owner');
    expect(d.description).toMatch(/official/i);
    expect(d.description).not.toMatch(/the person/i);
  });

  it('is the same for an address in any case', () => {
    expect(distinctionFor('super_admin', 'MahitP.16@Gmail.com').description).toMatch(/founder/i);
  });

  it('keeps the role default where the email is not known (search results)', () => {
    expect(distinctionFor('super_admin').label).toBe('Platform owner');
    expect(distinctionFor('student', 'mahitp.16@gmail.com')).toBeNull();
  });

  it('never says "district" on either', () => {
    for (const email of ['mahitp.16@gmail.com', 'wevolunteer.platform@gmail.com']) {
      const d = distinctionFor('super_admin', email);
      for (const text of [d.blurb, d.description]) expect(text).not.toMatch(/district/i);
    }
  });
});
