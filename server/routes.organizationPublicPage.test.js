import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The canonical public address, `/organizations/@robotics`.
 *
 * ── The distinction this file exists to keep sharp ──
 *
 * There are now two unauthenticated reads of a club, and they answer the same
 * projection while meaning completely different things:
 *
 *   `/invite/:token`  a CREDENTIAL. Unguessable, revocable, works whatever the
 *                     club's visibility is — that is what makes a flyer work —
 *                     and it is what lets a Join press succeed at an
 *                     invitation-only club.
 *   `/@handle`        an ADDRESS. Readable, printable, guessable BY DESIGN
 *                     because it is the club's name, and it carries no
 *                     authority whatsoever.
 *
 * A handle that granted joining authority would be a password anybody can read
 * off a poster and derive from a club's name. Half the assertions here are
 * about that: the handle opens the page and does nothing else.
 *
 * ── Why an unlisted club answers exactly like one that does not exist ──
 *
 * Same status, same body. Handles are guessable, so a distinguishable refusal
 * would turn this endpoint into a directory of every club on the platform that
 * chose NOT to be listed — including which schools have one.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';

describe('an organization’s public page', () => {
  let srv; let db;
  let manager; let student;
  let managerId; let studentId;
  let orgKey; let orgId;

  const open = (handle = orgKey) =>
    srv.call('GET', `/api/public/organizations/${handle}`);
  const setVisibility = (visibility) =>
    srv.call('PATCH', `/api/organizations/${orgKey}`, { visibility }, manager);
  const detail = async (session) =>
    (await srv.call('GET', `/api/organizations/${orgKey}`, undefined, session)).body;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    manager = await srv.login(ORGANIZER);
    student = await srv.login(STUDENT);
    managerId = (await srv.call('GET', '/api/auth/me', undefined, manager)).body.id;
    studentId = (await srv.call('GET', '/api/auth/me', undefined, student)).body.id;

    const created = await srv.call('POST', '/api/organizations', {
      name: `Public Page Club ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club used by the public-page tests.',
      tags: ['Coordination'],
    }, manager);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    orgKey = created.body.organization.slug;
    orgId = created.body.organization.id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    await db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(orgId);
    await db.prepare('DELETE FROM organization_share_links WHERE organization_id = ?').run(orgId);
    await db.prepare(`
      INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
      VALUES (?, ?, 'manager', ?)
    `).run(orgId, managerId, new Date().toISOString());
    await db.prepare(`
      UPDATE organizations
         SET status = 'active', join_policy = 'open', visibility = 'public'
       WHERE id = ?
    `).run(orgId);
  });

  describe('a club that chose to be public', () => {
    it('opens with no session at all', async () => {
      const res = await open();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.organization.name).toContain('Public Page Club');
    });

    it('accepts the handle written with or without the sigil', async () => {
      expect((await open(orgKey)).status).toBe(200);
      /* The `@` is punctuation the URL carries; the column stores it bare. The
         client passes the segment through verbatim, so both have to resolve. */
      expect((await open(`@${orgKey}`)).status).toBe(200);
      expect((await open(orgKey.toUpperCase())).status).toBe(200);
    });

    it('publishes the canonical address, so no client has to know about the @', async () => {
      const { organization } = (await open()).body;
      expect(organization.handle).toBe(`@${orgKey}`);
      expect(organization.slug).toBe(orgKey);
    });

    /**
     * The field list, asserted exactly.
     *
     * The half a happy-path test never covers is the ABSENT half, and this is
     * the one endpoint where getting it wrong publishes children's data to the
     * open web. A field cannot reach an unauthenticated reader by being added to
     * `organizations`, because this list would fail first.
     */
    it('discloses exactly the allowlist and nothing else', async () => {
      const { organization } = (await open()).body;
      expect(Object.keys(organization).sort()).toEqual([
        'avatar', 'avatarColor', 'description', 'eventCount', 'handle', 'imageUrl',
        'joinPolicy', 'kind', 'memberCount', 'name', 'slug', 'tags', 'upcoming',
      ]);
    });

    it('names not one member, not even the founder', async () => {
      await db.prepare(`
        INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(orgId, studentId, new Date().toISOString());

      const body = JSON.stringify((await open()).body);
      expect(body).not.toContain('Leo Chen');
      expect(body).not.toContain('leochen');
      expect(body).not.toContain('Jordan Whitfield');
      expect(body).not.toContain(studentId);
      /* The COUNT stays: it names nobody, and it is what tells a parent the
         club is real. */
      expect((await open()).body.organization.memberCount).toBeGreaterThanOrEqual(1);
    });

    it('carries neither the organization id nor any invitation token', async () => {
      await srv.call('POST', `/api/organizations/${orgKey}/share-links`, {}, manager);
      const body = JSON.stringify((await open()).body);
      expect(body).not.toContain(orgId);
      expect(body).not.toMatch(/[0-9a-f]{64}/);
    });

    it('says which policy applies, so a stranger knows what Join would do', async () => {
      for (const policy of ['open', 'invite', 'request']) {
        await db.prepare('UPDATE organizations SET join_policy = ? WHERE id = ?').run(policy, orgId);
        expect((await open()).body.organization.joinPolicy).toBe(policy);
      }
    });

    it('does not carry the invite policy or the visibility setting', async () => {
      const { organization } = (await open()).body;
      /* Both are facts about how the club is RUN, and a stranger has no use for
         either. `formatOrganization` publishes them to signed-in readers, who
         do — a member about to post the address needs to know it opens. */
      expect(organization.invitePolicy).toBeUndefined();
      expect(organization.visibility).toBeUndefined();
    });
  });

  describe('what a stranger cannot do with a handle', () => {
    /**
     * The whole security property, in one assertion.
     *
     * A handle is derived from a club's name and printed on posters. If it
     * conferred joining authority it would be a password anybody can guess.
     */
    it('cannot join an invitation-only club by naming it', async () => {
      await db.prepare(`UPDATE organizations SET join_policy = 'invite' WHERE id = ?`).run(orgId);
      const res = await srv.call('POST', `/api/organizations/${orgKey}/membership`,
        { shareToken: orgKey }, student);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('invite_required');
    });

    it('cannot pass the handle off as an invitation token', async () => {
      for (const guess of [orgKey, `@${orgKey}`, orgId]) {
        const res = await srv.call('GET', `/api/public/organizations/invite/${guess}`);
        expect(res.status, guess).toBe(404);
      }
    });

    it('cannot read the roster, the events or the announcements without a session', async () => {
      for (const path of ['', '/announcements', '/join-requests', '/invitations', '/share-links']) {
        const res = await srv.call('GET', `/api/organizations/${orgKey}${path}`);
        expect(res.status, path).toBe(401);
      }
    });
  });

  describe('a club that did not choose to be public', () => {
    /**
     * Byte-identical refusals.
     *
     * Not merely the same status: the shape of the refusal is the only thing an
     * attacker gets to measure, and "not public" distinguishable from "does not
     * exist" is a directory of the clubs that opted out.
     */
    it('answers the same 404 as a club that does not exist', async () => {
      await setVisibility('unlisted');
      const unlisted = await open();
      const absent = await open('no-such-club-anywhere');

      expect(unlisted.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(JSON.stringify(unlisted.body)).toBe(JSON.stringify(absent.body));
    });

    it('answers the same 404 once archived', async () => {
      const absent = await open('no-such-club-anywhere');
      await db.prepare(`UPDATE organizations SET status = 'archived' WHERE id = ?`).run(orgId);
      const archived = await open();

      expect(archived.status).toBe(404);
      expect(JSON.stringify(archived.body)).toBe(JSON.stringify(absent.body));
    });

    /**
     * A NULL from a row that predates the column reads as unlisted.
     *
     * `normaliseVisibility` fails closed towards not publishing, so a bad or
     * missing value can only ever publish LESS. The opposite default would mean
     * one unmigrated row silently exposes a club that never chose to be
     * exposed.
     */
    it('cannot be neither value, because the column refuses it', async () => {
      /* The first line of defence is the schema: `visibility TEXT NOT NULL`, so
         a row cannot be in a state the vocabulary does not name.

         Caught rather than asserted with `rejects`, because the two engines
         raise it differently: `node:sqlite` throws synchronously out of
         `.run()`, PostgreSQL rejects the promise. Awaiting inside a try covers
         both, which is what lets this file run unchanged under
         `npm run test:postgres`. */
      let refused;
      try {
        await db.prepare('UPDATE organizations SET visibility = NULL WHERE id = ?').run(orgId);
      } catch (err) {
        refused = err;
      }
      expect(refused, 'the column should refuse NULL').toBeTruthy();
      /* `not null` on SQLite, `not-null` on PostgreSQL — the hyphen is the
         only difference, and matching both is what lets this file run unchanged
         under `npm run test:postgres`. */
      expect(String(refused.message)).toMatch(/not[\s-]null/i);
      expect((await open()).status).toBe(200);
    });

    /**
     * And the second line is `normaliseVisibility`, which fails closed.
     *
     * Only the exact string `'public'` opens a club. Anything else — a typo, a
     * value from a future version, a row written by a script — reads as
     * unlisted, so a bad value can only ever publish LESS. The opposite default
     * would mean one odd row silently exposes a club that never chose to be.
     */
    it('reads an unrecognised value as unlisted rather than as public', async () => {
      await db.prepare(`UPDATE organizations SET visibility = 'sort-of' WHERE id = ?`).run(orgId);
      expect((await open()).status).toBe(404);

      await db.prepare(`UPDATE organizations SET visibility = 'PUBLIC' WHERE id = ?`).run(orgId);
      expect((await open()).status).toBe(404);
    });

    /** The credential still works. That is the point of having both. */
    it('is still reachable by its invitation link', async () => {
      await setVisibility('unlisted');
      const link = (await srv.call('POST', `/api/organizations/${orgKey}/share-links`, {}, manager))
        .body.link;
      const token = String(link.path).split('/').pop();

      const res = await srv.call('GET', `/api/public/organizations/invite/${token}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.organization.name).toContain('Public Page Club');
    });

    it('is still an ordinary page for a signed-in reader', async () => {
      await setVisibility('unlisted');
      const res = await srv.call('GET', `/api/organizations/${orgKey}`, undefined, student);
      expect(res.status).toBe(200);
    });
  });

  /**
   * The endpoint is bounded, and the bound is asserted rather than assumed.
   *
   * A handle is the club's NAME and guessable by design, so this is the public
   * route an enumeration would actually target — more so than the invitation
   * one, whose token is 32 random bytes. The limiter was mounted on
   * `/api/public/organizations/invite` and left this route behind `apiLimiter`
   * alone; the prefix now covers both.
   */
  describe('the rate limit', () => {
    it('is mounted on the public organization prefix, covering both endpoints', async () => {
      const { readFileSync } = await import('node:fs');
      const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

      /* Read out of app.js rather than probed with 121 requests: limiters fix
         their ceiling at module load, so a suite cannot exhaust one without a
         separate process — the shape `routes.signupMailLimit.test.js` exists
         for. What is checkable here is that the mount covers this route. */
      expect(app).toMatch(/app\.use\('\/api\/public\/organizations',\s*shareTokenLimiter\)/);
      expect(app).not.toMatch(/app\.use\('\/api\/public\/organizations\/invite',/);
    });

    it('answers a normal request without being throttled', async () => {
      /* The limit is 120 per window; a handful of reads must not trip it, or the
         ceiling would be wrong for a class opening a link together. */
      for (let i = 0; i < 5; i += 1) {
        expect((await open()).status, `request ${i}`).toBe(200);
      }
    });
  });

  describe('handles that could not name a club', () => {
    it('answers 404 for a reserved segment without a database round trip', async () => {
      for (const reserved of ['new', 'invite', '@new']) {
        expect((await open(reserved)).status, reserved).toBe(404);
      }
    });

    it('answers 404 for a malformed handle rather than an error', async () => {
      for (const bad of ['ab', 'a'.repeat(200), '2fast', 'has%20space', '..', '.']) {
        const res = await open(bad);
        /* 404, 400 or 414 depending on how far up the stack it is refused —
           an over-long path is rejected by Node before Express sees it. */
        expect([404, 400, 414, 431], `${bad} -> ${res.status}`).toContain(res.status);
      }
    });
  });

  describe('the visibility setting', () => {
    it('is a manager’s decision and nobody else’s', async () => {
      await db.prepare(`
        INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
        VALUES (?, ?, 'student_organizer', ?)
      `).run(orgId, studentId, new Date().toISOString());

      const res = await srv.call('PATCH', `/api/organizations/${orgKey}`,
        { visibility: 'unlisted' }, student);
      expect(res.status).toBe(403);
      /* And nothing changed. */
      expect((await open()).status).toBe(200);
    });

    it('refuses a value outside the vocabulary', async () => {
      const res = await setVisibility('members-only');
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('visibility');
    });

    it('takes effect on the next request', async () => {
      expect((await open()).status).toBe(200);
      await setVisibility('unlisted');
      expect((await open()).status).toBe(404);
      await setVisibility('public');
      expect((await open()).status).toBe(200);
    });

    /**
     * Published to every signed-in reader, and that is a warning rather than a
     * leak.
     *
     * A member about to put the club's address in a group chat needs to know
     * whether the people they send it to will be able to open it.
     */
    it('is on the signed-in payload, so a sharer is not surprised', async () => {
      await db.prepare(`
        INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(orgId, studentId, new Date().toISOString());

      expect((await detail(student)).organization.visibility).toBe('public');
      await setVisibility('unlisted');
      expect((await detail(student)).organization.visibility).toBe('unlisted');
    });

    it('is audited, because it decides who can read the club without an account', async () => {
      await setVisibility('unlisted');

      /**
       * Every matching row, and then a search — not `ORDER BY id DESC LIMIT 1`.
       *
       * `admin_audit_logs.id` is TEXT (`aud-<random>`), so ordering by it is
       * lexicographic and has nothing to do with when the row was written. That
       * assertion passed against an earlier case's row and reported the wrong
       * transition, which is a failure mode worth naming: an audit test that
       * reads an arbitrary row proves nothing and looks like it proves
       * everything.
       */
      const details = (await db.prepare(`
        SELECT details FROM admin_audit_logs
         WHERE action = 'ORGANIZATION_MEMBERSHIP_POLICY_CHANGED'
      `).all()).map(r => r.details ?? '');

      expect(details.some(d => /page visibility: public to unlisted/.test(d))).toBe(true);
      /* And it names the club by its canonical handle, which is the address
         somebody reading this six months later would go and check. */
      expect(details.some(d => d.includes(`@${orgKey}`))).toBe(true);
    });

    /**
     * The two axes are independent, which is the reason visibility is not a
     * fourth join mode.
     *
     * Findable with a door — a public club that admits by invitation — is the
     * combination a school club actually asks for, and the one a single enum
     * cannot express.
     */
    it('can be public while the club admits by invitation only', async () => {
      await srv.call('PATCH', `/api/organizations/${orgKey}`,
        { joinPolicy: 'invite', visibility: 'public' }, manager);

      const res = await open();
      expect(res.status).toBe(200);
      expect(res.body.organization.joinPolicy).toBe('invite');
      /* And a stranger reading it still cannot get in. */
      const tried = await srv.call('POST', `/api/organizations/${orgKey}/membership`, {}, student);
      expect(tried.status).toBe(403);
    });
  });

  describe('a new organization', () => {
    /**
     * Created public, unlike every club that predates the setting.
     *
     * The asymmetry is the privacy argument: migration 063 backfills existing
     * rows to `unlisted` because nobody running one agreed to publish it, and
     * creation takes the useful direction because whoever is creating it today
     * is looking at the setting.
     */
    it('is created with a public page', async () => {
      const created = await srv.call('POST', '/api/organizations', {
        name: `Fresh Club ${Math.random().toString(36).slice(2, 7)}`,
      }, manager);
      expect(created.status).toBe(201);
      expect(created.body.organization.visibility).toBe('public');
      expect((await open(created.body.organization.slug)).status).toBe(200);
    });
  });
});
