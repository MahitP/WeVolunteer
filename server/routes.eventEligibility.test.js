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
});
