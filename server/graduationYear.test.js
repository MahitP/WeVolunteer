/**
 * Graduation year — "Class of ____".
 *
 * ── What this is protecting ──
 *
 * Registration collected `grade` and nothing else about where somebody is in
 * school, and nothing in this application advances a grade: no scheduled job, no
 * login hook. So every stored grade is wrong from the following August onward,
 * and a tenth grader who registered in 2026 is still recorded as a tenth grader
 * after they graduate. That is the worst shape a data error can take — a stale
 * answer that looks perfectly valid to every caller that asks.
 *
 * The fix is not to add a second grade-shaped field. Grade level and graduation
 * year are one fact expressed two ways, so storing both as editable columns
 * guarantees they eventually disagree. `users.graduation_year` is the source of
 * truth because it never decays, and `users.grade` is derived from it.
 *
 * ── The half of this file that matters most ──
 *
 * The integration cases at the bottom, and specifically the ones that send a
 * hand-written payload. A client that can nominate its own grade next to its own
 * class year can register a ninth grader as a senior, and every functional test
 * still passes: the account is created, the profile renders, nothing errors. Only
 * a test that asserts on the STORED grade after submitting a contradiction
 * catches it.
 *
 * `accountValidation.js` imports only bcryptjs and `config.js`, neither of which
 * reaches `db.js`, so it is safe as a static top-level import here — see
 * testConsent.js's header for why that distinction matters.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { TEST_CONSENT } from './testConsent.js';
import {
  HIGH_SCHOOL_GRADES,
  schoolYearEndYear,
  graduationYearRange,
  graduationYearForGrade,
  gradeForGraduationYear,
  validateGraduationYear,
  validateAccountFields,
} from './accountValidation.js';

const at = (iso) => new Date(`${iso}T00:00:00Z`);

/* ── Pure units ──────────────────────────────────────────────────────────── */

describe('schoolYearEndYear — a class is named for the year it graduates', () => {
  it('is next calendar year once the new school year has started', () => {
    // August 2026: the seniors are the Class of 2027, not 2026.
    expect(schoolYearEndYear(at('2026-08-05'))).toBe(2027);
  });

  it('is this calendar year during the spring term', () => {
    expect(schoolYearEndYear(at('2027-02-14'))).toBe(2027);
  });

  it('turns over between June and July, not between December and January', () => {
    // A calendar-year boundary would make every senior a junior again on
    // 1 January, halfway through their last year.
    expect(schoolYearEndYear(at('2026-06-30'))).toBe(2026);
    expect(schoolYearEndYear(at('2026-07-01'))).toBe(2027);
    expect(schoolYearEndYear(at('2026-12-31'))).toBe(2027);
    expect(schoolYearEndYear(at('2027-01-01'))).toBe(2027);
  });
});

describe('graduationYearRange — derived from the clock, never written down', () => {
  it('spans the current seniors through this year\'s freshmen', () => {
    expect(graduationYearRange(at('2026-08-05'))).toEqual({ min: 2027, max: 2030 });
  });

  it('still computes a correct range five years from now', () => {
    // The failure a literal range would produce: 2027–2030 hardcoded is right
    // for one school year, and in 2031 it accepts only years that have already
    // graduated while refusing every real applicant.
    expect(graduationYearRange(at('2031-09-01'))).toEqual({ min: 2032, max: 2035 });
  });

  it('is exactly as wide as the number of high school grades', () => {
    const { min, max } = graduationYearRange(at('2026-08-05'));
    expect(max - min + 1).toBe(HIGH_SCHOOL_GRADES.length);
  });
});

describe('grade and class year are each other\'s inverse', () => {
  const now = at('2026-08-05');

  it('maps every grade to a class year and back again', () => {
    for (const grade of HIGH_SCHOOL_GRADES) {
      const year = graduationYearForGrade(grade, now);
      expect(year, `grade ${grade} produced no class year`).toEqual(expect.any(Number));
      expect(gradeForGraduationYear(year, now), `class of ${year} did not map back to grade ${grade}`)
        .toBe(grade);
    }
  });

  it('puts the seniors in the year the current school year ends', () => {
    expect(graduationYearForGrade('12', now)).toBe(2027);
    expect(graduationYearForGrade('9', now)).toBe(2030);
  });

  it('has no class year for a grade that is not high school', () => {
    // 'Adult' is an organizer; 'N/A' is the seeded administrator. Neither
    // graduates, and neither may carry a placeholder year.
    expect(graduationYearForGrade('Adult', now)).toBeNull();
    expect(graduationYearForGrade('N/A', now)).toBeNull();
  });

  it('refuses a year that has already graduated, or is not yet in high school', () => {
    const { min, max } = graduationYearRange(now);
    expect(gradeForGraduationYear(min - 1, now), 'already graduated').toBeNull();
    expect(gradeForGraduationYear(max + 1, now), 'not in high school yet').toBeNull();
  });

  it('refuses a non-integer year rather than rounding one', () => {
    for (const bad of [2027.5, NaN, '2027', null, undefined]) {
      expect(gradeForGraduationYear(bad, now), `${String(bad)} must not map to a grade`).toBeNull();
    }
  });
});

