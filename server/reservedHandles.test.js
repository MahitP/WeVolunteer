import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { handleReservedAgainst } from './ownerAllowlist.js';

/**
 * "Account email is mahitp.16@gmail.com username is @mahit" (FX-09).
 *
 * Nothing guaranteed it: any account could register `mahit`, or rename itself
 * to it, and the owner's handle would belong to whoever got there first. The
 * two owner handles are now reserved for the two owner addresses, on every
 * path that sets a username. An account that already holds one in production
 * is the owner's to resolve; nothing here renames or deletes anybody.
 */
describe('the owner handles are reserved', () => {
  /* First, before anything imports db.js — see the signup case. */
  let srv;
  let student;
  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login('leo.chen@example.com');
  }, 60000);
  afterAll(async () => { await srv?.close(); });

  it('for their own addresses, and nobody else', () => {
    expect(handleReservedAgainst('mahit', 'someone@example.org')).toBe(true);
    expect(handleReservedAgainst('Mahit', 'someone@example.org')).toBe(true);
    expect(handleReservedAgainst('mahit', 'mahitp.16@gmail.com')).toBe(false);
    expect(handleReservedAgainst('wevolunteer', 'someone@example.org')).toBe(true);
    expect(handleReservedAgainst('wevolunteer', 'wevolunteer.platform@gmail.com')).toBe(false);
    expect(handleReservedAgainst('maya', 'someone@example.org')).toBe(false);
  });

  it('at signup, including signup through Google or Microsoft', async () => {
    /* Imported here, not at the top: it reaches db.js, which opens its file on
       import, and must not before startTestServer has chosen a scratch one. */
    const { validateAccountFields } = await import('./accountValidation.js');
    const base = { name: 'Some One', email: 'someone@example.org', dateOfBirth: '2009-04-30', role: 'student', grade: '10' };
    const refused = validateAccountFields({ ...base, username: 'mahit' });
    expect(refused.ok).toBe(false);
    expect(refused.field).toBe('username');
    expect(validateAccountFields({ ...base, email: 'mahitp.16@gmail.com', username: 'mahit' }).ok).toBe(true);
  });

  describe('over HTTP', () => {
    it('reports the handle unavailable to anybody checking it', async () => {
      const res = await srv.call('GET', '/api/auth/check-username?username=mahit');
      expect(res.body.available).toBe(false);
    });

    it('refuses a rename to it', async () => {
      const res = await srv.call('POST', '/api/auth/change-username', { username: 'Mahit' }, student);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.field).toBe('username');
      expect(res.body.error).toMatch(/reserved/i);
    });
  });
});
