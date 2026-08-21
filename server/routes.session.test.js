import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { startTestServer, TEST_SIGNUP_DEFAULTS } from './testServer.js';
import { installMailbox } from './testMailbox.js';

// One server for the whole file — a second startTestServer() call would reuse
// the same module-cached db.js and not actually start a second instance.
let srv;
let mailbox;
beforeAll(async () => { srv = await startTestServer(); mailbox = installMailbox(); });
afterAll(async () => { mailbox.restore(); await srv.close(); });

const signup = (over = {}) => srv.call('POST', '/api/auth/signup', { ...TEST_SIGNUP_DEFAULTS,
  email: `session-${Math.random().toString(36).slice(2, 9)}@example.org`,
  password: 'Password123', name: 'Session Test', role: 'student', grade: '10',
  username: `session_${Math.random().toString(36).slice(2, 9)}`,
  ...over
});

describe('authenticateToken: reads identity from the database', () => {
  it('authenticates a valid token for an existing (seeded) user', async () => {
    const token = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('leo.chen@example.com');
  });

  it('rejects a token belonging to a user who has since been deleted', async () => {
    const signupRes = await signup();
    expect(signupRes.status).toBe(201);
    const userId = signupRes.body.user.id;
    const token = signupRes.cookie;

    // The token is valid right now.
    const before = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(before.status).toBe(200);

    // Delete the row directly, out from under the still-unexpired token.
    //
    // The consent rows have to go first. `legal_acceptances.user_id` is
    // ON DELETE RESTRICT — deliberately, so that a future hard-delete path
    // cannot silently destroy the evidence that a user agreed to the Terms —
    // and this fixture is a hard delete. The product's own deletion path is
    // anonymisation (an UPDATE), so it never hits this; the one real hard
    // delete, denying a pending organizer, clears these rows explicitly for
    // the same reason and with the same two lines.
    const { db } = await import('./db.js');
    await db.prepare('DELETE FROM legal_acceptances WHERE user_id = ?').run(userId);
    await db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    const after = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('Account no longer exists');
  });

  it('reads role live from the database rather than trusting the token payload', async () => {
    const signupRes = await signup();
    expect(signupRes.status).toBe(201);
    const userId = signupRes.body.user.id;
    const token = signupRes.cookie; // minted with role: 'student'

    // Confirm the token really was minted as a student.
    const decoded = jwt.decode(token);
    expect(decoded.role).toBe('student');

    // Promote the account directly in the DB — the token is untouched.
    const { db } = await import('./db.js');
    await db.prepare("UPDATE users SET role = 'organizer', email_verified = 1 WHERE id = ?").run(userId);

    /**
     * And record the Organizer Agreement acceptance the promotion implies.
     *
     * This test is about ONE thing: that role is re-read from the database rather
     * than trusted from the JWT payload. Since v1.2c an organizer holds none of
     * the capabilities that reach a student until an acceptance row exists (see
     * server/organizerAgreement.js), so a bare `UPDATE users SET role` produces an
     * organizer who is correctly refused — and the 403 would look like the live
     * role read having failed, when it is the gate working.
     *
     * Writing the row keeps the assertion below measuring what it was written to
     * measure. It is emphatically NOT a workaround: an organizer without this row
     * SHOULD be refused, which is asserted directly in
     * server/routes.organizerAgreement.test.js.
     */
    const { ORGANIZER_DOCUMENTS } = await import('./legalDocuments.js');
    for (const doc of ORGANIZER_DOCUMENTS) {
      await db.prepare(`
        INSERT INTO legal_acceptances
          (id, user_id, document_slug, version, content_hash, accepted_at, method, context, ip_prefix, ua_family)
        VALUES (?, ?, ?, ?, ?, ?, 'test_fixture', 'live-role-read', NULL, NULL)
      `).run(`acc-fixture-${userId}`, userId, doc.slug, doc.version, doc.contentHash, new Date().toISOString());
    }

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

describe('authenticateToken: token_version invalidates sessions on password reset', () => {
  /**
   * The reset token, read from the mail that was actually sent. The stored
   * column is a SHA-256 digest since migration 048, so nothing — a test
   * included — can recover a usable token from the table.
   */
  const tokenFor = (email) => mailbox.waitForToken(email, 'reset');

  it('rejects a token minted before a password reset, but a fresh login after the reset works', async () => {
    const signupRes = await signup({ password: 'OrigPassword1' });
    expect(signupRes.status).toBe(201);
    const email = signupRes.body.user.email;
    const oldToken = signupRes.cookie;

    // The pre-reset token works right now.
    const before = await srv.call('GET', '/api/auth/me', undefined, oldToken);
    expect(before.status).toBe(200);

    // Request and apply a password reset.
    mailbox.clear();
    const forgot = await srv.call('POST', '/api/auth/forgot-password', { email });
    expect(forgot.status).toBe(200);
    const resetToken = await tokenFor(email);
    expect(resetToken).toBeTruthy();

    const reset = await srv.call('POST', '/api/auth/reset-password', { token: resetToken, password: 'NewPassword1' });
    expect(reset.status).toBe(200);

    // The old token is now invalid.
    const after = await srv.call('GET', '/api/auth/me', undefined, oldToken);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('Session expired, please sign in again');

    // A fresh login with the new password works and yields a usable token.
    const relogin = await srv.call('POST', '/api/auth/login', { email, password: 'NewPassword1' });
    expect(relogin.status).toBe(200);
    const newToken = relogin.cookie;
    const me = await srv.call('GET', '/api/auth/me', undefined, newToken);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it('a current-version token keeps working across an unrelated request', async () => {
    const signupRes = await signup();
    expect(signupRes.status).toBe(201);
    const token = signupRes.cookie;

    const first = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(first.status).toBe(200);

    const second = await srv.call('GET', '/api/auth/me', undefined, token);
    expect(second.status).toBe(200);
    expect(second.body.email).toBe(signupRes.body.user.email);
  });

  it('a legacy token with no tokenVersion claim still authenticates against a version-0 row', async () => {
    const signupRes = await signup();
    expect(signupRes.status).toBe(201);
    const userId = signupRes.body.user.id;

    // Sign a token the old way, before tokenVersion existed.
    const legacyToken = jwt.sign(
      { id: userId, role: 'student', email: signupRes.body.user.email, name: signupRes.body.user.name },
      'test-secret-not-for-production',
      { expiresIn: '7d' }
    );

    const res = await srv.call('GET', '/api/auth/me', undefined, legacyToken);
    expect(res.status).toBe(200);
  });
});
