import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-invite-'));
process.env.WEV_DB_PATH = path.join(dir, 'invite.db');

let db, mod;

/**
 * `resolveInvitation` — the acceptance decision, tested directly.
 *
 * The route suite covers who may create and revoke. This covers the part that
 * decides whether a token becomes administrator authority, because that is the
 * decision an attacker attacks and it has five separate ways to say no.
 *
 * Tested at the module rather than through HTTP so each refusal can be produced
 * in isolation. Through the API several of them are indistinguishable BY DESIGN
 * (§4.3.5) — which is exactly why they need proving apart somewhere.
 */
beforeAll(async () => {
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  db = dbMod.db;
  mod = await import('./adminInvitations.js');
});

const NOW = new Date('2026-06-01T12:00:00.000Z');
const OWNER = 'inv-owner';
const INVITED = 'invited@example.invalid';

const addUser = (id, email, role, emailVerified = 1) => {
  db.prepare(`
    INSERT OR REPLACE INTO users (id, name, email, username, password_hash, grade, role,
                       verified, email_verified, account_status, created_at, token_version)
    VALUES (?, ?, ?, ?, 'x', '11', ?, 1, ?, 'active', ?, 0)
  `).run(id, `P ${id}`, email, id, role, emailVerified, NOW.toISOString());
};

const userRow = (id) => db.prepare(
  'SELECT id, email, email_verified FROM users WHERE id = ?'
).get(id);

beforeEach(() => {
  db.prepare('DELETE FROM admin_invitations').run();
  db.prepare("DELETE FROM users WHERE id LIKE 'inv-%'").run();
  addUser(OWNER, 'inv-owner@example.invalid', 'super_admin');
  addUser('inv-target', INVITED, 'student');
});

const makeInvite = (over = {}) => mod.createInvitation(db, {
  email: INVITED, role: 'admin', reason: 'Elected to the board for 2026',
  invitedBy: OWNER, now: NOW, ...over,
});

describe('resolveInvitation', () => {
  it('accepts a live token from the verified invited address', () => {
    const { token } = makeInvite();
    const res = mod.resolveInvitation(db, { token, user: userRow('inv-target'), now: NOW });
    expect(res.ok).toBe(true);
    expect(res.invitation.email).toBe(INVITED);
  });

  /**
   * IV-7, and the reason the feature is safe to deliver by email at all. Binding
   * to the token alone would mean a forwarded or intercepted message confers
   * administrator authority.
   */
  it('refuses a different signed-in address holding the same token', () => {
    const { token } = makeInvite();
    addUser('inv-other', 'somebody-else@example.invalid', 'student');

    const res = mod.resolveInvitation(db, { token, user: userRow('inv-other'), now: NOW });
    expect(res.ok).toBe(false);
    expect(res.logReason).toMatch(/does not match/);
  });

  /**
   * IV-6. Without this a token could be redeemed by registering the invited
   * address without ever proving control of it — which is the whole guarantee
   * IV-7 rests on.
   */
  it('refuses an unverified address, even the right one', () => {
    const { token } = makeInvite();
    db.prepare("UPDATE users SET email_verified = 0 WHERE id = 'inv-target'").run();

    const res = mod.resolveInvitation(db, { token, user: userRow('inv-target'), now: NOW });
    expect(res.ok).toBe(false);
    expect(res.logReason).toMatch(/not verified/);
  });

  /** IV-10: expiry is terminal, and there is deliberately no renewal path. */
  it('refuses an expired token', () => {
    const { token } = makeInvite();
    const later = new Date(NOW.getTime() + mod.INVITE_TTL_MS + 1000);

    const res = mod.resolveInvitation(db, { token, user: userRow('inv-target'), now: later });
    expect(res.ok).toBe(false);
    expect(res.logReason).toBe('expired');
  });

  it('refuses a revoked token', () => {
    const { token, id } = makeInvite();
    mod.revokeInvitation(db, { id, now: NOW });

    const res = mod.resolveInvitation(db, { token, user: userRow('inv-target'), now: NOW });
    expect(res.ok).toBe(false);
    expect(res.logReason).toMatch(/status is revoked/);
  });

  it('refuses a token that was replaced by a newer invitation', () => {
    const first = makeInvite();
    makeInvite({ reason: 'Re-sent because the first bounced' });

    const res = mod.resolveInvitation(db, { token: first.token, user: userRow('inv-target'), now: NOW });
    expect(res.ok).toBe(false);
    expect(res.logReason).toMatch(/status is replaced/);
  });

  /**
   * IV-15. Cannot happen today — ownership is not removable through the product —
   * and checked anyway so the property survives a future change rather than
   * becoming a comment nobody re-reads.
   */
  it("refuses when the inviting owner no longer holds ownership", () => {
    const { token } = makeInvite();
    db.prepare("UPDATE users SET role = 'student' WHERE id = ?").run(OWNER);

    const res = mod.resolveInvitation(db, { token, user: userRow('inv-target'), now: NOW });
    expect(res.ok).toBe(false);
    expect(res.logReason).toMatch(/no longer holds ownership/);
  });

  /**
   * Every refusal carries the SAME caller-facing shape, whatever the cause. The
   * `logReason` differs — that is for the server log — but a caller sees one
   * code and one sentence, because distinguishing them is a probe for a live
   * invitation.
   */
  it('gives every refusal an identical caller-facing shape', () => {
    const { token } = makeInvite();
    const target = userRow('inv-target');
    addUser('inv-other', 'somebody-else@example.invalid', 'student');

    /**
     * Four causes that are genuinely distinct at this layer.
     *
     * Deliberately NOT including a revoked token alongside a `user: null` case:
     * the status check runs before the address check, so both would report
     * "status is revoked" and the assertion about distinct log reasons would be
     * measuring the order of the checks rather than their coverage. The revoked
     * and expired paths are covered in their own tests above.
     */
    const refusals = [
      mod.resolveInvitation(db, { token: 'nope', user: target, now: NOW }),
      mod.resolveInvitation(db, { token: null, user: target, now: NOW }),
      mod.resolveInvitation(db, { token, user: userRow('inv-other'), now: NOW }),
      mod.resolveInvitation(db, { token, user: null, now: NOW }),
    ];

    const shapes = new Set(refusals.map(r => `${r.ok}|${r.code}|${r.error}`));
    expect(
      shapes.size,
      'the refusals differ to the caller, so somebody can tell which case applied'
    ).toBe(1);
    /* And every one of them explained itself differently to the log, so an
       operator fielding "the link does not work" can still diagnose it. */
    expect(new Set(refusals.map(r => r.logReason)).size).toBe(refusals.length);
  });

  /** The token is never recoverable from storage. */
  it('stores no form of the token that can be replayed', () => {
    const { token } = makeInvite();
    const row = db.prepare('SELECT * FROM admin_invitations WHERE email = ?').get(INVITED);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.token_hash).toBe(mod.__hashToken(token));
  });
});

describe('invitationRefusal', () => {
  it('allows an ordinary address', () => {
    expect(mod.invitationRefusal(db, {
      email: INVITED, role: 'admin', reason: 'Elected to the board for 2026',
    })).toBeNull();
  });

  it('normalises the address before deciding', () => {
    /* An owner invited as `INV-OWNER@Example.INVALID` must still be refused. */
    const res = mod.invitationRefusal(db, {
      email: '  INV-OWNER@Example.INVALID ', role: 'admin', reason: 'Elected to the board',
    });
    expect(res?.code).toBe('already_owner');
  });
});
