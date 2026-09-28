import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Which group a document is filed under.
 *
 * ── The defect this was written for ──
 *
 * `groupDocuments` assigns each document to the first group whose predicate
 * matches and consumes it, with `reference` as a catch-all that matches
 * everything left. That shape is fine, and it has one failure mode: a document
 * whose `scope` no predicate names does not raise anything. It silently lands in
 * "Reference policies" — a group whose blurb reads "The detail behind the
 * agreements above."
 *
 * That is what happened to the Student Organizer Agreement. Its scope is
 * `student-organizer-onboarding`; the organizers group tested
 * `scope === 'organizer-onboarding'`; nothing else matched it. So a contract a
 * student has to affirmatively accept before being trusted with other students'
 * contact details was presented as background reading. Nobody could see it,
 * because a misfiled document renders perfectly.
 *
 * ── Why this asserts a property and not that one case ──
 *
 * Pinning "the Student Organizer Agreement is under For organizers" would have
 * caught this bug and nothing like it. The invariant that actually matters is
 * the one the catch-all cannot enforce for itself: **only `notice` documents
 * belong in Reference policies.** Every other scope is something somebody signs
 * or acknowledges, and a scope added next year without a group of its own breaks
 * this test rather than quietly appearing as reference material.
 *
 * The scope list in FIXTURE is every value `server/legalDocuments.js` actually
 * uses. It is duplicated here rather than imported because that registry reads
 * the policy files off disk at call time, and this is a jsdom suite.
 * `server/legalDocuments.scopeCoverage.test.js` is the other half: it fails if
 * the registry grows a scope this file does not know about.
 */

const FIXTURE = [
  { slug: 'terms-of-service', title: 'Terms of Service', version: '1.0', scope: 'signup', consentType: 'agree', summary: 'The agreement between you and WeVolunteer.', effectiveAt: '2026-08-06' },
  { slug: 'community-guidelines', title: 'Community Guidelines', version: '1.0', scope: 'signup', consentType: 'agree', summary: 'How people are expected to behave here.', effectiveAt: '2026-08-06' },
  { slug: 'privacy-policy', title: 'Privacy Policy', version: '1.0', scope: 'signup', consentType: 'acknowledge', summary: 'What we collect and why.', effectiveAt: '2026-08-06' },
  { slug: 'organizer-agreement', title: 'Organizer Agreement', version: '1.0', scope: 'organizer-onboarding', consentType: 'agree', summary: 'What an organizer undertakes.', effectiveAt: '2026-08-06' },
  { slug: 'student-organizer-agreement', title: 'Student Organizer Agreement', version: '1.0', scope: 'student-organizer-onboarding', consentType: 'agree', summary: 'What a student helping run a club takes on.', effectiveAt: '2026-08-13' },
  { slug: 'admin-responsibilities-policy', title: 'Admin Responsibilities Policy', version: '1.0', scope: 'admin-onboarding', consentType: 'agree', summary: 'What an administrator undertakes before looking at a student\'s record.', effectiveAt: '2026-08-06' },
  { slug: 'youth-safety-guidelines', title: 'Youth Safety Guidelines', version: '1.0', scope: 'notice', consentType: 'notice', summary: 'How to stay safe volunteering.', effectiveAt: '2026-08-06' },
  { slug: 'cookie-and-tracking-notice', title: 'Cookie and Tracking Notice', version: '1.0', scope: 'notice', consentType: 'notice', summary: 'The cookies this site sets.', effectiveAt: '2026-08-06' },
];

/** Every scope the fixture covers, for the coverage assertion below. */
const FIXTURE_SCOPES = ['signup', 'organizer-onboarding', 'student-organizer-onboarding', 'admin-onboarding', 'notice'];

const apiMock = vi.hoisted(() => ({ fetchLegalDocuments: vi.fn() }));
vi.mock('../../utils/api', () => ({ api: apiMock }));

let LegalCenter;

/** The group section a document's card is rendered inside, by its title. */
function groupTitleFor(docTitle) {
  const link = screen.getByText(docTitle).closest('section');
  return link ? within(link).getAllByRole('heading')[0].textContent : null;
}

const renderCenter = async () => {
  /* The endpoint answers `{ documents }`, not a bare array. */
  apiMock.fetchLegalDocuments.mockResolvedValue({ documents: FIXTURE });
  const view = render(
    <MemoryRouter>
      <LegalCenter />
    </MemoryRouter>
  );
  /* The list is fetched, so wait for a card rather than asserting on the
     loading state. */
  await screen.findByText('Terms of Service');
  return view;
};

beforeEach(async () => {
  vi.clearAllMocks();
  ({ default: LegalCenter } = await import('./LegalCenter.jsx'));
});

describe('Legal Center grouping', () => {
  /* The group was renamed on 2026-09-27, when the Admin Responsibilities Policy
     became an agreement and landed here too — "For organizers" was no longer
     true of everything under it. These assert the group is SHARED, which is the
     property that matters, rather than pinning its wording. */
  it('files the Student Organizer Agreement with the other agreements somebody signs', async () => {
    await renderCenter();
    expect(groupTitleFor('Student Organizer Agreement'))
      .toBe(groupTitleFor('Organizer Agreement'));
  });

  it('files the Admin Responsibilities Policy there too, not as reference material', async () => {
    await renderCenter();
    expect(groupTitleFor('Admin Responsibilities Policy'))
      .toBe(groupTitleFor('Organizer Agreement'));
  });

  it('puts only notices under Reference policies', async () => {
    await renderCenter();

    /* The invariant. Anything a person signs or acknowledges is presented as
       such; Reference policies is for documents that ask nothing of anybody. */
    for (const doc of FIXTURE) {
      const group = groupTitleFor(doc.title);
      if (group === 'Reference policies') {
        expect(
          doc.scope,
          `${doc.slug} (scope "${doc.scope}") was filed as reference material`
        ).toBe('notice');
      }
    }
  });

  it('keeps the signup documents together, Community Guidelines included', async () => {
    await renderCenter();

    /* Community Guidelines is incorporated into the Terms and accepted by the
       same checkbox, so it belongs with what everyone agreed to — not under
       safety, even though it is one of the two documents a student most needs.
       FEATURED_NOTICES used to name it and the first-match-wins order overrode
       that, which meant the list described an intent the code did not carry out. */
    expect(groupTitleFor('Terms of Service')).toBe('What everyone agrees to');
    expect(groupTitleFor('Community Guidelines')).toBe('What everyone agrees to');
    expect(groupTitleFor('Privacy Policy')).toBe('What everyone agrees to');
  });

  it('lifts the Youth Safety Guidelines out of the reference pile', async () => {
    await renderCenter();
    expect(groupTitleFor('Youth Safety Guidelines')).toBe('Staying safe');
  });

  it('covers every scope the fixture declares, so the invariant is not vacuous', async () => {
    await renderCenter();

    /* Guards the test itself: if the fixture stopped exercising a scope, the
       "only notices under Reference" assertion above could pass by never
       meeting a counterexample. */
    const seen = new Set(FIXTURE.map(d => d.scope));
    expect([...seen].sort()).toEqual([...FIXTURE_SCOPES].sort());
  });
});
