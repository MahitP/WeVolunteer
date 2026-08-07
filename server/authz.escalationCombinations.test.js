import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { SUPER_ONLY, CAPABILITIES, ROLE } from './authz.js';

/* A seeded account promoted for this suite, the same idiom the invitation suite
   uses. Deliberately not `admin@example.gov` — the whole file is about what an
   ordinary administrator cannot do to an owner, so they must be two accounts. */
const OWNER_EMAIL = 'dsanger@outlook.com';
const STUDENT_EMAIL = 'leo.chen28@gmail.com';

/**
 * Capabilities that are individually safe and dangerous together.
 *
 * ── Why this file exists separately from `authz.matrix.test.js` ──
 *
 * The matrix asks "may role R reach route X" for every pair, and it is thorough.
 * What it cannot ask is the question that actually produces privilege-escalation
 * bugs: **given everything an account legitimately holds, is there a sequence
 * that ends somewhere it should never reach?**
 *
 * Each step in such a sequence answers 200 and is meant to. There is no wrong
 * status code to detect anywhere along it, which is why a status matrix is blind
 * to the whole class. The properties below are about composition, so they are
 * asserted as end states — what the account IS afterwards — rather than as
 * response codes.
 *
 * The one already found this way is in `suspendedWritePaths.test.js`: a suspended
 * person accepting an administrator invitation. Neither the invitation system nor
 * the suspension gate is wrong alone.
 */
