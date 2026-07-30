import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/**
 * Changing the email address and the username (audit findings U2, U3).
 *
 * Neither was possible before. That mattered most on the verification wall,
 * which told anyone who mistyped their address to "sign out and create your
 * account again with the right address" — advice that cannot work, because the
 * abandoned account keeps both the mistyped email and the username, so the
 * second attempt can reuse neither.
 */

let srv;
beforeAll(async () => {
  process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
});
afterAll(async () => {
  await srv?.close?.();
  delete process.env.REQUIRE_EMAIL_VERIFICATION;
});

const rnd = () => Math.random().toString(36).slice(2, 9);

const openDb = () => new DatabaseSync(process.env.WEV_DB_PATH);

/** The live email-change token for a user, read straight from the database. */
function changeTokenFor(userId) {
  const db = openDb();
  const row = db.prepare('SELECT token, new_email FROM email_change_tokens WHERE user_id = ?').get(userId);
  db.close();
  return row;
}

async function makeUser(over = {}) {
  return srv.signupConfirmed({
    name: 'Test Person',
    email: `id-${rnd()}@example.org`,
    username: `id_${rnd()}`,
    password: 'Password123',
    role: 'student',
    grade: '10',
    ...over
  });
}

describe('U2 — changing the email address', () => {
  it('does not move the address until the new one is confirmed', async () => {
    const { cookie, user } = await makeUser();
    const target = `moved-${rnd()}@example.org`;

    const res = await srv.call('POST', '/api/auth/change-email', { newEmail: target, password: 'Password123' }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(target);

    // The critical assertion: the account still answers at its old address.
    const db = openDb();
    const row = db.prepare('SELECT email FROM users WHERE id = ?').get(user.id);
    db.close();
    expect(row.email).toBe(user.email);
  });

  it('moves the address once the link is opened, and confirms it', async () => {
    const { cookie, user } = await makeUser();
    const target = `moved-${rnd()}@example.org`;

    await srv.call('POST', '/api/auth/change-email', { newEmail: target, password: 'Password123' }, cookie);
    const { token } = changeTokenFor(user.id);

    const res = await srv.call('POST', '/api/auth/confirm-email-change', { token });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(target);
    expect(res.body.emailVerified).toBe(true);

    // And the new address can sign in.
    const relogin = await srv.call('POST', '/api/auth/login', { email: target, password: 'Password123' });
    expect(relogin.status).toBe(200);
  });

  it('burns the token — a confirmation link works exactly once', async () => {
    const { cookie, user } = await makeUser();
    await srv.call('POST', '/api/auth/change-email', { newEmail: `once-${rnd()}@example.org`, password: 'Password123' }, cookie);
    const { token } = changeTokenFor(user.id);

    expect((await srv.call('POST', '/api/auth/confirm-email-change', { token })).status).toBe(200);
    expect((await srv.call('POST', '/api/auth/confirm-email-change', { token })).status).toBe(400);
  });

  it('signs other sessions out when the address moves', async () => {
    const { cookie, user } = await makeUser();
    const other = await srv.login(user.email, 'Password123');

    await srv.call('POST', '/api/auth/change-email', { newEmail: `sess-${rnd()}@example.org`, password: 'Password123' }, cookie);
    const { token } = changeTokenFor(user.id);
    await srv.call('POST', '/api/auth/confirm-email-change', { token });

    // The email address is the account's recovery channel, so moving it is as
    // security-relevant as changing the password — and if the request came from
    // a session that should not have had it, leaving that session live would
    // make the notice to the old address useless.
    const stale = await srv.call('GET', '/api/auth/me', undefined, other);
    expect(stale.status).toBe(401);
  });

  it('requires the current password when the account has one', async () => {
    const { cookie } = await makeUser();

    const noPassword = await srv.call('POST', '/api/auth/change-email', { newEmail: `np-${rnd()}@example.org` }, cookie);
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.field).toBe('password');

    const wrongPassword = await srv.call('POST', '/api/auth/change-email',
      { newEmail: `wp-${rnd()}@example.org`, password: 'NotMyPassword1' }, cookie);
    expect(wrongPassword.status).toBe(401);
  });

  it('refuses an address another account already uses', async () => {
    const { cookie } = await makeUser();
    const other = await makeUser();

    const res = await srv.call('POST', '/api/auth/change-email',
      { newEmail: other.user.email, password: 'Password123' }, cookie);
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('newEmail');
  });

  it('refuses an address claimed while the request was open', async () => {
    const { cookie, user } = await makeUser();
    const target = `race-${rnd()}@example.org`;

    await srv.call('POST', '/api/auth/change-email', { newEmail: target, password: 'Password123' }, cookie);
    const { token } = changeTokenFor(user.id);

    // Somebody else registers that address during the 24-hour window.
    await makeUser({ email: target });

    const res = await srv.call('POST', '/api/auth/confirm-email-change', { token });
    expect(res.status).toBe(409);
  });

  it('rejects a malformed address and its own current one', async () => {
    const { cookie, user } = await makeUser();

    expect((await srv.call('POST', '/api/auth/change-email',
      { newEmail: 'not-an-address', password: 'Password123' }, cookie)).status).toBe(400);

    const same = await srv.call('POST', '/api/auth/change-email',
      { newEmail: user.email.toUpperCase(), password: 'Password123' }, cookie);
    expect(same.status).toBe(400);
  });

  it('supersedes a previous request rather than leaving two live links', async () => {
    const { cookie, user } = await makeUser();

    await srv.call('POST', '/api/auth/change-email', { newEmail: `first-${rnd()}@example.org`, password: 'Password123' }, cookie);
    const first = changeTokenFor(user.id);

    await srv.call('POST', '/api/auth/change-email', { newEmail: `second-${rnd()}@example.org`, password: 'Password123' }, cookie);
    const second = changeTokenFor(user.id);

    expect(second.token).not.toBe(first.token);
    // Two live links would mean two different addresses could claim the account.
    expect((await srv.call('POST', '/api/auth/confirm-email-change', { token: first.token })).status).toBe(400);
    expect((await srv.call('POST', '/api/auth/confirm-email-change', { token: second.token })).status).toBe(200);
  });

  it('can be cancelled, and reports what is pending', async () => {
    const { cookie } = await makeUser();
    const target = `cancel-${rnd()}@example.org`;

    await srv.call('POST', '/api/auth/change-email', { newEmail: target, password: 'Password123' }, cookie);

    const before = await srv.call('GET', '/api/auth/pending-email-change', undefined, cookie);
    expect(before.body.pending).toBe(target);

    expect((await srv.call('POST', '/api/auth/cancel-email-change', {}, cookie)).status).toBe(200);

    const after = await srv.call('GET', '/api/auth/pending-email-change', undefined, cookie);
    expect(after.body.pending).toBeNull();
  });

  /**
   * The reason the whole flow exists. An account whose address has a typo can
   * never confirm, so it can never reach anything outside the email gate — and
   * correcting the address has to be one of the things inside it.
   */
  it('is reachable by an UNCONFIRMED account, which is the whole point', async () => {
    const signup = await srv.call('POST', '/api/auth/signup', {
      name: 'Typo Person',
      email: `typo-${rnd()}@example.org`,
      username: `typo_${rnd()}`,
      password: 'Password123',
      role: 'student',
      grade: '10'
    });
    expect(signup.status).toBe(201);
    expect(signup.body.emailVerified).toBe(false);
    const cookie = signup.cookie;

    // Confined by the gate: an ordinary route is refused.
    const gated = await srv.call('GET', '/api/events', undefined, cookie);
    expect(gated.status).toBe(403);
    expect(gated.body.code).toBe('email_unverified');

    // But correcting the address is not.
    const target = `fixed-${rnd()}@example.org`;
    const fix = await srv.call('POST', '/api/auth/change-email',
      { newEmail: target, password: 'Password123' }, cookie);
    expect(fix.status).toBe(200);

    const { token } = changeTokenFor(signup.body.user.id);
    const confirmed = await srv.call('POST', '/api/auth/confirm-email-change', { token });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.user.email).toBe(target);

    // And the account is now free of the gate.
    const ungated = await srv.call('GET', '/api/events', undefined, confirmed.cookie);
    expect(ungated.status).toBe(200);
  });
});

