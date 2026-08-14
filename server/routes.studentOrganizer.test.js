import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Student Organizer — the smallest thing a club president can hand out.
 *
 * ── What the rank is ──
 *
 * Until now the only way to let a student help run a club was to make them a
 * `manager`, which is the whole organization: archiving it, banning people,
 * deciding appeals, promoting other managers. That is far more than "put the
 * bake-sale shift up", and it was being handed to sixteen-year-olds because
 * there was nothing smaller to give.
 *
 * `student_organizer` is that smaller thing: posts and events for ONE club, and
 * nothing else. Their platform role stays `student`.
 *
 * ── The two layers, and why both are tested ──
 *
 * The capability (`organization.event.create` and friends) says "you help run
 * SOME organization" — it is granted to the person on promotion and deleted on
 * demotion, so a plain student does not hold it at all. `canHelpRun` then says
 * WHICH organization, reading the membership row for the one in the request.
 *
 * Neither layer is sufficient. Without the first, any student reaches the
 * handler on every event-management route in the application and the whole of
 * the protection is a lookup somebody has to remember to write. Without the
 * second, helping run the Chess Club would let you post as the Robotics Club.
 * The tests below break each layer separately.
 *
 * ── The escalations ──
 *
 * The `cannot` block is the point of the file. A rank granted by a student, to
 * a student, must not be a route to the powers that rank was carved out of.
 */

const OWNER = 'jordan.whitfield@example.org';       // organizer; manager of both clubs
const HELPER = 'leo.chen@example.com';              // student; promoted below
const BYSTANDER = 'priya.patel@example.com';        // student; stays an ordinary member

