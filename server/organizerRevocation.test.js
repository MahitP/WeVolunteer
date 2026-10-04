import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestServer } from './testServer.js';

/**
 * Taking an organizer's approval back (P2-12).
 *
 * The owner: "is there a button to 'revoke' access? … make an approved
 * organizer unapproved … Banned students shouldn't lose all their information
 * or records … only admins should be able to do that." Suspending a student and
 * demoting an administrator existed; an approved organizer could not be
 * unapproved.
 *
 * ── The hazard this is built around ──
 *
 * Approval was one flag, `users.verified`. Clearing it alone would put the
 * organizer back in the PENDING queue — where "Deny" hard-deletes the account,
 * and the delete cascades through their events into attendance, destroying
 * hours students earned. So a revoked organizer is its own state
 * (`approval_revoked_at`): never in the pending queue, never deniable. Their
 * events, and every volunteer's record of them, stay.
 */

const ADMIN = 'admin@example.gov';
const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';

describe('revoking an organizer\'s approval', () => {
  let srv;
  let db;
  let admin;
  let student;
  let organizerId;

  const revoke = (id, body, session = admin) => srv.call('POST', `/api/admin/organizers/${id}/revoke`, body, session);
  const pending = async () => (await srv.call('GET', '/api/admin/organizers/pending', undefined, admin)).body.map(o => o.id);
  const row = (id) => db.prepare('SELECT verified, approval_revoked_at FROM users WHERE id = ?').get(id);

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    admin = await srv.login(ADMIN);
    student = await srv.login(STUDENT);
    organizerId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(ORGANIZER)).id;
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('needs a reason, and only an administrator may do it', async () => {
    expect((await revoke(organizerId, {})).status).toBe(400);
    expect((await revoke(organizerId, { reason: 'Posting events that are not volunteering.' }, student)).status).toBe(403);
  });

  it('takes posting rights away, keeps the events, and records who and why', async () => {
    const events = (await db.prepare('SELECT COUNT(*) AS n FROM events WHERE organizer_id = ?').get(organizerId)).n;
    expect(Number(events)).toBeGreaterThan(0);

    const res = await revoke(organizerId, { reason: 'Posting events that are not volunteering.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const r = await row(organizerId);
    expect(r.verified).toBe(0);
    expect(r.approval_revoked_at).toBeTruthy();
    expect(Number((await db.prepare('SELECT COUNT(*) AS n FROM events WHERE organizer_id = ?').get(organizerId)).n)).toBe(Number(events));

    const audit = await db.prepare(
      "SELECT details FROM admin_audit_logs WHERE action = 'REVOKE_ORGANIZER_APPROVAL' AND target_user_id = ? ORDER BY created_at DESC"
    ).get(organizerId);
    expect(audit?.details).toMatch(/not volunteering/);
  });

  it('keeps a revoked organizer out of the pending queue, so Deny cannot reach it', async () => {
    expect(await pending()).not.toContain(organizerId);
    const denied = await srv.call('POST', `/api/admin/organizers/${organizerId}/deny`, undefined, admin);
    expect(denied.status).toBe(404);
    expect(await db.prepare('SELECT id FROM users WHERE id = ?').get(organizerId)).toBeTruthy();
  });

  it('lists revoked organizers apart, and restores one with approval', async () => {
    const list = (await srv.call('GET', '/api/admin/organizers/approved', undefined, admin)).body;
    const entry = list.organizers.find(o => o.id === organizerId);
    expect(entry?.status).toBe('revoked');

    const restored = await srv.call('POST', `/api/admin/organizers/${organizerId}/approve`, undefined, admin);
    expect(restored.status).toBe(200);
    const r = await row(organizerId);
    expect(r.verified).toBe(1);
    expect(r.approval_revoked_at).toBeNull();
  });

  it('refuses anybody who is not an approved organizer', async () => {
    const studentId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(STUDENT)).id;
    expect((await revoke(studentId, { reason: 'Not an organizer at all.' })).status).toBe(404);
    expect((await revoke(`user-${randomUUID()}`, { reason: 'Nobody by this id.' })).status).toBe(404);
  });

  it('will not Deny-delete an unapproved organizer who already has events', async () => {
    const id = `user-${randomUUID()}`;
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, email_verified, account_status, created_at, token_version)
      VALUES (?, 'Pending With Events', ?, ?, 'x', 'Adult', 'organizer', 0, 1, 'active', ?, 0)
    `).run(id, `${id}@example.invalid`, id.replace(/-/g, '_').slice(0, 20), now);
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, created_at)
      VALUES (?, 'Old event', 'd', 'Other', 'Gym', ?, ?, 'completed', ?)
    `).run(`evt-${randomUUID()}`, now, id, now);
    const denied = await srv.call('POST', `/api/admin/organizers/${id}/deny`, undefined, admin);
    expect(denied.status).toBe(409);
    expect(await db.prepare('SELECT id FROM users WHERE id = ?').get(id)).toBeTruthy();
  });
});
