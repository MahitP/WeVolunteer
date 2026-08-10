/**
 * Friends, mutes, restrictions, organizations, and external hours — end to end.
 *
 * The emphasis throughout is on the REFUSALS. A social feature on a platform
 * for minors is mostly interesting for what it declines to do: who is not
 * notified, who cannot create what, and which route refuses somebody the
 * client would never have offered the button to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

const PASSWORD = 'TestPass123!';

describe('the social and organization features', () => {
  let srv, db;
  let alice, bob, carol, organizer, admin;
  let aliceId, bobId, carolId, organizerId;

  /** Rows in `notifications` of a given kind for a given recipient. */
  const notificationsFor = (userId, titleLike) => db.prepare(
    `SELECT * FROM notifications WHERE user_id = ? AND title LIKE ?`
  ).all(userId, titleLike);

  beforeAll(async () => {
    srv = await startTestServer();
    organizer = await srv.login('jkatzenback@vikings.org');
    admin = await srv.login('admin@example.gov');
    ({ db } = await import('./db.js'));
    organizerId = db.prepare('SELECT id FROM users WHERE email = ?').get('jkatzenback@vikings.org').id;

    const make = async (name, username) => {
      const r = await srv.signupConfirmed({
        name, username, email: `${username}@student.example.org`,
        grade: '11', role: 'student', password: PASSWORD,
      });
      return { token: r.cookie, id: r.user.id };
    };
    const a = await make('Alice Adeyemi', 'alice');
    const b = await make('Bob Brennan', 'bobb');
    const c = await make('Carol Chen', 'carolc');
    alice = a.token; aliceId = a.id;
    bob = b.token; bobId = b.id;
    carol = c.token; carolId = c.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  describe('friendship requires both sides to agree', () => {
    it('starts as a request, not a friendship', async () => {
      const res = await srv.call('POST', `/api/users/${bobId}/friend`, undefined, alice);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.friendship).toBe('requested');
    });

    it('reads as incoming from the other side', async () => {
      const res = await srv.call('GET', '/api/me/friends', undefined, bob);
      expect(res.body.incoming.map(u => u.id)).toContain(aliceId);
      expect(res.body.friends).toEqual([]);
    });

    it('is idempotent — asking twice does not create a second request', async () => {
      await srv.call('POST', `/api/users/${bobId}/friend`, undefined, alice);
      const rows = db.prepare(
        `SELECT COUNT(*) AS n FROM user_relationships WHERE actor_id = ? AND subject_id = ? AND kind = 'friend'`
      ).get(aliceId, bobId);
      expect(rows.n).toBe(1);
    });

    it('completes when the addressee accepts', async () => {
      const res = await srv.call('POST', `/api/users/${aliceId}/friend/accept`, undefined, bob);
      expect(res.status).toBe(200);
      expect(res.body.friendship).toBe('friends');
    });

    it('refuses an action against your own account', async () => {
      const res = await srv.call('POST', `/api/users/${aliceId}/friend`, undefined, alice);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('self_target');
    });

    it('404s for an account that does not exist', async () => {
      const res = await srv.call('POST', '/api/users/user-nope/friend', undefined, alice);
      expect(res.status).toBe(404);
    });

    it('answers 401 without a session', async () => {
      expect((await srv.call('POST', `/api/users/${bobId}/friend`)).status).toBe(401);
    });
  });

  describe('signing up tells friends — subject to the privacy setting', () => {
    let eventId, slotId;

    beforeAll(async () => {
      const start = new Date(Date.now() + 14 * 86400000);
      const end = new Date(start.getTime() + 3 * 3600000);
      const created = await srv.call('POST', '/api/events', {
        title: 'Riverside cleanup', description: 'Bring gloves.', category: 'Other',
        location: 'Riverside Park', applicationDeadline: new Date(Date.now() + 7 * 86400000).toISOString(),
        slots: [{
          name: 'Morning', description: 'Litter picking', maxSpots: 20,
          startDatetime: start.toISOString(), endDatetime: end.toISOString(),
        }],
      }, organizer);
      expect(created.status).toBe(201);
      eventId = created.body.id;
      slotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(eventId).id;
    });

    const apply = (token) => srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, token);

    it('notifies an accepted friend', async () => {
      const res = await apply(alice);
      expect(res.status).toBe(201);
      expect(notificationsFor(bobId, 'A friend signed up')).toHaveLength(1);
    });

    it('does not notify somebody who is not a friend', async () => {
      expect(notificationsFor(carolId, 'A friend signed up')).toHaveLength(0);
    });

    /**
     * The privacy switch, proved at the point that matters: no notification row
     * is WRITTEN. A recipient list that was never built cannot be leaked later
     * by an endpoint that forgets to re-apply a filter.
     */
    it('writes nothing at all when the volunteer has turned the setting off', async () => {
      await srv.call('PATCH', '/api/auth/profile', { friendActivityVisible: false }, bob);
      await srv.call('POST', `/api/users/${carolId}/friend`, undefined, bob);
      await srv.call('POST', `/api/users/${bobId}/friend/accept`, undefined, carol);

      const before = notificationsFor(carolId, 'A friend signed up').length;
      const res = await apply(bob);
      expect(res.status).toBe(201);
      expect(notificationsFor(carolId, 'A friend signed up')).toHaveLength(before);
    });

    it('turns back on when the volunteer re-enables it', async () => {
      const { db: _db } = await import('./db.js');
      _db.prepare('DELETE FROM applications WHERE user_id = ? AND slot_id = ?').run(bobId, slotId);
      await srv.call('PATCH', '/api/auth/profile', { friendActivityVisible: true }, bob);
      const res = await apply(bob);
      expect(res.status).toBe(201);
      expect(notificationsFor(carolId, 'A friend signed up').length).toBeGreaterThan(0);
    });

    /* One piece of news per event, however many shifts were taken. */
    it('does not send a second notification for the same event', async () => {
      const before = notificationsFor(bobId, 'A friend signed up').length;
      await srv.call('PATCH', '/api/applications/bulk', {}, alice).catch(() => {});
      db.prepare('DELETE FROM applications WHERE user_id = ? AND slot_id = ?').run(aliceId, slotId);
      await apply(alice);
      expect(notificationsFor(bobId, 'A friend signed up')).toHaveLength(before);
    });
  });

  describe('mute and restrict', () => {
    it('mutes without telling anybody', async () => {
      const res = await srv.call('POST', `/api/users/${aliceId}/mute`, undefined, bob);
      expect(res.status).toBe(200);
      expect(res.body.muted).toBe(true);
      /* Alice's own view of Bob is unchanged — a mute is invisible. */
      const aliceView = await srv.call('GET', `/api/users/${bobId}/public-profile`, undefined, alice);
      expect(aliceView.body.viewer.muted).toBe(false);
    });

    it('stops the muter being notified about the muted account', async () => {
      const before = notificationsFor(bobId, 'A friend signed up').length;
      const start = new Date(Date.now() + 21 * 86400000);
      const created = await srv.call('POST', '/api/events', {
        title: 'Second cleanup', description: 'Also gloves.', category: 'Other',
        location: 'Elsewhere', applicationDeadline: new Date(Date.now() + 10 * 86400000).toISOString(),
        slots: [{
          name: 'Shift', description: 'Work', maxSpots: 10,
          startDatetime: start.toISOString(), endDatetime: new Date(start.getTime() + 3600000).toISOString(),
        }],
      }, organizer);
      const slot = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(created.body.id).id;
      await srv.call('POST', `/api/events/${created.body.id}/apply`, { slotId: slot }, alice);
      expect(notificationsFor(bobId, 'A friend signed up')).toHaveLength(before);
    });

    it('lifts a mute', async () => {
      const res = await srv.call('DELETE', `/api/users/${aliceId}/mute`, undefined, bob);
      expect(res.body.muted).toBe(false);
    });

    /**
     * Restricting withdraws the friendship. Leaving them friends would leave
     * the restricted party still receiving the restrictor's signup
     * notifications, which is precisely what the control is being used to stop.
     */
    it('restricting also ends the friendship', async () => {
      const res = await srv.call('POST', `/api/users/${aliceId}/restrict`, undefined, bob);
      expect(res.status).toBe(200);
      expect(res.body.restricted).toBe(true);
      expect(res.body.friendship).toBe('none');
    });

    it('refuses a friend request from a restricted account', async () => {
      const res = await srv.call('POST', `/api/users/${bobId}/friend`, undefined, alice);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('not_permitted');
    });

    it('lists the caller\'s own mutes and restrictions so they can be lifted', async () => {
      const res = await srv.call('GET', '/api/me/relationships', undefined, bob);
      expect(res.status).toBe(200);
      expect(res.body.restricted.map(u => u.id)).toContain(aliceId);
    });

    /**
     * The restricted party must not be able to tell.
     *
     * `restrictedBy` is stripped from the response rather than sent as `false`,
     * because a key that is present-and-false is still a key somebody can watch
     * for. To Alice, a profile she has been restricted from must be
     * indistinguishable from one where nothing has happened — which is the
     * difference between restricting and blocking, and the reason a student who
     * wants distance without a confrontation has something to reach for.
     */
    it('never tells the restricted person they were restricted', async () => {
      const aliceView = await srv.call('GET', `/api/users/${bobId}/public-profile`, undefined, alice);
      expect(aliceView.status).toBe(200);
      expect(Object.hasOwn(aliceView.body.viewer, 'restrictedBy')).toBe(false);
      /* And a control: the same shape for somebody with no relationship at all. */
      const carolView = await srv.call('GET', `/api/users/${carolId}/public-profile`, undefined, alice);
      expect(Object.keys(aliceView.body.viewer).sort()).toEqual(Object.keys(carolView.body.viewer).sort());
    });

    it('lifts a restriction', async () => {
      await srv.call('DELETE', `/api/users/${aliceId}/restrict`, undefined, bob);
      const res = await srv.call('GET', `/api/users/${aliceId}/public-profile`, undefined, bob);
      expect(res.body.viewer.restricted).toBe(false);
    });
  });

  describe('organizations', () => {
    let orgSlug, orgId;

    it('refuses creation to a student', async () => {
      const res = await srv.call('POST', '/api/organizations', { name: 'Student Club' }, alice);
      expect(res.status).toBe(403);
    });

    it('lets an organizer create one, as its first manager', async () => {
      const res = await srv.call('POST', '/api/organizations', {
        name: 'National Honor Society', description: 'NHS chapter.', tags: ['school'],
      }, organizer);
      expect(res.status).toBe(201);
      orgSlug = res.body.organization.slug;
      orgId = res.body.organization.id;
      expect(orgSlug).toBe('national-honor-society');
      expect(res.body.organization.memberCount).toBe(1);
    });

    it('gives a colliding name a distinct slug rather than refusing', async () => {
      const res = await srv.call('POST', '/api/organizations', { name: 'National Honor Society' }, organizer);
      expect(res.status).toBe(201);
      expect(res.body.organization.slug).toBe('national-honor-society-2');
    });

    it('lets a student join and leave', async () => {
      const join = await srv.call('POST', `/api/organizations/${orgSlug}/membership`, undefined, alice);
      expect(join.status).toBe(200);
      expect(join.body.isMember).toBe(true);

      const leave = await srv.call('DELETE', `/api/organizations/${orgSlug}/membership`, undefined, alice);
      expect(leave.body.isMember).toBe(false);
      await srv.call('POST', `/api/organizations/${orgSlug}/membership`, undefined, alice);
    });

    it('is idempotent on a second join', async () => {
      await srv.call('POST', `/api/organizations/${orgSlug}/membership`, undefined, alice);
      const n = db.prepare('SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .get(orgId, aliceId).n;
      expect(n).toBe(1);
    });

    /* An organization with no manager is one nobody can edit or attach an event
       to — recoverable only by an administrator, and only if somebody notices. */
    it('refuses to let the last manager leave', async () => {
      const res = await srv.call('DELETE', `/api/organizations/${orgSlug}/membership`, undefined, organizer);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_manager');
    });

    it('refuses edits from a member who is not a manager', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${orgSlug}`, { name: 'Hijacked' }, alice);
      expect(res.status).toBe(403);
    });

    it('lets its manager edit it', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${orgSlug}`, { description: 'Updated.' }, organizer);
      expect(res.status).toBe(200);
      expect(res.body.organization.description).toBe('Updated.');
    });

    it('lets an administrator edit one they did not create', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${orgSlug}`, { description: 'Moderated.' }, admin);
      expect(res.status).toBe(200);
    });

    it('is findable by search, badged as an organization', async () => {
      const res = await srv.call('GET', '/api/directory/search?q=Honor', undefined, alice);
      const hit = res.body.organizations.find(o => o.id === orgId);
      expect(hit).toBeTruthy();
      expect(hit.kind).toBe('organization');
      expect(hit.memberCount).toBeGreaterThanOrEqual(2);
    });

    describe('events posted under an organization', () => {
      it('refuses to attach an event to an organization the organizer does not manage', async () => {
        const other = await srv.call('POST', '/api/organizations', { name: 'Other Club' }, admin);
        const res = await srv.call('POST', '/api/events', {
          title: 'Sneaky', description: 'x', category: 'Other', location: 'y',
          applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
          organizationId: other.body.organization.id,
          slots: [{
            name: 's', description: 'd', maxSpots: 1,
            startDatetime: new Date(Date.now() + 10 * 86400000).toISOString(),
            endDatetime: new Date(Date.now() + 10 * 86400000 + 3600000).toISOString(),
          }],
        }, organizer);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('not_manager');
      });

      it('notifies every member except the creator, once each', async () => {
        const res = await srv.call('POST', '/api/events', {
          title: 'NHS food drive', description: 'Tins welcome.', category: 'Other',
          location: 'Gym', applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
          organizationId: orgId,
          slots: [{
            name: 'Collection', description: 'Sort tins', maxSpots: 30,
            startDatetime: new Date(Date.now() + 12 * 86400000).toISOString(),
            endDatetime: new Date(Date.now() + 12 * 86400000 + 7200000).toISOString(),
          }],
        }, organizer);
        expect(res.status).toBe(201);
        expect(res.body.organizationId).toBe(orgId);

        const forAlice = db.prepare(
          `SELECT * FROM notifications WHERE user_id = ? AND dedupe_key = ?`
        ).all(aliceId, `org-event:${res.body.id}`);
        expect(forAlice).toHaveLength(1);

        const forCreator = db.prepare(
          `SELECT * FROM notifications WHERE user_id = ? AND dedupe_key = ?`
        ).all(organizerId, `org-event:${res.body.id}`);
        expect(forCreator).toHaveLength(0);
      });

      it('lists the event on the organization page', async () => {
        const res = await srv.call('GET', `/api/organizations/${orgSlug}`, undefined, alice);
        expect(res.body.events.some(e => e.title === 'NHS food drive')).toBe(true);
        expect(res.body.viewer.isMember).toBe(true);
        expect(res.body.viewer.canManage).toBe(false);
      });
    });
  });

  describe('external hours', () => {
    let entryId;

    it('lets a student log service done elsewhere', async () => {
      const res = await srv.call('POST', '/api/external-hours', {
        organizationName: 'Elijah\'s Promise', activityName: 'Soup kitchen',
        occurredOn: '2026-05-02', hours: 3.5, description: 'Served lunch.',
      }, alice);
      expect(res.status).toBe(201);
      /* A constant, not a state. There is no other kind of external entry, and
         nothing can move one out of it. */
      expect(res.body.entry.selfReported).toBe(true);
      expect(res.body.entry).not.toHaveProperty('status');
      entryId = res.body.entry.id;
    });

    /**
     * The structural guarantee. An external record must never become something
     * other students can see or apply to — and it cannot, because it is not in
     * `events` at all.
     */
    it('creates no event, no slot, and no application', async () => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE title = ?').get('Soup kitchen').n).toBe(0);
      const browse = await srv.call('GET', '/api/events', undefined, bob);
      expect(browse.status).toBe(200);
      /* The list endpoint answers with a bare array in some shapes and
         `{ events }` in others; the assertion is about the CONTENT, so it
         accepts either rather than pinning a shape it does not care about. */
      const listed = Array.isArray(browse.body) ? browse.body : browse.body.events;
      expect(listed.some(e => e.title === 'Soup kitchen')).toBe(false);
    });

    it('never counts toward credited hours', async () => {
      const profile = await srv.call('GET', `/api/users/${aliceId}/public-profile`, undefined, alice);
      expect(profile.body.profile.stats.hours).toBe(0);
      expect(profile.body.profile.externalService.selfReportedHours).toBe(3.5);
      /* There is no verified total any more, on any payload. */
      expect(profile.body.profile.externalService).not.toHaveProperty('verifiedHours');
    });

    /**
     * A personal log is personal. Somebody else reading Alice's profile learns
     * what this platform confirmed and nothing she typed about elsewhere.
     */
    it('shows the external total to its owner and to nobody else', async () => {
      const mine = await srv.call('GET', `/api/users/${aliceId}/public-profile`, undefined, alice);
      expect(mine.body.profile.externalService.selfReportedHours).toBe(3.5);

      const theirs = await srv.call('GET', `/api/users/${aliceId}/public-profile`, undefined, bob);
      expect(theirs.status).toBe(200);
      expect(theirs.body.profile).not.toHaveProperty('externalService');

      const staff = await srv.call('GET', `/api/users/${aliceId}/public-profile`, undefined, admin);
      expect(staff.body.profile).not.toHaveProperty('externalService');
    });

    /* The same rule on the itemised record, which is the endpoint an organizer
       reviewing an applicant reads. */
    it('withholds the itemised external log from staff', async () => {
      const mine = await srv.call('GET', `/api/users/${aliceId}/service-record`, undefined, alice);
      expect(mine.status).toBe(200);
      expect(mine.body.external).toHaveLength(1);
      expect(mine.body.external[0].selfReported).toBe(true);
      expect(mine.body.externalWithheld).toBe(false);

      const staff = await srv.call('GET', `/api/users/${aliceId}/service-record`, undefined, admin);
      expect(staff.status).toBe(200);
      expect(staff.body.external).toEqual([]);
      expect(staff.body.externalWithheld).toBe(true);
    });

    it('never appears among certificates', async () => {
      const res = await srv.call('GET', '/api/certificates', undefined, alice);
      const items = res.body.certificates ?? res.body.events ?? [];
      expect(JSON.stringify(items)).not.toContain('Soup kitchen');
    });

    /**
     * Editing is unconditional, and the endpoint has a caller.
     *
     * `PATCH /api/external-hours/:id` existed with no UI behind it, so the one
     * thing a student could not do was correct a wrong date without deleting the
     * entry and retyping the rest. There is no state in which one of these
     * becomes uneditable — nobody else's judgement is stored on it, which is the
     * whole point of the feature being tracking-only.
     */
    it('lets the owner correct an entry, at any time', async () => {
      const res = await srv.call('PATCH', `/api/external-hours/${entryId}`, {
        occurredOn: '2026-05-03', hours: 4,
      }, alice);
      expect(res.status).toBe(200);
      expect(res.body.entry.occurredOn).toBe('2026-05-03');
      expect(res.body.entry.hours).toBe(4);
      /* Still self-reported, because there is no other kind. */
      expect(res.body.entry.selfReported).toBe(true);
      expect(res.body.entry).not.toHaveProperty('status');
    });

    it('validates an edit the same way it validates a new entry', async () => {
      const future = await srv.call('PATCH', `/api/external-hours/${entryId}`, {
        occurredOn: '2099-01-01',
      }, alice);
      expect(future.status).toBe(400);
      expect(future.body.field).toBe('occurredOn');

      const tooMany = await srv.call('PATCH', `/api/external-hours/${entryId}`, { hours: 500 }, alice);
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.field).toBe('hours');
    });

    it('refuses a future date', async () => {
      const res = await srv.call('POST', '/api/external-hours', {
        organizationName: 'x', activityName: 'y', occurredOn: '2099-01-01', hours: 1,
      }, alice);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('occurredOn');
    });

    it('bounds a single entry', async () => {
      const res = await srv.call('POST', '/api/external-hours', {
        organizationName: 'x', activityName: 'y', occurredOn: '2026-05-01', hours: 500,
      }, alice);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('hours');
    });

    /* 404 rather than 403 for somebody else's record: a distinguishable refusal
       would confirm the id exists. */
    it('hides another student\'s entry behind a 404', async () => {
      expect((await srv.call('PATCH', `/api/external-hours/${entryId}`, { hours: 99 }, bob)).status).toBe(404);
      expect((await srv.call('DELETE', `/api/external-hours/${entryId}`, undefined, bob)).status).toBe(404);
    });

    /**
     * There is no review workflow, and these assertions are the pin that keeps
     * one from coming back.
     *
     * The first implementation shipped `GET /api/admin/external-hours` (a queue)
     * and `PATCH /api/admin/external-hours/:id` (verify or reject) on the
     * reasoning that a `service.verify.external` capability existed so somebody
     * must have meant it. Nobody did: this is a student's own note about their
     * own afternoon, and asking an administrator to approve it makes a notebook
     * into an application form.
     *
     * 404 rather than 405: nothing is mounted at these paths at all, for any
     * caller, including the platform owner whose wildcard satisfies every
     * capability.
     */
    it('has no administrative review endpoints, for anybody', async () => {
      for (const actor of [admin, organizer, alice]) {
        expect((await srv.call('GET', '/api/admin/external-hours', undefined, actor)).status).toBe(404);
        expect((await srv.call(
          'PATCH', `/api/admin/external-hours/${entryId}`, { status: 'verified' }, actor
        )).status).toBe(404);
      }
    });

    /**
     * The owner can always edit. There is no state an entry reaches in which it
     * stops being theirs to correct, because there is no other party's judgement
     * recorded on it.
     */
    it('lets the owner edit their own entry, then delete it', async () => {
      const edit = await srv.call('PATCH', `/api/external-hours/${entryId}`, { hours: 4 }, alice);
      expect(edit.status).toBe(200);
      expect(edit.body.entry.hours).toBe(4);
      expect(edit.body.entry.selfReported).toBe(true);
      expect((await srv.call('DELETE', `/api/external-hours/${entryId}`, undefined, alice)).status).toBe(200);
    });
  });
});
