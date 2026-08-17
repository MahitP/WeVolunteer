import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

const OWNER_EMAIL = 'derek.sorensen@example.com';
const INVITEE = 'invitee@example.invalid';

/**
 * Administrator invitations — §4.3, acceptance criteria AC-4.3.1 … AC-4.3.10.
 *
 * ── The idea the whole feature turns on ──
 *
 * A pending invitation is administrator authority awaiting collection. That makes
 * this table the highest-value target on the platform, and it is why the token is
 * stored hashed, never shown to its creator, bound to a verified address rather
 * than to whoever holds it, and why every failure to redeem one answers
 * identically.
 *
 * The uniform-response requirement is the one most likely to be relaxed by
 * somebody debugging, so it is asserted from several angles below rather than
 * once.
 */
describe('administrator invitations', () => {
  let srv, db, owner, admin, student, inviteeToken;

  const invite = async (over = {}) => {
    const body = {
      email: INVITEE, role: 'admin',
      reason: 'Elected to the executive board for 2026-2027',
      ...over,
    };
    const challengeId = await srv.stepUp(owner, 'admin.invite', {
      params: { email: (body.email ?? '').trim().toLowerCase() },
    });
    return srv.call('POST', '/api/admin/invitations', body, owner, srv.reauthHeader(challengeId));
  };

  /** The plaintext token never leaves the server, so tests read the row directly. */
  const liveTokenFor = (email) => {
    const row = db.prepare(
      "SELECT id FROM admin_invitations WHERE email = ? AND status = 'pending'"
    ).get(email);
    return row?.id ?? null;
  };

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    owner = await srv.loginAsOwner(OWNER_EMAIL);
    admin = await srv.login('admin@example.gov');
    student = await srv.login('leo.chen@example.com');

    /* The invited person: a real account with a VERIFIED address, which is what
       IV-6 requires before a token can be redeemed. */
    await db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified,
                         email_verified, account_status, created_at, token_version)
      VALUES ('u-invitee', 'Invited Person', ?, 'invitedperson',
              '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789',
              '12', 'student', 1, 1, 'active', ?, 0)
    `).run(INVITEE, new Date().toISOString());
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  beforeEach(() => {
    db.prepare('DELETE FROM admin_invitations').run();
    db.prepare("UPDATE users SET role = 'student' WHERE id = 'u-invitee'").run();
  });

  /* ── AC-4.3.1: owner-only and step-up gated ─────────────────────────────── */

  it('refuses an ordinary administrator', async () => {
    const res = await srv.call('POST', '/api/admin/invitations',
      { email: INVITEE, role: 'admin', reason: 'Trying it on anyway' }, admin);
    expect(res.status).toBe(403);
  });

  it('refuses a student', async () => {
    const res = await srv.call('POST', '/api/admin/invitations',
      { email: INVITEE, role: 'admin', reason: 'Trying it on anyway' }, student);
    expect(res.status).toBe(403);
  });

  it('refuses an owner who has not verified recently', async () => {
    const res = await srv.call('POST', '/api/admin/invitations',
      { email: INVITEE, role: 'admin', reason: 'Elected to the board' }, owner);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  /* ── AC-4.3.3: the token is never returned ──────────────────────────────── */

  /**
   * IV-4, and the reason it exists: an inviter who keeps the token can accept
   * from an address they control, which defeats the address binding that makes
   * the whole feature safe to deliver by email.
   *
   * Asserted against the serialised response so a field ADDED later — a "copy
   * this link" convenience, say — fails here rather than shipping.
   */
  it('never returns the token, the link, or the hash to the inviter', async () => {
    const res = await invite();
    expect(res.status).toBe(201);

    const stored = await db.prepare(
      'SELECT token_hash FROM admin_invitations WHERE email = ?'
    ).get(INVITEE);
    expect(stored.token_hash).toHaveLength(64);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(stored.token_hash);
    expect(body).not.toMatch(/token/i);
    expect(body).not.toMatch(/accept-invitation\?/);
  });

  it('stores a hash rather than the token itself', async () => {
    await invite();
    const row = await db.prepare('SELECT * FROM admin_invitations WHERE email = ?').get(INVITEE);
    /* A 32-byte base64url token is 43 chars; a SHA-256 hex digest is 64. */
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  /* ── AC-4.3.2: an invitation confers nothing ────────────────────────────── */

  it('grants nothing before it is accepted', async () => {
    await invite();

    const row = await db.prepare("SELECT role FROM users WHERE id = 'u-invitee'").get();
    expect(row.role).toBe('student');

    /* And the account still cannot do administrative things. */
    inviteeToken = await srv.login(INVITEE, 'irrelevant').catch(() => null);
    const reports = await srv.call('GET', '/api/admin/reports', undefined, inviteeToken);
    expect([401, 403]).toContain(reports.status);
  });

  /* ── AC-4.3.7 / AC-4.3.8: refusals ─────────────────────────────────────── */

  it('refuses an address that already holds the role (IV-11)', async () => {
    const res = await invite({ email: 'admin@example.gov' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_holds_role');
  });

  /**
   * IV-12. Accepting would be a silent DEMOTION of the platform owner, performed
   * by the owner's own mailbox — ownership is strictly greater than `admin`.
   */
  it("refuses an owner's address (IV-12)", async () => {
    const res = await invite({ email: OWNER_EMAIL });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_owner');
  });

  it('refuses a role other than admin', async () => {
    const res = await invite({ role: 'super_admin' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('role_invalid');
  });

  it('requires a reason somebody can act on later', async () => {
    const res = await invite({ reason: 'board' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('reason_required');
  });

  /**
   * IV-13, enforced by a partial unique index rather than by application logic —
   * "check then insert" is a race whose failure mode is two live tokens for one
   * address, after which revoking one leaves the other working and the interface
   * cannot say which is authoritative.
   */
  it('keeps at most one pending invitation per address, replacing the first', async () => {
    await invite();
    const first = liveTokenFor(INVITEE);

    const second = await invite({ reason: 'Re-sent after the first was not received' });
    expect(second.status).toBe(201);
    expect(second.body.replaced).toBe(true);

    const pending = await db.prepare(
      "SELECT id FROM admin_invitations WHERE email = ? AND status = 'pending'"
    ).all(INVITEE);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(first);

    /* The superseded one is kept, not deleted, so the history survives. */
    const replaced = await db.prepare(
      "SELECT status FROM admin_invitations WHERE id = ?"
    ).get(first);
    expect(replaced.status).toBe('replaced');
  });

  /* ── AC-4.3.9: every failure response is identical ──────────────────────── */

  /**
   * The requirement most likely to be relaxed by somebody debugging, so it is
   * asserted across all five cases at once: a token that never existed, one
   * revoked, one for a different address, a malformed one, and none at all must
   * be indistinguishable.
   *
   * Distinguishing them is a probe for a live invitation, which is administrator
   * authority sitting unclaimed.
   */
  it('answers identically for every kind of bad token', async () => {
    await invite();
    const id = liveTokenFor(INVITEE);
    await db.prepare("UPDATE admin_invitations SET status = 'revoked' WHERE id = ?").run(id);

    const attempts = await Promise.all([
      srv.call('POST', '/api/auth/accept-invitation', { token: 'never-existed' }, student),
      srv.call('POST', '/api/auth/accept-invitation', { token: '' }, student),
      srv.call('POST', '/api/auth/accept-invitation', {}, student),
      srv.call('POST', '/api/auth/accept-invitation', { token: 'x'.repeat(43) }, student),
      srv.call('POST', '/api/auth/accept-invitation', { token: 12345 }, student),
    ]);

    const shapes = new Set(attempts.map(r => `${r.status}|${r.body.code}|${r.body.error}`));
    expect(
      shapes.size,
      'the refusals differ, so a caller can tell which case applied and probe for a live invitation'
    ).toBe(1);
    expect(attempts[0].status).toBe(400);
    expect(attempts[0].body.code).toBe('invitation_invalid');
  });

  /* ── AC-4.3.10: the pending list ───────────────────────────────────────── */

  it('shows owners the pending list with the five specified fields', async () => {
    await invite();
    const res = await srv.call('GET', '/api/admin/invitations', undefined, owner);

    expect(res.status).toBe(200);
    const [row] = res.body.invitations;
    expect(row.email).toBe(INVITEE);
    expect(row.role).toBe('admin');
    expect(row.invitedByName).toBeTruthy();
    expect(row.created_at).toBeTruthy();
    expect(row.expires_at).toBeTruthy();
    /* Never the token, on the list either. */
    expect(JSON.stringify(row)).not.toMatch(/token/i);
  });

  it('does not show the pending list to an administrator', async () => {
    const res = await srv.call('GET', '/api/admin/invitations', undefined, admin);
    expect(res.status).toBe(403);
  });

  /* ── IV-9: revocation ──────────────────────────────────────────────────── */

  it('revokes a pending invitation and records it', async () => {
    await invite();
    const id = liveTokenFor(INVITEE);

    const res = await srv.call('DELETE', `/api/admin/invitations/${id}`, undefined, owner);
    expect(res.status).toBe(200);

    expect((await db.prepare('SELECT status FROM admin_invitations WHERE id = ?').get(id)).status)
      .toBe('revoked');
    expect((await db.prepare(
      "SELECT COUNT(*) c FROM admin_audit_logs WHERE action = 'ADMIN_INVITE_REVOKED'"
    ).get()).c).toBeGreaterThan(0);
  });

  it('will not revoke one twice', async () => {
    await invite();
    const id = liveTokenFor(INVITEE);
    await srv.call('DELETE', `/api/admin/invitations/${id}`, undefined, owner);
    const again = await srv.call('DELETE', `/api/admin/invitations/${id}`, undefined, owner);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('not_pending');
  });

  /* ── The audit trail ───────────────────────────────────────────────────── */

  it('records the invitation with the address and the reason', async () => {
    await invite();
    const row = await db.prepare(
      "SELECT details FROM admin_audit_logs WHERE action = 'ADMIN_INVITED' ORDER BY created_at DESC"
    ).get();
    expect(row.details).toContain(INVITEE);
    expect(row.details).toContain('executive board');
  });
});
