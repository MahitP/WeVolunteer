import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Attacking the invitation link and the join queue over HTTP.
 *
 * ── Why this file exists separately from the three feature suites ──
 *
 * `routes.organizationShareLink`, `routes.organizationJoinPolicy` and
 * `routes.organizationJoinRequests` each prove that the feature WORKS and that
 * its own refusals fire. This one is written from the other side: it assumes the
 * feature works and tries to get something out of it that it should not give.
 *
 * The distinction matters because the two read differently under maintenance. A
 * feature test that starts failing means somebody changed the feature. One of
 * these failing means somebody opened a hole, and the case names say which hole.
 *
 * Every case here is one item from the review checklist the brief asks for:
 * IDOR, cross-organization access, unauthorized invitation, unauthorized
 * approval, token replay, token enumeration, privilege escalation, stale
 * authorization, and a race. The ones already covered in the feature suites are
 * NOT repeated — see the note at the end for where each of those lives.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const OTHER_ORGANIZER = 'robin.ellery@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';

describe('attacking the organization invitation link', () => {
  let srv;
  let db;
  /** Jordan manages MINE. Robin manages THEIRS. Neither is in the other. */
  let jordan; let robin; let student; let other;
  let jordanId; let robinId; let studentId; let otherId;
  let mineKey; let mineId; let theirsKey; let theirsId;

  const join = async (organizationId, userId, role = 'member') => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role
    `).run(organizationId, userId, role, new Date().toISOString());
  };

  const policy = async (organizationId, joinPolicy) => {
    await db.prepare('UPDATE organizations SET join_policy = ? WHERE id = ?')
      .run(joinPolicy, organizationId);
  };

  /**
   * Mints a link and remembers it, because a club may now hold several and
   * every destructive route names one.
   */
  const links = {};
  const mintLink = async (key) => {
    const res = await srv.call('POST', `/api/organizations/${key}/share-links`, {}, jordan);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    links[key] = res.body.link;
    return String(res.body.link.path).split('/').pop();
  };

  const linkId = (key) => links[key]?.id ?? 'oshl-does-not-exist';

  const isMember = async (organizationId, userId) => Boolean(await db.prepare(
    'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(organizationId, userId));

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    jordan = await srv.login(ORGANIZER);
    robin = await srv.login(OTHER_ORGANIZER);
    student = await srv.login(STUDENT);
    other = await srv.login(OTHER_STUDENT);

    const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;
    jordanId = await idOf(jordan);
    robinId = await idOf(robin);
    studentId = await idOf(student);
    otherId = await idOf(other);

    /* Both organizers have to have signed the Organizer Agreement, or
       `organizerAgreement.js` withholds `organization.manage.own` and every
       refusal below would come from the capability layer rather than from the
       ownership check this file is about. */
    const { acceptOrganizerAgreement } = await import('./organizerAgreement.js');
    for (const id of [jordanId, robinId]) {
      try { await acceptOrganizerAgreement(db, { userId: id }); } catch { /* already signed */ }
    }

    const make = async (name, session) => {
      const r = await srv.call('POST', '/api/organizations', {
        name: `${name} ${Math.random().toString(36).slice(2, 7)}`,
        description: 'An organization used by the adversarial invitation tests.',
      }, session);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return [r.body.organization.slug, r.body.organization.id];
    };
    [mineKey, mineId] = await make('Jordan Club', jordan);
    [theirsKey, theirsId] = await make('Robin Club', robin);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    for (const id of [mineId, theirsId]) {
      await db.prepare('DELETE FROM organization_share_links WHERE organization_id = ?').run(id);
      await db.prepare('DELETE FROM organization_join_requests WHERE organization_id = ?').run(id);
      await db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(id);
      await db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(id);
      await db.prepare(
        `UPDATE organizations SET join_policy = 'open', invite_policy = 'helpers', status = 'active' WHERE id = ?`
      ).run(id);
    }
    await join(mineId, jordanId, 'manager');
    await join(theirsId, robinId, 'manager');
  });

  /* ── Unauthenticated ─────────────────────────────────────────────────────── */

  describe('an unauthenticated caller', () => {
    /**
     * Every route but one. The exception is the whole point of the feature and
     * has its own section at the bottom of this file.
     */
    it.each([
      ['GET', 'share-links'],
      ['POST', 'share-links'],
      ['DELETE', 'share-links/oshl-anything'],
      ['PATCH', 'share-links/oshl-anything'],
      ['POST', 'join-requests'],
      ['GET', 'join-requests'],
      ['DELETE', 'join-requests/mine'],
      ['GET', 'invitations'],
      ['POST', 'invitations'],
      ['DELETE', 'invitations/oinv-anything'],
      ['DELETE', 'invitations/mine'],
    ])('is refused outright on %s …/%s', async (method, path) => {
      const res = await srv.call(method, `/api/organizations/${mineKey}/${path}`,
        method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(res.status).toBe(401);
      /* And the refusal carries nothing about the organization. */
      expect(JSON.stringify(res.body ?? {})).not.toContain(mineId);
    });

    it('cannot decide a request', async () => {
      await policy(mineId, 'request');
      await srv.call('POST', `/api/organizations/${mineKey}/join-requests`, {}, student);
      const requestId = (await srv.call('GET', `/api/organizations/${mineKey}/join-requests`, undefined, jordan))
        .body.requests[0].requestId;

      const res = await srv.call(
        'POST', `/api/organizations/${mineKey}/join-requests/${requestId}/decision`, { decision: 'accept' },
      );
      expect(res.status).toBe(401);
      expect(await isMember(mineId, studentId)).toBe(false);
    });

    it('cannot join, with or without a link', async () => {
      const token = await mintLink(mineKey);
      for (const body of [{}, { shareToken: token }]) {
        const res = await srv.call('POST', `/api/organizations/${mineKey}/membership`, body);
        expect(res.status).toBe(401);
      }
      const n = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?'
      ).get(mineId);
      expect(Number(n.n)).toBe(1);
    });
  });

  /* ── Cross-organization ──────────────────────────────────────────────────── */

  /**
   * A capability cannot express "this organization and not that one".
   *
   * Robin holds `organization.manage.own` — they run a club — so every refusal
   * in this section has to come from the OWNERSHIP check, not the capability.
   * That is the layer a route can forget, and forgetting it would hand every
   * organizer on the platform every other club's controls.
   */
  describe('a manager of a different organization', () => {
    it('cannot read our invitation link', async () => {
      const token = await mintLink(mineKey);
      const res = await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, robin);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_allowed_to_invite');
      /* Not merely refused — the token is nowhere in the answer. */
      expect(JSON.stringify(res.body)).not.toContain(token);
      expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
    });

    it('cannot mint, rename, expire, rotate or switch off our invitation link', async () => {
      const token = await mintLink(mineKey);
      const id = linkId(mineKey);

      expect((await srv.call('POST', `/api/organizations/${mineKey}/share-links`, {}, robin)).status).toBe(403);
      expect((await srv.call('DELETE', `/api/organizations/${mineKey}/share-links/${id}`, undefined, robin)).status)
        .toBe(403);
      expect((await srv.call('PATCH', `/api/organizations/${mineKey}/share-links/${id}`,
        { label: 'Theirs now' }, robin)).status).toBe(403);
      expect((await srv.call('PATCH', `/api/organizations/${mineKey}/share-links/${id}`,
        { rotate: true }, robin)).status).toBe(403);
      expect((await srv.call('PATCH', `/api/organizations/${mineKey}/share-links/${id}`,
        { expiresAt: '2020-01-01T00:00:00.000Z' }, robin)).status).toBe(403);

      /* Ours is untouched: the same token still opens it, under the same name. */
      const still = await srv.call('GET', `/api/public/organizations/invite/${token}`);
      expect(still.status).toBe(200);
      const ours = (await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, jordan)).body;
      expect(ours.links).toHaveLength(1);
      expect(ours.links[0].label).toBe('General');
      expect(ours.links[0].state).toBe('live');
    });

    /**
     * The cross-club id, which is the mistake a scoped route makes when it
     * trusts the id and not the pair.
     *
     * Robin manages their OWN club, so `loadManagedOrganization` lets them
     * through — the refusal has to come from the link lookup being scoped by
     * organization AND id. A handler that looked a link up by id alone would let
     * any organizer on the platform revoke any club's link.
     */
    it('cannot revoke our link by naming its id on their own club', async () => {
      const token = await mintLink(mineKey);
      const ourId = linkId(mineKey);

      const res = await srv.call(
        'DELETE', `/api/organizations/${theirsKey}/share-links/${ourId}`, undefined, robin,
      );
      expect(res.status).toBe(404);
      expect((await srv.call('GET', `/api/public/organizations/invite/${token}`)).status).toBe(200);
    });

    it('cannot rotate our link by naming its id on their own club', async () => {
      const token = await mintLink(mineKey);
      const ourId = linkId(mineKey);

      const res = await srv.call(
        'PATCH', `/api/organizations/${theirsKey}/share-links/${ourId}`, { rotate: true }, robin,
      );
      expect(res.status).toBe(404);
      expect((await srv.call('GET', `/api/public/organizations/invite/${token}`)).status).toBe(200);
    });

    it('cannot change who may join our organization', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${mineKey}`, { joinPolicy: 'invite' }, robin);
      expect(res.status).toBe(403);
      expect((await db.prepare('SELECT join_policy AS jp FROM organizations WHERE id = ?').get(mineId)).jp)
        .toBe('open');
    });

    it('cannot read our queue of waiting students', async () => {
      await policy(mineId, 'request');
      await srv.call('POST', `/api/organizations/${mineKey}/join-requests`, {}, student);

      const res = await srv.call('GET', `/api/organizations/${mineKey}/join-requests`, undefined, robin);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_manager');
      /* No name in the refusal. */
      expect(JSON.stringify(res.body)).not.toContain('Leo Chen');
    });

    /**
     * The IDOR proper: a real request id, pasted into a route scoped to the
     * attacker's OWN organization.
     *
     * Robin manages THEIRS, so `canManage` passes. The only thing standing
     * between them and deciding somebody else's request is
     * `WHERE … AND organization_id = ?` inside the statement.
     */
    it('cannot decide our request by pasting its id into their own route', async () => {
      await policy(mineId, 'request');
      await srv.call('POST', `/api/organizations/${mineKey}/join-requests`, {}, student);
      const requestId = (await srv.call('GET', `/api/organizations/${mineKey}/join-requests`, undefined, jordan))
        .body.requests[0].requestId;

      const res = await srv.call(
        'POST', `/api/organizations/${theirsKey}/join-requests/${requestId}/decision`,
        { decision: 'accept' }, robin,
      );
      expect(res.status).toBe(404);

      /* Nothing happened to the request, and nobody joined either club. */
      const row = await db.prepare(
        'SELECT status FROM organization_join_requests WHERE id = ?'
      ).get(requestId);
      expect(row.status).toBe('pending');
      expect(await isMember(mineId, studentId)).toBe(false);
      expect(await isMember(theirsId, studentId)).toBe(false);
    });

    it("cannot use our link to get into their own invitation-only club", async () => {
      const ours = await mintLink(mineKey);
      await policy(theirsId, 'invite');

      const res = await srv.call('POST', `/api/organizations/${theirsKey}/membership`,
        { shareToken: ours }, student);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('invite_required');
      expect(await isMember(theirsId, studentId)).toBe(false);
    });
  });

  /* ── Inside the club, but not entitled ───────────────────────────────────── */

  describe('an ordinary member', () => {
    beforeEach(async () => { await join(mineId, studentId, 'member'); });

    it('cannot read the link when the club says helpers only', async () => {
      const token = await mintLink(mineKey);
      const res = await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, student);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    /**
     * Stale authorization: the club widens the setting, then narrows it again.
     *
     * The answer has to follow the CURRENT row rather than anything cached from
     * the earlier request — `canInvite` is asked per request against the club's
     * stored policy, which is what makes narrowing take effect immediately.
     */
    it('loses the link again the moment the club narrows the setting', async () => {
      await mintLink(mineKey);

      await srv.call('PATCH', `/api/organizations/${mineKey}`, { invitePolicy: 'members' }, jordan);
      expect((await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, student)).status)
        .toBe(200);

      await srv.call('PATCH', `/api/organizations/${mineKey}`, { invitePolicy: 'helpers' }, jordan);
      expect((await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, student)).status)
        .toBe(403);
    });

    it('cannot mint, rename, expire or rotate the link even when the club lets them share it', async () => {
      await mintLink(mineKey);
      const id = linkId(mineKey);
      await srv.call('PATCH', `/api/organizations/${mineKey}`, { invitePolicy: 'members' }, jordan);

      /* The server says so on the payload, so the client need not derive it —
         and then refuses every write regardless of what any client believes. */
      const read = await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, student);
      expect(read.body.canManage).toBe(false);
      expect(read.body.canCreate).toBe(false);

      expect((await srv.call('POST', `/api/organizations/${mineKey}/share-links`, {}, student)).status).toBe(403);
      expect((await srv.call('DELETE', `/api/organizations/${mineKey}/share-links/${id}`, undefined, student)).status)
        .toBe(403);
      expect((await srv.call('PATCH', `/api/organizations/${mineKey}/share-links/${id}`,
        { label: 'Mine now' }, student)).status).toBe(403);
      expect((await srv.call('PATCH', `/api/organizations/${mineKey}/share-links/${id}`,
        { rotate: true }, student)).status).toBe(403);
      expect((await srv.call('PATCH', `/api/organizations/${mineKey}/share-links/${id}`,
        { expiresAt: '2020-01-01T00:00:00.000Z' }, student)).status).toBe(403);
    });

    /**
     * A member who may share cannot read the club's operational record.
     *
     * The join count is aggregate and not sensitive in itself — nothing
     * per-visitor is stored — but it is the club's own bookkeeping, and
     * somebody who may hand an address out has not been given a reason to read
     * how many people came through which link, or which links have lapsed.
     */
    it('is given the address and not the club’s bookkeeping', async () => {
      await mintLink(mineKey);
      const retired = (await srv.call('POST', `/api/organizations/${mineKey}/share-links`,
        { label: 'Old QR code' }, jordan)).body.link;
      await srv.call('DELETE', `/api/organizations/${mineKey}/share-links/${retired.id}`, undefined, jordan);
      await srv.call('PATCH', `/api/organizations/${mineKey}`, { invitePolicy: 'members' }, jordan);

      const res = await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, student);
      expect(res.status).toBe(200);
      expect(res.body.links).toHaveLength(1);
      expect(res.body.links[0]).not.toHaveProperty('uses');
      expect(res.body.links[0]).not.toHaveProperty('lastUsedAt');
      expect(res.body.links[0]).not.toHaveProperty('revokedAt');
      /* And not the revoked link's URL, which would be a dead credential they
         could hand out. */
      expect(JSON.stringify(res.body)).not.toContain(String(retired.path).split('/').pop());
    });
  });

  /**
   * Removal and banning have to take the link with them.
   *
   * Somebody the club has shown the door keeps whatever they wrote down, and
   * nothing can be done about that — but they must not be able to ASK the
   * product for the current link, which is what makes rotating one meaningful.
   */
  describe('somebody the club has removed', () => {
    it('cannot read the link after being removed', async () => {
      await join(mineId, studentId, 'student_organizer');
      const token = await mintLink(mineKey);
      const before = await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, student);
      expect(before.body.links[0].path).toContain(token);

      await srv.call('DELETE', `/api/organizations/${mineKey}/members/${studentId}`, undefined, jordan);

      const after = await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, student);
      expect(after.status).toBe(403);
      expect(JSON.stringify(after.body)).not.toContain(token);
    });

    it('cannot read the link while banned', async () => {
      await join(mineId, studentId, 'student_organizer');
      const token = await mintLink(mineKey);
      await srv.call('DELETE', `/api/organizations/${mineKey}/members/${studentId}`,
        { mode: 'ban', reason: 'Testing the ban' }, jordan);

      const after = await srv.call('GET', `/api/organizations/${mineKey}/share-links`, undefined, student);
      expect(after.status).toBe(403);
      expect(JSON.stringify(after.body)).not.toContain(token);
    });
  });

  /* ── Privilege escalation ────────────────────────────────────────────────── */

  /**
   * Getting into a club grants membership and nothing else.
   *
   * `syncOrganizerCapabilities` is called when a request is accepted, and it
   * grants the four helper capabilities to anybody holding `manager` or
   * `student_organizer` ANYWHERE. A bug that admitted somebody at the wrong rank
   * would therefore hand a student four platform capabilities, and the symptom
   * would be somebody posting as a club they merely joined.
   */
  describe('joining does not escalate anything', () => {
    const capabilitiesOf = async (userId) => (await db.prepare(
      'SELECT capability FROM user_capabilities WHERE user_id = ? ORDER BY capability'
    ).all(userId)).map(r => r.capability);

    const roleOf = async (userId) => (await db.prepare(
      'SELECT role FROM users WHERE id = ?'
    ).get(userId)).role;

    it('admits an accepted student as an ordinary member, with no new capability', async () => {
      await policy(mineId, 'request');
      const before = await capabilitiesOf(studentId);

      await srv.call('POST', `/api/organizations/${mineKey}/join-requests`, {}, student);
      const requestId = (await srv.call('GET', `/api/organizations/${mineKey}/join-requests`, undefined, jordan))
        .body.requests[0].requestId;
      const decided = await srv.call(
        'POST', `/api/organizations/${mineKey}/join-requests/${requestId}/decision`,
        { decision: 'accept' }, jordan,
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);

      const rank = await db.prepare(
        'SELECT member_role AS r FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(mineId, studentId);
      expect(rank.r).toBe('member');
      expect(await capabilitiesOf(studentId)).toEqual(before);
      expect(await roleOf(studentId)).toBe('student');
    });

    it('admits somebody joining by link as an ordinary member', async () => {
      await policy(mineId, 'invite');
      const token = await mintLink(mineKey);
      const before = await capabilitiesOf(otherId);

      const res = await srv.call('POST', `/api/organizations/${mineKey}/membership`,
        { shareToken: token }, other);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const rank = await db.prepare(
        'SELECT member_role AS r FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(mineId, otherId);
      expect(rank.r).toBe('member');
      expect(await capabilitiesOf(otherId)).toEqual(before);
      expect(await roleOf(otherId)).toBe('student');
    });

    it('cannot be talked into a rank by the request body', async () => {
      await policy(mineId, 'open');
      /* Neither route reads a rank from the caller, and this proves it rather
         than trusting that nobody adds one later. */
      const res = await srv.call('POST', `/api/organizations/${mineKey}/membership`,
        { memberRole: 'manager', member_role: 'manager', role: 'admin' }, student);
      expect(res.status).toBe(200);

      const rank = await db.prepare(
        'SELECT member_role AS r FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(mineId, studentId);
      expect(rank.r).toBe('member');
      expect(await roleOf(studentId)).toBe('student');
    });
  });

  /* ── Races ───────────────────────────────────────────────────────────────── */

  describe('concurrency', () => {
    /**
     * The membership pre-check reads OUTSIDE the transaction and the insert
     * happens inside it, so two overlapping joins both pass the check.
     *
     * `ON CONFLICT DO NOTHING` is what makes that harmless, and this drives it
     * rather than reading the SQL: the outcome that matters is one row, and two
     * successes.
     */
    it('produces one membership for five simultaneous joins', async () => {
      await policy(mineId, 'open');
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        srv.call('POST', `/api/organizations/${mineKey}/membership`, {}, student)));

      for (const res of results) expect(res.status, JSON.stringify(res.body)).toBe(200);
      const n = await db.prepare(
        'SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND user_id = ?'
      ).get(mineId, studentId);
      expect(Number(n.n)).toBe(1);
    });

    /**
     * Rotating while somebody joins.
     *
     * The token is resolved INSIDE the join handler, so each attempt is decided
     * against whatever the live row said at that moment. Both outcomes are
     * correct — admitted, or refused because the link had already been replaced
     * — and what must not happen is a 500, a half-written membership, or a
     * second link.
     */
    it('answers a join and a rotation racing each other without breaking either', async () => {
      await policy(mineId, 'invite');
      const token = await mintLink(mineKey);
      const id = linkId(mineKey);

      const [joined, rotated] = await Promise.all([
        srv.call('POST', `/api/organizations/${mineKey}/membership`, { shareToken: token }, student),
        srv.call('PATCH', `/api/organizations/${mineKey}/share-links/${id}`, { rotate: true }, jordan),
      ]);

      expect([200, 403]).toContain(joined.status);
      expect(rotated.status).toBe(200);

      /* Whichever order they landed in, the membership agrees with the answer
         that was given — a join reported 200 with no membership row, or 403
         with one, would mean the token was resolved somewhere other than the
         moment of the act. */
      expect(await isMember(mineId, studentId)).toBe(joined.status === 200);

      /* Exactly one LIVE link. The rotation leaves the old row behind as
         history, which is why this counts by state rather than by row. */
      const live = await db.prepare(`
        SELECT COUNT(*) AS n FROM organization_share_links
         WHERE organization_id = ? AND revoked_at IS NULL
      `).get(mineId);
      expect(Number(live.n)).toBe(1);

      /* And the use count agrees with the outcome: counted inside the join
         transaction, so a refused join must not have counted. */
      const uses = await db.prepare(
        'SELECT uses FROM organization_share_links WHERE id = ?'
      ).get(id);
      expect(Number(uses.uses)).toBe(joined.status === 200 ? 1 : 0);
    });
  });

  /* ── The public endpoint ─────────────────────────────────────────────────── */

  describe('the one unauthenticated endpoint', () => {
    it('cannot be walked to a real link by trying shapes', async () => {
      /* Not a proof about entropy — that is arithmetic on 256 bits. It proves
         the endpoint answers the same way to every near-miss, so nothing about
         the shape of a refusal narrows the search. */
      const real = await mintLink(mineKey);
      const misses = [
        'a'.repeat(64),
        real.slice(0, 63) + (real[63] === 'a' ? 'b' : 'a'),
        real.toUpperCase(),
        real.slice(0, 32),
        `${real} `,
        `${real}\n`,
      ];

      const bodies = new Set();
      for (const t of misses) {
        const res = await srv.call('GET', `/api/public/organizations/invite/${encodeURIComponent(t)}`);
        expect(res.status, `token ${t.slice(0, 12)}… must miss`).toBe(404);
        bodies.add(JSON.stringify(res.body));
      }
      /* One body, byte for byte, for all six. */
      expect(bodies.size).toBe(1);
    });

    it('does no unbounded work for an enormous token', async () => {
      const res = await srv.call('GET',
        `/api/public/organizations/invite/${'a'.repeat(20000)}`);
      /**
       * Refused before anything expensive happens, and the layer that refuses it
       * is allowed to vary.
       *
       * Measured: Node answers **431** for a URL this long, because the request
       * line exceeds `--max-http-header-size` and is rejected before Express is
       * handed it — better than any answer the application could give, since no
       * route, no limiter and no query runs at all. A shorter-but-still-absurd
       * token gets to `resolveShareToken`, whose shape check refuses it without a
       * round trip, and that is a 404.
       *
       * The assertion is the set rather than one value because which of those two
       * fires depends on the header limit the process was started with. What must
       * never appear is a 500, or a hang.
       */
      expect([404, 400, 414, 431]).toContain(res.status);
    });

    it('refuses a token that is long but within the URL limits, without a query', async () => {
      /* The other side of the case above: short enough to reach the handler,
         so this is the shape check doing the refusing. */
      const res = await srv.call('GET',
        `/api/public/organizations/invite/${'a'.repeat(2000)}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('invalid_link');
    });

    it('stops resolving the moment the organization is archived', async () => {
      const token = await mintLink(mineKey);
      expect((await srv.call('GET', `/api/public/organizations/invite/${token}`)).status).toBe(200);

      await srv.call('PATCH', `/api/organizations/${mineKey}`, { status: 'archived' }, jordan);
      const after = await srv.call('GET', `/api/public/organizations/invite/${token}`);
      expect(after.status).toBe(404);
      expect(after.body.code).toBe('invalid_link');
    });

    /**
     * The projection, checked against the ROSTER rather than against a list of
     * field names.
     *
     * The field-by-field assertion lives in `routes.organizationJoinPolicy`.
     * This one loads the club up with members, an uploaded-image path, an
     * announcement and a ban, and then asserts that nothing any of them
     * introduced appears — which is the check that keeps working when somebody
     * adds a field.
     */
    it('publishes nothing about anybody, however much the club has', async () => {
      await join(mineId, studentId, 'student_organizer');
      await join(mineId, otherId, 'member');
      await db.prepare('UPDATE organizations SET image_url = ? WHERE id = ?')
        .run('/uploads/avatars/org-secret-path.webp', mineId);
      await srv.call('POST', `/api/organizations/${mineKey}/announcements`,
        { body: 'A private notice for members only.' }, jordan);

      const token = await mintLink(mineKey);
      const res = await srv.call('GET', `/api/public/organizations/invite/${token}`);
      expect(res.status).toBe(200);

      const body = JSON.stringify(res.body);
      for (const secret of [
        'Leo Chen', 'leochen', studentId,
        'Priya Patel', 'priyapatel', otherId,
        'Jordan Whitfield', 'jwhitfield', jordanId,
        mineId,
        'A private notice',
        'student_organizer', 'manager',
        token,
      ]) {
        expect(body, `${secret} must not be published`).not.toContain(secret);
      }

      /* The counts, which name nobody, DO travel — a page that showed neither a
         roster nor a size would leave a stranger unable to tell a real club
         from an empty one, which is the judgement this feature is built on. */
      expect(res.body.organization.memberCount).toBe(3);
    });

    it('publishes the logo path, because that file is already served publicly', async () => {
      /* Stated rather than assumed: `imageUrl` is in the projection on purpose.
         It is the same URL every signed-in surface already renders, served by
         the uploads route to anybody who asks — so withholding it here would
         hide a club's own logo from its own invitation page while changing
         nothing about who can fetch the file. */
      await db.prepare('UPDATE organizations SET image_url = ? WHERE id = ?')
        .run('/uploads/avatars/org-logo.webp', mineId);
      const token = await mintLink(mineKey);
      const res = await srv.call('GET', `/api/public/organizations/invite/${token}`);
      expect(res.body.organization.imageUrl).toBe('/uploads/avatars/org-logo.webp');
    });
  });

  /**
   * ── Checklist items proved elsewhere, so they are not repeated here ──
   *
   *   token replay after rotation, after revocation, and cross-organization
   *     → routes.organizationJoinPolicy.test.js
   *   a malformed or oversized `shareToken` on the join route
   *     → routes.organizationJoinPolicy.test.js
   *   a banned holder of a valid link
   *     → routes.organizationJoinPolicy.test.js
   *   two managers deciding one request at the same time
   *     → routes.organizationJoinRequests.test.js
   *   duplicate requests under concurrency
   *     → routes.organizationJoinRequests.test.js
   *   the roster withheld from non-members
   *     → organization.rosterPrivacy.test.js
   *   the token absent from every organization response and from the audit trail
   *     → routes.organizationShareLink.test.js
   *   the partial unique index and the CHECK constraints
   *     → migrations.organizationMembershipPolicy.test.js (both engines)
   */
});
