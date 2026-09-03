import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Joining, under each of the three policies — and the public projection an
 * invitation link opens.
 *
 * ── Why the refusals are the subject and the successes are the control ──
 *
 * `organizationPolicy.test.js` proves the rule is right by enumerating it. This
 * file proves the rule is the one the ROUTE consults, which is a different claim
 * and the one that matters: a client that skips the page and posts straight to
 * `POST …/membership` must meet exactly the same three answers.
 *
 * ── The privacy half ──
 *
 * `GET /api/public/organizations/invite/:token` is the only unauthenticated read
 * of real data this feature adds. Its assertions are written as "these fields
 * are absent" rather than "these fields are present", because a happy-path test
 * that checks the name is on the payload cannot tell you the roster is not.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';
const OTHER_STUDENT = 'priya.patel@example.com';

describe('joining an organization', () => {
  let srv;
  let db;
  let manager;
  let student;
  let other;
  let managerId;
  let studentId;
  let otherId;
  let orgKey;
  let orgId;
  let otherOrgKey;

  const join = async (userId, role = 'member') => {
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET member_role = excluded.member_role
    `).run(orgId, userId, role, new Date().toISOString());
  };

  const policy = async (joinPolicy) => {
    await db.prepare('UPDATE organizations SET join_policy = ? WHERE id = ?').run(joinPolicy, orgId);
  };

  const mintLink = async (key = orgKey) => {
    const res = await srv.call('POST', `/api/organizations/${key}/share-link`, {}, manager);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return String(res.body.path).split('/').pop();
  };

  const attemptJoin = (body, session = student) =>
    srv.call('POST', `/api/organizations/${orgKey}/membership`, body, session);

  const page = async (session = student) =>
    (await srv.call('GET', `/api/organizations/${orgKey}`, undefined, session)).body;

  const isMember = async (userId) => Boolean(await db.prepare(
    'SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?'
  ).get(orgId, userId));

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    student = await srv.login(STUDENT);
    other = await srv.login(OTHER_STUDENT);

    managerId = (await srv.call('GET', '/api/auth/me', undefined, manager)).body.id;
    studentId = (await srv.call('GET', '/api/auth/me', undefined, student)).body.id;
    otherId = (await srv.call('GET', '/api/auth/me', undefined, other)).body.id;

    const created = await srv.call('POST', '/api/organizations', {
      name: `Join Policy Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club used by the join-policy tests.',
      tags: ['Coordination'],
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;

    const second = await srv.call('POST', '/api/organizations', {
      name: `Neighbouring Club ${Math.random().toString(36).slice(2, 7)}`,
    }, manager);
    otherOrgKey = second.body.organization.slug;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_share_links WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_join_requests WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_bans WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(orgId);
    await join(managerId, 'manager');
    await db.prepare(
      `UPDATE organizations SET join_policy = 'open', invite_policy = 'helpers', status = 'active' WHERE id = ?`
    ).run(orgId);
  });

  describe('an open organization', () => {
    it('lets anybody join, exactly as it always did', async () => {
      const res = await attemptJoin({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.isMember).toBe(true);
      expect(await isMember(studentId)).toBe(true);
    });

    it('offers Join on the page', async () => {
      expect((await page()).viewer.affordance).toBe('join');
    });

    it('is still idempotent — pressing twice is not an error', async () => {
      await attemptJoin({});
      const again = await attemptJoin({});
      expect(again.status).toBe(200);
      expect(again.body.isMember).toBe(true);
    });
  });

  describe('an invitation-only organization', () => {
    beforeEach(async () => { await policy('invite'); });

    it('tells the page an invitation is required', async () => {
      const p = await page();
      expect(p.viewer.affordance).toBe('invite_required');
      expect(p.organization.joinPolicy).toBe('invite');
    });

    /** The server refusal, not the missing button. This is the boundary. */
    it('refuses a join with no token', async () => {
      const res = await attemptJoin({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('invite_required');
      expect(await isMember(studentId)).toBe(false);
    });

    it('refuses a made-up token', async () => {
      const res = await attemptJoin({ shareToken: 'f'.repeat(64) });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('invite_required');
    });

    it.each([
      ['the empty string', ''],
      ['a short string', 'abc'],
      ['a non-hex string', 'z'.repeat(64)],
      ['a number', 12345],
      ['an object', { token: 'x' }],
      ['an array', ['x']],
      ['a very long string', 'a'.repeat(100000)],
    ])('refuses %s without touching the database', async (_label, shareToken) => {
      const res = await attemptJoin({ shareToken });
      expect(res.status).toBe(403);
      expect(await isMember(studentId)).toBe(false);
    });

    it('admits somebody holding the current link', async () => {
      const token = await mintLink();
      const res = await attemptJoin({ shareToken: token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await isMember(studentId)).toBe(true);
    });

    /**
     * The cross-organization case, closed in the WHERE clause of the resolver
     * rather than by a check the next refactor can drop: `tokenOpens` asks
     * whether the token opens THIS club, not whether it resolves to anything.
     */
    it("refuses another organization's link", async () => {
      const foreign = await mintLink(otherOrgKey);
      const res = await attemptJoin({ shareToken: foreign });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('invite_required');
      expect(await isMember(studentId)).toBe(false);
    });

    it('refuses a link that has since been regenerated', async () => {
      const first = await mintLink();
      await mintLink();
      const res = await attemptJoin({ shareToken: first });
      expect(res.status).toBe(403);
      expect(await isMember(studentId)).toBe(false);
    });

    it('refuses a link that has been switched off', async () => {
      const token = await mintLink();
      await srv.call('DELETE', `/api/organizations/${orgKey}/share-link`, undefined, manager);
      const res = await attemptJoin({ shareToken: token });
      expect(res.status).toBe(403);
      expect(await isMember(studentId)).toBe(false);
    });

    /**
     * A ban outranks a link, and it has to, or a banned student who kept the
     * club's link would simply walk back in.
     */
    it('refuses a banned holder of a valid link', async () => {
      const token = await mintLink();
      await db.prepare(`
        INSERT INTO organization_bans (id, organization_id, user_id, banned_by, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`ban-${Date.now()}`, orgId, studentId, managerId, 'Testing the ban', new Date().toISOString());

      const res = await attemptJoin({ shareToken: token });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('banned');
      expect(await isMember(studentId)).toBe(false);
      expect((await page()).viewer.affordance).toBe('banned');
    });

    /** An existing member must never be asked for a link they never needed. */
    it('leaves an existing member alone when the policy changes under them', async () => {
      await policy('open');
      await attemptJoin({});
      await policy('invite');

      expect((await page()).viewer.affordance).toBe('member');
      const again = await attemptJoin({});
      expect(again.status).toBe(200);
      expect(again.body.isMember).toBe(true);
    });

    it('is still discoverable, so being private does not mean being hidden', async () => {
      /* §17: discovering a club and being allowed into it are different
         questions. A club that vanished from search when it went invite-only
         would read as broken rather than as private. */
      const browse = await srv.call('GET', '/api/organizations?limit=50', undefined, student);
      expect(browse.body.organizations.some(o => o.slug === orgKey)).toBe(true);
    });
  });

  describe('an organization that approves members', () => {
    beforeEach(async () => { await policy('request'); });

    it('offers Request rather than Join', async () => {
      expect((await page()).viewer.affordance).toBe('request');
    });

    it('refuses a direct join and says what to do instead', async () => {
      const res = await attemptJoin({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('request_required');
      expect(await isMember(studentId)).toBe(false);
    });

    /**
     * Possession of the link does NOT bypass the approval.
     *
     * The safer of the two models the design considered: in `request` mode the
     * link is an address and nothing more, so sharing it cannot accidentally
     * become a way around the approval the club chose.
     */
    it('refuses a join even with a valid link', async () => {
      const token = await mintLink();
      const res = await attemptJoin({ shareToken: token });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('request_required');
      expect(await isMember(studentId)).toBe(false);
    });
  });

  describe('an archived organization', () => {
    it('refuses every path in, however the caller arrives', async () => {
      const token = await mintLink();
      await db.prepare(`UPDATE organizations SET status = 'archived' WHERE id = ?`).run(orgId);

      expect((await attemptJoin({ shareToken: token })).status).toBe(409);
      expect((await srv.call('POST', `/api/organizations/${orgKey}/join-requests`, {}, student)).status).toBe(409);
      /* And the link stops resolving, so archiving is a real withdrawal rather
         than one that leaves a public door open. */
      expect((await srv.call('GET', `/api/public/organizations/invite/${token}`)).status).toBe(404);
    });
  });

  describe('the public projection an invitation link opens', () => {
    let token;

    beforeEach(async () => {
      token = await mintLink();
    });

    const open = async (t = token) =>
      await srv.call('GET', `/api/public/organizations/invite/${t}`);

    it('answers without a session at all', async () => {
      const res = await open();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.organization.name).toContain('Join Policy Club');
    });

    it('publishes the club’s own advertisement and its counts', async () => {
      const { organization: o } = (await open()).body;
      expect(Object.keys(o).sort()).toEqual([
        'avatar', 'avatarColor', 'description', 'eventCount', 'imageUrl',
        'joinPolicy', 'kind', 'memberCount', 'name', 'slug', 'tags', 'upcoming',
      ]);
      expect(o.memberCount).toBeGreaterThanOrEqual(1);
      expect(o.tags).toEqual(['Coordination']);
    });

    /**
     * The assertion that matters most in this file.
     *
     * A link forwarded once into a group chat must not publish a named list of
     * children. The member COUNT stays — it names nobody and is what tells a
     * parent the club is real — and nothing else about a person does.
     */
    it('names not one member, not even the founder', async () => {
      await join(studentId, 'member');
      const body = JSON.stringify((await open()).body);
      expect(body).not.toContain('Leo Chen');
      expect(body).not.toContain('leochen');
      expect(body).not.toContain('Jordan Whitfield');
      expect(body).not.toContain(studentId);
      expect(body).not.toContain(managerId);
      expect(body).not.toMatch(/"members"|"createdBy"|"viewer"|"totals"/);
    });

    it('does not carry the organization id or the token', async () => {
      const body = JSON.stringify((await open()).body);
      expect(body).not.toContain(orgId);
      expect(body).not.toContain(token);
    });

    it('says which policy applies, so a stranger knows what Join will do', async () => {
      await policy('request');
      expect((await open()).body.organization.joinPolicy).toBe('request');
    });

    it('answers the same 404 for a token that never existed, one replaced, and one switched off', async () => {
      const never = await open('a'.repeat(64));
      const replaced = await (async () => { const t = token; await mintLink(); return open(t); })();
      const off = await (async () => {
        const t = await mintLink();
        await srv.call('DELETE', `/api/organizations/${orgKey}/share-link`, undefined, manager);
        return open(t);
      })();

      for (const res of [never, replaced, off]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('invalid_link');
      }
      /* Byte-identical, not merely the same status: the shape of the refusal is
         the only thing an attacker gets to measure. */
      expect(JSON.stringify(replaced.body)).toBe(JSON.stringify(never.body));
      expect(JSON.stringify(off.body)).toBe(JSON.stringify(never.body));
    });

    it.each([
      ['too short', 'abc'],
      ['not hex', 'z'.repeat(64)],
      ['too long', 'a'.repeat(200)],
      ['upper case', 'A'.repeat(64)],
    ])('answers the same 404 for a malformed token (%s)', async (_label, t) => {
      const res = await open(t);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('invalid_link');
    });

    describe('upcoming opportunities', () => {
      let eventId;

      beforeEach(async () => {
        /* Cleared per case, not only at the end: each of these assertions is
           about what the projection contains, so an event left behind by the
           previous one makes the next one measure two clubs' worth of history. */
        await db.prepare('DELETE FROM slots WHERE event_id LIKE ?').run('evt-public-%');
        await db.prepare('DELETE FROM events WHERE id LIKE ?').run('evt-public-%');

        eventId = `evt-public-${Math.random().toString(36).slice(2, 8)}`;
        const start = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
        await db.prepare(`
          INSERT INTO events (id, title, description, category, location, address,
                              organizer_id, organization_id, status, created_at,
                              application_deadline)
          VALUES (?, ?, ?, 'Environment', ?, ?, ?, ?, 'open', ?, ?)
        `).run(
          eventId, 'Beach cleanup', 'Bring gloves.', 'Sandy Cove Beach',
          '400 Shoreline Drive, Example Valley', managerId, orgId,
          new Date().toISOString(), start,
        );
        await db.prepare(`
          INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
          VALUES (?, ?, 'Morning', 'Litter picking', ?, ?, 10)
        `).run(`slot-${eventId}`, eventId, start, new Date(Date.parse(start) + 3600 * 1000).toISOString());
      });

      afterAll(async () => {
        await db.prepare('DELETE FROM slots WHERE event_id LIKE ?').run('evt-public-%');
        await db.prepare('DELETE FROM events WHERE id LIKE ?').run('evt-public-%');
      });

      it('advertises the title, the date and the category', async () => {
        const { organization: o } = (await open()).body;
        expect(o.upcoming).toHaveLength(1);
        expect(o.upcoming[0]).toMatchObject({ title: 'Beach cleanup', category: 'Environment' });
        expect(o.upcoming[0].startsAt).toBeTruthy();
      });

      /**
       * An event's location is where named minors will physically be at a stated
       * time. The title advertises the club; the location is not something a
       * share link should publish outside the platform.
       */
      it('publishes no location and no address', async () => {
        const body = JSON.stringify((await open()).body);
        expect(body).not.toContain('Sandy Cove Beach');
        expect(body).not.toContain('Shoreline Drive');
        expect(Object.keys((await open()).body.organization.upcoming[0]).sort())
          .toEqual(['category', 'startsAt', 'title']);
      });

      it('leaves a cancelled event out', async () => {
        await db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = ?`).run(eventId);
        expect((await open()).body.organization.upcoming).toEqual([]);
      });

      it('leaves a past event out', async () => {
        const past = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
        await db.prepare('UPDATE slots SET start_datetime = ?, end_datetime = ? WHERE event_id = ?')
          .run(past, past, eventId);
        expect((await open()).body.organization.upcoming).toEqual([]);
      });
    });

    it('renders a club with nothing on yet rather than failing', async () => {
      const { organization: o } = (await open()).body;
      expect(o.upcoming).toEqual([]);
      expect(o.eventCount).toBe(0);
    });
  });
});
