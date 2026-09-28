/**
 * The Admin Responsibilities Policy gate.
 *
 * The policy was published as a notice and enforced by nothing. The
 * launch-checklist audit on 2026-09-27 found both owner accounts holding every
 * capability with zero acceptance rows against it, while the Organizer Agreement
 * had gated its far weaker role since it shipped.
 *
 * ── What these tests are really protecting ──
 *
 * Two opposite failures, and the second is the dangerous one.
 *
 *   1. The gate does not gate — an administrator reads a student's contact
 *      details having undertaken nothing.
 *   2. **The gate cannot be passed.** This is the only gate in the codebase that
 *      reaches the platform owner, because `can()` checks `withheld` before the
 *      `'*'` wildcard. If the acceptance route were ever gated on one of the
 *      capabilities it restores, or if sign-in were withheld, the owner would be
 *      locked out of their own instance with only `bin/` left. The
 *      "escape hatch" block below exists for that, and it matters more than the
 *      refusals above it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

describe('Admin Responsibilities Policy', () => {
  let srv;
  let ADMIN_GATED_CAPABILITIES;

  const ADMIN = 'admin@example.gov';

  beforeAll(async () => {
    srv = await startTestServer();
    ({ ADMIN_GATED_CAPABILITIES } = await import('./adminResponsibilitiesPolicy.js'));
  });
  afterAll(async () => { await srv.close(); });

  /**
   * Signs the admin in with NO acceptance row.
   *
   * Clears first, because every test here shares one server and one database:
   * without the delete, the first test that accepts leaves the admin accepted for
   * every test after it, and the refusals start passing for the wrong reason.
   */
  async function adminWithoutAcceptance() {
    const { db } = await import('./db.js');
    const row = await db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN);
    await db.prepare('DELETE FROM legal_acceptances WHERE user_id = ? AND document_slug = ?')
      .run(row.id, 'admin-responsibilities-policy');
    return srv.login(ADMIN);
  }

  describe('an administrator who has not accepted', () => {
    it('is refused a capability the policy governs', async () => {
      const token = await adminWithoutAcceptance();
      const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, token);
      expect(res.status).toBe(403);
    });

    it('is still a real administrator, not demoted', async () => {
      const token = await adminWithoutAcceptance();
      const me = await srv.call('GET', '/api/auth/me', undefined, token);
      expect(me.status).toBe(200);
      /* `selfUserResponse` is spread at the top level, so the role is on the body
         itself rather than under a `user` key. */
      expect(['admin', 'super_admin']).toContain(me.body?.role);
    });
  });

  /**
   * ── The escape hatch ──
   *
   * Everything above is worthless if these fail: a gate the owner cannot pass is
   * an outage, not a control.
   */
  describe('the escape hatch always works', () => {
    it('can still sign in and read their own account', async () => {
      const token = await adminWithoutAcceptance();
      expect((await srv.call('GET', '/api/auth/me', undefined, token)).status).toBe(200);
    });

    it('can read the policy status while gated', async () => {
      const token = await adminWithoutAcceptance();
      const res = await srv.call('GET', '/api/legal/admin-responsibilities/status', undefined, token);
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(false);
      expect(res.body.withheld).toEqual([...ADMIN_GATED_CAPABILITIES]);
    });

    it('can ACCEPT while gated — the route is not gated on what it restores', async () => {
      const token = await adminWithoutAcceptance();
      const res = await srv.call('POST', '/api/legal/admin-responsibilities/accept',
        { acknowledged: true }, token);
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
    });

    it('the withheld list never contains a capability needed to accept', () => {
      /* Asserted structurally as well as behaviourally: the behavioural test
         above would start failing the day somebody adds `self.read` to the gated
         list, but only if a test happens to exercise that path. This fails
         immediately and says why. */
      for (const needed of ['self.read', 'self.write', 'persona.preview.exit']) {
        expect(ADMIN_GATED_CAPABILITIES, `${needed} must never be withheld — it is how an admin reaches the policy`)
          .not.toContain(needed);
      }
    });

    it('never withholds the owner\'s instance-recovery controls', () => {
      for (const recovery of ['owner.console', 'admin.create', 'legal.edit', 'audit.read']) {
        expect(ADMIN_GATED_CAPABILITIES, `${recovery} must stay available — it is how an instance is recovered`)
          .not.toContain(recovery);
      }
    });
  });

  describe('accepting', () => {
    it('grants the withheld capabilities on the same session', async () => {
      const token = await adminWithoutAcceptance();
      expect((await srv.call('GET', '/api/admin/organizers/pending', undefined, token)).status).toBe(403);

      await srv.call('POST', '/api/legal/admin-responsibilities/accept', { acknowledged: true }, token);

      expect((await srv.call('GET', '/api/admin/organizers/pending', undefined, token)).status).toBe(200);
    });

    it('refuses a submission that acknowledges nothing', async () => {
      const token = await adminWithoutAcceptance();
      const res = await srv.call('POST', '/api/legal/admin-responsibilities/accept', {}, token);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('acknowledgement_required');
    });

    it('does not write a second record when submitted twice', async () => {
      const token = await adminWithoutAcceptance();
      await srv.call('POST', '/api/legal/admin-responsibilities/accept', { acknowledged: true }, token);
      const again = await srv.call('POST', '/api/legal/admin-responsibilities/accept', { acknowledged: true }, token);
      expect(again.status).toBe(200);
      expect(again.body.already).toBe(true);
    });

    it('refuses to record an acceptance for somebody it does not bind', async () => {
      const student = await srv.login('cameron.caldwell@example.com');
      const res = await srv.call('POST', '/api/legal/admin-responsibilities/accept',
        { acknowledged: true }, student);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('not_an_administrator');
    });
  });
});
