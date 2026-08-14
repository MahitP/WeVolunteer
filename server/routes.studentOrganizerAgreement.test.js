import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The Student Organizer Agreement, and the gate it releases.
 *
 * ── What this covers ──
 *
 * A student promoted to help run a club can see the people who apply to its
 * events — names, usernames, grade, school, and on the CSV export, email
 * addresses — and can write credited hours onto their service records. The
 * Organizer Agreement binds `organizer` accounts and does not reach them; this
 * document does, and until it is accepted the four capabilities the rank confers
 * are withheld.
 *
 * The important property is that the SERVER is the gate. A screen that says
 * "agreement required" while the API already works is worse than no screen: it
 * reads as enforcement to everyone who looks at it, and enforces nothing.
 */

const OWNER = 'jordan.whitfield@example.org';
const HELPER = 'leo.chen@example.com';
const BYSTANDER = 'priya.patel@example.com';

describe('the Student Organizer Agreement', () => {
  let srv; let db;
  let owner; let helper; let bystander;
  let ownerId; let helperId; let bystanderId;
  let orgId; let orgKey;

  const idOf = async (s) => (await srv.call('GET', '/api/auth/me', undefined, s)).body.id;

  const seat = (userId, role) => db.prepare(`
    INSERT OR REPLACE INTO organization_members (organization_id, user_id, member_role, joined_at)
    VALUES (?, ?, ?, ?)
  `).run(orgId, userId, role, new Date().toISOString());

  const setRole = (userId, memberRole) =>
    srv.call('PATCH', `/api/organizations/${orgKey}/members/${userId}`, { memberRole }, owner);

  const status = (session) =>
    srv.call('GET', '/api/legal/student-organizer-agreement', undefined, session);

  const accept = (session, body = { acknowledged: true }) =>
    srv.call('POST', '/api/legal/student-organizer-agreement/accept', body, session);

  const post = (session) => srv.call('POST', `/api/organizations/${orgKey}/announcements`,
    { body: 'A notice from the club.' }, session);

  const acceptanceRows = (userId) => db.prepare(
    `SELECT document_slug, version FROM legal_acceptances
      WHERE user_id = ? AND document_slug = 'student-organizer-agreement'`
  ).all(userId);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    owner = await srv.login(OWNER);
    helper = await srv.login(HELPER);
    bystander = await srv.login(BYSTANDER);
    ownerId = await idOf(owner);
    helperId = await idOf(helper);
    bystanderId = await idOf(bystander);

    const created = await srv.call('POST', '/api/organizations', {
      name: `Agreement Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club used by the student-organizer-agreement tests.',
    }, owner);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgId = created.body.organization.id;
    orgKey = created.body.organization.slug;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    db.prepare(
      `DELETE FROM legal_acceptances
        WHERE user_id IN (?, ?) AND document_slug = 'student-organizer-agreement'`
    ).run(helperId, bystanderId);
    seat(ownerId, 'manager');
    seat(bystanderId, 'member');
    seat(helperId, 'member');
    await setRole(helperId, 'student_organizer');
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the gate', () => {
    it('withholds the rank’s capabilities until it is accepted', async () => {
      const before = await post(helper);
      expect(before.status, 'the rank worked with no agreement on record').toBe(403);

      expect((await accept(helper)).status).toBe(200);

      const after = await post(helper);
      expect(after.status, JSON.stringify(after.body)).toBe(201);
    });

    it('is enforced by the SERVER, not by the screen', async () => {
      /**
       * The property that matters. The capabilities are granted on the
       * membership row and withheld by `can()` — so the rows exist while the
       * request is still refused, and no client is involved in the decision.
       */
      const granted = db.prepare(
        `SELECT COUNT(*) AS n FROM user_capabilities
          WHERE user_id = ? AND capability LIKE 'organization.%'`
      ).get(helperId).n;
      expect(granted, 'the promotion did not grant').toBe(4);

      const me = await srv.call('GET', '/api/auth/me', undefined, helper);
      expect(me.body.withheld).toEqual(expect.arrayContaining([
        'organization.post.create', 'organization.event.create',
      ]));
      expect((await post(helper)).status).toBe(403);
    });

    it('releases every one of the four, not just the one that was tried', async () => {
      await accept(helper);
      const me = await srv.call('GET', '/api/auth/me', undefined, helper);
      for (const cap of ['organization.post.create', 'organization.post.manage',
        'organization.event.create', 'organization.event.manage.own']) {
        expect(me.body.withheld, `${cap} stayed withheld`).not.toContain(cap);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('who is asked', () => {
    it('tells a helper it is required', async () => {
      const res = await status(helper);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ required: true, accepted: false });
      expect(res.body.documents[0]).toMatchObject({
        slug: 'student-organizer-agreement', version: '1.0',
      });
    });

    it('tells an ordinary member it is not, rather than refusing', async () => {
      /* The client asks this on load. A 403 would make "nothing to accept"
         indistinguishable from "the request failed". */
      const res = await status(bystander);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ required: false });
    });

    it('refuses an acceptance from somebody it does not bind', async () => {
      /* A row for a person the agreement does not cover is a false record, and
         a false record in this table is worse than a missing one. */
      const res = await accept(bystander);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('not_a_student_organizer');
      expect(acceptanceRows(bystanderId)).toEqual([]);
    });

    it('also binds a STUDENT who manages a club', async () => {
      /**
       * A student manager holds the four by grant exactly as a helper does —
       * their role gives them nothing — so the same undertaking applies. Asked
       * of the membership table rather than the role, because the rank is a
       * membership row.
       */
      await setRole(helperId, 'manager');
      const res = await status(helper);
      expect(res.body.required).toBe(true);
      expect((await post(helper)).status).toBe(403);

      await accept(helper);
      expect((await post(helper)).status).toBe(201);
    });

    it('does not withhold anything from an ADULT organizer who is also seated', async () => {
      /**
       * An organizer holds these four from their ROLE, and is bound by the
       * Organizer Agreement, which withholds the same four already. Making a
       * second document a precondition for capabilities their role grants would
       * gate an adult on a form written for fifteen-year-olds.
       */
      const me = await srv.call('GET', '/api/auth/me', undefined, owner);
      expect(me.body.withheld).not.toContain('organization.post.create');
      expect((await post(owner)).status).toBe(201);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the record', () => {
    it('writes one acceptance row, at the current version', async () => {
      await accept(helper);
      expect(acceptanceRows(helperId)).toEqual([
        { document_slug: 'student-organizer-agreement', version: '1.0' },
      ]);
    });

    it('is idempotent — a second submission writes no second row', async () => {
      await accept(helper);
      const again = await accept(helper);
      expect(again.status).toBe(200);
      expect(again.body.alreadyAccepted).toBe(true);
      expect(acceptanceRows(helperId)).toHaveLength(1);
    });

    it('refuses a submission that acknowledges nothing', async () => {
      /* `=== true`, not a truthy test: the string "false" is truthy. */
      for (const body of [{}, { acknowledged: false }, { acknowledged: 'false' }]) {
        const res = await accept(helper, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe('acknowledgement_required');
      }
      expect(acceptanceRows(helperId)).toEqual([]);
    });

    it('survives demotion, so re-promotion does not ask again at the same version', async () => {
      /**
       * The acceptance is a historical fact about a person, not a property of a
       * rank they currently hold. Deleting it on demotion would destroy the
       * evidence the document exists to create, and would make somebody
       * re-accept text they have already read and agreed to.
       */
      await accept(helper);
      await setRole(helperId, 'member');
      expect(acceptanceRows(helperId)).toHaveLength(1);

      await setRole(helperId, 'student_organizer');
      expect((await status(helper)).body.accepted).toBe(true);
      expect((await post(helper)).status).toBe(201);
    });

    it('asks again when the version moves', async () => {
      /**
       * The whole reason the record is keyed on `(slug, version)`. An acceptance
       * of 1.0 is not an acceptance of 1.1 — the gate re-arms, which is what
       * makes republishing meaningful rather than decorative.
       */
      await accept(helper);
      expect((await post(helper)).status).toBe(201);

      db.prepare(
        `UPDATE legal_acceptances SET version = '0.9'
          WHERE user_id = ? AND document_slug = 'student-organizer-agreement'`
      ).run(helperId);

      expect((await status(helper)).body.accepted).toBe(false);
      expect((await post(helper)).status).toBe(403);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('reachability while withheld', () => {
    it('lets somebody holding nothing read and accept it', async () => {
      /**
       * Load-bearing. A consent screen that requires the permissions it releases
       * is a lockout, and a lockout is what teaches people to click through
       * without reading. Both endpoints must answer while the four are withheld.
       */
      expect((await status(helper)).status).toBe(200);
      expect((await accept(helper)).status).toBe(200);
    });

    it('serves the document text itself', async () => {
      const doc = await srv.call('GET', '/api/legal/student-organizer-agreement/document', undefined, helper);
      /* Whichever path the Legal Center serves it on, the text must be reachable
         — the acceptance screen renders the whole agreement above the boxes. */
      if (doc.status === 404) {
        const alt = await srv.call('GET', '/api/legal/documents/student-organizer-agreement', undefined, helper);
        expect(alt.status, 'the published text is not reachable anywhere').toBe(200);
        expect(alt.body.markdown).toMatch(/Student Organizer Agreement/);
      } else {
        expect(doc.status).toBe(200);
      }
    });
  });
});
