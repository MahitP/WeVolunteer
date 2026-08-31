import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGAL_DOCUMENTS } from './legalDocuments.js';

/**
 * Every registered `scope` has somewhere to be displayed.
 *
 * ── Why this test is in the server suite and reads a client file ──
 *
 * `src/views/legal/LegalCenter.jsx` sorts the catalogue into four groups by
 * first match, with "Reference policies" as the catch-all. The registry here is
 * the only source of `scope`. Nothing connected the two, so adding a document
 * with a new scope was a silent presentation change: it rendered, in the wrong
 * group, and every existing test passed.
 *
 * That is not hypothetical. `student-organizer-onboarding` was added to this
 * registry, the organizers group tested `scope === 'organizer-onboarding'`, and
 * the Student Organizer Agreement — a contract a student has to accept before
 * being trusted with other students' contact details — was filed as background
 * reading until it was found by reading the grouping code.
 *
 * The grouping behaviour itself is tested where it happens, in
 * `src/views/legal/LegalCenter.grouping.test.jsx`, against a fixture. This is
 * the other half, and it is the half that catches the real-world case: the
 * fixture cannot know about a scope somebody adds here tomorrow. Same split, and
 * the same reason, as `src/uploadsProxy.test.js` reading `vite.config.js` as
 * text rather than trusting a copy of it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGAL_CENTER = path.join(ROOT, 'src', 'views', 'legal', 'LegalCenter.jsx');

/**
 * The scopes that have a home, and where.
 *
 * `-onboarding` is not enumerated because the grouping matches the suffix, so a
 * fourth role's agreement is handled the moment it is registered. That is the
 * property the second assertion below pins.
 */
const PLACED = {
  signup: 'What everyone agrees to',
  notice: 'Reference policies, or Staying safe when FEATURED_NOTICES names it',
};

describe('legal document scope coverage', () => {
  it('places every scope in the registry', () => {
    const unplaced = [...new Set(LEGAL_DOCUMENTS.map(d => d.scope))]
      .filter(scope => !(scope in PLACED) && !String(scope).endsWith('-onboarding'));

    expect(
      unplaced,
      'These scopes reach no named group in LegalCenter.jsx and would be shown as '
      + '"Reference policies" — the group whose blurb reads "The detail behind the '
      + 'agreements above." If the new scope is something a person signs, give it a '
      + 'group. If it is genuinely reference material, add it to PLACED here with '
      + 'the group it lands in.'
    ).toEqual([]);
  });

  it('still groups onboarding agreements by suffix rather than by one role name', () => {
    /* The claim above — that a new `*-onboarding` scope needs no work — is only
       true while the predicate matches the suffix. If someone narrows it back to
       an equality check against a single role, the first assertion starts
       passing vacuously for exactly the scope it was written to protect. */
    const source = readFileSync(LEGAL_CENTER, 'utf8');
    expect(source).toMatch(/\.endsWith\(\s*['"]-onboarding['"]\s*\)/);
  });

  it('has at least one onboarding document, so the suffix rule is exercised', () => {
    const onboarding = LEGAL_DOCUMENTS.filter(d => String(d.scope).endsWith('-onboarding'));
    expect(onboarding.length).toBeGreaterThan(0);
  });
});
