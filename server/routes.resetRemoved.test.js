import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer } from './testServer.js';

/**
 * Regression cover for the P0 audit finding: a reachable HTTP endpoint could
 * destroy the database.
 *
 * `POST /api/auth/reset` dropped 16 tables one statement at a time and then
 * failed partway through — `conversations` declares foreign keys to BOTH
 * `events` and `users`, so by the time `users` was dropped SQLite could no
 * longer resolve the cascade and threw `no such table: main.events`.
 * `initDatabase()` was never reached, so nothing was recreated: the database
 * was left with users but no events, applications, attendance, notifications
 * or hours ledger, and every screen touching them threw. Restarting recreated
 * empty tables but could not re-seed, because `users` was non-empty.
 *
 * The root cause was a hand-maintained DROP list that drifted every time a
 * feature added a table — messaging, certificates and moderation each added
 * tables and each left the list behind. A list that must be updated by hand
 * will drift again, so the capability is gone from the HTTP surface entirely
 * and the development utility recreates the file instead of enumerating tables.
 *
 * These tests assert the capability cannot come back:
 *   1. No HTTP method reaches a reset route, even with DEMO_MODE on.
 *   2. The development utility refuses to run against NODE_ENV=production.
 *   3. The development utility refuses to run without explicit confirmation.
 *   4. The development utility does restore a usable seeded database.
 */

const ROOT = process.cwd().replace(/\\/g, '/');
const SCRIPT = path.join(process.cwd(), 'bin', 'reset-dev-db.mjs');

describe('the database-reset HTTP endpoint is gone', () => {
  let srv;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv?.close(); });

  // startTestServer runs with DEMO_MODE=true, which is exactly the condition
  // that used to register the route. If it is reachable at all, it is here.
  it('answers 404 for POST /api/auth/reset even in DEMO_MODE', async () => {
    const res = await srv.call('POST', '/api/auth/reset', {});
    expect(res.status).toBe(404);
  });

  it('answers 404 for every other method on /api/auth/reset', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const res = await srv.call(method, '/api/auth/reset');
      expect(res.status, `${method} /api/auth/reset`).toBe(404);
    }
  });

  it('is still authenticated-and-404, not a silent 200, for a signed-in admin', async () => {
    const token = await srv.login('admin@example.gov');
    const res = await srv.call('POST', '/api/auth/reset', {}, token);
    expect(res.status).toBe(404);
  });

  // The demo database survives the attempt — the point of the finding was that
  // the old handler destroyed data before failing.
  it('leaves the database intact after the attempt', async () => {
    await srv.call('POST', '/api/auth/reset', {});
    const res = await srv.call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('connected');
  });

  it('no route in the mounted app matches a reset path', async () => {
    const { app } = await import('./app.js');
    const paths = [];
    const walk = (stack) => {
      for (const layer of stack) {
        if (layer.route?.path) paths.push(layer.route.path);
        if (layer.handle?.stack) walk(layer.handle.stack);
      }
    };
    walk(app._router.stack);
    // /api/auth/reset-password is a different, legitimate route: it must survive.
    expect(paths).not.toContain('/api/auth/reset');
    expect(paths).toContain('/api/auth/reset-password');
  });
});

describe('the development reset utility refuses to destroy production data', () => {
  it('exists as a script', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('refuses to run when NODE_ENV=production', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-reset-prod-'));
    const dbFile = path.join(dir, 'prod.db');
    writeFileSync(dbFile, 'not-really-a-db-but-must-not-be-deleted');

    let failed = false;
    let output = '';
    try {
      execFileSync(process.execPath, [SCRIPT, '--yes'], {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'production',
          WEV_DB_PATH: dbFile,
          JWT_SECRET: 'x'.repeat(48)
        }
      });
    } catch (err) {
      failed = true;
      output = String(err.stdout || '') + String(err.stderr || '');
    }

    const stillThere = existsSync(dbFile);
    rmSync(dir, { recursive: true, force: true });

    expect(failed, 'must exit non-zero in production').toBe(true);
    expect(output).toMatch(/production/i);
    expect(stillThere, 'the database file must not be touched').toBe(true);
  });

  it('refuses to run without explicit confirmation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-reset-noconfirm-'));
    const dbFile = path.join(dir, 'dev.db');
    writeFileSync(dbFile, 'placeholder');

    let failed = false;
    let output = '';
    try {
      execFileSync(process.execPath, [SCRIPT], {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'development',
          WEV_DB_PATH: dbFile,
          JWT_SECRET: 'x'.repeat(48),
          CI: '1'
        }
      });
    } catch (err) {
      failed = true;
      output = String(err.stdout || '') + String(err.stderr || '');
    }

    const stillThere = existsSync(dbFile);
    rmSync(dir, { recursive: true, force: true });

    expect(failed, 'must exit non-zero without --yes').toBe(true);
    expect(output).toMatch(/--yes|confirm/i);
    expect(stillThere, 'the database file must not be touched').toBe(true);
  });

  it('restores a usable seeded database in development', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-reset-dev-'));
    const dbFile = path.join(dir, 'dev.db');

    // Seed a database, then dirty it, so the reset has something to undo.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
      process.env.JWT_SECRET = 'x'.repeat(48);
      process.env.DEMO_MODE = 'true';
      const { db, initDatabase, completeDatabaseInit } = await import('${ROOT}/server/db.js');
      initDatabase();
      await completeDatabaseInit();
      db.exec("DELETE FROM events");
      db.exec("INSERT INTO users (id,name,email,password_hash,grade,role,created_at) VALUES ('junk','Junk','junk@x.org','h','11','student','2026-01-01')");
    `], { cwd: process.cwd(), stdio: 'pipe' });

    const before = new DatabaseSync(dbFile);
    const beforeEvents = before.prepare('SELECT COUNT(*) AS c FROM events').get().c;
    const beforeJunk = before.prepare("SELECT COUNT(*) AS c FROM users WHERE id='junk'").get().c;
    before.close();

    execFileSync(process.execPath, [SCRIPT, '--yes'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        WEV_DB_PATH: dbFile,
        JWT_SECRET: 'x'.repeat(48),
        DEMO_MODE: 'true'
      }
    });

    const after = new DatabaseSync(dbFile);
    const afterEvents = after.prepare('SELECT COUNT(*) AS c FROM events').get().c;
    const afterJunk = after.prepare("SELECT COUNT(*) AS c FROM users WHERE id='junk'").get().c;
    // Every table the app relies on must be back, including the ones the old
    // hand-maintained DROP list kept forgetting.
    const tables = after.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map(r => r.name);
    after.close();
    rmSync(dir, { recursive: true, force: true });

    expect(beforeEvents).toBe(0);
    expect(beforeJunk).toBe(1);
    expect(afterEvents, 'seed events must be restored').toBeGreaterThan(0);
    expect(afterJunk, 'the dirty row must be gone').toBe(0);
    for (const t of [
      'users', 'events', 'slots', 'applications', 'attendance', 'notifications',
      'hours_ledger', 'certificates', 'conversations', 'conversation_participants',
      'messages', 'notification_preferences', 'admin_audit_logs', 'data_export_jobs'
    ]) {
      expect(tables, `table ${t} must exist after reset`).toContain(t);
    }
  });
});
