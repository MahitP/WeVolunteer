/**
 * The profile headline belongs to a distinguished account, and to no other.
 *
 * ── The gap this closes ──
 *
 * `profile_headline` and `profile_highlights` shipped on the public BASELINE —
 * emitted at every privacy setting, to every holder of `directory.read` — while
 * `bio` sat behind `profile_visibility`. They are the same kind of thing: free
 * text the account holder wrote to appear under their own name. So a student who
 * set their profile to private still published one line to the whole school:
 *
 *   PATCH /api/auth/profile
 *   { "headline": "Sophomore at SBHS, I walk home down Elm after 4pm" }
 *
 * The reasoning that put them on the baseline — "written by the account holder
 * for exactly this audience" — is true of a partner organization and false of a
 * fourteen-year-old, and nothing restricted the field to the accounts the
 * reasoning was about.
 *
 * The fix is in two halves, and both are asserted here. The serializer follows
 * the privacy setting for an ordinary account and ignores it for a distinguished
 * one; the route REFUSES the write outright for an ordinary account, because a
 * field that stores what it will not show is a field somebody later decides to
 * show.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

const PASSWORD = 'TestPass123!';

describe('the profile headline', () => {
  let srv, db;
  let student, studentId, viewer, admin;

  beforeAll(async () => {
    srv = await startTestServer();
    admin = await srv.login('admin@example.gov');
    ({ db } = await import('./db.js'));

    const made = await srv.signupConfirmed({
      name: 'Headline Student', username: 'headliner',
      email: 'headliner@student.example.org', grade: '10',
      role: 'student', password: PASSWORD,
    });
    student = made.cookie;
    studentId = made.user.id;

    const other = await srv.signupConfirmed({
      name: 'Nosy Classmate', username: 'nosy',
      email: 'nosy@student.example.org', grade: '10',
      role: 'student', password: PASSWORD,
    });
    viewer = other.cookie;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  describe('an ordinary account cannot hold one', () => {
    it('refuses the write, naming the field', async () => {
      const res = await srv.call('PATCH', '/api/auth/profile', {
        headline: 'Sophomore at SBHS, I walk home down Elm after 4pm',
      }, student);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_distinguished');
      expect(res.body.field).toBe('headline');
    });

    it('refuses highlights on the same terms', async () => {
      const res = await srv.call('PATCH', '/api/auth/profile', {
        highlights: ['Captain of something'],
      }, student);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_distinguished');
    });

    /* Nothing is stored, so there is nothing for a future query to disclose. */
    it('stores nothing', async () => {
      const row = db.prepare('SELECT profile_headline, profile_highlights FROM users WHERE id = ?')
        .get(studentId);
      expect(row.profile_headline).toBeNull();
      expect(row.profile_highlights).toBeNull();
    });

    it('still accepts the ordinary free-text field, which privacy covers', async () => {
      const res = await srv.call('PATCH', '/api/auth/profile', { bio: 'I like helping out.' }, student);
      expect(res.status).toBe(200);
    });
  });

  /**
   * Belt and braces: even a value written straight into the database — by a
   * migration, a script, or a bug — must not escape the privacy setting on an
   * ordinary profile. The route refusing the write is the first line; the
   * serializer gating the read is the one that holds if the first is bypassed.
   */
  describe('a value in the column is still gated on an ordinary account', () => {
    beforeAll(() => {
      db.prepare(`
        UPDATE users SET profile_headline = ?, profile_highlights = ?, profile_visibility = 'private'
        WHERE id = ?
      `).run('Walks home down Elm after 4pm', JSON.stringify(['Sophomore']), studentId);
    });

    it('withholds it from another student while the profile is private', async () => {
      const res = await srv.call('GET', '/api/users/by-username/headliner', undefined, viewer);
      expect(res.status).toBe(200);
      expect(res.body.profile).not.toHaveProperty('headline');
      expect(res.body.profile).not.toHaveProperty('highlights');
    });

    it('withholds it from an organizer too', async () => {
      const organizer = await srv.login('jkatzenback@vikings.org');
      const res = await srv.call('GET', '/api/users/by-username/headliner', undefined, organizer);
      expect(res.body.profile).not.toHaveProperty('headline');
    });

    it('shows it once the account chooses a public profile', async () => {
      db.prepare(`UPDATE users SET profile_visibility = 'public' WHERE id = ?`).run(studentId);
      const res = await srv.call('GET', '/api/users/by-username/headliner', undefined, viewer);
      expect(res.body.profile.headline).toBe('Walks home down Elm after 4pm');
      db.prepare(`UPDATE users SET profile_visibility = 'private' WHERE id = ?`).run(studentId);
    });

    it('shows it to the account itself regardless', async () => {
      const res = await srv.call('GET', '/api/users/by-username/headliner', undefined, student);
      expect(res.body.profile.headline).toBe('Walks home down Elm after 4pm');
    });
  });

  /**
   * On an official account the field is the point of the page, and an
   * institution is not a child. An owner's one-line introduction disappearing
   * behind a privacy toggle would make the page unreadable for no benefit.
   */
  describe('a distinguished account holds one unconditionally', () => {
    let ownerCookie, ownerId;

    beforeAll(async () => {
      const owner = await srv.signupConfirmed({
        name: 'Platform Owner', username: 'theowner',
        email: 'theowner@test.local', grade: 'Adult',
        role: 'organizer', password: PASSWORD,
      });
      ownerId = owner.user.id;
      /* Promoted with SQL, then the existing cookie is reused: identity is
         re-derived from the users row on every request. */
      db.prepare(`UPDATE users SET role = 'super_admin' WHERE id = ?`).run(ownerId);
      const { enrolTwoFactor } = await import('./testServer.js');
      await enrolTwoFactor(db, 'theowner@test.local');
      ownerCookie = owner.cookie;
    });

    it('accepts the write', async () => {
      const res = await srv.call('PATCH', '/api/auth/profile', {
        headline: 'Runs WeVolunteer for the district.',
        highlights: ['Built the platform', 'Still a student'],
      }, ownerCookie);
      expect(res.status).toBe(200);
    });

    it('emits it at a private visibility, to a stranger', async () => {
      db.prepare(`UPDATE users SET profile_visibility = 'private' WHERE id = ?`).run(ownerId);
      const res = await srv.call('GET', '/api/users/by-username/theowner', undefined, viewer);
      expect(res.status).toBe(200);
      expect(res.body.profile.headline).toBe('Runs WeVolunteer for the district.');
      expect(res.body.profile.highlights).toEqual(['Built the platform', 'Still a student']);
      expect(res.body.profile.distinction.kind).toBe('owner');
    });

    /**
     * The distinction is ADDITIVE. The platform's owner is a high-school student
     * who volunteers, so the member fields belong on the page exactly as
     * anybody else's do — returning the distinction INSTEAD would hide a real
     * service record behind a job title.
     */
    it('still carries the ordinary member fields', async () => {
      const res = await srv.call('GET', '/api/users/by-username/theowner', undefined, viewer);
      const p = res.body.profile;
      expect(p.stats).toBeTruthy();
      expect(p.stats.eventsSignedUp).toBeTypeOf('number');
      expect(p.stats.hours).toBeTypeOf('number');
      expect(Array.isArray(p.skills)).toBe(true);
      expect(Array.isArray(p.hobbies)).toBe(true);
      expect(p).toHaveProperty('joinedAt');
      expect(p).toHaveProperty('lastVolunteeredAt');
    });

    /* And the sensitive fields are still sensitive — being an owner is not a
       reason to publish a school and a year group. */
    it('does not thereby publish the private fields', async () => {
      const res = await srv.call('GET', '/api/users/by-username/theowner', undefined, viewer);
      expect(res.body.profile).not.toHaveProperty('school');
      expect(res.body.profile).not.toHaveProperty('grade');
      expect(res.body.profile).not.toHaveProperty('email');
    });

    it('is derived from the role and not from the name', async () => {
      db.prepare(`UPDATE users SET role = 'student' WHERE id = ?`).run(ownerId);
      const res = await srv.call('GET', '/api/users/by-username/theowner', undefined, viewer);
      /* Same account, same name, same username — no distinction, and the
         headline now follows the privacy setting like anybody else's. */
      expect(res.body.profile.distinction).toBeNull();
      expect(res.body.profile).not.toHaveProperty('headline');
      db.prepare(`UPDATE users SET role = 'super_admin' WHERE id = ?`).run(ownerId);
    });
  });
});
