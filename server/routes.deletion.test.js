/**
 * Account deletion, now behind step-up re-verification (v1.2b Task 6).
 *
 * ── What changed, and why the tests changed with it ──
 *
 * This endpoint proved a password inline, and a provider-only account — having
 * none — was asked to type its own username instead, which the handler's own
 * comment conceded was not a credential. Both are gone:
 * `requireAAL2('account.delete')` demands a challenge granted by a password OR
 * by provider re-consent, and the handler spends that grant inside the same
 * transaction as the deletion.
 *
 * So every test here drives a REAL challenge end to end — open, grant, present
 * the header — rather than passing a password field. Faking a granted row would
 * skip the two things most likely to break: that the grant is bound to THIS
 * action, and that it is spent exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';

let srv;
beforeAll(async () => {
  // The provider-only deletion path below has no password to verify with, so it
  // needs the mock provider transport.
  process.env.OAUTH_ALLOW_MOCK = 'true';
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
  delete process.env.OAUTH_ALLOW_MOCK;
});

const rnd = () => Math.random().toString(36).slice(2, 9);

const signup = (over = {}) => srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
  email: `delete-${rnd()}@example.org`,
  password: 'Password123', name: 'Delete Me', role: 'student', grade: '10',
  username: `delete_${rnd()}`,
  ...over
});

const openDb = () => new DatabaseSync(process.env.WEV_DB_PATH);

/** The stored challenge row, to assert on what spending it actually did. */
function challengeRow(id) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM reauth_challenges WHERE id = ?').get(id);
  db.close();
  return row;
}

const deleteAccount = (cookie, challengeId) =>
  srv.call('DELETE', '/api/auth/account', {}, cookie, challengeId ? srv.reauthHeader(challengeId) : {});

