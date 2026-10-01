import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RUNNING_ON_POSTGRES } from './testEngine.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { startTestServer } from './testServer.js';

let srv;
let db;
let JWT_SECRET, COOKIE_NAME;
let decryptSecret;

beforeAll(async () => { 
  srv = await startTestServer(); 
  
  /* No `await import('./server.js')` here. It was imported into an unused
     variable, which boots a SECOND full server — instance lock, workers,
     scheduler, a listener on 5050 — inside a process that already has one from
     `startTestServer()`. */

  const dbModule = await import('./db.js');
  db = dbModule.db;

  const configModule = await import('./config.js');
  JWT_SECRET = configModule.JWT_SECRET;
  COOKIE_NAME = configModule.COOKIE_NAME;

  const cryptoUtilsModule = await import('./cryptoUtils.js');
  decryptSecret = cryptoUtilsModule.decryptSecret;
});
afterAll(async () => { 
  if (srv) await srv.close(); 
});

describe('2FA Security Hardening Regressions', () => {

  describe('Pre-auth bypass', () => {
    it('rejects a preauth token on protected endpoints', async () => {
      const preauthToken = jwt.sign({ id: 'user-student-1', email: 'leo.chen@example.com', preauth: true }, JWT_SECRET, { expiresIn: '15m' });
      
      const res = await srv.call('GET', '/api/auth/me', undefined, preauthToken);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Pre-authentication tokens cannot be used as full sessions');
    });

    it('rejects a modified preauth token (tampered signature)', async () => {
      const forgedToken = jwt.sign({ id: 'user-student-1', email: 'leo.chen@example.com' }, 'wrong-secret');
      
      const res = await srv.call('GET', '/api/auth/me', undefined, forgedToken);

      /* 401: an unverifiable session is an authentication failure (see
         routes.session.test.js for why this is no longer 403). */
      expect(res.status).toBe(401);
    });
  });

  describe('TOTP encryption and migration', () => {
    it('encrypts newly generated secrets', async () => {
      const sessionToken = await srv.login('leo.chen@example.com');
      console.log('Session token:', sessionToken);
      const challengeId = await srv.stepUp(sessionToken, '2fa.generate');
      
      const generateRes = await srv.call('POST', '/api/2fa/generate', undefined, sessionToken, { 'X-Reauth-Challenge': challengeId });
        
      expect(generateRes.status).toBe(200);
      expect(generateRes.body.secret).toBeDefined();

      const userRow = await db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get('leo.chen@example.com');
      expect(userRow.tfa_secret.startsWith('v1:')).toBe(true);
      expect(decryptSecret(userRow.tfa_secret)).toBe(generateRes.body.secret);
    });

    /**
     * Deliberately NOT the seeded administrator.
     *
     * This wrote a legacy plaintext secret over `admin@example.gov`, which the
     * harness enrols with a known secret so that `srv.login` can complete the
     * second factor. Clobbering it left every later test in the file unable to
     * sign in as an administrator at all — a test that damages a shared fixture
     * fails its neighbours rather than itself, which is the hardest kind to read.
     */
    /**
     * SQLite-only: it drives migration 027 directly.
     *
     * PostgreSQL never replays the migrations — `initDatabase()` returns before
     * running one and the generated schema is applied whole — so `027`'s
     * synchronous SQLite code is handed the async handle and its `.all()`
     * returns a promise, giving "usersWithPlaintextSecrets is not iterable".
     * The subject here is the migration pass itself, not the encryption.
     *
     * What it protects IS covered on PostgreSQL: the encryption round-trip is
     * asserted by the neighbouring cases in this file, and the resulting column
     * shape by db.postgresSchema.test.js.
     */
    it.skipIf(RUNNING_ON_POSTGRES)('migrates legacy plaintext secrets cleanly without corruption', async () => {
      const MIGRATION_SUBJECT = 'priya.patel@example.com';
      const plaintextSecret = 'JBSWY3DPEHPK3PXP';
      await db.prepare('UPDATE users SET tfa_secret = ? WHERE email = ?').run(plaintextSecret, MIGRATION_SUBJECT);

      const m = await import('./migrations/027_encrypt_tfa_secrets.js');
      m.default.up(db);
      
      const userRow = await db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get(MIGRATION_SUBJECT);
      expect(userRow.tfa_secret.startsWith('v1:')).toBe(true);
      expect(decryptSecret(userRow.tfa_secret)).toBe(plaintextSecret);
      
      m.default.up(db);
      const userRow2 = await db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get(MIGRATION_SUBJECT);
      expect(userRow2.tfa_secret).toBe(userRow.tfa_secret);
    });
  });

  describe('Recovery codes', () => {
    it('uses bcrypt for storage and verifies correctly', async () => {
      const preauthToken = jwt.sign({ id: 'user-admin', email: 'admin@example.gov', preauth: true }, JWT_SECRET, { expiresIn: '15m' });
      await db.prepare('UPDATE users SET tfa_enabled = 1 WHERE id = ?').run('user-admin');

      const recoveryCode = 'A1B2C3D4E5';
      const hash = bcrypt.hashSync(recoveryCode, 10);
      await db.prepare(`INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, '${new Date().toISOString()}')`).run('rc-1', 'user-admin', hash);

      const res = await srv.call('POST', '/api/auth/login-2fa', { method: 'recovery', code: recoveryCode }, undefined, { Cookie: `wev_preauth=${preauthToken}` });
      console.log('Recovery response:', res.status, res.body);
      
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('user-admin');

      const count = (await db.prepare('SELECT COUNT(*) as c FROM recovery_codes WHERE id = ?').get('rc-1')).c;
      expect(count).toBe(0);

      const auditLog = await db.prepare('SELECT * FROM security_audit_logs WHERE user_id = ? AND event_type = ?').get('user-admin', '2FA_RECOVERY_USED');
      expect(auditLog).toBeDefined();
    });
  });

  describe('Admin enforcement', () => {
    /**
     * This asserted nothing.
     *
     * It signed in as `admin@example.com` — an address that does not exist; the
     * seeded administrator is `admin@example.gov` — and called
     * `/api/admin/metrics`, a route that does not exist either. The whole body
     * was then wrapped in
     *
     *     if (res.status === 404 && !res.body.code) { } else { …assertions… }
     *
     * so the 404 it always received took the empty branch and the test passed
     * without executing a single expectation. A test that cannot fail is worse
     * than a missing one: it occupies the space where the real one would go and
     * reports the feature as covered.
     *
     * Rewritten against a route that exists, an account that exists, and an
     * administrator deliberately stripped of the second factor — because the
     * harness now enrols seeded administrators, so the unenrolled state has to be
     * created on purpose rather than inherited by accident.
     */
    it('refuses an administrator who has no second factor', async () => {
      /**
       * A promoted account, NOT the seeded `admin@example.gov`.
       *
       * That address is the demo administrator, and it is deliberately exempt from
       * the two-factor policy in a DEMO_MODE process (see `isDemoExemptAccount` in
       * server/utils.js) — the harness runs with DEMO_MODE on, so this assertion
       * used it and started passing vacuously the moment the exemption landed.
       *
       * That is the second time this exact test has been able to pass without
       * proving anything; the docstring above records the first. So it now uses an
       * administrator the exemption cannot reach, and the exempt account gets its
       * own case below asserting the opposite.
       */
      const email = 'leo.chen@example.com';
      const token = await srv.login(email);

      await db.prepare(
        "UPDATE users SET role = 'admin', tfa_enabled = 0, tfa_email_enabled = 0, tfa_secret = NULL WHERE email = ?"
      ).run(email);

      try {
        const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, token);

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/Two-factor authentication must be enabled/);
        expect(res.body.code).toBe('tfa_required');
      } finally {
        await db.prepare("UPDATE users SET role = 'student' WHERE email = ?").run(email);
      }
    });

    /**
     * …and can still reach the enrolment that fixes it.
     *
     * ── Why this is the case that matters ──
     *
     * The refusal above is only half a policy. An owner or administrator whose
     * account has no second factor is refused every capability — and if the
     * enrolment endpoints were gated the same way, the only accounts that could
     * turn 2FA on would be the ones that already had it. That is a permanent
     * lockout of the platform's owners, reachable on the very first production
     * boot, and the refusal test passes happily while it is true.
     *
     * It is not true today because `/api/2fa/*` is gated by `requireAAL2` —
     * "prove it is still you" — and not by `requireCap`, which is the gate that
     * consults `tfaRequired`. That distinction is load-bearing and nothing else
     * asserted it, so a `tfaRequired` check added to `requireAAL2` by somebody
     * tightening the screws would lock the owners out and go green.
     *
     * Written against a real deployment question: `pilot.db` carries two owners
     * (`wevolunteer` and `Mahit`), both verified and active, and both with
     * `tfa_enabled = 0`. On the first production boot — where `REQUIRE_ADMIN_2FA`
     * cannot be false — this path is how they get in.
     */
    it('lets an administrator with no second factor reach 2FA enrolment', async () => {
      const email = 'leo.chen@example.com';
      const token = await srv.login(email);

      await db.prepare(
        "UPDATE users SET role = 'admin', tfa_enabled = 0, tfa_email_enabled = 0, tfa_secret = NULL WHERE email = ?"
      ).run(email);

      try {
        /* Refused where it should be — the precondition, so this case cannot
           pass by the account simply being unaffected by the policy. */
        const gated = await srv.call('GET', '/api/admin/organizers/pending', undefined, token);
        expect(gated.status, 'precondition: the account is under the policy').toBe(403);
        expect(gated.body.code).toBe('tfa_required');

        /* Status is readable: the settings screen has to be able to render. */
        const status = await srv.call('GET', '/api/2fa/status', undefined, token);
        expect(status.status, JSON.stringify(status.body)).toBe(200);
        expect(status.body.roleRequires2FA, 'the account is told the rule applies').toBe(true);

        /**
         * And enrolment is reachable. The refusal here must be
         * `reauth_required` — "prove yourself and try again" — and never
         * `tfa_required`, which would be the dead end: an instruction to enable
         * the thing you are trying to enable.
         */
        const generate = await srv.call('POST', '/api/2fa/generate', {}, token);
        expect(
          generate.body?.code,
          'enrolment refused with tfa_required — an administrator with no second '
          + 'factor can never obtain one, which locks the platform owners out',
        ).not.toBe('tfa_required');
        expect([200, 403]).toContain(generate.status);
        if (generate.status === 403) expect(generate.body.code).toBe('reauth_required');
      } finally {
        await db.prepare("UPDATE users SET role = 'student' WHERE email = ?").run(email);
      }
    });

    /**
     * The exemption, from the other side.
     *
     * The demo administrator has no mailbox anybody can read — `admin@example.gov`
     * does not exist — so an enrolment wall makes the one account a developer needs
     * in order to see the administrative surfaces permanently unusable. It is
     * exempt in a DEMO_MODE process and nowhere else;
     * `demoTwoFactorExemption.test.js` covers the boundary in every direction.
     *
     * Asserted here as well because this is the file that owns "the policy is
     * enforced", and an exemption is part of that policy rather than a footnote to
     * it: the two cases have to sit together or the next person removes one.
     */
    it('lets the demo administrator through without one, in a demo process', async () => {
      const token = await srv.login('admin@example.gov');

      await db.prepare(
        'UPDATE users SET tfa_enabled = 0, tfa_email_enabled = 0, tfa_secret = NULL WHERE email = ?'
      ).run('admin@example.gov');

      try {
        const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, token);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      } finally {
        const { encryptSecret } = await import('./cryptoUtils.js');
        const { TEST_TOTP_SECRET } = await import('./testServer.js');
        await db.prepare('UPDATE users SET tfa_enabled = 1, tfa_secret = ? WHERE email = ?')
          .run(encryptSecret(TEST_TOTP_SECRET), 'admin@example.gov');
      }
    });

    /**
     * And an enrolled administrator is let through.
     *
     * Without this the enforcement could be "refuse every administrator", which
     * passes the case above and makes the platform unusable.
     */
    it('lets an enrolled administrator through', async () => {
      const token = await srv.login('admin@example.gov');
      const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, token);
      expect(res.status).toBe(200);
    });

    /**
     * A student is unaffected. The policy is about blast radius, not about
     * everybody — applying it to volunteers would make 2FA a condition of using
     * the platform at all.
     */
    it('does not apply the rule to an ordinary volunteer', async () => {
      const token = await srv.login('leo.chen@example.com');
      const res = await srv.call('GET', '/api/auth/me', undefined, token);
      expect(res.status).toBe(200);
    });
  });
});
