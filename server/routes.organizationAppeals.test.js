import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Appeals belong to the organization, not to the manager who issued the ban.
 *
 * ── The design being tested ──
 *
 * A ban is pressed by one person and is a decision of the club. Routing the
 * appeal back to whoever pressed the button asks the subject of the complaint to
 * judge it, and it fails outright the moment that manager leaves, is away, or is
 * the reason for the appeal. So every manager sees it — and only managers of
 * THAT organization.
 *
 * ── What must not happen ──
 *
 * The inbox carries the ban reason and somebody's written defence. A manager of
 * another club reading either would be a disclosure, and an appeal id is
 * guessable in the way any id is, so scoping cannot rest on the id being secret.
 */

const OWNER = 'jordan.whitfield@example.org';   // manager of the organization
const SECOND = 'priya.patel@example.com';       // second manager, promoted below
const STUDENT = 'leo.chen@example.com';         // the appellant
/* An ORGANIZER, not a student: they must genuinely hold organization.manage.own
   and run a club of their own, so that only the per-organization scope check can
   be what refuses them below. A student would be refused by the capability gate
   instead, and the test would prove nothing about scoping. */
const OUTSIDER = 'robin.ellery@example.org';

describe('the organization appeal inbox', () => {
  let srv; let db;
  let manager; let second; let student; let outsider;
  let managerId; let secondId; let studentId; let outsiderId;
  let orgKey; let orgId;
  let otherKey; let otherId;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    manager = await srv.login(OWNER);
    second = await srv.login(SECOND);
    student = await srv.login(STUDENT);
    outsider = await srv.login(OUTSIDER);

    const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;
    managerId = await idOf(manager); secondId = await idOf(second);
    studentId = await idOf(student); outsiderId = await idOf(outsider);

    /**
     * The Organizer Agreement gate withholds `organization.create` from an
     * organizer who has not signed. `jordan.whitfield` is seeded as having
     * signed; the second organizer is not, so their club could not be created
     * and every scoping test below skipped on the fixture rather than running.
     *
     * Signed through the module that owns the rule, so this fixture cannot
     * drift from what the gate actually checks.
     */
    const { acceptOrganizerAgreement } = await import('./organizerAgreement.js');

    /**
     * The second manager is made an ORGANIZER, not left a student.
     *
     * Being a manager of an organization is a membership row; reaching a manager
     * ROUTE additionally needs the platform capability `organization.manage.own`,
     * which students do not hold. So promoting a student to manager in the
     * membership table gives them a title and no access, and the first version
     * of these tests failed on exactly that — which is worth knowing, because it
     * means an organization cannot delegate management to a student today.
     */
    db.prepare("UPDATE users SET role = 'organizer' WHERE id = ?").run(secondId);

    for (const id of [managerId, outsiderId, secondId]) {
      try { acceptOrganizerAgreement(db, { userId: id }); } catch { /* already signed */ }
    }
    /* The role change invalidates the cached session principal. */
    second = await srv.login(SECOND);

    const mk = async (name, session) => {
      const r = await srv.call('POST', '/api/organizations', {
        name: `${name} ${Math.random().toString(36).slice(2, 7)}`,
        description: 'An organization used by the appeal-inbox tests.',
      }, session);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return { key: r.body.organization.slug, id: r.body.organization.id };
    };
    ({ key: orgKey, id: orgId } = await mk('Appeal Inbox Org', manager));
    ({ key: otherKey, id: otherId } = await mk('Unrelated Org', outsider));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  const join = (orgIdent, userId, role = 'member') =>
    db.prepare(`INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
                VALUES (?, ?, ?, ?)`).run(orgIdent, userId, role, new Date().toISOString());

  /** Ban the student, then file their appeal through the ordinary route. */
  const banAndAppeal = async () => {
    join(orgId, studentId);
    const banned = await srv.call('DELETE', `/api/organizations/${orgKey}/members/${studentId}`,
      { mode: 'ban', reason: 'Missed three shifts without telling anyone.' }, manager);
    expect(banned.status, JSON.stringify(banned.body)).toBe(200);

    const filed = await srv.call('POST', '/api/appeals', {
      subject: 'organization_ban',
      organizationId: orgId,
      statement: 'Two of those shifts were cancelled by the organizer and I was never told.',
    }, student);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    return filed.body.appealId;
  };

  beforeEach(() => {
    db.prepare('DELETE FROM organization_bans WHERE organization_id IN (?, ?)').run(orgId, otherId);
    db.prepare("UPDATE appeals SET status = 'resolved' WHERE user_id = ? AND status IN ('open','reviewing')").run(studentId);
    join(orgId, managerId, 'manager');
  });

  const inbox = (key, session) => srv.call('GET', `/api/organizations/${key}/appeals`, undefined, session);

  it('shows the appeal to the manager who issued the ban', async () => {
    const id = await banAndAppeal();
    const res = await inbox(orgKey, manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.appeals.map(a => a.id)).toContain(id);
  });

  it('shows the SAME appeal to a second manager who had nothing to do with it', async () => {
    /* The whole point of moving this to the organization. */
    const id = await banAndAppeal();
    join(orgId, secondId, 'manager');
    const res = await inbox(orgKey, second);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.appeals.map(a => a.id)).toContain(id);
  });

  it('marks the issuer so another manager can choose to take it', async () => {
    /* Surfaced, not enforced: a one-manager club has nobody to hand it to. */
    await banAndAppeal();
    join(orgId, secondId, 'manager');
    const mine = (await inbox(orgKey, manager)).body.appeals[0];
    const theirs = (await inbox(orgKey, second)).body.appeals[0];
    expect(mine.youIssuedThisBan).toBe(true);
    expect(theirs.youIssuedThisBan).toBe(false);
  });

  it('REFUSES an ordinary member of the same organization', async () => {
    /**
     * `second` HOLDS `organization.manage.own` — they are an organizer — and is
     * a member of this organization. So the capability gate passes and only
     * `canManage` can be refusing: membership is not management.
     */
    await banAndAppeal();
    join(orgId, secondId, 'member');
    const res = await inbox(orgKey, second);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/Missed three shifts/);
  });

  it('REFUSES a manager of a different organization', async () => {
    /**
     * The disclosure that matters most. `outsider` genuinely holds
     * `organization.manage.own` — they run their own club — so only the
     * per-organization check can be refusing here.
     */
    await banAndAppeal();
    const res = await inbox(orgKey, outsider);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/Missed three shifts/);
  });

  it('does not leak the appeal through the other organization\'s own inbox', async () => {
    await banAndAppeal();
    const res = await inbox(otherKey, outsider);
    expect(res.status).toBe(200);
    expect(res.body.appeals).toEqual([]);
  });

  it('carries the ban reason and the appellant to a manager, and nothing more', async () => {
    await banAndAppeal();
    const a = (await inbox(orgKey, manager)).body.appeals[0];
    expect(a.ban.reason).toMatch(/Missed three shifts/);
    expect(a.appellant.name).toBeTruthy();
    expect(a.statement).toMatch(/cancelled by the organizer/);
    /* Not a profile view: no contact details, no id to correlate elsewhere. */
    expect(JSON.stringify(a)).not.toMatch(/@[\w.-]+\.\w+/);
    expect(a.appellant.id).toBeUndefined();
  });

  const decide = (key, id, body, session) =>
    srv.call('POST', `/api/organizations/${key}/appeals/${id}/decision`, body, session);

  it('lifts the ban when an appeal is upheld, and lets them rejoin', async () => {
    const id = await banAndAppeal();
    const res = await decide(orgKey, id, { decision: 'reversed', reasoning: 'Two shifts were cancelled by us.' }, manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const ban = db.prepare('SELECT lifted_at, lifted_by FROM organization_bans WHERE organization_id = ? AND user_id = ?')
      .get(orgId, studentId);
    expect(ban.lifted_at).toBeTruthy();
    expect(ban.lifted_by).toBe(managerId);

    const rejoin = await srv.call('POST', `/api/organizations/${orgKey}/membership`, undefined, student);
    expect(rejoin.status, 'an upheld appeal must actually let them back in').toBe(200);
  });

  it('leaves the ban in force when an appeal is refused', async () => {
    const id = await banAndAppeal();
    await decide(orgKey, id, { decision: 'stands', reasoning: 'The shifts were not cancelled by us.' }, manager);

    const ban = db.prepare('SELECT lifted_at FROM organization_bans WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL')
      .get(orgId, studentId);
    expect(ban, 'the ban was lifted by a refusal').toBeTruthy();

    const rejoin = await srv.call('POST', `/api/organizations/${orgKey}/membership`, undefined, student);
    expect(rejoin.status).toBe(403);
  });

  it('never deletes the ban, so the record survives the decision', async () => {
    /* "Banned, then unbanned" is what an appeal produces; erasing the row would
       lose the outcome and the reason together. */
    const id = await banAndAppeal();
    await decide(orgKey, id, { decision: 'reversed', reasoning: 'Two shifts were cancelled by us.' }, manager);
    const rows = db.prepare('SELECT COUNT(*) n FROM organization_bans WHERE organization_id = ? AND user_id = ?')
      .get(orgId, studentId).n;
    expect(rows).toBe(1);
  });

  it('records who decided it and why, on the appeal itself', async () => {
    const id = await banAndAppeal();
    await decide(orgKey, id, { decision: 'stands', reasoning: 'The shifts were not cancelled by us.' }, manager);
    const row = db.prepare('SELECT status, decision, reasoning, reviewer_id, decided_at FROM appeals WHERE id = ?').get(id);
    expect(row).toMatchObject({ status: 'resolved', decision: 'stands', reviewer_id: managerId });
    expect(row.reasoning).toMatch(/not cancelled/);
    expect(row.decided_at).toBeTruthy();
  });

  it('writes an append-only history entry for the decision', async () => {
    const id = await banAndAppeal();
    await decide(orgKey, id, { decision: 'stands', reasoning: 'The shifts were not cancelled by us.' }, manager);
    const events = db.prepare('SELECT action, actor_id, to_status, note FROM appeal_events WHERE appeal_id = ? ORDER BY created_at').all(id);
    expect(events.map(e => e.action)).toContain('decided');
    const decided = events.find(e => e.action === 'decided');
    expect(decided.actor_id).toBe(managerId);
    expect(decided.to_status).toBe('resolved');
    expect(decided.note).toMatch(/stands/);
  });

  it('refuses a decision with no reasoning', async () => {
    /* An appellant told only "denied" has an outcome without a reason, which is
       the complaint the appeal was about. */
    const id = await banAndAppeal();
    const res = await decide(orgKey, id, { decision: 'stands', reasoning: 'too short' }, manager);
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT status FROM appeals WHERE id = ?').get(id).status).not.toBe('resolved');
  });

  it('refuses an unknown decision', async () => {
    const id = await banAndAppeal();
    const res = await decide(orgKey, id, { decision: 'maybe', reasoning: 'A perfectly long reasoning string.' }, manager);
    expect(res.status).toBe(400);
  });

  it('REFUSES a decision from a manager of another organization', async () => {
    const id = await banAndAppeal();
    const res = await decide(orgKey, id, { decision: 'reversed', reasoning: 'Not my club to decide.' }, outsider);
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT status FROM appeals WHERE id = ?').get(id).status).not.toBe('resolved');
  });

  it('cannot be decided through another organization it does not belong to', async () => {
    /**
     * The IDOR. `outsider` manages `otherKey` legitimately, and the appeal id is
     * real — only the scoping in the WHERE clause refuses it.
     */
    const id = await banAndAppeal();
    const res = await decide(otherKey, id, { decision: 'reversed', reasoning: 'Reaching into another club.' }, outsider);
    expect(res.status).toBe(404);
    expect(db.prepare('SELECT status FROM appeals WHERE id = ?').get(id).status).not.toBe('resolved');
  });

  it('refuses a second decision rather than overwriting the first', async () => {
    /* Two managers pressing at once must not overwrite each other's reasoning. */
    const id = await banAndAppeal();
    join(orgId, secondId, 'manager');
    const first = await decide(orgKey, id, { decision: 'stands', reasoning: 'The first decision, recorded.' }, manager);
    expect(first.status).toBe(200);

    const again = await decide(orgKey, id, { decision: 'reversed', reasoning: 'A second, contradictory decision.' }, second);
    expect(again.status).toBe(409);
    expect(db.prepare('SELECT decision FROM appeals WHERE id = ?').get(id).decision).toBe('stands');
  });

  it('tells the appellant, in words written for a ban', async () => {
    const id = await banAndAppeal();
    await decide(orgKey, id, { decision: 'reversed', reasoning: 'Two shifts were cancelled by us.' }, manager);
    const note = db.prepare('SELECT title, body FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(studentId);
    expect(note?.title).toMatch(/appeal/i);
    /* Not the suspension vocabulary: they were never suspended. */
    expect(note.body).not.toMatch(/suspend/i);
    expect(note.body).toMatch(/join again|lifted/i);
  });

  it('refuses everything to somebody with no session', async () => {
    const id = await banAndAppeal();
    expect((await inbox(orgKey)).status).toBe(401);
    expect((await decide(orgKey, id, { decision: 'reversed', reasoning: 'Anonymous decision attempt.' })).status).toBe(401);
  });
});
