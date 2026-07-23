import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';
import { startTestServer } from './testServer.js';

// One server for the whole file — a second startTestServer() call would reuse
// the same module-cached db.js and not actually start a second instance.
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

const signup = (over = {}) => srv.call('POST', '/api/auth/signup', {
  email: `session-${Math.random().toString(36).slice(2, 9)}@example.org`,
  password: 'password123', name: 'Session Test', role: 'student', grade: '10',
  username: `session_${Math.random().toString(36).slice(2, 9)}`,
  ...over
});

describe('authenticateToken: reads identity from the database', () => {
  it('authenticates a valid token for an existing (seeded) user', async () => {
    const token = await srv.login('leo.chen28@gmail.com');
    const res = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('leo.chen28@gmail.com');
  });

  it('rejects a token belonging to a user who has since been deleted', async () => {
    const signupRes = await signup();
    expect(signupRes.status).toBe(201);
    const userId = signupRes.body.user.id;
    const token = signupRes.body.token;

    // The token is valid right now.
    const before = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(before.status).toBe(200);

    // Delete the row directly, out from under the still-unexpired token.
    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.close();

    const after = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('Account no longer exists');
  });

  it('reads role live from the database rather than trusting the token payload', async () => {
    const signupRes = await signup();
    expect(signupRes.status).toBe(201);
    const userId = signupRes.body.user.id;
    const token = signupRes.body.token; // minted with role: 'student'

    // Confirm the token really was minted as a student.
    const decoded = jwt.decode(token);
    expect(decoded.role).toBe('student');

    // Promote the account directly in the DB — the token is untouched.
    const db = new DatabaseSync(process.env.SBV_DB_PATH);
    db.prepare("UPDATE users SET role = 'organizer' WHERE id = ?").run(userId);
    db.close();

    // Hit an organizer-only endpoint with the SAME (still student-shaped) token.
    const res = await srv.call('POST', '/api/events', {
      title: 'Live Role Test Event',
      description: 'Exercises live role reads.',
      category: 'Other',
      location: '1 Test St',
      applicationDeadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      slots: [{
        name: 'Shift', description: 'A shift',
        startDatetime: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        endDatetime: new Date(Date.now() + 51 * 3600 * 1000).toISOString(),
        maxSpots: 3
      }]
    }, token);

    // The account was seeded via student signup (verified=1), and is now
    // flipped to organizer directly in the DB, so this should sail all the
    // way through to event creation — proving role AND verified are both
    // read live from the database, not from the (still student-shaped) token.
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('still returns 403 for a forged token (wrong signing secret)', async () => {
    const forged = jwt.sign(
      { id: 'user-student-1', role: 'admin', email: 'x@example.org', name: 'Nobody' },
      'not-the-real-secret',
      { expiresIn: '7d' }
    );
    const res = await srv.call('GET', '/api/auth/me', undefined, forged);
    expect(res.status).toBe(403);
  });

  it('still returns 403 for garbage in the Authorization header', async () => {
    const res = await srv.call('GET', '/api/auth/me', undefined, 'garbage');
    expect(res.status).toBe(403);
  });
});