describe('validateGraduationYear', () => {
  const now = at('2026-08-05');

  it('accepts a year in range and reports the grade it implies', () => {
    const r = validateGraduationYear(2029, { grade: '10', now });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(2029);
    expect(r.grade).toBe('10');
  });

  it('accepts the numeric string a <select> actually submits', () => {
    const r = validateGraduationYear('2029', { grade: '10', now });
    expect(r.ok).toBe(true);
    expect(r.value, 'stored as a number, because the column is INTEGER').toBe(2029);
  });

  it('derives the year from the grade when none is supplied', () => {
    // The one-time conversion at account creation: at that instant "the grade I
    // am in" is true by construction, so the class year it implies is exact.
    const r = validateGraduationYear(undefined, { grade: '11', now });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(2028);
    expect(gradeForGraduationYear(r.value, now)).toBe('11');
  });

  it('treats an empty string as absent rather than as a bad year', () => {
    const r = validateGraduationYear('', { grade: '9', now });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(2030);
  });

  it('refuses a year that has already graduated, and names the range', () => {
    const { min, max } = graduationYearRange(now);
    const r = validateGraduationYear(min - 1, { grade: '12', now });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('graduationYear');
    expect(r.error).toContain(String(min));
    expect(r.error).toContain(String(max));
  });

  it('refuses a year too far ahead to be in high school', () => {
    const { max } = graduationYearRange(now);
    expect(validateGraduationYear(max + 1, { grade: '9', now }).ok).toBe(false);
  });

  it('refuses anything that is not a four-digit year', () => {
    // `Number('')` is 0 and `Number(true)` is 1, so a value has to look like a
    // year before it is compared to one.
    for (const bad of ['twenty thirty', '2029abc', '29', '20299', 0, -2029, 2029.5, true, {}, [], '  ']) {
      expect(
        validateGraduationYear(bad, { grade: '10', now }).ok,
        `${JSON.stringify(bad)} must not pass`
      ).toBe(false);
    }
  });

  it('gives an adult a null year — never zero, never the current year', () => {
    for (const grade of ['Adult', 'N/A']) {
      const r = validateGraduationYear(undefined, { grade, now });
      expect(r.ok).toBe(true);
      expect(r.value, `grade ${grade} must carry no class year`).toBeNull();
    }
  });

  it('refuses a graduation year attached to an adult account', () => {
    // Ignoring it would store NULL and answer 201, so "this row has a class
    // year" would stop meaning "this person is in school".
    const r = validateGraduationYear(2029, { grade: 'Adult', now });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('graduationYear');
  });
});

describe('validateAccountFields — the class year decides the grade', () => {
  const base = {
    name: 'Class Tester', username: 'classtester', email: 'class@example.com',
    role: 'student', dateOfBirth: '2009-05-20',
  };

  it('overrides a grade the client claimed but the class year contradicts', () => {
    const { max } = graduationYearRange();
    const r = validateAccountFields({ ...base, grade: '12', graduationYear: max });
    expect(r.ok).toBe(true);
    expect(r.value.graduationYear).toBe(max);
    expect(
      r.value.grade,
      'the claimed grade must lose — otherwise the two columns can be stored in contradiction'
    ).toBe('9');
  });

  it('backfills the class year for a payload that names only a grade', () => {
    const r = validateAccountFields({ ...base, grade: '10' });
    expect(r.ok).toBe(true);
    expect(r.value.grade).toBe('10');
    expect(r.value.graduationYear).toBe(graduationYearForGrade('10'));
  });

  it('leaves an organizer with no class year at all', () => {
    const r = validateAccountFields({ ...base, role: 'organizer', grade: 'Adult' });
    expect(r.ok).toBe(true);
    expect(r.value.grade).toBe('Adult');
    expect(r.value.graduationYear).toBeNull();
  });
});

/* ── Integration: the class year at signup ───────────────────────────────── */

