import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';
import { installMailbox } from './testMailbox.js';
import { hashToken } from './tokenDigest.js';

// One server for the whole file. See the note above.
let srv;
let mailbox;
beforeAll(async () => { srv = await startTestServer(); mailbox = installMailbox(); });
afterAll(async () => { mailbox.restore(); await srv.close(); });

describe('auth: email verification state', () => {
  it('returns emailVerified on the user object', async () => {
    const token = await srv.login('leo.chen@example.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body).toHaveProperty('emailVerified');
  });

  // Seeded demo fixtures are confirmed on purpose — their addresses are
  // invented, so no confirmation mail could ever reach them.
  it('marks a seeded demo user verified', async () => {
    const token = await srv.login('leo.chen@example.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.body.emailVerified).toBe(true);
  });

  it('creates a new signup unconfirmed and signs it in anyway', async () => {
    const res = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email: 'verify.check@example.org', password: 'Password123',
      name: 'Verify Check', role: 'student', grade: '10', username: 'verify_check'
    });
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
    expect(res.body.action).toBe('verification_required');
    // A session is issued regardless: without one, "resend verification"
    // (which requires authentication) is unreachable for the very people who
    // need it.
    expect(res.cookie).toBeTruthy();
  });

  it('rejects a signup password that fails the complexity rules', async () => {
    const res = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email: 'short.pass@example.org', password: 'short',
      name: 'Short Pass', role: 'student', grade: '10', username: 'short_pass'
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('password');
    expect(res.body.error).toMatch(/at least 8 characters/i);
  });

  it('names every unmet password rule at once rather than one at a time', async () => {
    const res = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email: 'weak.pass@example.org', password: 'aaaaaaaa',
      name: 'Weak Pass', role: 'student', grade: '10', username: 'weak_pass'
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uppercase/i);
    expect(res.body.error).toMatch(/number/i);
  });

  it('confines an unconfirmed account to the allowlist, and frees it on confirmation', async () => {
    mailbox.clear();
    const res = await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email: 'gated.signup@example.org', password: 'Password123',
      name: 'Gated Signup', role: 'student', grade: '10', username: 'gated_signup'
    });
    expect(res.status).toBe(201);

    // An action route is refused...
    const blocked = await srv.call('GET', '/api/applications', undefined, res.cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('email_unverified');

    // ...but the routes needed to finish verifying are not.
    expect((await srv.call('GET', '/api/auth/me', undefined, res.cookie)).status).toBe(200);

    // The confirmation link is taken from the message that was actually sent —
    // the stored column is a SHA-256 digest since migration 048, so the token
    // is no longer recoverable from the table by anyone, tests included.
    const token = await mailbox.waitForToken('gated.signup@example.org', 'verify');
    expect(token).toBeTruthy();

    expect((await srv.call('POST', '/api/auth/verify-email', { token })).status).toBe(200);
    expect((await srv.call('GET', '/api/applications', undefined, res.cookie)).status).toBe(200);
  });

  /**
   * Regression: /api/auth/login never consulted email_verified, so the signup
   * route's refusal to issue a session achieved nothing — the same account
   * signed in a second later with full access.
   */
  it('does not let an unconfirmed account act by signing in again', async () => {
    const email = 'bypass.attempt@example.org';
    await srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
      email, password: 'Password123',
      name: 'Bypass Attempt', role: 'student', grade: '10', username: 'bypass_attempt'
    });

    const login = await srv.call('POST', '/api/auth/login', { email, password: 'Password123' });
    expect(login.status).toBe(200);
    expect(login.body.emailVerified).toBe(false);

    const apps = await srv.call('GET', '/api/applications', undefined, login.cookie);
    expect(apps.status).toBe(403);
    expect(apps.body.code).toBe('email_unverified');
  });
});

