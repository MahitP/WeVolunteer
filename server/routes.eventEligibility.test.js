import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A ban from an organization is a ban from its events.
 *
 * ── The gap this closes ──
 *
 * `organization_bans` was consulted on exactly one path: joining the
 * organization. Applying to that organization's EVENTS consulted nothing, so a
 * banned person could not join the club but could still take a place on every
 * shift the club ran — which is the thing the ban was about.
 *
 * ── Why one gate is enough ──
 *
 * There is a single production path that creates an application, and both of
 * its branches — the insert for a new one and the update that revives a
 * withdrawn one — run through the same handler. Every later state (waitlisted,
 * promoted, accepted by a draw) operates on a row that already exists, so
 * nothing downstream can admit somebody who was refused here. That is asserted
 * below rather than assumed.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const MEMBER = 'leo.chen@example.com';
const OUTSIDER = 'priya.patel@example.com';

describe('applying to an organization event', () => {
  let srv; let db;
  let organizer; let member; let outsider;
  let organizerId; let memberId; let outsiderId;
  let orgId; let orgKey;
  let orgEventId; let publicEventId; let slotOf;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    organizer = await srv.login(ORGANIZER);
    member = await srv.login(MEMBER);
    outsider = await srv.login(OUTSIDER);

    const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;
    organizerId = await idOf(organizer);
    memberId = await idOf(member);
    outsiderId = await idOf(outsider);

    const created = await srv.call('POST', '/api/organizations', {
      name: `Eligibility Org ${Math.random().toString(36).slice(2, 7)}`,
      description: 'An organization used by the event-eligibility tests.',
    }, organizer);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgId = created.body.organization.id;
    orgKey = created.body.organization.slug;

    /* Two events cloned from a real one, so every NOT NULL column is satisfied:
       one belonging to the organization, one belonging to nobody. */
    const tmplEvent = db.prepare('SELECT * FROM events LIMIT 1').get();
    const tmplSlot = db.prepare('SELECT * FROM slots WHERE event_id = ? LIMIT 1').get(tmplEvent.id);
    expect(tmplEvent && tmplSlot, 'no event/slot to clone').toBeTruthy();

    const clone = (table, tmpl, over) => {
      const row = { ...tmpl, ...over };
      const cols = Object.keys(row);
      db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map(c => row[c]));
    };

    const soon = new Date(Date.now() + 7 * 86400000).toISOString();
    const later = new Date(Date.now() + 7 * 86400000 + 3600000).toISOString();

    orgEventId = 'elig-org-event';
    publicEventId = 'elig-public-event';
    clone('events', tmplEvent, {
      id: orgEventId, title: 'Organization event', status: 'open',
      organization_id: orgId, organizer_id: organizerId, application_deadline: soon,
    });
    clone('slots', tmplSlot, { id: 'elig-org-slot', event_id: orgEventId, start_datetime: soon, end_datetime: later });

    clone('events', tmplEvent, {
      id: publicEventId, title: 'Public event', status: 'open',
      organization_id: null, organizer_id: organizerId, application_deadline: soon,
    });
    /* A different time, so applying to both cannot trip the schedule-conflict
       guard and mask what is being measured. */
    const soon2 = new Date(Date.now() + 9 * 86400000).toISOString();
    clone('slots', tmplSlot, { id: 'elig-public-slot', event_id: publicEventId, start_datetime: soon2, end_datetime: soon2 });

    slotOf = { [orgEventId]: 'elig-org-slot', [publicEventId]: 'elig-public-slot' };
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const join = (userId, role = 'member') =>
    db.prepare(`INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
                VALUES (?, ?, ?, ?)`).run(orgId, userId, role, new Date().toISOString());

  const ban = (userId) =>
    db.prepare(`INSERT OR REPLACE INTO organization_bans (id, organization_id, user_id, banned_by, reason, created_at)
                VALUES ('elig-ban', ?, ?, ?, 'Repeatedly no-showed shifts.', ?)`)
      .run(orgId, userId, organizerId, new Date().toISOString());

  const setAudience = (eventId, audience) =>
    db.prepare('UPDATE events SET audience = ? WHERE id = ?').run(audience, eventId);

  const apply = (eventId, session, extra = {}) =>
    srv.call('POST', `/api/events/${eventId}/apply`, { slotId: slotOf[eventId], ...extra }, session);

  beforeEach(() => {
    db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM applications WHERE event_id IN (?, ?)').run(orgEventId, publicEventId);
    db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(orgId);
    join(organizerId, 'manager');
    setAudience(orgEventId, 'everyone');
    setAudience(publicEventId, 'everyone');
  });

  describe('bans', () => {
    it('lets an ordinary member apply, so the refusals below mean something', async () => {
      /* The vacuity guard. If applying were broken for everybody, every
         "cannot apply" assertion would pass without the ban doing anything. */
      join(memberId);
      const res = await apply(orgEventId, member);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('REFUSES a banned user applying to that organization’s event', async () => {
      join(memberId);
      ban(memberId);
      const res = await apply(orgEventId, member);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('organization_banned');
      expect(db.prepare('SELECT COUNT(*) n FROM applications WHERE event_id = ? AND user_id = ?')
        .get(orgEventId, memberId).n, 'an application row was created anyway').toBe(0);
    });

    it('refuses a banned user who is no longer a member either', async () => {
      /* Banning removes the membership, so the realistic state is banned AND
         not a member. Neither on its own may be what refuses. */
      ban(memberId);
      const res = await apply(orgEventId, member);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('organization_banned');
    });

    it('cannot be bypassed with the schedule-conflict override', async () => {
      /**
       * `overrideConflict` exists so somebody can double-book themselves
       * deliberately. It re-enters the same handler, so it must not become a
       * second door into it.
       */
      join(memberId);
      ban(memberId);
      const res = await apply(orgEventId, member, { overrideConflict: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('organization_banned');
    });

    it('cannot be bypassed by reviving a withdrawn application', async () => {
      /**
       * The second branch of the same route: applying again after withdrawing
       * UPDATEs the old row rather than inserting. A gate on the insert alone
       * would have let a banned person walk back in through a row they left
       * behind.
       */
      join(memberId);
      const first = await apply(orgEventId, member);
      expect(first.status).toBe(201);
      /* Self-withdrawal is `PATCH /api/applications/:id` with a status — there
         is no DELETE route, and the row is kept rather than removed, which is
         exactly why reviving it is a path worth guarding. */
      const withdrawn = await srv.call('PATCH', `/api/applications/${first.body.application.id}`,
        { status: 'withdrawn' }, member);
      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);

      ban(memberId);
      const again = await apply(orgEventId, member);
      expect(again.status).toBe(403);
      expect(db.prepare("SELECT status FROM applications WHERE event_id = ? AND user_id = ?")
        .get(orgEventId, memberId).status, 'the withdrawn row was revived').toBe('withdrawn');
    });

    it('does not touch an application made BEFORE the ban', async () => {
      /**
       * The deliberate product rule: a ban stops somebody applying, it does not
       * reach backwards and cancel a place they already hold. Revoking it would
       * be a second, unannounced consequence with no record and no appeal — and
       * an organizer who wants them off a specific shift already has a control
       * for that.
       */
      join(memberId);
      const applied = await apply(orgEventId, member);
      expect(applied.status).toBe(201);

      ban(memberId);
      const row = db.prepare('SELECT status FROM applications WHERE id = ?').get(applied.body.application.id);
      expect(row, 'the existing application was deleted by a later ban').toBeTruthy();
      expect(row.status).not.toBe('withdrawn');
    });

    it('leaves the PUBLIC event alone — a ban is scoped to its organization', async () => {
      join(memberId);
      ban(memberId);
      const res = await apply(publicEventId, member);
      expect(res.status, 'a ban from one club blocked an unrelated public event').toBe(201);
    });

    it('restores eligibility when the ban is lifted', async () => {
      join(memberId);
      ban(memberId);
      expect((await apply(orgEventId, member)).status).toBe(403);

      db.prepare('UPDATE organization_bans SET lifted_at = ? WHERE organization_id = ? AND user_id = ?')
        .run(new Date().toISOString(), orgId, memberId);

      const res = await apply(orgEventId, member);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
  });

  describe('audience', () => {
    it('lets anybody apply to an organization event open to everyone', async () => {
      /* `organization_id` alone must not restrict anything — most events a club
         posts are open calls, and that is the default. */
      const res = await apply(orgEventId, outsider);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('REFUSES a non-member applying to a members-only event', async () => {
      setAudience(orgEventId, 'organization');
      const res = await apply(orgEventId, outsider);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('organization_members_only');
    });

    it('lets a member apply to the same event', async () => {
      setAudience(orgEventId, 'organization');
      join(outsiderId);
      const res = await apply(orgEventId, outsider);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('still refuses a BANNED member of a members-only event', async () => {
      /* Membership and the ban are separate facts, and the ban wins. */
      setAudience(orgEventId, 'organization');
      join(memberId);
      ban(memberId);
      const res = await apply(orgEventId, member);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('organization_banned');
    });

    it('ignores an organization id supplied by the client', async () => {
      /**
       * The tampering case. The applicant names a slot; they do not get to
       * nominate which organization they would like to be measured against.
       * Every fact comes off the event row.
       */
      setAudience(orgEventId, 'organization');
      const res = await apply(orgEventId, outsider, { organizationId: null, audience: 'everyone' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('organization_members_only');
    });

    it('leaves a members-only event with no organization open, rather than shut', async () => {
      /**
       * Fails safe. An event marked members-only whose organization link is
       * missing is a broken record; refusing everybody would silently close a
       * shift nobody could reopen, so it stays open and visible instead.
       */
      setAudience(publicEventId, 'organization');
      const res = await apply(publicEventId, outsider);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });
  });

  describe('the organizer of the event', () => {
    it('is refused before the handler, because they do not hold event.apply', async () => {
      /**
       * A global organizer cannot apply to ANY event: `event.apply` appears
       * only in the student capability list, so `requireCap` refuses them at
       * the middleware and the handler never runs.
       *
       * The `own_event` rule inside `eventApplicationEligibility` is therefore
       * not for them — it exists for an account that DOES hold `event.apply`
       * and can still run an event, which is precisely a student organizer.
       * That case is tested where such an account exists.
       */
      const res = await apply(publicEventId, organizer);
      expect(res.status).toBe(403);
      expect(res.body.code).toBeUndefined();
    });
  });

  describe('setting and changing the audience', () => {
    /* A real event through the real route, so validation, storage and the
       response shape are all exercised rather than a hand-written row. */
    const createEvent = (body, session) => srv.call('POST', '/api/events', {
      title: 'Audience fixture',
      description: 'An event used by the audience tests.',
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

    it('defaults to everyone when nothing is said', async () => {
      const res = await createEvent({}, organizer);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(db.prepare('SELECT audience FROM events WHERE id = ?').get(res.body.id).audience)
        .toBe('everyone');
    });

    it('stores a members-only event against its organization', async () => {
      const res = await createEvent({ organizationId: orgId, audience: 'organization' }, organizer);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = db.prepare('SELECT audience, organization_id FROM events WHERE id = ?').get(res.body.id);
      expect(row).toMatchObject({ audience: 'organization', organization_id: orgId });
    });

    it('REFUSES members-only with no organization', async () => {
      /* "Members only" of nothing is a shift nobody can join. Refused rather
         than quietly corrected to open, which would publish a different event
         from the one the organizer described. */
      const res = await createEvent({ audience: 'organization' }, organizer);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('organization_required');
    });

    it('refuses an organization the caller does not manage', async () => {
      /**
       * The tampering case at creation. `outsider` is a student here, but the
       * check that matters is `canManage` — publishing under a club's name and
       * restricting a shift to its members is a membership question, not a
       * capability one.
       */
      const res = await createEvent({ organizationId: orgId, audience: 'organization' }, outsider);
      expect([400, 403]).toContain(res.status);
      expect(res.status).not.toBe(201);
    });

    it('ignores an unrecognised audience rather than storing it', async () => {
      /* Anything that is not the literal `organization` reads as open, so an
         unknown value must not be persisted and later interpreted by somebody
         else's code. */
      const res = await createEvent({ organizationId: orgId, audience: 'friends-only' }, organizer);
      expect(res.status).toBe(201);
      expect(db.prepare('SELECT audience FROM events WHERE id = ?').get(res.body.id).audience)
        .toBe('everyone');
    });

  /**
   * An edit that keeps the existing shift.
   *
   * `PUT` retains only slots that arrive WITH an id it already knows
   * (`slots.filter(sl => sl.id && existingIds.includes(sl.id))`); anything else
   * is a replacement, and dropping a slot cascade-deletes the applications on
   * it. So an edit that omits the id destroys applications for reasons that have
   * nothing to do with the audience — which is what the first draft of the
   * test below did, and it looked exactly like the bug it was checking for.
   */
    const editEvent = (id, body, session) => {
      const slot = db.prepare('SELECT * FROM slots WHERE event_id = ? LIMIT 1').get(id);
      return srv.call('PUT', `/api/events/${id}`, {
        title: 'Audience fixture', description: 'Edited.', category: 'Other', location: 'Somewhere',
        applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
        slots: [{
          id: slot?.id,
          name: slot?.name ?? 'Shift',
          startDatetime: slot?.start_datetime ?? new Date(Date.now() + 6 * 86400000).toISOString(),
          endDatetime: slot?.end_datetime ?? new Date(Date.now() + 6 * 86400000 + 3600000).toISOString(),
          description: slot?.description ?? '',
          maxSpots: slot?.max_spots ?? 5,
          hoursAwarded: slot?.hours_awarded ?? 2,
        }],
        ...body,
      }, session);
    };

    it('narrows an open event to members only', async () => {
      const created = await createEvent({ organizationId: orgId }, organizer);
      const res = await editEvent(created.body.id, { audience: 'organization' }, organizer);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(db.prepare('SELECT audience FROM events WHERE id = ?').get(created.body.id).audience)
        .toBe('organization');
    });

    it('does NOT invalidate an application made while it was open', async () => {
      /**
       * The rule this pass chose and records. Somebody who applied to something
       * genuinely open keeps their place when it narrows; taking it away
       * silently would remove a place with no notice and no record. The
       * audience governs who may apply from now on.
       */
      const created = await createEvent({ organizationId: orgId }, organizer);
      const eventId = created.body.id;
      const slotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(eventId).id;

      const applied = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, outsider);
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);

      await editEvent(eventId, { audience: 'organization' }, organizer);

      const row = db.prepare('SELECT status FROM applications WHERE id = ?').get(applied.body.application.id);
      expect(row, 'the application was deleted by the narrowing').toBeTruthy();
      expect(row.status).not.toBe('withdrawn');
    });

    it('stops NEW applications from non-members once narrowed', async () => {
      const created = await createEvent({ organizationId: orgId }, organizer);
      const eventId = created.body.id;
      const slotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(eventId).id;
      await editEvent(eventId, { audience: 'organization' }, organizer);

      const res = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, outsider);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('organization_members_only');
    });

    it('widens a members-only event back to everyone', async () => {
      /* Every event this block creates runs at the same hour, so an application
         left by an earlier test collides here as a schedule conflict rather
         than as the audience decision being measured. */
      db.prepare('DELETE FROM applications WHERE user_id = ?').run(outsiderId);
      const created = await createEvent({ organizationId: orgId, audience: 'organization' }, organizer);
      const eventId = created.body.id;
      await editEvent(eventId, { audience: 'everyone' }, organizer);

      const slotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(eventId).id;
      const res = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, outsider);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('leaves the audience alone when the field is omitted', async () => {
      /* A client that predates this field must not reopen a members-only shift
         by saving an unrelated edit. */
      const created = await createEvent({ organizationId: orgId, audience: 'organization' }, organizer);
      await editEvent(created.body.id, { location: 'Moved' }, organizer);
      expect(db.prepare('SELECT audience FROM events WHERE id = ?').get(created.body.id).audience)
        .toBe('organization');
    });

    it('REFUSES narrowing an event that belongs to no organization', async () => {
      const created = await createEvent({}, organizer);
      const res = await editEvent(created.body.id, { audience: 'organization' }, organizer);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('organization_required');
    });

    it('refuses an edit from somebody who does not host the event', async () => {
      const created = await createEvent({ organizationId: orgId }, organizer);
      const res = await editEvent(created.body.id, { audience: 'organization' }, outsider);
      expect([403, 404]).toContain(res.status);
      expect(db.prepare('SELECT audience FROM events WHERE id = ?').get(created.body.id).audience)
        .toBe('everyone');
    });

    it('tells the client which audience an event has', async () => {
      /* The list labels members-only events rather than showing an apply
         button that will be refused. */
      const created = await createEvent({ organizationId: orgId, audience: 'organization' }, organizer);
      const list = await srv.call('GET', '/api/events?scope=listable&limit=60&offset=0', undefined, member);
      const found = (list.body.events || []).find(e => e.id === created.body.id);
      expect(found?.audience).toBe('organization');
    });
  });

  describe('what the event tells the reader about the restriction', () => {
    /**
     * A members-only event stays discoverable. Hiding it would mean somebody
     * who would happily join the club never learns the club exists — so it is
     * listed, labelled, and refused at the point of applying, with a reason.
     */
    const listed = async (session) => {
      const res = await srv.call('GET', '/api/events?scope=listable&limit=60&offset=0', undefined, session);
      return (res.body.events || []).find(e => e.id === orgEventId);
    };

    beforeEach(() => {
      db.prepare("UPDATE events SET audience = 'organization' WHERE id = ?").run(orgEventId);
    });

    it('is still listed to somebody who cannot apply to it', async () => {
      const card = await listed(outsider);
      expect(card, 'the members-only event vanished from the list').toBeTruthy();
      expect(card.audience).toBe('organization');
    });

    it('still says whose it is, so they know what to join', async () => {
      const card = await listed(outsider);
      expect(card.organizationId).toBe(orgId);
      expect(card.organizationName).toBeTruthy();
    });

    it('tells an outsider they are not a member', async () => {
      expect((await listed(outsider)).viewerIsMember).toBe(false);
    });

    it('tells a member they are one', async () => {
      db.prepare(`INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
                  VALUES (?, ?, 'member', ?)`).run(orgId, memberId, new Date().toISOString());
      expect((await listed(member)).viewerIsMember).toBe(true);
    });

    it('says nothing either way for an event with no organization', async () => {
      const res = await srv.call('GET', '/api/events?scope=listable&limit=60&offset=0', undefined, outsider);
      const card = (res.body.events || []).find(e => e.id === publicEventId);
      expect(card.viewerIsMember).toBeNull();
    });

    it('does not leak anybody ELSE\u2019s membership', async () => {
      /* The field answers "am I a member", and takes no parameter that could
         point it at somebody else — the same rule `viewerBan` follows. */
      db.prepare(`INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
                  VALUES (?, ?, 'member', ?)`).run(orgId, memberId, new Date().toISOString());
      const card = await listed(outsider);
      expect(card.viewerIsMember).toBe(false);
      expect(Object.keys(card).filter(k => /member/i.test(k))).toEqual(['viewerIsMember']);
    });
  });
});
