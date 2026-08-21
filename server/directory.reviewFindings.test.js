/**
 * The defects an adversarial review of this branch found, pinned.
 *
 * Each of these passed the feature suite. They are here because "the tests are
 * green" was true of every one of them, and the way a fixed bug comes back is
 * that nothing was ever written down about it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

const PASSWORD = 'TestPass123!';

describe('review findings', () => {
  let srv, db;
  let alice, bob, organizer, admin;
  let aliceId, bobId, organizerId;

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login('jordan.whitfield@example.org');
    admin = await srv.login('admin@example.gov');
    ({ db } = await import('./db.js'));
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get('jordan.whitfield@example.org')).id;

    const make = async (name, username) => {
      const r = await srv.signupConfirmed({
        name, username, email: `${username}@student.example.org`,
        grade: '11', role: 'student', password: PASSWORD,
      });
      return { token: r.cookie, id: r.user.id };
    };
    const a = await make('Alice Adeyemi', 'ralice');
    const b = await make('Bob Brennan', 'rbob');
    alice = a.token; aliceId = a.id;
    bob = b.token; bobId = b.id;

    await srv.call('POST', `/api/users/${bobId}/friend`, undefined, alice);
    await srv.call('POST', `/api/users/${aliceId}/friend/accept`, undefined, bob);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /**
   * The in-app copy for FRIEND_SIGNED_UP names no time and no place, on purpose.
   * The email builder then appended a date/location/organizer card to anything
   * whose payload carried an `eventId` — so the email said what the in-app
   * notification was written to avoid saying, into an inbox that may be shared,
   * forwarded, or retained indefinitely.
   */
  it('does not put a named minor\'s date and location into a friend-signup email', async () => {
    const { default: worker } = await import('./workers/notificationWorker.js').then(m => ({ default: m }));
    /* The allowlist is the mechanism; assert on it directly so a future kind
       cannot acquire the card by accident. */
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('./workers/notificationWorker.js', import.meta.url), 'utf8'));
    expect(src).toContain('EVENT_CARD_EVENTS');
    expect(src).toMatch(/EVENT_CARD_EVENTS\.has\(event\)/);
    /* FRIEND_SIGNED_UP must NOT be in the set. */
    const setBody = src.slice(src.indexOf('const EVENT_CARD_EVENTS'), src.indexOf(']);', src.indexOf('const EVENT_CARD_EVENTS')));
    expect(setBody).not.toContain('FRIEND_SIGNED_UP');
    expect(setBody).toContain('APPLICATION_ACCEPTED');
    expect(worker).toBeTruthy();
  });

  /**
   * `attendee_visibility: 'private'` refuses the roster even to an accepted
   * co-attendee. Telling a volunteer's friends "X signed up for <title>"
   * disclosed exactly that participation, to people not on the event at all.
   */
  it('does not tell friends about a signup when the organizer made the roster private', async () => {
    const start = new Date(Date.now() + 20 * 86400000);
    const created = await srv.call('POST', '/api/events', {
      title: 'Confidential support shift', description: 'Discreet.', category: 'Other',
      location: 'Community centre',
      applicationDeadline: new Date(Date.now() + 9 * 86400000).toISOString(),
      attendeeVisibility: 'private',
      slots: [{
        name: 'Shift', description: 'Work', maxSpots: 10,
        startDatetime: start.toISOString(),
        endDatetime: new Date(start.getTime() + 3600000).toISOString(),
      }],
    }, organizer);
    expect(created.status).toBe(201);
    const slotId = (await db.prepare('SELECT id FROM slots WHERE event_id = ?').get(created.body.id)).id;

    const before = (await db.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = 'A friend signed up'`
    ).get(bobId)).n;

    const applied = await srv.call('POST', `/api/events/${created.body.id}/apply`, { slotId }, alice);
    expect(applied.status).toBe(201);

    expect((await db.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = 'A friend signed up'`
    ).get(bobId)).n).toBe(before);
  });

  /**
   * Restriction is invisible to its subject — that is the whole difference
   * between it and blocking. Sending `restrictedBy` told the restricted person
   * directly, and the client rendered it as a missing button.
   */
  it('gives the restricted person a viewer object indistinguishable from a stranger\'s', async () => {
    await srv.call('POST', `/api/users/${aliceId}/restrict`, undefined, bob);

    const restrictedView = await srv.call('GET', `/api/users/${bobId}/public-profile`, undefined, alice);
    const strangerView = await srv.call('GET', `/api/users/${organizerId}/public-profile`, undefined, alice);

    expect(Object.hasOwn(restrictedView.body.viewer, 'restrictedBy')).toBe(false);
    expect(Object.keys(restrictedView.body.viewer).sort())
      .toEqual(Object.keys(strangerView.body.viewer).sort());
    expect(restrictedView.body.viewer.friendship).toBe('none');

    await srv.call('DELETE', `/api/users/${aliceId}/restrict`, undefined, bob);
  });

  /**
   * The sole manager could demote themselves to 'member' (200), leaving the
   * organization with zero managers — and the leave guard then passed too,
   * because it reads the role it had just been allowed to change.
   */
  it('refuses to demote the last manager, closing the two-step leave bypass', async () => {
    const created = await srv.call('POST', '/api/organizations', { name: 'Solo Managed Club' }, organizer);
    expect(created.status).toBe(201);
    const slug = created.body.organization.slug;

    const demote = await srv.call(
      'PATCH', `/api/organizations/${slug}/members/${organizerId}`, { memberRole: 'member' }, organizer
    );
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('last_manager');

    /* And the leave guard still holds, so the two together leave no path to a
       manager-less organization. */
    const leave = await srv.call('DELETE', `/api/organizations/${slug}/membership`, undefined, organizer);
    expect(leave.status).toBe(409);
    expect(leave.body.code).toBe('last_manager');

    expect((await db.prepare(
      `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND member_role = 'manager'`
    ).get(created.body.organization.id)).n).toBe(1);
  });

  it('still allows demotion once a second manager exists', async () => {
    const created = await srv.call('POST', '/api/organizations', { name: 'Two Manager Club' }, organizer);
    const slug = created.body.organization.slug;
    await srv.call('POST', `/api/organizations/${slug}/membership`, undefined, alice);
    await srv.call('PATCH', `/api/organizations/${slug}/members/${aliceId}`, { memberRole: 'manager' }, organizer);

    const demote = await srv.call(
      'PATCH', `/api/organizations/${slug}/members/${organizerId}`, { memberRole: 'member' }, organizer
    );
    expect(demote.status).toBe(200);
  });

  /**
   * The two endpoints that return a student's itemised service history must
   * apply the SAME rule. Whichever is looser is the effective policy, so a
   * difference between them is not a stricter endpoint — it is an unenforced
   * one next to an enforced one.
   */
  describe('the itemised service history has one rule, not two', () => {
    let eventId, slotId;

    beforeAll(async () => {
      const start = new Date(Date.now() + 25 * 86400000);
      const created = await srv.call('POST', '/api/events', {
        title: 'Review workflow event', description: 'd', category: 'Other', location: 'l',
        applicationDeadline: new Date(Date.now() + 11 * 86400000).toISOString(),
        slots: [{
          name: 'Shift', description: 'd', maxSpots: 5,
          startDatetime: start.toISOString(),
          endDatetime: new Date(start.getTime() + 3600000).toISOString(),
        }],
      }, organizer);
      eventId = created.body.id;
      slotId = (await db.prepare('SELECT id FROM slots WHERE event_id = ?').get(eventId)).id;
      await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, alice);
    });

    it('lets the organizer reviewing an applicant read it from BOTH endpoints', async () => {
      const profile = await srv.call('GET', `/api/users/${aliceId}/profile`, undefined, organizer);
      expect(profile.status).toBe(200);
      expect(profile.body.completedRedacted).toBe(false);

      const record = await srv.call('GET', `/api/users/${aliceId}/service-record`, undefined, organizer);
      expect(record.status).toBe(200);
    });

    it('refuses a fellow student on BOTH endpoints', async () => {
      const profile = await srv.call('GET', `/api/users/${aliceId}/profile`, undefined, bob);
      expect(profile.status).toBe(200);
      expect(profile.body.completed).toEqual([]);
      expect(profile.body.completedRedacted).toBe(true);

      const record = await srv.call('GET', `/api/users/${aliceId}/service-record`, undefined, bob);
      expect(record.status).toBe(403);
    });

    it('refuses an organizer the student never applied to, on both', async () => {
      const other = await srv.signupConfirmed({
        name: 'Unrelated Organizer', username: 'unrelatedorg',
        email: 'unrelated.org.contact@example.net', grade: 'Adult', role: 'organizer', password: PASSWORD,
      });
      /* Organizers must accept the agreement before they hold applicant.review;
         either way this must not disclose the history. */
      const profile = await srv.call('GET', `/api/users/${aliceId}/profile`, undefined, other.cookie);
      if (profile.status === 200) expect(profile.body.completed).toEqual([]);

      const record = await srv.call('GET', `/api/users/${aliceId}/service-record`, undefined, other.cookie);
      expect([403, 200]).toContain(record.status);
      if (record.status === 200) expect(record.body.completed).toEqual([]);
    });
  });
});
