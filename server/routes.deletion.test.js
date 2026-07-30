import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './testServer.js';

let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const signup = (over = {}) => srv.call('POST', '/api/auth/signup', {
  email: `delete-${Math.random().toString(36).slice(2, 9)}@example.org`,
  password: 'Password123', name: 'Delete Me', role: 'student', grade: '10',
  username: `delete_${Math.random().toString(36).slice(2, 9)}`,
  ...over
});

describe('Account Deletion System', () => {
  it('should block deletion if no password provided', async () => {
    const signupRes = await signup();
    const token = signupRes.cookie;

    const res = await srv.call('DELETE', '/api/auth/account', {}, token);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Password is required/);
  });

  it('should block deletion with wrong password', async () => {
    const signupRes = await signup();
    const token = signupRes.cookie;

    const res = await srv.call('DELETE', '/api/auth/account', { password: 'WrongPassword' }, token);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Incorrect password');
  });

  it('should delete account and anonymize data on success', async () => {
    const signupRes = await signup({ password: 'CorrectPassword123' });
    const token = signupRes.cookie;
    const userId = signupRes.body.user.id;

    const res = await srv.call('DELETE', '/api/auth/account', { password: 'CorrectPassword123' }, token);
    expect(res.status).toBe(200);

    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    db.close();

    expect(user.account_status).toBe('deleted');
    expect(user.deleted_at).not.toBeNull();
    expect(user.name).toBe('Delete M.');
    expect(user.email).toBe(`deleted_${userId}@system.local`);
    expect(user.avatar).toBeNull();
    expect(user.token_version).toBe(1);
  });

  it('should block deleted users from logging in', async () => {
    const email = `delete-login-${Math.random().toString(36).slice(2, 9)}@example.org`;
    const signupRes = await signup({ email, password: 'CorrectPassword123' });
    const token = signupRes.cookie;

    await srv.call('DELETE', '/api/auth/account', { password: 'CorrectPassword123' }, token);

    const loginRes = await srv.call('POST', '/api/auth/login', { email, password: 'CorrectPassword123' });
    expect(loginRes.status).toBe(401);
    expect(loginRes.body.code).toBe('no_such_account');
  });

  /**
   * S4 — deletion must release the commitments the account still holds.
   *
   * Deletion used to touch only the user row and its preferences, so a deleted
   * volunteer stayed `accepted` on an upcoming shift: they occupied a spot
   * nobody could fill, they still counted towards the slot's capacity, and an
   * anonymised name sat on the organizer's roster for an event being staffed
   * that week.
   */
  describe('releases upcoming commitments (S4)', () => {
    /** An open event with one future slot, hosted by the seeded organizer. */
    const findOpenFutureSlot = () => {
      const db = new DatabaseSync(process.env.WEV_DB_PATH);
      const row = db.prepare(`
        SELECT s.id AS slot_id, e.id AS event_id, e.organizer_id
        FROM slots s JOIN events e ON s.event_id = e.id
        WHERE s.start_datetime > datetime('now')
          AND e.status = 'open'
        ORDER BY s.start_datetime ASC LIMIT 1
      `).get();
      db.close();
      return row;
    };

    it('withdraws the deleted account from a future shift', async () => {
      const slot = findOpenFutureSlot();
      expect(slot).toBeTruthy(); // guards the fixture, not the code

      const { cookie, user } = await srv.signupConfirmed({
        email: `release-${Math.random().toString(36).slice(2, 9)}@example.org`,
        password: 'CorrectPassword123', name: 'Release Me', role: 'student', grade: '10',
        username: `release_${Math.random().toString(36).slice(2, 9)}`
      });

      const apply = await srv.call('POST', `/api/events/${slot.event_id}/apply`, { slotId: slot.slot_id }, cookie);
      expect(apply.status).toBeLessThan(400);

      const del = await srv.call('DELETE', '/api/auth/account', { password: 'CorrectPassword123' }, cookie);
      expect(del.status).toBe(200);

      const db = new DatabaseSync(process.env.WEV_DB_PATH);
      const apps = db.prepare('SELECT status, waitlist_order FROM applications WHERE user_id = ?').all(user.id);
      const organizerNotice = db.prepare(`
        SELECT COUNT(*) AS c FROM notifications
        WHERE user_id = ? AND title LIKE '%volunteer left%'
      `).get(slot.organizer_id).c;
      db.close();

      expect(apps.length).toBeGreaterThan(0);
      // Nothing is left holding a spot.
      expect(apps.every(a => a.status === 'withdrawn')).toBe(true);
      expect(apps.every(a => a.waitlist_order === null)).toBe(true);
      // And the organizer staffing that event is told, so the freed spot is
      // actionable rather than silently vacant.
      expect(organizerNotice).toBeGreaterThan(0);
    });

    /**
     * S5 — the audit row used `audit-${Date.now()}` as its PRIMARY KEY, so two
     * deletions in the same millisecond collided, rolled the transaction back,
     * and failed both deletions with a 500.
     */
    it('survives two deletions in the same millisecond', async () => {
      const make = async (n) => srv.signupConfirmed({
        email: `race-${n}-${Math.random().toString(36).slice(2, 9)}@example.org`,
        password: 'CorrectPassword123', name: `Race ${n}`, role: 'student', grade: '10',
        username: `race_${n}_${Math.random().toString(36).slice(2, 9)}`
      });
      const [a, b] = await Promise.all([make(1), make(2)]);

      const results = await Promise.all([
        srv.call('DELETE', '/api/auth/account', { password: 'CorrectPassword123' }, a.cookie),
        srv.call('DELETE', '/api/auth/account', { password: 'CorrectPassword123' }, b.cookie)
      ]);

      expect(results.map(r => r.status)).toEqual([200, 200]);
    });
  });
});