describe('Account Deletion System', () => {
  it('refuses deletion presenting no verification at all', async () => {
    const { cookie } = await signup();

    const res = await deleteAccount(cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    // The action is in the response so the client knows which challenge to open.
    // Without it the UI has to guess, and a guess that is one character off is a
    // modal the user can never satisfy.
    expect(res.body.action).toBe('account.delete');
  });

  it('refuses to delete a super_admin account', async () => {
    const { cookie, body } = await signup();
    
    const db = openDb();
    db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(body.user.id);
    db.close();

    const granted = await srv.stepUp(cookie, 'account.delete', { password: 'Password123' });
    const res = await deleteAccount(cookie, granted);
    
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('super_admin_protected');
  });

  it('refuses a grant obtained for a different action', async () => {
    const { cookie, body } = await signup();

    /**
     * The binding that stops "verify to export your data" deleting your account.
     *
     * A challenge is a grant of AAL2 for ONE action. Presenting a perfectly
     * valid, freshly granted, correctly session-bound challenge for
     * `data.export` here must be worth nothing at all — otherwise every
     * sensitive action shares one verification and the registry's whole point
     * (this action, those arguments) is decorative.
     */
    const forExport = await srv.stepUp(cookie, 'data.export', { password: 'Password123' });

    const res = await deleteAccount(cookie, forExport);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
    expect(res.body.action).toBe('account.delete');

    // And the account is untouched — the refusal is before any work.
    const db = openDb();
    const user = db.prepare('SELECT account_status FROM users WHERE id = ?').get(body.user.id);
    db.close();
    expect(user.account_status).toBe('active');
  });

  it('refuses a challenge id that was never granted', async () => {
    const { cookie } = await signup();

    // Opened but not satisfied: this is what presenting the id straight out of
    // the modal, before answering it, looks like.
    const opened = await srv.call('POST', '/api/auth/reauth/challenge',
      { action: 'account.delete', params: {} }, cookie);
    expect(opened.status).toBe(201);

    const res = await deleteAccount(cookie, opened.body.challengeId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');
  });

  it('deletes and anonymises once identity is re-verified', async () => {
    const { cookie, body } = await signup({ password: 'CorrectPassword123' });
    const userId = body.user.id;

    const challengeId = await srv.stepUp(cookie, 'account.delete', { password: 'CorrectPassword123' });
    const res = await deleteAccount(cookie, challengeId);
    expect(res.status).toBe(200);

    const db = openDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    db.close();

    expect(user.account_status).toBe('deleted');
    expect(user.deleted_at).not.toBeNull();
    expect(user.name).toBe('Delete M.');
    expect(user.email).toBe(`deleted_${userId}@system.local`);
    expect(user.avatar).toBeNull();
    expect(user.token_version).toBe(1);
  });

  /**
   * Single use, asserted where it is decided rather than where it is convenient.
   *
   * `requireAAL2` is an early refusal, not the check: the grant only stops being
   * spendable when the handler consumes it, inside the deletion's own
   * transaction. A route that gated and never consumed would pass every other
   * test in this file while leaving the grant live for the rest of its five
   * minutes — so this reads the row.
   *
   * A literal replay of the DELETE cannot say much here: the first one bumped
   * `token_version`, so the second is refused for being an invalid session
   * before assurance is ever considered. It is asserted anyway (it must not be a
   * second 200), and the sharper replay tests live on the endpoints whose
   * session survives — see routes.identityChange.test.js and
   * routes.oauth.test.js.
   */
  it('spends the grant exactly once', async () => {
    const { cookie } = await signup({ password: 'CorrectPassword123' });

    const challengeId = await srv.stepUp(cookie, 'account.delete', { password: 'CorrectPassword123' });
    expect(challengeRow(challengeId).consumed_at).toBeNull();

    expect((await deleteAccount(cookie, challengeId)).status).toBe(200);

    const after = challengeRow(challengeId);
    expect(after.consumed_at, 'the grant is still spendable after the action it authorised').not.toBeNull();

    expect((await deleteAccount(cookie, challengeId)).status).not.toBe(200);
  });

  it('does not spend the grant on a request it refuses', async () => {
    /**
     * The reason the consume is in the handler and not in the middleware.
     *
     * An organizer with live events is refused with 409 before anything is
     * written. If the grant had been burned on the way in, the user would have
     * to re-verify to try again after closing the event — a verification spent
     * on a request that never happened.
     */
    const { cookie, body } = await srv.signupConfirmed({
      email: `host-${rnd()}@example.org`, password: 'Password123',
      name: 'Host Person', role: 'organizer', grade: 'N/A',
      username: `host_${rnd()}`
    }).then(r => ({ cookie: r.cookie, body: { user: r.user } }));

    // Organizers need approval before posting, so create the event directly.
    const db = openDb();
    const eventId = `event-del-${rnd()}`;
    db.prepare(`
      INSERT INTO events (id, title, description, category, location, organizer_id,
                          status, application_deadline, created_at)
      VALUES (?, 'Blocking Event', 'Still open', 'Other', 'Somewhere', ?, 'open', ?, ?)
    `).run(
      eventId, body.user.id,
      new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      new Date().toISOString()
    );
    db.close();

    const challengeId = await srv.stepUp(cookie, 'account.delete', { password: 'Password123' });
    const blocked = await deleteAccount(cookie, challengeId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('has_active_events');

    // Unspent, so the same verification still works for the retry.
    expect(challengeRow(challengeId).consumed_at).toBeNull();

    const db2 = openDb();
    db2.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(eventId);
    db2.close();

    expect((await deleteAccount(cookie, challengeId)).status).toBe(200);
  });

  /**
   * The user-visible win of the whole feature.
   *
   * A provider-only account could not prove anything before: it has no password,
   * so it was asked to type its own username — a value that is public within the
   * app and appears on every comment the person has posted. It can now
   * re-authenticate at its provider, which is an actual credential check.
   */
  it('lets a provider-only account delete itself via OAuth re-consent', async () => {
    const email = `provonly-${rnd()}@example.org`;
    const username = `provonly_${rnd()}`;
    const sub = `sub-${username}`;

    // Sign up through the provider, which is what produces the '!OAUTH_ONLY!'
    // sentinel and the linked oauth_accounts row.
    const urlRes = await srv.call('POST', '/api/oauth/google/url', {
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'Provider Only', username, role: 'student', grade: '10', skills: [] }
    });
    expect(urlRes.status).toBe(200);
    const state = new URL(urlRes.body.url).searchParams.get('state');
    const nonceCookie = (urlRes.headers.get('set-cookie') || '').match(/(wev_oauth_state_[a-f0-9]{8}=[^;]+)/)?.[1];

    const cbRes = await fetch(`${srv.base}/api/oauth/google/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: nonceCookie },
      body: JSON.stringify({ code: JSON.stringify({ email, sub, name: 'Provider Only', emailVerified: true }), state })
    });
    expect(cbRes.status).toBe(200);
    const cookie = (cbRes.headers.get('set-cookie') || '').match(/wev_session=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();
    const userId = (await cbRes.json()).user.id;

    // No password prompt is offered, because there is no password to answer it.
    const opened = await srv.call('POST', '/api/auth/reauth/challenge',
      { action: 'account.delete', params: {} }, cookie);
    expect(opened.status).toBe(201);
    expect(opened.body.methods).toEqual(['oauth']);

    const challengeId = await srv.stepUpOAuth(cookie, 'account.delete', { sub });
    const res = await deleteAccount(cookie, challengeId);
    expect(res.status).toBe(200);

    const db = openDb();
    const user = db.prepare('SELECT account_status FROM users WHERE id = ?').get(userId);
    db.close();
    expect(user.account_status).toBe('deleted');
  });

  it('refuses re-consent as a DIFFERENT account at the same provider', async () => {
    /**
     * A completed OAuth round trip proves who is at the keyboard and nothing
     * more. Without comparing the returned `sub` to this account's linked row, an
     * attacker holding a stolen session presses "verify with Google", signs in as
     * themselves, and is re-verified as the victim — so the deletion must not
     * even be reachable.
     */
    const email = `wrongsub-${rnd()}@example.org`;
    const username = `wrongsub_${rnd()}`;

    const urlRes = await srv.call('POST', '/api/oauth/google/url', {
      signupData: { ...TEST_SIGNUP_DEFAULTS, name: 'Wrong Sub', username, role: 'student', grade: '10', skills: [] }
    });
    const state = new URL(urlRes.body.url).searchParams.get('state');
    const nonceCookie = (urlRes.headers.get('set-cookie') || '').match(/(wev_oauth_state_[a-f0-9]{8}=[^;]+)/)?.[1];
    const cbRes = await fetch(`${srv.base}/api/oauth/google/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: nonceCookie },
      body: JSON.stringify({
        code: JSON.stringify({ email, sub: `sub-${username}`, name: 'Wrong Sub', emailVerified: true }),
        state
      })
    });
    const cookie = (cbRes.headers.get('set-cookie') || '').match(/wev_session=([^;]+)/)?.[1];
    const userId = (await cbRes.json()).user.id;

    await expect(
      srv.stepUpOAuth(cookie, 'account.delete', { sub: 'sub-somebody-else-entirely' })
    ).rejects.toThrow(/grant failed/);

    const db = openDb();
    const user = db.prepare('SELECT account_status FROM users WHERE id = ?').get(userId);
    db.close();
    expect(user.account_status).toBe('active');
  });

  it('should block deleted users from logging in', async () => {
    const email = `delete-login-${rnd()}@example.org`;
    const { cookie } = await signup({ email, password: 'CorrectPassword123' });

    const challengeId = await srv.stepUp(cookie, 'account.delete', { password: 'CorrectPassword123' });
    expect((await deleteAccount(cookie, challengeId)).status).toBe(200);

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
      const db = openDb();
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
        email: `release-${rnd()}@example.org`,
        password: 'CorrectPassword123', name: 'Release Me', role: 'student', grade: '10',
        username: `release_${rnd()}`
      });

      const apply = await srv.call('POST', `/api/events/${slot.event_id}/apply`, { slotId: slot.slot_id }, cookie);
      expect(apply.status).toBeLessThan(400);

      const challengeId = await srv.stepUp(cookie, 'account.delete', { password: 'CorrectPassword123' });
      const del = await deleteAccount(cookie, challengeId);
      expect(del.status).toBe(200);

      const db = openDb();
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
      const make = async (n) => {
        const acct = await srv.signupConfirmed({
          email: `race-${n}-${rnd()}@example.org`,
          password: 'CorrectPassword123', name: `Race ${n}`, role: 'student', grade: '10',
          username: `race_${n}_${rnd()}`
        });
        // Verified up front, so the two DELETEs really do arrive together — the
        // grant round trips are not part of what is being raced.
        const challengeId = await srv.stepUp(acct.cookie, 'account.delete', { password: 'CorrectPassword123' });
        return { ...acct, challengeId };
      };
      const [a, b] = await Promise.all([make(1), make(2)]);

      const results = await Promise.all([
        deleteAccount(a.cookie, a.challengeId),
        deleteAccount(b.cookie, b.challengeId)
      ]);

      expect(results.map(r => r.status)).toEqual([200, 200]);
    });
  });
});