describe('cross-feature privilege escalation', () => {
  let srv, db, owner, admin;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    admin = await srv.login('admin@example.gov');
    owner = await srv.loginAsOwner(OWNER_EMAIL);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /* ── Administrator authority must not spread without an owner ──────────── */

  /**
   * The anti-propagation property, and the most important one here.
   *
   * If an administrator could invite an administrator, then one compromised or
   * regretted admin account becomes any number of them, and the owner who granted
   * the first has no involvement in — and no notice of — the rest. Ownership of
   * the administrator population has to stay with the owner.
   *
   * It holds because `admin.create` is in SUPER_ONLY rather than in the `admin`
   * capability list. Asserted here at the route, because "it is in a list" and
   * "the endpoint refuses" are different claims.
   */
  it('an administrator cannot invite another administrator', async () => {
    const res = await srv.call('POST', '/api/admin/invitations',
      { email: 'chain@example.invalid', reason: 'Extending the team quietly' }, admin);

    expect(res.status).toBe(403);
    /* The capability gate, not a step-up refusal. `requireCap('admin.create')` runs
       before `requireAAL2`, so an administrator never even reaches the point of
       being asked to verify — which is right: being asked to re-enter a password
       for something you can never do is a worse answer than "no". */
    expect(res.body?.code).not.toBe('reauth_required');

    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_invitations WHERE email = ?')
      .get('chain@example.invalid').n).toBe(0);
  });

  /**
   * And it cannot be reached by the mechanism designed to hand out capabilities
   * one at a time.
   *
   * A per-user grant is the sanctioned way to build a narrow role — the "triage
   * helper" who works the report queue and nothing else. That mechanism must not
   * be able to hand out the capability that creates administrators, or the
   * SUPER_ONLY list above is decoration.
   *
   * Asserted against the *authorization kernel* rather than a grant endpoint,
   * because the check that makes it true (`SUPER_ONLY` consulted before grants)
   * lives there and applies to every future caller.
   */
  it('SUPER_ONLY capabilities are not grantable to an administrator', async () => {
    const { can } = await import('./authz.js');
    const { principalFor } = await import('./authz.js');

    const adminRow = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@example.gov');

    for (const cap of SUPER_ONLY) {
      /* A principal holding the grant explicitly — the strongest form of the
         question. If a grant could confer it, this is where it would show. */
      const withGrant = principalFor(adminRow, { grants: [cap] });
      expect(can(withGrant, cap), `${cap} became reachable through a per-user grant`).toBe(false);
    }
  });

  /**
   * An invited administrator is an administrator, not an owner.
   *
   * The invitation row's role is what the promotion writes, and the request may
   * name a role. So the question is whether a crafted invitation can name
   * `super_admin` and be honoured — which would turn the one owner-only feature
   * into a way of minting owners.
   */
  it('an invitation cannot be created for the owner role', async () => {
    const res = await srv.call('POST', '/api/admin/invitations', {
      email: 'wants-the-crown@example.invalid',
      role: ROLE.SUPER_ADMIN,
      reason: 'Should be refused outright',
    }, owner, await srv.verified(owner, 'admin.invite', {
      params: { email: 'wants-the-crown@example.invalid' },
    }));

    /* Refused for the ROLE specifically — asserted by code rather than by status,
       so this cannot start passing because of an unrelated 400. */
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe('role_invalid');

    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_invitations WHERE email = ?')
      .get('wants-the-crown@example.invalid').n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_invitations WHERE email = ?')
      .get('wants-the-crown@example.invalid').n).toBe(0);
  });

  /**
   * Defence in depth for the same thing, at the storage layer.
   *
   * The route validates against `INVITABLE_ROLES`. If somebody later adds a code
   * path that writes an invitation without going through it, the CHECK constraint
   * is what still refuses. Asserted by attempting the write directly, because
   * that is the only way to reach past the application.
   */
  it('the database refuses to store an owner invitation at all', () => {
    expect(() => db.prepare(`
      INSERT INTO admin_invitations (id, email, role, token_hash, invited_by, reason, status, created_at, expires_at)
      VALUES ('inv-escalation-probe', 'db@example.invalid', 'super_admin', 'x', 'user-admin', 'probe', 'pending', '2026-08-07', '2026-08-14')
    `).run()).toThrow();
  });

  /* ── An administrator must not be able to remove the owner ─────────────── */

  /**
   * `user.suspend` is an ordinary moderation capability. An owner who can be
   * suspended by an administrator is not an owner — and the administrator would
   * be using a capability granted for keeping students safe to lock out the only
   * account that could undo it.
   *
   * Each of these is guarded separately in `adminRoutes.js`. They are asserted
   * together because the escalation is "reach the owner by ANY route", and a new
   * route would be the gap.
   *
   * `warn` answers with suspension's wording ("A super administrator cannot be
   * suspended") because it reuses `suspensionTargetError` wholesale. That is
   * deliberate and recorded at the handler: a warning is a lesser act, but every
   * reason those refusals exist applies to it unchanged, and one set of target
   * rules that is slightly misworded beats two copies that can diverge. Asserted
   * on status rather than message text so this file does not pin a wording its
   * author chose to accept.
   */
  it.each([
    ['suspend', 'POST', (id) => `/api/admin/users/${id}/suspend`, { reason: 'Locking out the owner' }],
    ['warn', 'POST', (id) => `/api/admin/users/${id}/warn`, { reason: 'Warning the owner' }],
    ['revoke ownership from', 'POST', (id) => `/api/admin/users/${id}/revoke`, { reason: 'Demoting the owner' }],
  ])('an administrator cannot %s the owner', async (_label, method, pathFor, body) => {
    const ownerRow = db.prepare('SELECT id, role, account_status FROM users WHERE email = ?')
      .get(OWNER_EMAIL);
    expect(ownerRow.role).toBe(ROLE.SUPER_ADMIN);

    const res = await srv.call(method, pathFor(ownerRow.id), body, admin);

    /**
     * 403, and specifically NOT 404.
     *
     * This assertion exists because two cases in this file originally used
     * `/promote-admin` and `/revoke-admin` — paths that do not exist. Express
     * answered 404, `status >= 400` was satisfied, and both tests passed while
     * proving nothing at all about the owner being protected. A test that passes
     * because the URL is wrong is worse than a missing test: it occupies the space
     * where the real one would go.
     */
    expect(res.status, `${method} ${pathFor(ownerRow.id)} does not exist — the test is probing nothing`)
      .not.toBe(404);
    expect(res.status).toBe(403);

    /* The end state is the assertion. A refusal that still changed the row would
       satisfy a status check and lose the platform. */
    const after = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(ownerRow.id);
    expect(after.role).toBe(ROLE.SUPER_ADMIN);
    expect(after.account_status).toBe('active');
  });

  /**
   * There is no administrative route that deletes an account, so the owner cannot
   * be deleted by one.
   *
   * Written as a positive assertion rather than left out, because the absence is
   * the security property. Account deletion is self-service only
   * (`DELETE /api/auth/account`, behind a step-up), which means no administrator
   * can erase a person — including an owner, and including a student whose
   * account is the subject of an open report.
   *
   * Discovered while adding a `DELETE /api/admin/users/:id` case to the list
   * above: the 404 tripwire refused it, which is the tripwire doing its job on the
   * person who wrote it.
   */
  it('has no administrative account-deletion route to reach the owner through', async () => {
    const ownerRow = db.prepare('SELECT id FROM users WHERE email = ?').get(OWNER_EMAIL);

    for (const path of [
      `/api/admin/users/${ownerRow.id}`,
      `/api/admin/users/${ownerRow.id}/delete`,
    ]) {
      const res = await srv.call('DELETE', path, {}, admin);
      expect(res.status, `${path} exists — it needs an owner guard`).toBe(404);
    }

    /* And the owner is still there, which is the point of all of it. */
    expect(db.prepare('SELECT account_status FROM users WHERE id = ?').get(ownerRow.id)
      .account_status).toBe('active');
  });

  /**
   * Nor promote themselves.
   *
   * `admin.promote` creates administrators, not owners, so this is not reachable
   * by design — but self-promotion is the shortest escalation path in any system
   * that has a promote endpoint, and it costs one test to know.
   */
  it('an administrator cannot promote themselves to owner', async () => {
    const before = db.prepare('SELECT role FROM users WHERE email = ?').get('admin@example.gov').role;

    const res = await srv.call('POST', '/api/admin/users/user-admin/promote',
      { reason: 'Self-service', role: ROLE.SUPER_ADMIN }, admin);

    expect(res.status, 'the promote route moved — this test is probing nothing').not.toBe(404);
    /* Refused on the capability: `admin.create` is SUPER_ONLY, so promotion is not
       something an administrator can perform on anybody, themselves included. */
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT role FROM users WHERE email = ?').get('admin@example.gov').role)
      .toBe(before);
  });

  /* ── A narrow grant must stay narrow ──────────────────────────────────── */

  /**
   * The triage helper, which is the reason per-user grants exist.
   *
   * `report.evidence.read` was split from `report.resolve` precisely so somebody
   * can work the queue without reading a student's private messages, and so the
   * reverse can be granted too. The split is worth nothing if holding one quietly
   * implies the other, or if either implies reading the audit trail.
   */
  it('a grant of one capability confers no other', async () => {
    const { can, principalFor } = await import('./authz.js');
    const studentRow = db.prepare('SELECT * FROM users WHERE email = ?')
      .get(STUDENT_EMAIL);

    const helper = principalFor(studentRow, { grants: ['report.evidence.read'] });

    expect(can(helper, 'report.evidence.read')).toBe(true);
    for (const cap of ['report.resolve', 'audit.read', 'user.suspend', 'admin.create']) {
      expect(can(helper, cap), `a report.evidence.read grant leaked ${cap}`).toBe(false);
    }
  });

  /**
   * A capability nobody defined must never resolve true — including for the owner.
   *
   * `can()` refuses any capability not named in `authz.js`, and this is the case
   * that keeps that honest. Without it a typo'd gate (`'error.raed'`) resolves
   * TRUE for super_admin because of the `'*'` wildcard and 403 for everybody
   * else — a bug that looks like a working feature to whoever tests it, because
   * the person testing an owner-only feature is usually the owner.
   */
  it('a misspelled capability is refused even for the owner', async () => {
    const { can, principalFor } = await import('./authz.js');
    const ownerRow = db.prepare('SELECT * FROM users WHERE email = ?')
      .get(OWNER_EMAIL);

    const principal = principalFor(ownerRow);
    expect(can(principal, 'admin.create')).toBe(true);          // the real one
    expect(can(principal, 'admin.craete')).toBe(false);         // the typo
    expect(can(principal, 'error.raed')).toBe(false);
    expect(can(principal, '')).toBe(false);
  });

  /* ── The role tables themselves ───────────────────────────────────────── */

  /**
   * No ordinary role may list a SUPER_ONLY capability.
   *
   * The two lists are independent structures, and `SUPER_ONLY` is enforced by a
   * check that runs *before* per-user grants — but nothing stops somebody adding
   * `'audit.read'` to the `admin` array, at which point the SUPER_ONLY entry
   * becomes a comment. This is the guard for that, and it is cheap.
   */
  it('no role list contains a SUPER_ONLY capability', () => {
    const leaks = [];
    for (const [role, caps] of Object.entries(CAPABILITIES)) {
      if (caps.includes('*')) continue;                 // super_admin, by design
      for (const cap of caps) {
        if (SUPER_ONLY.includes(cap)) leaks.push(`${role} lists ${cap}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
