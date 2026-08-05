import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { TEST_CONSENT } from './testConsent.js';
import { validateDateOfBirth, ageOn, MINIMUM_AGE } from './accountValidation.js';

/**
 * The age gate.
 *
 * ── What it is actually protecting ──
 *
 * `grade` accepted '9'–'12', 'Adult' and 'N/A', nothing else about age was
 * collected, and ninth-graders are commonly 13 at enrollment. An under-13
 * account was not merely possible — nothing in the product could have noticed
 * one.
 *
 * As an independent platform there is no district between WeVolunteer and the
 * child, so COPPA lands directly. It also couples to a product decision: the
 * amended COPPA Rule forbids retaining a child's data indefinitely, and
 * certificates and volunteer hours are kept indefinitely by design. "No child
 * is here" is therefore the premise that makes that retention lawful, which is
 * why the gate refuses a MISSING birth date rather than defaulting.
 */

/* ── Pure units ──────────────────────────────────────────────────────────── */

describe('ageOn — calendar years, never divided days', () => {
  const at = (iso) => new Date(`${iso}T00:00:00Z`);

  it('is exact on the birthday itself', () => {
    expect(ageOn(at('2013-08-05'), at('2026-08-05'))).toBe(13);
  });

  it('is one less the day before', () => {
    expect(ageOn(at('2013-08-05'), at('2026-08-04'))).toBe(12);
  });

  it('handles a 29 February birth date without drifting', () => {
    // The case that breaks `(now - dob) / 365.25`: on a hard 13-year boundary
    // a leap-year child is admitted or refused depending on arithmetic noise.
    expect(ageOn(at('2012-02-29'), at('2025-02-28'))).toBe(12);
    expect(ageOn(at('2012-02-29'), at('2025-03-01'))).toBe(13);
  });

  it('handles a December-to-January boundary', () => {
    expect(ageOn(at('2012-12-31'), at('2025-12-30'))).toBe(12);
    expect(ageOn(at('2012-12-31'), at('2025-12-31'))).toBe(13);
  });
});

describe('validateDateOfBirth', () => {
  const now = new Date('2026-08-05T00:00:00Z');

  it('accepts someone comfortably over the minimum', () => {
    const r = validateDateOfBirth('2009-03-14', { now });
    expect(r.ok).toBe(true);
    expect(r.age).toBe(17);
  });

  it('accepts someone who turns 13 today', () => {
    const r = validateDateOfBirth('2013-08-05', { now });
    expect(r.ok, 'the gate must admit on the birthday, not the day after').toBe(true);
  });

  it('refuses someone who turns 13 tomorrow', () => {
    const r = validateDateOfBirth('2013-08-06', { now });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('under_minimum_age');
  });

  it('refuses a missing date rather than assuming an adult', () => {
    for (const bad of ['', '   ', null, undefined]) {
      const r = validateDateOfBirth(bad, { now });
      expect(r.ok, `${JSON.stringify(bad)} must not pass`).toBe(false);
    }
  });

  it('refuses malformed input without guessing at intent', () => {
    for (const bad of ['05/08/2013', '2013-8-5', 'yesterday', '2013', '2013-13-01T00:00']) {
      expect(validateDateOfBirth(bad, { now }).ok, `${bad} must not pass`).toBe(false);
    }
  });

  it('refuses a future date', () => {
    expect(validateDateOfBirth('2030-01-01', { now }).ok).toBe(false);
  });

  it('refuses an implausible year, which is nearly always a typo', () => {
    expect(validateDateOfBirth('1890-01-01', { now }).ok).toBe(false);
  });

  it('NEVER echoes the computed age back in a refusal', () => {
    // A message like "you must be 13, you are 12" teaches the child exactly
    // which year to retype, which turns the gate into a formality.
    const r = validateDateOfBirth('2016-01-01', { now });
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(/\b12\b|\byou are\b/i);
    expect(r.error).toContain(String(MINIMUM_AGE));
  });
});

/* ── Integration: the gate at signup ─────────────────────────────────────── */

describe('signup enforces the age gate server-side', () => {
  let srv;
  let db;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
  });
  afterAll(async () => { await srv.close(); });

  let n = 0;
  const account = (extra = {}) => {
    n += 1;
    return {
      ...TEST_CONSENT,
      name: `Age Tester ${n}`,
      email: `age.tester.${n}@example.com`,
      username: `agetester${n}`,
      password: 'Str0ng!Passphrase9',
      grade: '11',
      role: 'student',
      dateOfBirth: '2009-05-20',
      ...extra,
    };
  };

  const yearsAgo = (years) => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - years);
    return d.toISOString().slice(0, 10);
  };

  it('creates an account for an eligible applicant and stores the date', async () => {
    const payload = account();
    const res = await srv.call('POST', '/api/auth/signup', payload);
    expect(res.status).toBe(201);

    const row = db.prepare('SELECT date_of_birth FROM users WHERE email = ?').get(payload.email);
    expect(row.date_of_birth).toBe('2009-05-20');
  });

  it('REFUSES an under-13 applicant', async () => {
    const payload = account({ dateOfBirth: yearsAgo(11) });
    const res = await srv.call('POST', '/api/auth/signup', payload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('under_minimum_age');
    expect(
      db.prepare('SELECT id FROM users WHERE email = ?').get(payload.email),
      'a refused applicant must leave no account behind'
    ).toBeFalsy();
  });

  it('refuses a signup with no date of birth at all', async () => {
    const payload = account({ dateOfBirth: undefined });
    const res = await srv.call('POST', '/api/auth/signup', payload);

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('dateOfBirth');
    expect(db.prepare('SELECT id FROM users WHERE email = ?').get(payload.email)).toBeFalsy();
  });

  it('cannot be bypassed by claiming an Adult grade', async () => {
    // `grade: 'Adult'` and `'N/A'` were the values that made an under-13
    // account invisible. The birth date, not the grade, is the gate.
    for (const grade of ['Adult', 'N/A']) {
      const payload = account({ grade, dateOfBirth: yearsAgo(10) });
      const res = await srv.call('POST', '/api/auth/signup', payload);
      expect(res.status, `grade ${grade} must not bypass the age gate`).toBe(400);
      expect(res.body.code).toBe('under_minimum_age');
    }
  });

  it('applies to the OAuth signup path too', async () => {
    // A provider vouches for an address, never for an age.
    const jwt = (await import('jsonwebtoken')).default;
    const { JWT_SECRET } = await import('./config.js');

    const email = `age.oauth.${Date.now()}@example.com`;
    const signupToken = jwt.sign(
      {
        action: 'signup', provider: 'google',
        providerUserId: `google-age-${Date.now()}`,
        providerEmail: email, providerEmailVerified: true,
      },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const res = await srv.call('POST', '/api/auth/signup', {
      ...account({ email, dateOfBirth: yearsAgo(9) }),
      signupToken,
      password: undefined,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('under_minimum_age');
    expect(db.prepare('SELECT id FROM users WHERE email = ?').get(email)).toBeFalsy();
  });

  it('does not leak the applicant\'s age back to the client', async () => {
    const res = await srv.call('POST', '/api/auth/signup', account({ dateOfBirth: yearsAgo(8) }));
    expect(JSON.stringify(res.body)).not.toMatch(/\b8\b/);
  });
});
