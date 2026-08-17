/**
 * The demo sign-in shortcuts describe the database, not the seed script.
 *
 * ── The defect ──
 *
 * The roster was a literal in `src/views/Login.jsx`, duplicated in
 * `src/components/DemoBar.jsx`. On the pilot deployment `user-admin` had been
 * deleted — `account_status = 'deleted'`, address anonymised to
 * `deleted_user-admin@system.local` — and the sign-in screen went on offering
 * "System Admin · admin@example.gov" as a one-tap demo credential. Pressing it
 * answered "No account found with that email address": the product advertising an
 * account it had itself destroyed, and re-publishing the display name attached to
 * a row somebody had asked to erase.
 *
 * Removing that one entry from the array would have fixed that one account and
 * left the defect in place for the next deletion. So the list is derived, and
 * this file is what stops it being written down again.
 *
 * ── What is asserted ──
 *
 *   • a deleted account never appears, whatever else is true of it;
 *   • internal actors (`system-cli`) never appear;
 *   • the endpoint does not exist at all outside DEMO_MODE;
 *   • what IS listed is genuinely signable-in, which is the only property that
 *     makes the shortcut worth having.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// db.js opens its connection at module scope — see testServer.js.
let srv, db;

const list = () => srv.call('GET', '/api/auth/demo-accounts');

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
});

afterAll(async () => { await srv.close(); });

beforeEach(async () => {
  /* Undo any tombstoning a previous case did. The seed's own values, restored
     by id so the roster is exercised rather than sidestepped. */
  await db.prepare(`
    UPDATE users SET account_status = 'active', email = 'admin@example.gov'
     WHERE id = 'user-admin'
  `).run();
});

describe('GET /api/auth/demo-accounts', () => {
  it('lists the seeded demo accounts', async () => {
    const res = await list();
    expect(res.status).toBe(200);

    const emails = res.body.accounts.map(a => a.email);
    expect(emails).toContain('leo.chen@example.com');
    expect(emails).toContain('jordan.whitfield@example.org');
    expect(emails).toContain('admin@example.gov');
  });

  it('omits an account that has been deleted', async () => {
    /* Exactly the shape a real deletion leaves behind — see the anonymisation in
       the account-deletion route: status flipped and the address replaced with a
       synthetic one that no mailbox answers. */
    await db.prepare(`
      UPDATE users
         SET account_status = 'deleted', email = 'deleted_user-admin@system.local'
       WHERE id = 'user-admin'
    `).run();

    const res = await list();
    const emails = res.body.accounts.map(a => a.email);

    expect(emails).not.toContain('admin@example.gov');
    expect(emails).not.toContain('deleted_user-admin@system.local');
    /* And the NAME is gone too, not merely the address: the tombstone is not a
       thing to advertise under any spelling. */
    expect(res.body.accounts.map(a => a.name)).not.toContain('System Admin');
    // The rest are untouched.
    expect(emails).toContain('leo.chen@example.com');
  });

  it('never lists an internal actor', async () => {
    /* `system-cli` attributes CLI-performed moderation. It is not a person, has
       no usable password, and exists in every database that has run migration
       022 — including this one. */
    const res = await list();
    const ids = res.body.accounts.map(a => a.id);
    expect(ids).not.toContain('system-cli');
    expect(res.body.accounts.map(a => a.email))
      .not.toContain('system-cli@wevolunteer.invalid');
  });

  it('lists only accounts that can actually be signed in to', async () => {
    const res = await list();

    for (const account of res.body.accounts) {
      const row = await db.prepare('SELECT account_status FROM users WHERE id = ?').get(account.id);
      expect(row, `${account.id} does not exist`).toBeTruthy();
      expect(row.account_status, `${account.email} is a tombstone`).not.toBe('deleted');
    }
  });

  it('signs in with a listed account', async () => {
    const res = await list();
    const student = res.body.accounts.find(a => a.role === 'Student');

    const login = await srv.call('POST', '/api/auth/login', {
      email: student.email,
      password: 'password123'
    });
    /* 200 either way: a session, or a second-factor challenge. What must not
       happen is 401 "No account found", which is what the stale literal produced. */
    expect(login.status, JSON.stringify(login.body)).toBe(200);
  });

  it('reports a role label derived from the row, not stored beside it', async () => {
    const res = await list();
    const pending = res.body.accounts.find(a => a.id === 'user-org-pending');
    expect(pending.role).toBe('Pending organizer');

    const organizer = res.body.accounts.find(a => a.id === 'user-org-1');
    expect(organizer.role).toBe('Organizer');
  });
});

describe('outside DEMO_MODE', () => {
  it('the endpoint does not exist', async () => {
    /**
     * A subprocess, because DEMO_MODE is read into a module-scope constant in
     * config.js when it is first imported — this suite's server is already
     * bound to `true` and cannot be re-bound in place.
     *
     * 404 rather than an empty list, deliberately: an empty list would let an
     * unauthenticated caller tell a demo deployment with no demo accounts from a
     * production one, and the addresses this endpoint publishes are real.
     */
    const { execFileSync } = await import('node:child_process');
    const script = `
      process.env.DEMO_MODE = 'false';
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'test-secret-not-for-production';
      process.env.WEV_DB_PATH = process.env.PROBE_DB;
      const { initDatabase, completeDatabaseInit } = await import('./server/db.js');
      initDatabase();
      await completeDatabaseInit();
      const { app } = await import('./server/app.js');
      const server = app.listen(0, '127.0.0.1');
      await new Promise(r => server.once('listening', r));
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/auth/demo-accounts');
      console.log(JSON.stringify({ status: res.status }));
      server.close();
      process.exit(0);
    `;

    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const probeDb = path.join(mkdtempSync(path.join(tmpdir(), 'wev-demoflag-')), 'probe.db');

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, PROBE_DB: probeDb, DEMO_MODE: 'false' },
      encoding: 'utf8'
    });

    const parsed = JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop());
    expect(parsed.status).toBe(404);
  }, 30_000);
});