describe('signup enforces the class year server-side', () => {
  let srv;
  let db;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
  }, 60000);
  afterAll(async () => { await srv?.close(); });

  let n = 0;
  const account = (extra = {}) => {
    n += 1;
    return {
      ...TEST_CONSENT,
      name: `Class Tester ${n}`,
      email: `class.tester.${n}@example.com`,
      username: `classtester${n}`,
      password: 'Str0ng!Passphrase9',
      grade: '11',
      role: 'student',
      dateOfBirth: '2009-05-20',
      ...extra,
    };
  };

  const row = async (email) =>
    await db.prepare('SELECT grade, graduation_year FROM users WHERE email = ?').get(email);

  it('stores the class year and the grade derived from it', async () => {
    const { min } = graduationYearRange();
    const payload = account({ grade: '9', graduationYear: min });

    const res = await srv.call('POST', '/api/auth/signup', payload);
    expect(res.status).toBe(201);

    expect(await row(payload.email)).toEqual({ grade: '12', graduation_year: min });
  });

  it('accepts the numeric string a form submits, and stores a number', async () => {
    const year = graduationYearForGrade('10');
    const payload = account({ grade: '10', graduationYear: String(year) });

    expect((await srv.call('POST', '/api/auth/signup', payload)).status).toBe(201);
    expect(await row(payload.email)).toEqual({ grade: '10', graduation_year: year });
  });

  /**
   * The case that only a stored-value assertion can catch. A hand-written
   * request claiming grade 12 alongside a freshman class year creates a
   * perfectly working account either way; the question is which of the two the
   * database ends up believing.
   */
  it('cannot be talked into a higher grade than the class year allows', async () => {
    const { max } = graduationYearRange();
    const payload = account({ grade: '12', graduationYear: max });

    expect((await srv.call('POST', '/api/auth/signup', payload)).status).toBe(201);
    expect(
      await row(payload.email),
      'the client claimed 12th grade with a freshman class year and the server believed it'
    ).toEqual({ grade: '9', graduation_year: max });
  });

  it('REFUSES a class year that has already graduated, leaving no account behind', async () => {
    const { min } = graduationYearRange();
    const payload = account({ graduationYear: min - 1 });

    const res = await srv.call('POST', '/api/auth/signup', payload);

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('graduationYear');
    expect(await row(payload.email), 'a refused applicant must leave no account behind').toBeFalsy();
  });

  it('REFUSES a class year too far ahead to be in high school', async () => {
    const { max } = graduationYearRange();
    const payload = account({ graduationYear: max + 5 });

    const res = await srv.call('POST', '/api/auth/signup', payload);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('graduationYear');
    expect(await row(payload.email)).toBeFalsy();
  });

  /**
   * Three shapes, not seven: `authLimiter` allows ten FAILED auth requests per
   * window and this suite is deliberately made of failures, so the exhaustive
   * list of malformed values is asserted against the pure validator above and
   * only one representative of each shape — unparseable text, a non-integer
   * number, a wrong type — is sent over the wire.
   */
  it('REFUSES a graduation year that is not a year, sent directly', async () => {
    for (const bad of ['senior', 2029.5, true]) {
      const payload = account({ graduationYear: bad });
      const res = await srv.call('POST', '/api/auth/signup', payload);
      expect(res.status, `${JSON.stringify(bad)} must be refused`).toBe(400);
      expect(res.body.field).toBe('graduationYear');
      expect(await row(payload.email)).toBeFalsy();
    }
  });

  it('REFUSES a graduation year on an adult account', async () => {
    const payload = account({ role: 'organizer', grade: 'Adult', graduationYear: graduationYearForGrade('11') });

    const res = await srv.call('POST', '/api/auth/signup', payload);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('graduationYear');
    expect(await row(payload.email)).toBeFalsy();
  });

  it('stores no class year for an organizer, rather than a placeholder', async () => {
    const payload = account({ role: 'organizer', grade: 'Adult' });

    expect((await srv.call('POST', '/api/auth/signup', payload)).status).toBe(201);
    expect(await row(payload.email)).toEqual({ grade: 'Adult', graduation_year: null });
  });

  /**
   * Backward compatibility, and the reason an absent year is derived rather than
   * refused: every caller that predates this field sends a grade and no class
   * year. Leaving `graduation_year` NULL for those would recreate the original
   * defect — a stored grade with nothing to recompute it from.
   */
  it('derives and stores a class year for a payload that sends only a grade', async () => {
    const payload = account({ grade: '10', graduationYear: undefined });

    expect((await srv.call('POST', '/api/auth/signup', payload)).status).toBe(201);
    expect(await row(payload.email)).toEqual({ grade: '10', graduation_year: graduationYearForGrade('10') });
  });

  it('applies to the OAuth signup path too — a provider vouches for an address, not a grade', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { JWT_SECRET } = await import('./config.js');
    const { min } = graduationYearRange();

    const email = `class.oauth.${Date.now()}@example.com`;
    const signupToken = jwt.sign(
      {
        action: 'signup', provider: 'google',
        providerUserId: `google-class-${Date.now()}`,
        providerEmail: email, providerEmailVerified: true,
      },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const res = await srv.call('POST', '/api/auth/signup', {
      ...account({ email, graduationYear: min - 1 }),
      signupToken,
      password: undefined,
    });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('graduationYear');
    expect(await row(email)).toBeFalsy();
  });
});
