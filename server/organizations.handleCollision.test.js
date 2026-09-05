import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A handle must not be able to impersonate an organization's id.
 *
 * ── The exploit this file exists for ──
 *
 * `loadOrganization` resolves a route key against both namespaces, because
 * notification payloads and audit rows written before handles existed name
 * organizations by id and must keep resolving. That made the two namespaces
 * collide, and `validateHandle` did not stop it:
 *
 *   1. An organization id is `org-` plus a UUID — exactly `HANDLE_MAX`
 *      characters, starts with a letter, lowercase alphanumerics separated by
 *      single hyphens. It satisfied every rule a handle had to satisfy, and
 *      that module's comment claimed the letter-first rule ruled ids out.
 *   2. `formatOrganization` publishes `id` to every holder of `directory.read`,
 *      so any organizer could read any club's id.
 *   3. Claiming it as their own handle made their club shadow the victim's on
 *      every id-addressed path — so the victim's own members following a
 *      notification link landed on the attacker's page, and on an `open` club
 *      their Join press put them on a stranger's roster.
 *
 * ── Two locks, and both are asserted here ──
 *
 * `handleAvailable` refuses a handle that equals any club's id, which stops the
 * collision existing. `organizationByKey` asks the ID namespace FIRST, which
 * makes it harmless if one ever does — a value somebody typed must never
 * override an identifier the system minted.
 *
 * The second lock is the one worth having a live test for. Handle-first was
 * tried and hands the attacker exactly what they wanted, and no unit test on
 * `validateHandle` would have caught it: the ids in this suite's own database
 * are the short readable kind (`org-robotics`), not UUIDs, which is precisely
 * the shape the syntactic check misses.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const OTHER_ORGANIZER = 'robin.ellery@example.org';
const STUDENT = 'leo.chen@example.com';

