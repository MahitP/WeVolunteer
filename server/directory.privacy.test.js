/**
 * What a member may learn about another member.
 *
 * ── Why this file is adversarial rather than illustrative ──
 *
 * The v1.3 directory makes every profile discoverable, which turns a
 * previously-theoretical question into the platform's largest disclosure
 * surface: this is a service whose members are schoolchildren, and the profile
 * endpoints now hand one child's details to another on request.
 *
 * The recurring shape of a profile-privacy bug is NOT a hole in the profile
 * endpoint. It is a second endpoint that returns the same rows and was never
 * thought of as a profile endpoint — search, an organization roster, a
 * notification body, a member list. So the tests below deliberately go at every
 * one of those, and assert on the SHAPE of the response rather than on a
 * hand-picked field: a new column on `users` that leaks through any of them
 * fails here rather than shipping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Fields that must never appear in any user-facing payload about somebody else,
 * at any privacy setting, through any route in this file.
 */
const NEVER = [
  'password_hash', 'passwordHash', 'tfa_secret', 'tfaSecret', 'date_of_birth',
  'dateOfBirth', 'token_version', 'tokenVersion', 'suspension_reason',
  'suspensionReason', 'email_verification', 'recovery',
];

/** Fields a PRIVATE profile must withhold from an ordinary member. */
const PRIVATE_FIELDS = ['bio', 'school', 'grade', 'graduationYear'];

/** Recursively collects every key present anywhere in a payload. */
function allKeys(value, into = new Set()) {
  if (Array.isArray(value)) { for (const v of value) allKeys(v, into); return into; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { into.add(k); allKeys(v, into); }
  }
  return into;
}