describe('auth: password reset', () => {
  /**
   * The reset token, read from the mail that was actually sent rather than from
   * the table — migration 048 stores only a SHA-256 digest there, so a usable
   * token cannot be recovered from the database by anything, including a test.
   */
  const tokenFor = (email) => mailbox.waitForToken(email, 'reset');

  /** Clears first, so a reset link from an earlier case cannot be read instead. */
  const forgot = (email) => {
    mailbox.clear();
    return srv.call('POST', '/api/auth/forgot-password', { email });
  };

  it('issues a reset token for a known address', async () => {
    const res = await forgot('leo.chen@example.com');
    expect(res.status).toBe(200);
    expect(await tokenFor('leo.chen@example.com')).toBeTruthy();
  });

  it('does not reveal whether an address exists', async () => {
    const known = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen@example.com' });
    const unknown = await srv.call('POST', '/api/auth/forgot-password', { email: 'nobody@example.org' });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('resets the password and lets the user sign in with it', async () => {
    await forgot('leo.chen@example.com');
    const token = await tokenFor('leo.chen@example.com');

    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'BrandNewPass1' });
    expect(res.status).toBe(200);

    const relogin = await srv.call('POST', '/api/auth/login', {
      email: 'leo.chen@example.com', password: 'BrandNewPass1'
    });
    expect(relogin.status).toBe(200);
  });

  it('burns the token so it cannot be replayed', async () => {
    await forgot('priya.patel@example.com');
    const token = await tokenFor('priya.patel@example.com');

    const first = await srv.call('POST', '/api/auth/reset-password', { token, password: 'FirstChange1' });
    expect(first.status).toBe(200);

    const replay = await srv.call('POST', '/api/auth/reset-password', { token, password: 'SecondChange1' });
    expect(replay.status).toBe(400);
  });

  it('rejects an expired token', async () => {
    await forgot('ethan.miller@example.com');
    const token = await tokenFor('ethan.miller@example.com');

    // The row is addressed by the digest of the token, because that is all the
    // table holds now — the same lookup the route itself performs.
    const db = new DatabaseSync(process.env.WEV_DB_PATH);
    db.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = ?')
      .run('2020-01-01T00:00:00.000Z', hashToken(token));
    db.close();

    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'TooLatePass1' });
    expect(res.status).toBe(400);
  });

  it('rejects a password below the minimum length', async () => {
    await forgot('arjun.gopal@example.com');
    const token = await tokenFor('arjun.gopal@example.com');
    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'abc' });
    expect(res.status).toBe(400);
  });
});

describe('auth: username', () => {
  const signup = (over = {}) => srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
    email: `u${Math.random().toString(36).slice(2, 9)}@example.org`,
    password: 'Password123', name: 'Some Person', role: 'student', grade: '10',
    username: `u${Math.random().toString(36).slice(2, 9)}`,
    ...over
  });

  it('stores the username the signup form sends', async () => {
    const res = await signup({ username: 'alex_r' });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('alex_r');
  });

  it('rejects a duplicate username', async () => {
    await signup({ username: 'taken_name' });
    const res = await signup({ username: 'taken_name' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/username/i);
    expect(res.body.field).toBe('username');
  });

  it('rejects a duplicate regardless of case', async () => {
    await signup({ username: 'casecheck' });
    const res = await signup({ username: 'CaseCheck' });
    expect(res.status).toBe(409);
  });

  it('rejects characters the signup form does not allow', async () => {
    const res = await signup({ username: 'bad name!' });
    expect(res.status).toBe(400);
  });

  it('rejects a username that is too short or too long', async () => {
    expect((await signup({ username: 'ab' })).status).toBe(400);
    expect((await signup({ username: 'a'.repeat(21) })).status).toBe(400);
  });

  it('requires a username', async () => {
    const res = await signup({ username: undefined });
    expect(res.status).toBe(400);
  });
});

