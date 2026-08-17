import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Whether somebody agreed to be measured.
 *
 * ── What this is guarding ──
 *
 * The column that decides whether Session Replay runs. It is the only privacy
 * setting in the schema that does NOT default to the behaviour already in
 * place — migration 052 says why — so the cases below are mostly about the
 * default and about what counts as a yes.
 *
 * ── Why the string cases are here ──
 *
 * Every other switch on this endpoint coerces: `leaderboardOptIn ? 1 : 0`.
 * That is right for a preference and wrong for a consent record. `'false'` is a
 * truthy string, so a coercing endpoint would store a YES for a client that
 * meant no — and a consent record that can be wrong in that direction is worse
 * than no record, because it is evidence of something that did not happen.
 */

let srv, db;
let student, studentId;

beforeAll(async () => {
  srv = await startTestServer();
  db = (await import('./db.js')).db;

  const { cookie, user } = await srv.signupConfirmed({
    name: 'Consent Person',
    email: 'consent.person@example.org',
    username: 'consentperson',
    password: 'Password123',
    role: 'student',
    grade: '11',
  });
  student = cookie;
  studentId = user.id;
});

afterAll(async () => { await srv?.close?.(); });

/** The column as actually stored, which is the thing that matters. */
const stored = async () =>
  (await db.prepare('SELECT analytics_consent FROM users WHERE id = ?').get(studentId)).analytics_consent;

describe('a brand new account', () => {
  it('has not been asked, which is not the same as having declined', async () => {
    /**
     * NULL rather than 0. The distinction is the whole reason this is not a
     * boolean column: "never asked" is a state a consent record has to be able
     * to represent, or it cannot tell agreement from silence.
     */
    expect(await stored()).toBeNull();
  });

  it('is reported to the client as null, not false', async () => {
    /* `/api/auth/me` spreads `selfUserResponse` at the top level rather than
       nesting it under `user`, unlike the PATCH below. */
    const res = await srv.call('GET', '/api/auth/me', undefined, student);
    expect(res.status).toBe(200);
    expect(res.body.analyticsConsent).toBeNull();
  });
});

describe('recording a decision', () => {
  it('stores a yes', async () => {
    const res = await srv.call('PATCH', '/api/auth/profile', { analyticsConsent: true }, student);
    expect(res.status).toBe(200);
    expect(res.body.user.analyticsConsent).toBe(true);
    expect(await stored()).toBe(1);
  });

  it('stores a no, and it is distinguishable from never having been asked', async () => {
    const res = await srv.call('PATCH', '/api/auth/profile', { analyticsConsent: false }, student);
    expect(res.status).toBe(200);
    expect(res.body.user.analyticsConsent).toBe(false);
    expect(await stored()).toBe(0);
    expect(await stored()).not.toBeNull();
  });

  it('is revocable, repeatedly', async () => {
    await srv.call('PATCH', '/api/auth/profile', { analyticsConsent: true }, student);
    expect(await stored()).toBe(1);
    await srv.call('PATCH', '/api/auth/profile', { analyticsConsent: false }, student);
    expect(await stored()).toBe(0);
  });
});

describe('what does not count as consent', () => {
  it.each([
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['the number 1', 1],
    ['the number 0', 0],
    ['null', null],
    ['an object', {}],
  ])('refuses %s with a 400 rather than coercing it', async (_label, value) => {
    await srv.call('PATCH', '/api/auth/profile', { analyticsConsent: false }, student);
    const before = await stored();

    const res = await srv.call('PATCH', '/api/auth/profile', { analyticsConsent: value }, student);

    expect(res.status, `${_label} was accepted`).toBe(400);
    expect(res.body.field).toBe('analyticsConsent');
    expect(await stored(), 'a refused request changed the stored consent anyway').toBe(before);
  });
});

describe('the answer is nobody else’s business', () => {
  it('never appears on another member’s view of the profile', async () => {
    /**
     * `profileSerializer.js` is an allowlist, so this passes by construction
     * today — which is exactly why it is worth pinning. The failure mode is
     * somebody adding the field to the public serializer while wiring up an
     * admin screen, and an allowlist gives no warning when a name is added
     * to it.
     */
    await srv.call('PATCH', '/api/auth/profile', { analyticsConsent: true }, student);

    const { cookie: other } = await srv.signupConfirmed({
      name: 'Other Person',
      email: 'other.consent.person@example.org',
      username: 'otherconsentperson',
      password: 'Password123',
      role: 'student',
      grade: '11',
    });

    const res = await srv.call('GET', `/api/users/${studentId}/public-profile`, undefined, other);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('analyticsConsent');
    expect(JSON.stringify(res.body)).not.toContain('analytics_consent');
  });
});

describe('an account that predates the column', () => {
  it('reads as not-asked rather than as consent', async () => {
    /**
     * The migration adds the column with no DEFAULT and does not backfill, so
     * every account that existed before it becomes NULL. Simulated by writing
     * NULL back, because that is precisely the state a real upgraded row is in.
     *
     * If this ever read as `true`, the deploy that added consent would have
     * silently granted it on behalf of every existing student.
     */
    await db.prepare('UPDATE users SET analytics_consent = NULL WHERE id = ?').run(studentId);
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(studentId);

    expect(row.analytics_consent).toBeNull();
    expect(row.analytics_consent === 1).toBe(false);
  });
});
