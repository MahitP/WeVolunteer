import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './testServer.js';

// One server for the whole file. See the note above.
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('auth: email verification state', () => {
  it('returns emailVerified on the user object', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.status).toBe(200);
    expect(me.body).toHaveProperty('emailVerified');
  });

  it('marks a seeded user verified when verification is not required', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const me = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(me.body.emailVerified).toBe(true);
  });

  it('marks a new signup verified when verification is not required', async () => {
    const res = await srv.call('POST', '/api/auth/signup', {
      email: 'verify.check@example.org', password: 'password123',
      name: 'Verify Check', role: 'student', grade: '10', username: 'verify_check'
    });
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(true);
  });
});

describe('auth: password reset', () => {
  const tokenFor = (userId) => {
    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    const row = db.prepare(
      'SELECT token FROM password_reset_tokens WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1'
    ).get(userId);
    db.close();
    return row?.token;
  };

  it('issues a reset token for a known address', async () => {
    const res = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    expect(res.status).toBe(200);
    expect(tokenFor('user-student-1')).toBeTruthy();
  });

  it('does not reveal whether an address exists', async () => {
    const known = await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    const unknown = await srv.call('POST', '/api/auth/forgot-password', { email: 'nobody@example.org' });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('resets the password and lets the user sign in with it', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'leo.chen28@gmail.com' });
    const token = tokenFor('user-student-1');

    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'brand-new-pass' });
    expect(res.status).toBe(200);

    const relogin = await srv.call('POST', '/api/auth/login', {
      email: 'leo.chen28@gmail.com', password: 'brand-new-pass'
    });
    expect(relogin.status).toBe(200);
  });

  it('burns the token so it cannot be replayed', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'priya.patel.nhs@outlook.com' });
    const token = tokenFor('user-student-2');

    const first = await srv.call('POST', '/api/auth/reset-password', { token, password: 'first-change' });
    expect(first.status).toBe(200);

    const replay = await srv.call('POST', '/api/auth/reset-password', { token, password: 'second-change' });
    expect(replay.status).toBe(400);
  });

  it('rejects an expired token', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'emiller2027@gmail.com' });
    const token = tokenFor('user-student-3');

    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    db.prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token = ?')
      .run('2020-01-01T00:00:00.000Z', token);
    db.close();

    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'too-late-pass' });
    expect(res.status).toBe(400);
  });

  it('rejects a password below the minimum length', async () => {
    await srv.call('POST', '/api/auth/forgot-password', { email: 'advait.g@yahoo.com' });
    const token = tokenFor('user-advait');
    const res = await srv.call('POST', '/api/auth/reset-password', { token, password: 'abc' });
    expect(res.status).toBe(400);
  });
});

describe('auth: username', () => {
  const signup = (over = {}) => srv.call('POST', '/api/auth/signup', {
    email: `u${Math.random().toString(36).slice(2, 9)}@example.org`,
    password: 'password123', name: 'Some Person', role: 'student', grade: '10',
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
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it('rejects a duplicate regardless of case', async () => {
    await signup({ username: 'casecheck' });
    const res = await signup({ username: 'CaseCheck' });
    expect(res.status).toBe(400);
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
    organizerToken = await srv.login('jkatzenback@vikings.org');
    // Earlier in this file, "auth: password reset" actually resets these two
    // seeded students' passwords while exercising the reset flow — their live
    // passwords are no longer the seeded 'password123'.
    leoToken = await srv.login('leo.chen28@gmail.com', 'brand-new-pass');
    priyaToken = await srv.login('priya.patel.nhs@outlook.com', 'first-change');
    adminToken = await srv.login('admin@sbvolunteers.gov');

    // Build a real confirmed future shift for Priya via the actual API, so the
    // assertions below are not vacuous.
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const futureEnd = new Date(future.getTime() + 3 * 3600 * 1000);
    const createRes = await srv.call('POST', '/api/events', {
      title: 'Whereabouts Test Event',
      description: 'Created to prove upcoming shift data is gated correctly.',
      category: 'Other',
      location: '12 Maple Ave, South Brunswick',
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
    expect(shift.location).toBe('12 Maple Ave, South Brunswick');
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
    expect(res.body.volunteer.email).toBe('priya.patel.nhs@outlook.com');
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