describe('auth: volunteer profile does not leak whereabouts to other students', () => {
  let organizerToken, leoToken, priyaToken, adminToken, eventId, slotId;

  beforeAll(async () => {
    organizerToken = await srv.login('jordan.whitfield@example.org');
    // Earlier in this file, "auth: password reset" actually resets these two
    // seeded students' passwords while exercising the reset flow — their live
    // passwords are no longer the seeded 'password123'.
    leoToken = await srv.login('leo.chen@example.com', 'BrandNewPass1');
    priyaToken = await srv.login('priya.patel@example.com', 'FirstChange1');
    adminToken = await srv.login('admin@example.gov');

    // Build a real confirmed future shift for Priya via the actual API, so the
    // assertions below are not vacuous.
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const futureEnd = new Date(future.getTime() + 3 * 3600 * 1000);
    const createRes = await srv.call('POST', '/api/events', {
      title: 'Whereabouts Test Event',
      description: 'Created to prove upcoming shift data is gated correctly.',
      category: 'Other',
      location: '12 Maple Ave, Example Valley',
      applicationDeadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      slots: [{
        name: 'Morning', description: 'Morning shift',
        startDatetime: future.toISOString(), endDatetime: futureEnd.toISOString(),
        maxSpots: 5
      }]
    }, organizerToken);
    expect(createRes.status).toBe(201);
    eventId = createRes.body.id;

    const eventDetail = await srv.call('GET', `/api/events/${eventId}`, undefined, organizerToken);
    slotId = eventDetail.body.event.slots[0].id;

    const applyRes = await srv.call('POST', `/api/events/${eventId}/apply`, { slotId }, priyaToken);
    expect(applyRes.status).toBe(201);

    const apps = (await srv.call('GET', '/api/applications', undefined, organizerToken)).body;
    const priyaApp = apps.find(a => a.slotId === slotId && a.userId === 'user-student-2');
    expect(priyaApp).toBeTruthy();

    const acceptRes = await srv.call('PATCH', `/api/applications/${priyaApp.id}`, { status: 'accepted' }, organizerToken);
    expect(acceptRes.status).toBe(200);
  });

  it('hides another student\'s upcoming shifts from a fellow student, even though a confirmed future shift exists', async () => {
    const res = await srv.call('GET', '/api/users/user-student-2/profile', undefined, leoToken);
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toEqual([]);
    expect(res.body.stats.upcomingCount).toBe(0);
  });

  it('gives the student their own populated upcoming array, including location', async () => {
    const res = await srv.call('GET', '/api/users/user-student-2/profile', undefined, priyaToken);
    expect(res.status).toBe(200);
    expect(res.body.upcoming.length).toBeGreaterThan(0);
    const shift = res.body.upcoming.find(u => u.eventId === eventId);
    expect(shift).toBeTruthy();
    expect(shift.location).toBe('12 Maple Ave, Example Valley');
    expect(res.body.stats.upcomingCount).toBeGreaterThan(0);
  });

  it('gives an organizer an empty upcoming array but a correct non-zero upcomingCount', async () => {
    const res = await srv.call('GET', '/api/users/user-student-2/profile', undefined, organizerToken);
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toEqual([]);
    expect(res.body.stats.upcomingCount).toBeGreaterThan(0);
  });

  it('does not regress the organizer applicant-review workflow: email and completed history still show', async () => {
    const res = await srv.call('GET', '/api/users/user-student-2/profile', undefined, organizerToken);
    expect(res.status).toBe(200);
    expect(res.body.volunteer.email).toBe('priya.patel@example.com');
    expect(Array.isArray(res.body.completed)).toBe(true);
    expect(res.body.completed.length).toBeGreaterThan(0);
  });

  it('also hides the upcoming array from an admin, staying self-only', async () => {
    const res = await srv.call('GET', '/api/users/user-student-2/profile', undefined, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toEqual([]);
    expect(res.body.stats.upcomingCount).toBeGreaterThan(0);
  });
});