describe('U3 — changing the username', () => {
  it('changes it, and the new one can sign in', async () => {
    const { cookie } = await makeUser();
    const target = `newname${rnd()}`.slice(0, 20);

    const res = await srv.call('POST', '/api/auth/change-username', { username: target }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(target);

    const relogin = await srv.call('POST', '/api/auth/login', { email: target, password: 'Password123' });
    expect(relogin.status).toBe(200);
  });

  it('does not sign the user out', async () => {
    const { cookie } = await makeUser();
    await srv.call('POST', '/api/auth/change-username', { username: `keep${rnd()}`.slice(0, 20) }, cookie);

    // A username authenticates nothing, so changing it is no reason to eject anyone.
    expect((await srv.call('GET', '/api/auth/me', undefined, cookie)).status).toBe(200);
  });

  it('refuses one already taken, case-insensitively', async () => {
    const { cookie } = await makeUser();
    const other = await makeUser();

    const res = await srv.call('POST', '/api/auth/change-username',
      { username: other.user.username.toUpperCase() }, cookie);
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('username');
  });

  it('applies the same format rules as signup', async () => {
    const { cookie } = await makeUser();

    expect((await srv.call('POST', '/api/auth/change-username', { username: 'ab' }, cookie)).status).toBe(400);
    expect((await srv.call('POST', '/api/auth/change-username', { username: '1abc' }, cookie)).status).toBe(400);
    expect((await srv.call('POST', '/api/auth/change-username', { username: 'has spaces' }, cookie)).status).toBe(400);
    expect((await srv.call('POST', '/api/auth/change-username', { username: 'a'.repeat(21) }, cookie)).status).toBe(400);
    // The deletion tombstone prefix stays reserved.
    expect((await srv.call('POST', '/api/auth/change-username', { username: 'deleted_abc' }, cookie)).status).toBe(400);
  });

  it('enforces the 30-day cooldown on the second change', async () => {
    const { cookie } = await makeUser();

    expect((await srv.call('POST', '/api/auth/change-username', { username: `first${rnd()}`.slice(0, 20) }, cookie)).status).toBe(200);

    const second = await srv.call('POST', '/api/auth/change-username', { username: `second${rnd()}`.slice(0, 20) }, cookie);
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('username_cooldown');
    expect(second.body.retryAfterDays).toBeGreaterThan(0);
  });

  /**
   * A change of capitalisation cannot collide with anyone, because the
   * uniqueness index is case-insensitive. Refusing it, or spending the cooldown
   * on it, would be pedantry.
   */
  it('allows a capitalisation-only change for free', async () => {
    const { cookie, user } = await makeUser({ username: `case${rnd()}`.slice(0, 20) });

    const res = await srv.call('POST', '/api/auth/change-username',
      { username: user.username.toUpperCase() }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(user.username.toUpperCase());

    // And it did not start the cooldown.
    const next = await srv.call('POST', '/api/auth/change-username',
      { username: `after${rnd()}`.slice(0, 20) }, cookie);
    expect(next.status).toBe(200);
  });
});