describe('a handle that collides with an organization id', () => {
  let srv; let db;
  let mine; let theirs; let student;
  let mineKey; let mineId; let theirsKey; let theirsId;

  const make = async (name, session) => {
    const res = await srv.call('POST', '/api/organizations', {
      name: `${name} ${Math.random().toString(36).slice(2, 7)}`,
      description: 'A club used by the handle-collision tests.',
    }, session);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return [res.body.organization.slug, res.body.organization.id];
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    mine = await srv.login(ORGANIZER);
    theirs = await srv.login(OTHER_ORGANIZER);
    student = await srv.login(STUDENT);

    /* `robin.ellery` is a PENDING organizer in the seed, so `organization.create`
       is withheld until the Organizer Agreement is accepted — the same step
       `organizations.shareLinkAdversarial.test.js` takes, and the reason a 403
       here would otherwise look like an authorization bug. */
    const { acceptOrganizerAgreement } = await import('./organizerAgreement.js');
    const idOf = async (session) =>
      (await srv.call('GET', '/api/auth/me', undefined, session)).body.id;
    for (const session of [mine, theirs]) {
      const id = await idOf(session);
      try { await acceptOrganizerAgreement(db, { userId: id }); } catch { /* already signed */ }
    }

    [mineKey, mineId] = await make('Victim Club', mine);
    [theirsKey, theirsId] = await make('Attacker Club', theirs);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(async () => {
    /* Both handles back to something harmless, so each case starts clean. */
    await db.prepare('UPDATE organizations SET slug = ? WHERE id = ?').run(mineKey, mineId);
    await db.prepare('UPDATE organizations SET slug = ? WHERE id = ?').run(theirsKey, theirsId);
  });

  describe('the collision cannot be created', () => {
    /**
     * Refused — and WHICH lock refuses it depends on the id's shape, which is
     * worth being explicit about because that is how the gap was found.
     *
     * `createOrganization` mints `org-<uuid>`, so in this database the
     * syntactic lock fires first with a 400. A database seeded with the short
     * readable ids the demo uses (`org-robotics`) slips past that one and is
     * caught by the database check with a 409 — asserted separately below.
     */
    it('refuses a handle that is another organization’s id', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${theirsKey}`,
        { handle: mineId }, theirs);

      expect([400, 409], JSON.stringify(res.body)).toContain(res.status);
      /* And nothing moved. */
      const row = await db.prepare('SELECT slug FROM organizations WHERE id = ?').get(theirsId);
      expect(row.slug).toBe(theirsKey);
    });

    /**
     * The database lock on its own, exercised with an id the syntactic one
     * cannot see.
     *
     * This is the shape the demo seed uses and the shape that found the gap: a
     * UUID pattern covers every id `createOrganization` mints and none of the
     * hand-written ones, so the check that actually holds is the one that asks
     * the database.
     */
    it('refuses a handle equal to a short, readable id the pattern cannot see', async () => {
      const shortId = `org-short-${Math.random().toString(36).slice(2, 7)}`;
      await db.prepare(`
        INSERT INTO organizations (id, name, slug, description, status, created_at, updated_at)
        VALUES (?, 'Short Id Club', ?, '', 'active', ?, ?)
      `).run(shortId, `${shortId}-slug`, new Date().toISOString(), new Date().toISOString());

      /* Passes every syntactic rule — lowercase, letter-first, single hyphens,
         well inside the length bounds — so only the database check stands
         between it and the collision. */
      const res = await srv.call('PATCH', `/api/organizations/${theirsKey}`,
        { handle: shortId }, theirs);

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe('handle_taken');

      await db.prepare('DELETE FROM organizations WHERE id = ?').run(shortId);
    });

    it('refuses a handle that is the club’s OWN id, too', async () => {
      /* Not an attack — but it would make the club's own address ambiguous with
         its own id, and there is no reason to allow it. */
      const res = await srv.call('PATCH', `/api/organizations/${theirsKey}`,
        { handle: theirsId }, theirs);
      expect([400, 409]).toContain(res.status);
    });

    /**
     * The syntactic lock, which covers the id shape `createOrganization` mints.
     *
     * Asserted separately from the database check because it is the one that
     * works without a round trip — and because it is the one that would have
     * caught a production id while missing the short seeded ones.
     */
    it('refuses a UUID-shaped handle whether or not it names anything', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${theirsKey}`,
        { handle: 'org-4a30e1d4-0191-4694-81e2-d715926a5817' }, theirs);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('handle');
    });

    it('still accepts an ordinary handle', async () => {
      const res = await srv.call('PATCH', `/api/organizations/${theirsKey}`,
        { handle: 'attacker-club-renamed' }, theirs);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.organization.slug).toBe('attacker-club-renamed');
    });
  });

  describe('and if one existed anyway, an id still resolves to its own row', () => {
    /**
     * Written straight to the column, bypassing every validator.
     *
     * That is the point: this asserts the RESOLUTION order, which is the
     * property that has to hold even if a handle got in by some route the
     * validators do not cover — a migration, a `bin/` script, or a rule that
     * changes later.
     */
    const forceCollision = async () => {
      await db.prepare('UPDATE organizations SET slug = ? WHERE id = ?').run(mineId, theirsId);
    };

    it('resolves the id to the club whose id it is, not to the claimant', async () => {
      await forceCollision();

      const res = await srv.call('GET', `/api/organizations/${mineId}`, undefined, student);
      expect(res.status).toBe(200);
      /* The VICTIM. Handle-first returned the attacker here, which is exactly
         what the exploit wanted. */
      expect(res.body.organization.id).toBe(mineId);
    });

    it('does not hand the claimant the victim’s roster or its controls', async () => {
      await forceCollision();

      const res = await srv.call('GET', `/api/organizations/${mineId}`, undefined, theirs);
      expect(res.status).toBe(200);
      expect(res.body.organization.id).toBe(mineId);
      /* They manage their own club, not this one — so `canManage` has to be
         false even though the path they used is the string they chose. */
      expect(res.body.viewer.canManage).toBe(false);
    });

    it('does not let a join through the colliding path land on the wrong club', async () => {
      await forceCollision();
      await db.prepare(`UPDATE organizations SET join_policy = 'open' WHERE id = ?`).run(mineId);

      const res = await srv.call('POST', `/api/organizations/${mineId}/membership`, {}, student);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      /* On the victim's roster, which is the club the id names — not on the
         claimant's. */
      const onVictim = await db.prepare(
        'SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ('
        + 'SELECT id FROM users WHERE email = ?)'
      ).get(mineId, STUDENT);
      const onAttacker = await db.prepare(
        'SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ('
        + 'SELECT id FROM users WHERE email = ?)'
      ).get(theirsId, STUDENT);

      expect(onVictim).toBeTruthy();
      expect(onAttacker).toBeFalsy();
    });

    /**
     * The `@` form is NEVER resolved as an id, and that is deliberate.
     *
     * `@` says "this is a handle", so `/organizations/@<something>` asks for
     * whoever holds that handle — which is the claimant, here. That is the
     * right answer: the canonical form addresses the handle namespace, and the
     * bare form is the one that has to keep serving ids written into
     * notification and audit rows before handles existed.
     *
     * So the two namespaces are only ever ambiguous on the BARE path, where the
     * id wins — and the club that chose a colliding name is the one that loses
     * its bare address, which is the right way round for the harm to fall.
     */
    it('resolves the @ form as a handle and never as an id', async () => {
      await forceCollision();

      const canonical = await srv.call('GET', `/api/organizations/@${mineId}`, undefined, student);
      expect(canonical.status).toBe(200);
      /* The claimant, because that is who holds the handle. */
      expect(canonical.body.organization.id).toBe(theirsId);

      /* And the BARE form still answers with the club whose id it is, which is
         the property the exploit turned on. */
      const bare = await srv.call('GET', `/api/organizations/${mineId}`, undefined, student);
      expect(bare.body.organization.id).toBe(mineId);
    });
  });
});
