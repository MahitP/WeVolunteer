/**
 * The signup form's grade ⇄ class-year conversion.
 *
 * ── Why this test exists now and did not before ──
 *
 * The grade control used to be a `<select>` whose option VALUES were the class
 * years — the student picked "Class of 2029" directly, so the client did no
 * arithmetic and could not produce a wrong year. `Signup.jsx`'s header said as
 * much: drift against the server was "a cosmetic bug and never an eligibility
 * one".
 *
 * The picker now asks "What grade are you in?" and converts, because a
 * fourteen-year-old knows their grade and should not have to work out their
 * graduation year to sign up. That moves the arithmetic into the client, and it
 * invalidates the old reasoning: the server refuses a year outside the eligible
 * range, but a wrong year INSIDE the range is a perfectly valid year for a
 * DIFFERENT grade. A bug here would therefore register a ninth grader as a
 * senior and reach whatever a school scopes to seniors — which is exactly the
 * outcome `accountValidation.js` describes itself as existing to prevent.
 *
 * So the conversion is pinned in both directions, and pinned against the clock
 * rather than against a literal year: a test written as `expect(…).toBe('2028')`
 * passes for one school year and then fails every August for the rest of time.
 *
 * The server's half of this pair is covered by `server/graduationYear.test.js`,
 * which asserts the same inverse property against the authoritative
 * implementation. These two files are deliberately separate — the client cannot
 * import `accountValidation.js` (it pulls in bcryptjs and the server config),
 * which is the whole reason the logic is duplicated and the reason the
 * duplication needs its own guard.
 */
import { describe, it, expect } from 'vitest';
import {
  HS_GRADES, schoolYearEndYear, gradeForClassYear, classYearForGrade,
} from './Signup.jsx';

describe('schoolYearEndYear — a class is named for the year it graduates', () => {
  it('is the next calendar year once the new school year has started', () => {
    // August 2026 is in the school year that ends in June 2027.
    expect(schoolYearEndYear(new Date('2026-08-06T00:00:00Z'))).toBe(2027);
  });

  it('is this calendar year during the spring term', () => {
    expect(schoolYearEndYear(new Date('2027-03-01T00:00:00Z'))).toBe(2027);
  });

  it('turns over between June and July, not between December and January', () => {
    expect(schoolYearEndYear(new Date('2027-06-30T00:00:00Z'))).toBe(2027);
    expect(schoolYearEndYear(new Date('2027-07-01T00:00:00Z'))).toBe(2028);
  });
});

describe('grade and class year are each other\'s inverse', () => {
  it('maps every grade the picker offers to a year and back again', () => {
    // The property, not a table of literals: whatever the clock says, a grade
    // that goes in must be the grade that comes out.
    for (const grade of HS_GRADES) {
      const year = classYearForGrade(grade);
      expect(year, `grade ${grade} produced no class year`).toMatch(/^\d{4}$/);
      expect(gradeForClassYear(year), `grade ${grade} did not round-trip`).toBe(grade);
    }
  });

  it('puts the seniors in the year the current school year ends', () => {
    // A twelfth grader graduates at the end of the year in progress. Getting
    // this off by one is the bug that registers every student a year early.
    expect(classYearForGrade('12')).toBe(String(schoolYearEndYear()));
  });

  it('puts the freshmen three years further out, and nothing in between', () => {
    const senior = Number(classYearForGrade('12'));
    expect(Number(classYearForGrade('11'))).toBe(senior + 1);
    expect(Number(classYearForGrade('10'))).toBe(senior + 2);
    expect(Number(classYearForGrade('9'))).toBe(senior + 3);
  });

  it('produces four distinct years, so two grades can never share one', () => {
    const years = HS_GRADES.map(classYearForGrade);
    expect(new Set(years).size).toBe(HS_GRADES.length);
  });
});

describe('the answers that are not a grade', () => {
  /**
   * "Not in high school" must send NO year rather than a placeholder one.
   *
   * `validateGraduationYear` refuses a year attached to a non-student grade
   * outright, so a placeholder here would not be quietly ignored — it would fail
   * the signup for every adult volunteer.
   */
  it('gives an adult no class year at all', () => {
    expect(classYearForGrade('')).toBe('');
    expect(classYearForGrade('Adult')).toBe('');
    expect(classYearForGrade('N/A')).toBe('');
  });

  it('gives no class year for a grade below or above high school', () => {
    expect(classYearForGrade('8')).toBe('');
    expect(classYearForGrade('13')).toBe('');
  });

  it('reads an empty or absent year as "not in high school"', () => {
    // This is what drives the picker's checked state: no year means the
    // "Not in high school" chip is the selected one.
    expect(gradeForClassYear('')).toBe('');
    expect(gradeForClassYear(undefined)).toBe('');
  });

  it('reads a year outside the eligible range as no grade', () => {
    const senior = schoolYearEndYear();
    expect(gradeForClassYear(String(senior - 1))).toBe('');   // already graduated
    expect(gradeForClassYear(String(senior + 4))).toBe('');   // not yet in high school
  });
});
