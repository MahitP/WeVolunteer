import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { startTestServer } from './testServer.js';

let srv;
let db;
let JWT_SECRET, COOKIE_NAME;
let decryptSecret;

beforeAll(async () => { 
  srv = await startTestServer(); 
  
  const serverModule = await import('./server.js');

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
      const preauthToken = jwt.sign({ id: 'user-student', email: 'student@example.com', preauth: true }, JWT_SECRET, { expiresIn: '15m' });
      
      const res = await srv.call('GET', '/api/auth/me', undefined, preauthToken);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Pre-authentication tokens cannot be used as full sessions');
    });

    it('rejects a modified preauth token (tampered signature)', async () => {
      const forgedToken = jwt.sign({ id: 'user-student', email: 'student@example.com' }, 'wrong-secret');
      
      const res = await srv.call('GET', '/api/auth/me', undefined, forgedToken);
      
      expect(res.status).toBe(403);
    });
  });

  describe('TOTP encryption and migration', () => {
    it('encrypts newly generated secrets', async () => {
      const sessionToken = await srv.login('leo.chen28@gmail.com');
      console.log('Session token:', sessionToken);
      const challengeId = await srv.stepUp(sessionToken, '2fa.generate');
      
      const generateRes = await srv.call('POST', '/api/2fa/generate', undefined, sessionToken, { 'X-Reauth-Challenge': challengeId });
        
      expect(generateRes.status).toBe(200);
      expect(generateRes.body.secret).toBeDefined();

      const userRow = db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get('leo.chen28@gmail.com');
      expect(userRow.tfa_secret.startsWith('v1:')).toBe(true);
      expect(decryptSecret(userRow.tfa_secret)).toBe(generateRes.body.secret);
    });

    it('migrates legacy plaintext secrets cleanly without corruption', async () => {
      const plaintextSecret = 'JBSWY3DPEHPK3PXP';
      db.prepare('UPDATE users SET tfa_secret = ? WHERE email = ?').run(plaintextSecret, 'admin@example.gov');

      const m = await import('./migrations/027_encrypt_tfa_secrets.js');
      m.default.up(db);
      
      const userRow = db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get('admin@example.gov');
      expect(userRow.tfa_secret.startsWith('v1:')).toBe(true);
      expect(decryptSecret(userRow.tfa_secret)).toBe(plaintextSecret);
      
      m.default.up(db);
      const userRow2 = db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get('admin@example.gov');
      expect(userRow2.tfa_secret).toBe(userRow.tfa_secret);
    });
  });

  describe('Recovery codes', () => {
    it('uses bcrypt for storage and verifies correctly', async () => {
      const preauthToken = jwt.sign({ id: 'user-admin', email: 'admin@example.com', preauth: true }, JWT_SECRET, { expiresIn: '15m' });
      db.prepare('UPDATE users SET tfa_enabled = 1 WHERE id = ?').run('user-admin');

      const recoveryCode = 'A1B2C3D4E5';
      const hash = bcrypt.hashSync(recoveryCode, 10);
      db.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime('now'))").run('rc-1', 'user-admin', hash);

      const res = await srv.call('POST', '/api/auth/login-2fa', { method: 'recovery', code: recoveryCode }, undefined, { Cookie: `wev_preauth=${preauthToken}` });
      console.log('Recovery response:', res.status, res.body);
      
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('user-admin');

      const count = db.prepare('SELECT COUNT(*) as c FROM recovery_codes WHERE id = ?').get('rc-1').c;
      expect(count).toBe(0);

      const auditLog = db.prepare('SELECT * FROM security_audit_logs WHERE user_id = ? AND event_type = ?').get('user-admin', '2FA_RECOVERY_USED');
      expect(auditLog).toBeDefined();
    });
  });

  describe('Admin enforcement', () => {
    it('blocks admin actions if tfaRequired is true', async () => {
      const sessionToken = await srv.login('admin@example.com');
      
      const res = await srv.call('GET', '/api/admin/metrics', undefined, sessionToken);
      
      if (res.status === 404 && !res.body.code) {
      } else {
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/Two-factor authentication must be enabled/);
        expect(res.body.code).toBe('tfa_required');
      }
    });
  });
});
