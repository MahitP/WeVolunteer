import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * What a new student's location, interests and skills look like to another
 * member, on every route that returns them.
 *
 * These three were on the always-visible baseline, so a student with a PRIVATE
 * profile still published a general location, a list of hobbies and a list of
 * skills to every student, organizer and administrator — while the published
 * documents said the profile was private until the student turned sharing on.
 * The owner moved them behind the profile setting (2026-10-04,
 * docs/legal/15-PROFILE-VISIBILITY-DEFAULTS.md).
 *
 * Driven through the API because each of these has a second route: the
 * volunteer profile, and the search summary that feeds every member list. The
 * recurring shape of this bug is the route nobody thought of as a profile.
 */

let srv;
let alice, bob, aliceId;

const LOCATION = 'Riverbend, NJ';
const HOBBY = 'Origami';
const SKILL = 'Sign language';

beforeAll(async () => {
  srv = await startTestServer();
  const make = async (n) => srv.signupConfirmed({
    name: `Baseline Person ${n}`,
    email: `baseline.person.${n}@example.org`,
    username: `baselineperson${n}`,
    password: 'Password123',
    role: 'student',
    grade: '10',
  });
  const a = await make(1); alice = a.cookie; aliceId = a.user.id;
  const b = await make(2); bob = b.cookie;

  const saved = await srv.call('PATCH', '/api/auth/profile',
    { location: LOCATION, hobbies: [HOBBY], skills: [SKILL] }, alice);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
});

afterAll(async () => { await srv.close(); });

const publicProfileOf = async (session) => {
  const res = await srv.call('GET', `/api/users/${aliceId}/public-profile`, undefined, session);
  expect(res.status).toBe(200);
  return res.body.profile ?? res.body;
};

const setProfileVisibility = (value) =>
  srv.call('PATCH', '/api/auth/profile', { profileVisibility: value }, alice);

describe('a new student, as another student sees them', () => {
  it('shows no location, interests or skills on the profile', async () => {
    const p = await publicProfileOf(bob);
    expect(p.visibility).toBe('private');
    for (const field of ['location', 'hobbies', 'skills']) expect(p).not.toHaveProperty(field);
  });

  it('shows no skills on the volunteer profile either', async () => {
    const res = await srv.call('GET', `/api/users/${aliceId}/profile`, undefined, bob);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SKILL);
  });

  it('carries no location in a search result', async () => {
    const res = await srv.call('GET', '/api/directory/search?q=@baselineperson1', undefined, bob);
    expect(res.status).toBe(200);
    const hit = res.body.users.find(u => u.id === aliceId);
    expect(hit, 'the student should still be findable by name').toBeTruthy();
    expect(hit).not.toHaveProperty('location');
    expect(JSON.stringify(res.body)).not.toContain(LOCATION);
  });

  it('is still visible to the student herself', async () => {
    const p = await publicProfileOf(alice);
    expect(p.location).toBe(LOCATION);
    expect(p.hobbies).toEqual([HOBBY]);
    expect(p.skills).toEqual([SKILL]);
  });
});

describe('once the student makes the profile public', () => {
  it('shows location, interests and skills on the profile', async () => {
    expect((await setProfileVisibility('public')).status).toBe(200);
    const p = await publicProfileOf(bob);
    expect(p.location).toBe(LOCATION);
    expect(p.hobbies).toEqual([HOBBY]);
    expect(p.skills).toEqual([SKILL]);
  });

  it('still keeps location out of search, which is the strictest summary', async () => {
    const res = await srv.call('GET', '/api/directory/search?q=@baselineperson1', undefined, bob);
    expect(JSON.stringify(res.body)).not.toContain(LOCATION);
  });

  it('withholds them again the moment it goes back to private', async () => {
    expect((await setProfileVisibility('private')).status).toBe(200);
    const p = await publicProfileOf(bob);
    for (const field of ['location', 'hobbies', 'skills']) expect(p).not.toHaveProperty(field);
  });
});
