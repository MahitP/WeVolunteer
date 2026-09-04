import { describe, it, expect } from 'vitest';
import {
  MATERIAL_NOTICE_DAYS, LegalValidationError, materialNoticeFloor, parseNoticeOverride,
} from './legalStore.js';
import { LEGAL_DOCUMENTS } from './legalDocuments.js';

/**
 * The thirty days the Terms promise before a material change takes effect.
 *
 * ── Why this is enforced rather than documented ──
 *
 * §13 of the published Terms: a change that leaves a reader worse off "gets a
 * new major version and we ask you to accept it again", and "we will tell you
 * in the app at least **30 days** before it takes effect". Until this rule
 * existed the editor would happily publish a MAJOR revision dated today, and
 * three things would then happen at once, none of them reversible:
 * `signupConsentWithholdingsFor` would start withholding the participation
 * capabilities from every existing account, the email would go out saying the
 * change was already in effect, and `legal_document_revisions` is append-only
 * so there would be no un-publish.
 *
 * A rule whose only enforcement is an admin remembering it is a rule the
 * product will break on the one afternoon somebody is in a hurry.
 *
 * The pure half is tested here; `routes.legalEditor.test.js` and
 * `legalEditor.adversarial.test.js` cover the endpoint.
 */

const SIGNUP = LEGAL_DOCUMENTS.find(d => d.scope === 'signup');
const NOTICE_ONLY = LEGAL_DOCUMENTS.find(d => d.scope === 'notice');
const ORGANIZER = LEGAL_DOCUMENTS.find(d => d.scope === 'organizer-onboarding');

const NOW = new Date('2026-09-04T12:00:00Z');
/** 2026-09-04 plus thirty days. */
const EARLIEST = '2026-10-04';

describe('when the notice period applies', () => {
  it('to a MAJOR bump on a document collected at signup', () => {
    const floor = materialNoticeFloor(SIGNUP, '2.0.0', null, NOW);
    expect(floor).toMatchObject({
      earliest: EARLIEST, days: MATERIAL_NOTICE_DAYS, fromMajor: 1, toMajor: 2,
    });
  });

  it('not to a MINOR or PATCH bump — §13 says those get notice only', () => {
    expect(materialNoticeFloor(SIGNUP, '1.1.0', null, NOW)).toBeNull();
    expect(materialNoticeFloor(SIGNUP, '1.0.1', null, NOW)).toBeNull();
  });

  /**
   * A `notice`-scope document collects no acceptance in any version, so a MAJOR
   * bump asks nobody for anything and withholds nothing. Holding it to a
   * thirty-day floor would delay an honest correction to, say, the
   * Accessibility Statement for no protective purpose.
   */
  it('not to a document nobody ever accepts', () => {
    expect(materialNoticeFloor(NOTICE_ONLY, '2.0.0', null, NOW)).toBeNull();
  });

  /**
   * The Organizer Agreement is re-gated on ANY version change by a mechanism
   * that predates this one, with its own screen and its own seven checkboxes.
   * §13's thirty-day sentence is about the documents every account agrees to;
   * applying it here would be borrowing a rule from one consent flow to govern
   * another.
   */
  it('not to the onboarding agreements, which have their own gate', () => {
    expect(materialNoticeFloor(ORGANIZER, '2.0.0', null, NOW)).toBeNull();
  });

  /**
   * Measured against the version a reader is actually being served, which is
   * the newest revision when there is one. Comparing against the registry
   * constant would call a second 2.x revision material all over again and
   * demand another thirty days for a change nobody's acceptance is behind on.
   */
  it('against the version in effect, not the version the registry shipped', () => {
    const previous = { version: '2.0.0' };
    expect(materialNoticeFloor(SIGNUP, '2.1.0', previous, NOW)).toBeNull();
    expect(materialNoticeFloor(SIGNUP, '3.0.0', previous, NOW)).toMatchObject({
      fromMajor: 2, toMajor: 3, fromVersion: '2.0.0',
    });
  });

  it('never to a version that goes backwards or stays put', () => {
    expect(materialNoticeFloor(SIGNUP, '1.0.0', null, NOW)).toBeNull();
    expect(materialNoticeFloor(SIGNUP, '0.9.0', null, NOW)).toBeNull();
  });

  it('is exactly the number the Terms print', () => {
    /* If this ever needs changing, §13 has to change with it — the sentence
       names the number, so the code and the contract move together or the
       product is publishing something untrue. */
    expect(MATERIAL_NOTICE_DAYS).toBe(30);
  });
});

describe('the override, when something genuinely obliges an earlier date', () => {
  const GOOD = 'Our analytics subprocessor was terminated today after a breach '
    + 'disclosure, and the policy names them as a recipient.';

  it('accepts a written reason', () => {
    expect(parseNoticeOverride(GOOD)).toBe(GOOD);
    expect(parseNoticeOverride({ reason: GOOD })).toBe(GOOD);
  });

  it('is absent by default, so the floor applies unless somebody asks', () => {
    expect(parseNoticeOverride(undefined)).toBeNull();
    expect(parseNoticeOverride(null)).toBeNull();
    expect(parseNoticeOverride(false)).toBeNull();
  });

  /**
   * A reason field with no length requirement is a rubber stamp. The audit row
   * has to read as an explanation rather than as a keypress, because it is the
   * only record that a promise made to every reader was set aside.
   */
  it('refuses a reason that says nothing', () => {
    for (const bad of ['', '   ', 'asdf', 'urgent', 'because', true, {}]) {
      expect(() => parseNoticeOverride(bad), JSON.stringify(bad))
        .toThrow(LegalValidationError);
    }
  });

  it('refuses a reason nobody will read', () => {
    expect(() => parseNoticeOverride('x'.repeat(501))).toThrow(/under 500 characters/);
  });

  it('points at the MINOR version when the change is not really material', () => {
    /* The most likely mistake by far: a correction that leaves nobody worse off
       given a MAJOR number by accident. The refusal should teach that rather
       than just blocking. */
    let message = '';
    try { parseNoticeOverride('short'); } catch (err) { message = err.message; }
    expect(message).toMatch(/MINOR version/);
    expect(message).toMatch(/audit trail/);
  });

  it('names the field, so the editor can focus it', () => {
    let field = null;
    try { parseNoticeOverride('short'); } catch (err) { field = err.field; }
    expect(field).toBe('noticePeriodOverride');
  });
});