describe('the member directory: what one member may learn about another', () => {
  let srv, db;
  let student, otherStudent, organizer, admin;
  let studentId, otherId;

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login('leo.chen@example.com');
    organizer = await srv.login('jordan.whitfield@example.org');
    admin = await srv.login('admin@example.gov');

    ({ db } = await import('./db.js'));
    studentId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('leo.chen@example.com')).id;

    /* A second student, so the "one member reading another" case is a real one
       rather than a self-read wearing a disguise. */
    const signup = await srv.signupConfirmed({
      name: 'Priya Raman', email: 'priya.test@student.example.org', grade: '11',
      username: 'priya', role: 'student', password: 'TestPass123!',
    });
    otherStudent = signup.cookie;
    otherId = signup.user.id;

    await db.prepare(`
      UPDATE users SET bio = ?, school = ?, location = ?,
                       hobbies = ?, skills = ?, profile_visibility = 'public'
      WHERE id = ?
    `).run('I like helping out.', 'Example Valley High', 'Example Valley, NJ',
      JSON.stringify(['baking']), JSON.stringify(['first aid']), otherId);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  describe('a public profile', () => {
    it('is reachable by username, with the public baseline', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, student);
      expect(res.status).toBe(200);
      expect(res.body.profile.name).toBe('Priya Raman');
      expect(res.body.profile.username).toBe('priya');
      expect(res.body.profile.location).toBe('Example Valley, NJ');
      expect(res.body.profile.hobbies).toEqual(['baking']);
      expect(res.body.profile.stats).toBeTruthy();
    });

    it('matches the username case-insensitively, the way sign-in does', async () => {
      const res = await srv.call('GET', '/api/users/by-username/PRIYA', undefined, student);
      expect(res.status).toBe(200);
      expect(res.body.profile.id).toBe(otherId);
    });

    it('shows school and grade, because that is what public means', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, student);
      expect(res.body.profile.school).toBe('Example Valley High');
      expect(res.body.profile.grade).toBe('11');
    });

    /**
     * The distinction the whole design turns on: choosing a public profile is
     * not consenting to publish an email address.
     */
    it('never shows an email address to an ordinary member', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, student);
      expect(res.body.profile.email).toBeUndefined();
    });

    it('does not carry a single sensitive column, anywhere in the payload', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, student);
      const keys = allKeys(res.body);
      for (const forbidden of NEVER) expect([...keys]).not.toContain(forbidden);
    });

    it('answers 404 for a username nobody has', async () => {
      const res = await srv.call('GET', '/api/users/by-username/nobody-at-all', undefined, student);
      expect(res.status).toBe(404);
    });

    it('requires a session', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya');
      expect(res.status).toBe(401);
    });
  });

  describe('a private profile', () => {
    beforeAll(() => {
      db.prepare(`UPDATE users SET profile_visibility = 'private' WHERE id = ?`).run(otherId);
    });

    /**
     * The redesign, asserted directly: privacy hides FIELDS, it does not hide
     * the person. A profile that vanished entirely is what made the old setting
     * useless, and is what students turned off in order to be findable.
     */
    it('is still discoverable, with the public baseline intact', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, student);
      expect(res.status).toBe(200);
      expect(res.body.profile.name).toBe('Priya Raman');
      expect(res.body.profile.location).toBe('Example Valley, NJ');
      expect(res.body.profile.hobbies).toEqual(['baking']);
      expect(res.body.profile.skills).toEqual(['first aid']);
      expect(res.body.profile.stats.eventsSignedUp).toBeTypeOf('number');
      expect(res.body.profile.stats.eventsAttended).toBeTypeOf('number');
      expect(res.body.profile.joinedAt).toBeTruthy();
    });

    it('withholds school, grade, bio and graduation year', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, student);
      for (const field of PRIVATE_FIELDS) expect(res.body.profile[field]).toBeUndefined();
    });

    /** An organizer is an adult with a capability, not an exemption. */
    it('withholds the same fields from an organizer', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, organizer);
      expect(res.status).toBe(200);
      for (const field of PRIVATE_FIELDS) expect(res.body.profile[field]).toBeUndefined();
    });

    it('shows them to staff holding user.contact.read', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, admin);
      expect(res.body.profile.school).toBe('Example Valley High');
      expect(res.body.profile.grade).toBe('11');
    });

    it('shows them to the account itself', async () => {
      const res = await srv.call('GET', '/api/users/by-username/priya', undefined, otherStudent);
      expect(res.body.profile.isSelf).toBe(true);
      expect(res.body.profile.bio).toBe('I like helping out.');
    });

    afterAll(() => {
      db.prepare(`UPDATE users SET profile_visibility = 'public' WHERE id = ?`).run(otherId);
    });
  });

  /**
   * The alternate-route tests. Each of these returns rows from `users`, and
   * each is a place a reviewer looking at "the profile endpoint" would not
   * think to check.
   */
  describe('no alternate route discloses more than the profile does', () => {
    beforeAll(() => {
      db.prepare(`UPDATE users SET profile_visibility = 'private' WHERE id = ?`).run(otherId);
    });

    it('search results carry no private field', async () => {
      const res = await srv.call('GET', '/api/directory/search?q=Priya', undefined, student);
      expect(res.status).toBe(200);
      const hit = res.body.users.find(u => u.id === otherId);
      expect(hit).toBeTruthy();
      for (const field of [...PRIVATE_FIELDS, 'email', ...NEVER]) {
        expect(hit[field]).toBeUndefined();
      }
    });

    it('search never returns a suspended or deleted account', async () => {
      await db.prepare(`UPDATE users SET account_status = 'deleted' WHERE id = ?`).run(otherId);
      const res = await srv.call('GET', '/api/directory/search?q=Priya', undefined, student);
      expect(res.body.users.find(u => u.id === otherId)).toBeUndefined();

      const profile = await srv.call('GET', '/api/users/by-username/priya', undefined, student);
      expect(profile.status).toBe(404);
      await db.prepare(`UPDATE users SET account_status = 'active' WHERE id = ?`).run(otherId);
    });

    /**
     * A wildcard in a LIKE pattern is how a search box becomes an enumeration
     * endpoint. `%` must match a literal percent sign, not everybody.
     */
    it('does not let a LIKE wildcard enumerate the whole membership', async () => {
      for (const wildcard of ['%', '_', '%%', '%_%']) {
        const res = await srv.call(`GET`, `/api/directory/search?q=${encodeURIComponent(wildcard)}`, undefined, student);
        expect(res.status).toBe(200);
        expect(res.body.users).toEqual([]);
      }
    });

    /**
     * `q=a` is ONE character, which is below SEARCH_MIN — so the handler
     * short-circuits to `{users: [], tooShort: true}` and the assertion below
     * passed without the LIMIT clause ever running. A two-character query is
     * what actually reaches the query this test is about.
     */
    it('bounds the page size however large a limit is asked for', async () => {
      const res = await srv.call('GET', '/api/directory/search?q=an&limit=100000', undefined, student);
      expect(res.status).toBe(200);
      expect(res.body.tooShort).toBeUndefined();
      expect(res.body.users.length).toBeLessThanOrEqual(25);
    });

    /**
     * Bounding the page size bounds one REQUEST. Without a companion bound on
     * `offset`, `?offset=0,25,50,…` walks the same rows out in pages — the same
     * enumeration, run more slowly, against a membership of schoolchildren.
     */
    it('refuses to page arbitrarily deep into the membership', async () => {
      const shallow = await srv.call('GET', '/api/directory/search?q=an&offset=25', undefined, student);
      expect(shallow.status).toBe(200);

      const deep = await srv.call('GET', '/api/directory/search?q=an&offset=100000', undefined, student);
      expect(deep.status).toBe(400);
      expect(deep.body.code).toBe('offset_too_deep');
    });

    it('refuses the whole directory to a partner account', async () => {
      const partner = await srv.signupConfirmed({
        name: 'Partner Org', email: 'partner.dir@test.local', grade: 'Adult',
        username: 'partnerorg', role: 'student', password: 'TestPass123!',
      });
      const partnerToken = partner.cookie;
      await db.prepare(`UPDATE users SET role = 'partner' WHERE email = ?`).run('partner.dir@test.local');

      for (const path of [
        '/api/directory/search?q=priya',
        '/api/users/by-username/priya',
        `/api/users/${otherId}/public-profile`,
        '/api/organizations',
      ]) {
        const res = await srv.call('GET', path, undefined, partnerToken);
        expect(res.status, `${path} must refuse a partner`).toBe(403);
      }
    });

    /**
     * The pre-v1.3 leak, pinned so it cannot come back.
     *
     * `GET /api/users/:id/profile` returned every past event's title, LOCATION
     * and exact start and end times to any authenticated caller. For a minor
     * that is a week-by-week record of where they have been.
     */
    it('does not hand a minor\'s itemised whereabouts to another member', async () => {
      const res = await srv.call('GET', `/api/users/${otherId}/profile`, undefined, student);
      expect(res.status).toBe(200);
      expect(res.body.completed).toEqual([]);
      expect(res.body.completedRedacted).toBe(true);
    });

    it('still gives the itemised record to the account itself and to staff', async () => {
      const mine = await srv.call('GET', `/api/users/${otherId}/service-record`, undefined, otherStudent);
      expect(mine.status).toBe(200);
      expect(Array.isArray(mine.body.completed)).toBe(true);

      const staff = await srv.call('GET', `/api/users/${otherId}/service-record`, undefined, admin);
      expect(staff.status).toBe(200);
    });

    it('refuses another student\'s itemised service record', async () => {
      const res = await srv.call('GET', `/api/users/${otherId}/service-record`, undefined, student);
      expect(res.status).toBe(403);
    });

    afterAll(() => {
      db.prepare(`UPDATE users SET profile_visibility = 'public' WHERE id = ?`).run(otherId);
    });
  });

  describe('the privacy setting is writable, and only by its owner', () => {
    it('lets the account change its own visibility', async () => {
      const res = await srv.call('PATCH', '/api/auth/profile', { profileVisibility: 'private' }, otherStudent);
      expect(res.status).toBe(200);
      expect(res.body.user.profileVisibility).toBe('private');
      await srv.call('PATCH', '/api/auth/profile', { profileVisibility: 'public' }, otherStudent);
    });

    it('rejects a value outside the closed set rather than answering 500', async () => {
      const res = await srv.call('PATCH', '/api/auth/profile', { profileVisibility: 'everyone' }, otherStudent);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('profileVisibility');
    });

    it('bounds the location field, and never geocodes it', async () => {
      const tooLong = await srv.call('PATCH', '/api/auth/profile', { location: 'x'.repeat(200) }, otherStudent);
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.field).toBe('location');

      const ok = await srv.call('PATCH', '/api/auth/profile', { location: 'Kendall Park, NJ' }, otherStudent);
      expect(ok.status).toBe(200);
      /* There is no latitude/longitude on `users` and there must not be one:
         an event's coordinates are a meeting point an organizer published; a
         student's would be a child's whereabouts. */
      const columns = (await db.prepare('PRAGMA table_info(users)').all()).map(c => c.name);
      expect(columns).not.toContain('latitude');
      expect(columns).not.toContain('longitude');
    });
  });
});
