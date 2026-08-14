import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Five people, one club, one afternoon.
 *
 * ── Why a simulation and not more unit tests ──
 *
 * Bans, audiences and the Student Organizer rank were built separately and each
 * has its own file proving its own rule. What none of them proves is what
 * happens when all three are true of the same club at once: the person who was
 * banned is also a former member, the members-only event was posted by somebody
 * who is not a manager, and the outsider can see all of it and take part in none
 * of it.
 *
 * This walks the whole matrix in one pass, in the order the afternoon actually
 * happens, and asserts what each of the five can see and do at each step. It
 * duplicates coverage on purpose — the value is the combination, and a rule that
 * only holds in isolation is not a rule.
 *
 * ── The cast ──
 *
 *   A — the manager. An organizer, runs the club.
 *   B — the Student Organizer. A student, promoted by A.
 *   C — an ordinary member. A student, joined the club.
 *   D — an outsider. A student, has nothing to do with the club.
 *   E — banned. Was a member; A banned them.
 */

const A = 'jordan.whitfield@example.org';
const B = 'leo.chen@example.com';
const C = 'priya.patel@example.com';
const D = 'arjun.gopal@example.com';
const E = 'ethan.miller@example.com';

describe('one club, five people', () => {
  let srv; let db;
  const s = {};   // sessions, by letter
  const id = {};  // user ids, by letter
  let orgId; let orgKey;
  let openEventId; let openSlotId;
  let membersEventId; let membersSlotId;

  const idOf = async (session) => (await srv.call('GET', '/api/auth/me', undefined, session)).body.id;

  const setRoleAsA = (userId, memberRole) =>
    srv.call('PATCH', `/api/organizations/${orgKey}/members/${userId}`, { memberRole }, s.A);

  const seat = (userId, role) => db.prepare(`
    INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
    VALUES (?, ?, ?, ?)
  `).run(orgId, userId, role, new Date().toISOString());

  const createEvent = (body, session) => srv.call('POST', '/api/events', {
    title: 'Simulation event',
    description: 'An event used by the organization-access simulation.',
    category: 'Other',
    location: 'The gym',
    applicationDeadline: new Date(Date.now() + 5 * 86400000).toISOString(),
    slots: [{
      name: 'Shift', description: '',
      startDatetime: new Date(Date.now() + 6 * 86400000).toISOString(),
      endDatetime: new Date(Date.now() + 6 * 86400000 + 3600000).toISOString(),
      maxSpots: 5, hoursAwarded: 2,
    }],
    ...body,
  }, session);

  const apply = (eventId, slotId, session) =>
    srv.call('POST', `/api/events/${eventId}/apply`, { slotId, message: 'I can help.' }, session);

  const cardFor = async (eventId, session) => {
    const res = await srv.call('GET', '/api/events?scope=listable&limit=60&offset=0', undefined, session);
    return (res.body.events || []).find(e => e.id === eventId) || null;
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    for (const [letter, email] of [['A', A], ['B', B], ['C', C], ['D', D], ['E', E]]) {
      s[letter] = await srv.login(email);
      id[letter] = await idOf(s[letter]);
    }

    const created = await srv.call('POST', '/api/organizations', {
      name: `Simulation Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club used by the organization-access simulation.',
    }, s.A);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgId = created.body.organization.id;
    orgKey = created.body.organization.slug;
  }, 90000);

  afterAll(async () => { await srv?.close(); });

  // ───────────────────────────────────────────────────────────────────────────
  it('1. A runs the club; B, C and E join it; D stays outside', async () => {
    seat(id.A, 'manager');
    seat(id.B, 'member');
    seat(id.C, 'member');
    seat(id.E, 'member');

    const page = await srv.call('GET', `/api/organizations/${orgKey}`, undefined, s.A);
    expect(page.status).toBe(200);
    const roster = new Map(page.body.members.map(m => [m.id, m.memberRole]));
    expect(roster.get(id.A)).toBe('manager');
    expect(roster.get(id.D)).toBeUndefined();
  });

  it('2. A promotes B to Student Organizer, and only A could have', async () => {
    /* C trying it first, so the refusal is measured before the promotion
       rather than after — a test that promotes and then checks would prove
       nothing about who was allowed to. */
    const byC = await srv.call('PATCH', `/api/organizations/${orgKey}/members/${id.B}`,
      { memberRole: 'student_organizer' }, s.C);
    expect(byC.status).toBe(403);

    const byA = await srv.call('PATCH', `/api/organizations/${orgKey}/members/${id.B}`,
      { memberRole: 'student_organizer' }, s.A);
    expect(byA.status, JSON.stringify(byA.body)).toBe(200);

    const caps = db.prepare('SELECT capability FROM user_capabilities WHERE user_id = ?')
      .all(id.B).map(r => r.capability).sort();
    expect(caps).toEqual([
      'organization.event.create', 'organization.event.manage.own',
      'organization.post.create', 'organization.post.manage',
    ]);
  });

  it('3. B posts the notice; C, D and E cannot post as the club', async () => {
    const byB = await srv.call('POST', `/api/organizations/${orgKey}/announcements`,
      { body: 'Setup is at nine on Saturday.' }, s.B);
    expect(byB.status, JSON.stringify(byB.body)).toBe(201);

    for (const letter of ['C', 'D', 'E']) {
      const res = await srv.call('POST', `/api/organizations/${orgKey}/announcements`,
        { body: `Posting as the club, from ${letter}.` }, s[letter]);
      expect(res.status, `${letter} posted as the club`).toBe(403);
    }
  });

  it('4. B puts up an open event and a members-only one', async () => {
    const open = await createEvent({ organizationId: orgId, title: 'Open day' }, s.B);
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    openEventId = open.body.id;
    openSlotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(openEventId).id;

    const members = await createEvent({
      organizationId: orgId, audience: 'organization', title: 'Members practice',
      /* A different day, so a schedule conflict cannot mask an eligibility
         answer later on. */
      slots: [{
        name: 'Shift', description: '',
        startDatetime: new Date(Date.now() + 9 * 86400000).toISOString(),
        endDatetime: new Date(Date.now() + 9 * 86400000 + 3600000).toISOString(),
        maxSpots: 5, hoursAwarded: 2,
      }],
    }, s.B);
    expect(members.status, JSON.stringify(members.body)).toBe(201);
    membersEventId = members.body.id;
    membersSlotId = db.prepare('SELECT id FROM slots WHERE event_id = ?').get(membersEventId).id;

    expect(db.prepare('SELECT audience FROM events WHERE id = ?').get(membersEventId).audience)
      .toBe('organization');
  });

  it('5. B cannot put up an event with no club behind it', async () => {
    const res = await createEvent({ title: 'My own event' }, s.B);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('organization_required');
  });

  it('6. D can SEE both events, and is told which one is not for them', async () => {
    /* The whole argument for not hiding it: D learns the club exists, and what
       joining it would get them. */
    const open = await cardFor(openEventId, s.D);
    const members = await cardFor(membersEventId, s.D);
    expect(open, 'the open event vanished for an outsider').toBeTruthy();
    expect(members, 'the members-only event was hidden from an outsider').toBeTruthy();
    expect(members.audience).toBe('organization');
    expect(members.organizationName).toBeTruthy();
    expect(members.viewerIsMember).toBe(false);
  });

  it('7. D may apply to the open event and not to the members-only one', async () => {
    const ok = await apply(openEventId, openSlotId, s.D);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    const no = await apply(membersEventId, membersSlotId, s.D);
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('organization_members_only');
  });

  it('8. C, a member, may apply to both', async () => {
    expect((await apply(openEventId, openSlotId, s.C)).status).toBe(201);
    expect((await apply(membersEventId, membersSlotId, s.C)).status).toBe(201);
  });

  it('9. B cannot apply to the events B is running', async () => {
    for (const [eventId, slotId] of [[openEventId, openSlotId], [membersEventId, membersSlotId]]) {
      const res = await apply(eventId, slotId, s.B);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('own_event');
    }
  });

  it('10. E applies, and is accepted, while still in good standing', async () => {
    const applied = await apply(openEventId, openSlotId, s.E);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);

    const appId = db.prepare('SELECT id FROM applications WHERE user_id = ? AND slot_id = ?')
      .get(id.E, openSlotId).id;
    const accepted = await srv.call('PATCH', `/api/applications/${appId}`, { status: 'accepted' }, s.B);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  });

  it('11. A bans E — and B could not have', async () => {
    const byB = await srv.call('DELETE', `/api/organizations/${orgKey}/members/${id.E}`,
      { mode: 'ban', reason: 'Repeatedly no-showed shifts.' }, s.B);
    expect(byB.status, 'a Student Organizer banned somebody').toBe(403);

    const byA = await srv.call('DELETE', `/api/organizations/${orgKey}/members/${id.E}`,
      { mode: 'ban', reason: 'Repeatedly no-showed shifts.' }, s.A);
    expect(byA.status, JSON.stringify(byA.body)).toBe(200);
  });

  it('12. the ban stops E applying again, and says why', async () => {
    const res = await apply(membersEventId, membersSlotId, s.E);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('organization_banned');
    expect(res.body.reason).toBe('Repeatedly no-showed shifts.');
  });

  it('13. the ban does NOT delete the place E already earned', async () => {
    /**
     * Deliberate. Revoking the accepted application would be a second
     * consequence nobody announced, with no record and no appeal — and the
     * organizer already has a per-shift removal control for when that is what
     * they meant.
     */
    const row = db.prepare('SELECT status FROM applications WHERE user_id = ? AND slot_id = ?')
      .get(id.E, openSlotId);
    expect(row.status).toBe('accepted');
  });

  it('14. E is told about their own ban, and nobody else is', async () => {
    const mine = await cardFor(openEventId, s.E);
    expect(mine.viewerBan).toMatchObject({ banned: true, reason: 'Repeatedly no-showed shifts.' });

    for (const letter of ['A', 'B', 'C', 'D']) {
      const theirs = await cardFor(openEventId, s[letter]);
      expect(theirs.viewerBan, `${letter} was told about E's ban`).toBeNull();
    }
  });

  it('15. E can appeal, and B cannot decide it', async () => {
    const filed = await srv.call('POST', '/api/appeals', {
      subject: 'organization_ban', organizationId: orgId,
      statement: 'Two of those shifts were cancelled and nobody told me.',
    }, s.E);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const inboxB = await srv.call('GET', `/api/organizations/${orgKey}/appeals`, undefined, s.B);
    expect(inboxB.status, 'a Student Organizer read the appeal inbox').toBe(403);

    const decideB = await srv.call('POST',
      `/api/organizations/${orgKey}/appeals/${filed.body.appealId}/decision`,
      { decision: 'reversed', reasoning: 'Letting my friend back in.' }, s.B);
    expect(decideB.status, 'a Student Organizer decided an appeal').toBe(403);

    const inboxA = await srv.call('GET', `/api/organizations/${orgKey}/appeals`, undefined, s.A);
    expect(inboxA.status).toBe(200);
  });

  it('16. B cannot touch the club itself', async () => {
    const before = db.prepare('SELECT name, status FROM organizations WHERE id = ?').get(orgId);
    for (const body of [{ status: 'archived' }, { name: 'B’s Club' }, { description: 'Mine.' }]) {
      const res = await srv.call('PATCH', `/api/organizations/${orgKey}`, body, s.B);
      expect(res.status, `B changed ${Object.keys(body)[0]}`).toBe(403);
    }
    expect(db.prepare('SELECT name, status FROM organizations WHERE id = ?').get(orgId))
      .toEqual(before);
  });

  it('17. B cannot promote themselves, or anybody else', async () => {
    for (const target of [id.B, id.C]) {
      const res = await srv.call('PATCH', `/api/organizations/${orgKey}/members/${target}`,
        { memberRole: 'manager' }, s.B);
      expect(res.status).toBe(403);
    }
    expect(db.prepare('SELECT member_role FROM organization_members WHERE organization_id = ? AND user_id = ?')
      .get(orgId, id.B).member_role).toBe('student_organizer');
  });

  it('18. B cannot act for a club B does not help run', async () => {
    const other = await srv.call('POST', '/api/organizations', {
      name: `Other Simulation Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club B has nothing to do with.',
    }, s.A);
    expect(other.status).toBe(201);

    const posted = await srv.call('POST', `/api/organizations/${other.body.organization.slug}/announcements`,
      { body: 'Hello from a club I do not run.' }, s.B);
    expect(posted.status).toBe(403);

    const made = await createEvent({ organizationId: other.body.organization.id }, s.B);
    expect(made.status).toBe(403);
  });

  it('19. A demotes B, and B stops being able to do any of it', async () => {
    const demoted = await srv.call('PATCH', `/api/organizations/${orgKey}/members/${id.B}`,
      { memberRole: 'member' }, s.A);
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM user_capabilities WHERE user_id = ?').get(id.B).n)
      .toBe(0);
    expect((await createEvent({ organizationId: orgId }, s.B)).status).toBe(403);
    expect((await srv.call('POST', `/api/organizations/${orgKey}/announcements`,
      { body: 'Still here?' }, s.B)).status).toBe(403);
  });

  it('20. the events B made outlive B’s rank, and A can still run them', async () => {
    /**
     * Demotion is not a deletion. The club's Saturday shift does not disappear
     * because the student who typed it in is no longer the one who posts.
     *
     * This assertion used to read `expect([200, 403]).toContain(...)`, which
     * accepted both answers — and the real answer was 403. Every management
     * route asked `event.organizer_id === userId` and nothing else, so an event
     * a demoted helper had posted was left with NOBODY who could edit it,
     * cancel it, accept its applicants or record who turned up. A review found
     * it behind the very test that was supposed to cover it.
     */
    const row = db.prepare('SELECT status, organization_id FROM events WHERE id = ?').get(openEventId);
    expect(row).toMatchObject({ status: 'open', organization_id: orgId });

    const cancelled = await srv.call('PATCH', `/api/events/${openEventId}/status`,
      { status: 'cancelled' }, s.A);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(db.prepare('SELECT status FROM events WHERE id = ?').get(openEventId).status)
      .toBe('cancelled');
  });

  it('21. and A could run them while B was still in post', async () => {
    /**
     * The manager is above every event published under the club's name, not
     * only the ones left behind. Otherwise the club's own manager cannot cancel
     * its shift while the helper is away, which is the ordinary case rather
     * than the edge one.
     *
     * B is put back first — step 19 demoted them — so this measures the
     * in-post state rather than repeating step 20.
     */
    await setRoleAsA(id.B, 'student_organizer');
    const made = await createEvent({ organizationId: orgId, title: 'Helper’s shift' }, s.B);
    expect(made.status, JSON.stringify(made.body)).toBe(201);

    const cancelled = await srv.call('PATCH', `/api/events/${made.body.id}/status`,
      { status: 'cancelled' }, s.A);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  });

  it('22. but B cannot run an event A published under the same club', async () => {
    /* The line the widening had to stop at. Being trusted to post the bake-sale
       shift is not being trusted to call off the fundraiser somebody else
       built, so `canRunEvent` asks `canManage` for the organization branch and
       not `canHelpRun`. */
    const theirs = await createEvent({ organizationId: orgId, title: 'The manager’s own' }, s.A);
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);

    const attempt = await srv.call('PATCH', `/api/events/${theirs.body.id}/status`,
      { status: 'cancelled' }, s.B);
    expect(attempt.status).toBe(403);
    expect(db.prepare('SELECT status FROM events WHERE id = ?').get(theirs.body.id).status)
      .not.toBe('cancelled');
  });
});