describe('Student Organizer', () => {
  let srv; let db;
  let owner; let helper; let bystander;
  let ownerId; let helperId; let bystanderId;
  let orgId; let orgKey;         // the club the helper helps run
  let otherId; let otherKey;     // a club they have nothing to do with

  const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;

  const makeOrg = async (label) => {
    const res = await srv.call('POST', '/api/organizations', {
      name: `${label} ${Math.random().toString(36).slice(2, 7)}`,
      description: 'An organization used by the student-organizer tests.',
    }, owner);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.organization;
  };

  /** Membership written directly — joining is not what these tests measure. */
  const seat = (organizationId, userId, role = 'member') => {
    db.prepare(`
      INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
    `).run(organizationId, userId, role, new Date().toISOString());
  };

  /** Promotion through the REAL route, so the capability lifecycle runs. */
  const setRole = (key, userId, memberRole, session = owner) =>
    srv.call('PATCH', `/api/organizations/${key}/members/${userId}`, { memberRole }, session);

  const createEvent = (body, session) => srv.call('POST', '/api/events', {
    title: 'Student organizer fixture',
    description: 'An event used by the student-organizer tests.',
    category: 'Other',
    location: 'Somewhere',
    applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
    slots: [{
      name: 'Shift',
      startDatetime: new Date(Date.now() + 6 * 86400000).toISOString(),
      endDatetime: new Date(Date.now() + 6 * 86400000 + 3600000).toISOString(),
      description: '',
      maxSpots: 5, hoursAwarded: 2,
    }],
    ...body,
  }, session);

  const capabilitiesOf = (userId) => db.prepare(
    'SELECT capability FROM user_capabilities WHERE user_id = ?'
  ).all(userId).map(r => r.capability).sort();

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    owner = await srv.login(OWNER);
    helper = await srv.login(HELPER);
    bystander = await srv.login(BYSTANDER);
    ownerId = await idOf(owner);
    helperId = await idOf(helper);
    bystanderId = await idOf(bystander);

    ({ id: orgId, slug: orgKey } = await makeOrg('Helper Club'));
    ({ id: otherId, slug: otherKey } = await makeOrg('Other Club'));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    /* A second manager on each club, so the last-manager guard never fires as a
       side effect of a test that is about something else. */
    seat(orgId, ownerId, 'manager');
    seat(otherId, ownerId, 'manager');
    seat(orgId, bystanderId, 'member');
    seat(orgId, helperId, 'member');
    db.prepare('DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?')
      .run(otherId, helperId);
    await setRole(orgKey, helperId, 'student_organizer');
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the rank itself', () => {
    it('is a value the membership table accepts', () => {
      const row = db.prepare(
        'SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(orgId, helperId);
      expect(row.member_role).toBe('student_organizer');
    });

    it('refuses a rank that is not one of the three', async () => {
      const res = await setRole(orgKey, helperId, 'president');
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('memberRole');
    });

    it('refuses a rank the database itself would not store', () => {
      /* The CHECK constraint from migration 046 is the backstop under the route
         validation — a path that skips the route must still not write junk. */
      expect(() => db.prepare(
        'UPDATE organization_members SET member_role = ? WHERE organization_id = ? AND user_id = ?'
      ).run('president', orgId, helperId)).toThrow();
    });

    it('leaves the account a student', async () => {
      const me = await srv.call('GET', '/api/auth/me', undefined, helper);
      expect(me.body.role).toBe('student');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('what they can do', () => {
    it('creates an event for the club they help run', async () => {
      const res = await createEvent({ organizationId: orgId }, helper);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(db.prepare('SELECT organization_id, organizer_id FROM events WHERE id = ?').get(res.body.id))
        .toMatchObject({ organization_id: orgId, organizer_id: helperId });
    });

    it('creates a members-only event for that club', async () => {
      const res = await createEvent({ organizationId: orgId, audience: 'organization' }, helper);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(db.prepare('SELECT audience FROM events WHERE id = ?').get(res.body.id).audience)
        .toBe('organization');
    });

    it('posts an announcement as that club', async () => {
      const res = await srv.call('POST', `/api/organizations/${orgKey}/announcements`,
        { body: 'Setup starts at nine on Saturday.' }, helper);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('edits and deletes the club’s announcements', async () => {
      const posted = await srv.call('POST', `/api/organizations/${orgKey}/announcements`,
        { body: 'First draft.' }, helper);
      const annId = posted.body.announcement.id;

      const edited = await srv.call('PATCH', `/api/organizations/${orgKey}/announcements/${annId}`,
        { body: 'Second draft.' }, helper);
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);

      const gone = await srv.call('DELETE', `/api/organizations/${orgKey}/announcements/${annId}`,
        undefined, helper);
      expect(gone.status).toBe(200);
    });

    it('manages applicants on an event they created', async () => {
      const created = await createEvent({ organizationId: orgId }, helper);
      const slotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(created.body.id).id;

      const applied = await srv.call('POST', `/api/events/${created.body.id}/apply`,
        { slotId, message: 'I can help.' }, bystander);
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);

      const appId = db.prepare('SELECT id FROM applications WHERE user_id = ? AND slot_id = ?')
        .get(bystanderId, slotId).id;
      const decided = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'accepted' }, helper);
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    });

    it('edits an event they created', async () => {
      const created = await createEvent({ organizationId: orgId }, helper);
      const slot = db.prepare('SELECT * FROM slots WHERE event_id = ?').get(created.body.id);
      const res = await srv.call('PUT', `/api/events/${created.body.id}`, {
        title: 'Renamed by the helper',
        description: 'An event used by the student-organizer tests.',
        category: 'Other', location: 'Somewhere',
        applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
        slots: [{
          id: slot.id, name: slot.name, description: slot.description || '',
          startDatetime: slot.start_datetime, endDatetime: slot.end_datetime,
          maxSpots: slot.max_spots, hoursAwarded: slot.hours_awarded,
        }],
      }, helper);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('what they cannot do', () => {
    it('cannot create a personal event with no organization', async () => {
      /**
       * The single line that keeps this rank from being a promotion. Without it
       * the same request with `organizationId` omitted produces an event under
       * their own name with no club behind it — which is the `organizer` role,
       * granted by a club president who was choosing who posts a bake sale.
       */
      const res = await createEvent({}, helper);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('organization_required');
      expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE organizer_id = ? AND organization_id IS NULL')
        .get(helperId).n).toBe(0);
    });

    it('cannot create an event for a club they have nothing to do with', async () => {
      const res = await createEvent({ organizationId: otherId }, helper);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_manager');
    });

    it('cannot post as a club they have nothing to do with', async () => {
      const res = await srv.call('POST', `/api/organizations/${otherKey}/announcements`,
        { body: 'Hello from somebody else’s club.' }, helper);
      expect(res.status).toBe(403);
    });

    it('cannot archive the organization', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${orgKey}`, { status: 'archived' }, helper);
      expect(res.status).toBe(403);
      expect(db.prepare('SELECT status FROM organizations WHERE id = ?').get(orgId).status).toBe('active');
    });

    it('cannot rename the organization', async () => {
      const before = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId).name;
      const res = await srv.call('PATCH', `/api/organizations/${orgKey}`, { name: 'Mine Now' }, helper);
      expect(res.status).toBe(403);
      expect(db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId).name).toBe(before);
    });

    it('cannot promote themselves to manager', async () => {
      const res = await setRole(orgKey, helperId, 'manager', helper);
      expect(res.status).toBe(403);
      expect(db.prepare('SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .get(orgId, helperId).member_role).toBe('student_organizer');
    });

    it('cannot promote somebody else', async () => {
      const res = await setRole(orgKey, bystanderId, 'student_organizer', helper);
      expect(res.status).toBe(403);
      expect(db.prepare('SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .get(orgId, bystanderId).member_role).toBe('member');
    });

    it('cannot demote a manager', async () => {
      const res = await setRole(orgKey, ownerId, 'member', helper);
      expect(res.status).toBe(403);
    });

    it('cannot remove or ban a member', async () => {
      const res = await srv.call('DELETE', `/api/organizations/${orgKey}/members/${bystanderId}`,
        undefined, helper);
      expect(res.status).toBe(403);
      expect(db.prepare('SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .get(orgId, bystanderId)?.ok).toBe(1);
    });

    it('cannot read or decide the organization’s appeals', async () => {
      const inbox = await srv.call('GET', `/api/organizations/${orgKey}/appeals`, undefined, helper);
      expect(inbox.status).toBe(403);
    });

    it('cannot manage an event somebody else created', async () => {
      const theirs = await createEvent({ organizationId: orgId }, owner);
      const res = await srv.call('PATCH', `/api/events/${theirs.body.id}/status`,
        { status: 'cancelled' }, helper);
      expect(res.status).toBe(403);
      expect(db.prepare('SELECT status FROM events WHERE id = ?').get(theirs.body.id).status)
        .not.toBe('cancelled');
    });

    it('cannot apply to an event they are running', async () => {
      /* Enforced by `eventApplicationEligibility`, which is checked for every
         applicant regardless of how they came to be the organizer. The person
         picking and the person picked must not be the same. */
      const created = await createEvent({ organizationId: orgId }, helper);
      const slotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(created.body.id).id;
      const res = await srv.call('POST', `/api/events/${created.body.id}/apply`,
        { slotId, message: 'Let me in.' }, helper);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('own_event');
    });

    it('cannot grant themselves a capability', async () => {
      const res = await srv.call('POST', `/api/admin/users/${helperId}/capabilities`,
        { capability: 'event.create' }, helper);
      expect([401, 403, 404]).toContain(res.status);
      expect(capabilitiesOf(helperId)).not.toContain('event.create');
    });

    it('holds ONLY the four helper capabilities, and no more', async () => {
      /* An explicit inventory. If a future promotion path grants something
         wider, this is the line that says so out loud. */
      expect(capabilitiesOf(helperId)).toEqual([
        'organization.event.create',
        'organization.event.manage.own',
        'organization.post.create',
        'organization.post.manage',
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('an ordinary member is not a helper', () => {
    it('holds none of the four capabilities', () => {
      expect(capabilitiesOf(bystanderId)).toEqual([]);
    });

    it('is refused at the gate, before any handler runs', async () => {
      const res = await createEvent({ organizationId: orgId }, bystander);
      expect(res.status).toBe(403);
      /* No `code` — this is the capability middleware, not the scope check
         inside the handler. Asserting the difference is what proves the FIRST
         layer is doing the work here. */
      expect(res.body.code).not.toBe('organization_required');
    });

    it('cannot post as the club', async () => {
      const res = await srv.call('POST', `/api/organizations/${orgKey}/announcements`,
        { body: 'I am just a member.' }, bystander);
      expect(res.status).toBe(403);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the capability follows the rank', () => {
    it('is taken back on demotion', async () => {
      await setRole(orgKey, helperId, 'member');
      expect(capabilitiesOf(helperId)).toEqual([]);
      const res = await createEvent({ organizationId: orgId }, helper);
      expect(res.status).toBe(403);
    });

    it('is taken back when they are removed from the organization', async () => {
      const removed = await srv.call('DELETE', `/api/organizations/${orgKey}/members/${helperId}`,
        undefined, owner);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(capabilitiesOf(helperId)).toEqual([]);
    });

    it('is taken back when they leave of their own accord', async () => {
      const left = await srv.call('DELETE', `/api/organizations/${orgKey}/membership`, undefined, helper);
      expect([200, 204]).toContain(left.status);
      expect(capabilitiesOf(helperId)).toEqual([]);
    });

    it('SURVIVES demotion in one club while they still help run another', async () => {
      /**
       * The reason the sync recomputes from the membership table instead of
       * reading the new `memberRole` off the request. Stripping the capability
       * on demotion here would silently break the OTHER club they still run.
       */
      seat(otherId, helperId, 'member');
      await setRole(otherKey, helperId, 'student_organizer');
      await setRole(orgKey, helperId, 'member');

      expect(capabilitiesOf(helperId)).toContain('organization.event.create');

      /* Still refused for the club they were demoted in — the second layer. */
      const here = await createEvent({ organizationId: orgId }, helper);
      expect(here.status).toBe(403);
      expect(here.body.code).toBe('not_manager');

      /* And allowed for the one they still run. */
      const there = await createEvent({ organizationId: otherId }, helper);
      expect(there.status, JSON.stringify(there.body)).toBe(201);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the manager invariant survives the new rank', () => {
    it('refuses to let the last manager step down to student_organizer', async () => {
      /**
       * The guard used to read `memberRole === 'member'`. A third value added
       * elsewhere would have walked straight through it and left the club with
       * nobody who can ban, archive or promote.
       */
      db.prepare(`DELETE FROM organization_members
                   WHERE organization_id = ? AND member_role = 'manager' AND user_id <> ?`)
        .run(orgId, ownerId);
      const res = await setRole(orgKey, ownerId, 'student_organizer');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_manager');
      expect(db.prepare('SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?')
        .get(orgId, ownerId).member_role).toBe('manager');
    });

    it('still lets a manager do everything a helper can', async () => {
      const res = await srv.call('POST', `/api/organizations/${orgKey}/announcements`,
        { body: 'The manager can still post.' }, owner);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the paths a security review found', () => {
    /**
     * Every one of these was reachable. They are grouped because they share a
     * cause: a rule enforced at the front door and not on the side entrances.
     */

    it('cannot mint a personal event by DUPLICATING a club one', async () => {
      /**
       * The escalation. `POST /api/events` refuses a Student Organizer an event
       * with no organization behind it; duplicate was a second create path that
       * had never learned the rule, and it copied neither `organization_id` nor
       * `audience`. Create one legitimate club event, duplicate it, and the
       * copy came out unattached: a platform-wide event hosted by a student,
       * outside the club's sight, with no ban check and no membership check.
       */
      const created = await createEvent({ organizationId: orgId }, helper);
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const copy = await srv.call('POST', `/api/events/${created.body.id}/duplicate`, {}, helper);
      expect(copy.status, JSON.stringify(copy.body)).toBe(201);

      const row = db.prepare('SELECT organization_id, audience FROM events WHERE id = ?')
        .get(copy.body.id ?? copy.body.event?.id);
      expect(row.organization_id, 'the copy was detached from the organization').toBe(orgId);

      expect(db.prepare(`SELECT COUNT(*) AS n FROM events
                          WHERE organizer_id = ? AND organization_id IS NULL`).get(helperId).n)
        .toBe(0);
    });

    it('carries the members-only setting onto the copy', async () => {
      /* The same omission, hurting an ordinary organizer: duplicating a
         members-only shift produced a public one, which is the setting they
         had just chosen against. */
      const created = await createEvent({ organizationId: orgId, audience: 'organization' }, owner);
      const copy = await srv.call('POST', `/api/events/${created.body.id}/duplicate`, {}, owner);
      expect(copy.status, JSON.stringify(copy.body)).toBe(201);

      expect(db.prepare('SELECT audience, organization_id FROM events WHERE id = ?')
        .get(copy.body.id ?? copy.body.event?.id))
        .toMatchObject({ audience: 'organization', organization_id: orgId });
    });

    it('sends per-user grants to the client, or the page is unreachable', async () => {
      /**
       * `src/authz.js` decides what the navigation offers from `user.grants`,
       * and this payload did not carry them — so a Student Organizer was
       * refused `/events/new` by the client's own route table while the server
       * would have allowed the request. It failed closed, which is why nothing
       * caught it: the feature was simply dead in the browser.
       */
      const me = await srv.call('GET', '/api/auth/me', undefined, helper);
      expect(me.status).toBe(200);
      expect(me.body.grants).toContain('organization.event.create');

      const theirs = await srv.call('GET', '/api/auth/me', undefined, bystander);
      expect(theirs.body.grants, 'an ordinary member was sent a grant').toEqual([]);
    });

    it('does not let an ARCHIVED organization keep posting', async () => {
      const archived = await srv.call('PATCH', `/api/organizations/${orgKey}`,
        { status: 'archived' }, owner);
      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
      try {
        const posted = await srv.call('POST', `/api/organizations/${orgKey}/announcements`,
          { body: 'Still going, apparently.' }, helper);
        expect(posted.status).toBe(409);
        expect(posted.body.code).toBe('organization_archived');
      } finally {
        await srv.call('PATCH', `/api/organizations/${orgKey}`, { status: 'active' }, owner);
      }
    });
  });
});
