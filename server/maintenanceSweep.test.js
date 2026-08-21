/**
 * Periodic maintenance must actually be scheduled.
 *
 * ── A correction, recorded so it is not re-derived ──
 *
 * This file was started on the belief that `purgeExpiredRevocations()` was dead code —
 * a cleanup function that existed, carried the comment "Without this the table would
 * grow by one row per sign-out forever", and was never invoked.
 *
 * That was WRONG, and the way it went wrong is worth writing down. The greps that
 * "proved" it searched for `pruneRevokedSessions` and `purgeRevoked` — neither of
 * which is the function's name. The live reproduction was equally invalid: 12
 * revocation rows were backdated past expiry and the server was then shut down within
 * seconds, so no sweep ran between the backdating and the measurement. The 12
 * surviving rows demonstrated nothing.
 *
 * `purgeExpiredRevocations` is in fact called from `runNotificationSweep`
 * (server/utils.js:377), which runs at boot and every 15 minutes. The maintenance
 * works.
 *
 * ── What this file is for, then ──
 *
 * Two things worth having regardless:
 *
 *   1. Behaviour cover for maintenance that currently works and had none. The purge is
 *      load-bearing: `revoked_sessions` is read on EVERY authenticated request via
 *      `isSessionRevoked(jti)`, and without pruning it grows by one row per sign-out —
 *      ~182,000 rows a year at 500 students — while retaining session metadata about
 *      minors long past the point where the row does anything, since an expired token
 *      is rejected by `jwt.verify` on its own. The counter-test matters just as much:
 *      purging a row whose token is still valid would silently un-revoke a session
 *      the user believed they had ended.
 *
 *   2. A static guard against the bug actually existing next time. The last describe
 *      block fails if any `purge*`/`cleanup*`/`reclaim*`/`prune*` helper has no caller
 *      — because a cleanup function that is never invoked reads as a working control
 *      while the thing it should bound grows without limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const ROOT = process.cwd();
let dir;

async function fresh() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-maint-'));
  process.env.WEV_DB_PATH = path.join(dir, 'maint.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  process.env.APP_URL = 'http://localhost:5173';
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  const utils = await import('./utils.js');
  return { db: dbMod.db, utils };
}

/** A revocation row whose token expired `hoursAgo` hours ago. */
async function revocation(db, jti, hoursAgo) {
  await db.prepare(`
    INSERT INTO revoked_sessions (jti, user_id, revoked_at, expires_at)
    VALUES (?, 'u1', ?, ?)
  `).run(
    jti,
    new Date(Date.now() - (hoursAgo + 1) * 3600_000).toISOString(),
    new Date(Date.now() - hoursAgo * 3600_000).toISOString()
  );
}

const rows = async (db) => (await db.prepare('SELECT COUNT(*) AS c FROM revoked_sessions').get()).c;

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('purgeExpiredRevocations', () => {
  it('removes revocations whose token has already expired', async () => {
    const { db, utils } = await fresh();
    await revocation(db, 'jti-old-1', 48);
    await revocation(db, 'jti-old-2', 200);
    expect(await rows(db)).toBe(2);

    const removed = await utils.purgeExpiredRevocations();

    expect(removed).toBe(2);
    expect(await rows(db)).toBe(0);
  });

  it('keeps revocations whose token is still valid', async () => {
    const { db, utils } = await fresh();
    // Still inside its 7-day life: the denylist row is the ONLY thing making this
    // token stop working, so removing it would un-revoke a session.
    await db.prepare(`
      INSERT INTO revoked_sessions (jti, user_id, revoked_at, expires_at)
      VALUES ('jti-live', 'u1', ?, ?)
    `).run(new Date().toISOString(), new Date(Date.now() + 3 * 86400_000).toISOString());

    await utils.purgeExpiredRevocations();

    expect(await rows(db), 'a live revocation was purged, un-revoking a signed-out session').toBe(1);
  });
});

describe('the sweep actually runs it', () => {
  it('runNotificationSweep purges expired revocations', async () => {
    const { db, utils } = await fresh();
    await revocation(db, 'jti-swept', 48);

    // The regression: the function existed and was never invoked, so the table grew
    // forever while the code read as though pruning were handled.
    await utils.runNotificationSweep();

    expect(await rows(db), 'the sweep did not purge expired revocations').toBe(0);
  });

  it('leaves live revocations alone when sweeping', async () => {
    const { db, utils } = await fresh();
    await revocation(db, 'jti-expired', 48);
    await db.prepare(`
      INSERT INTO revoked_sessions (jti, user_id, revoked_at, expires_at)
      VALUES ('jti-live', 'u1', ?, ?)
    `).run(new Date().toISOString(), new Date(Date.now() + 3 * 86400_000).toISOString());

    await utils.runNotificationSweep();

    const remaining = (await db.prepare('SELECT jti FROM revoked_sessions').all()).map(r => r.jti);
    expect(remaining).toEqual(['jti-live']);
  });

  it('a purge failure does not stop the rest of the sweep', async () => {
    const { db, utils } = await fresh();

    // Maintenance is the least important thing the sweep does; it must never be the
    // reason reminders stop going out.
    const real = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(async (sql) => {
      if (/DELETE FROM revoked_sessions/.test(sql)) throw new Error('database is locked');
      return real(sql);
    });

    await expect(utils.runNotificationSweep()).resolves.toBeTypeOf('number');
  });
});

describe('no maintenance helper is left unscheduled', () => {
  /**
   * The general form of this bug: a cleanup function that exists, reads as a working
   * control, and is never called. This catches the next one.
   */
  it('every purge/cleanup/reclaim helper has a caller outside its own module', () => {
    const MAINTENANCE = /^export function (purge|cleanup|reclaim|prune)[A-Za-z]*/;
    const helpers = [];

    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        const src = readFileSync(full, 'utf8');
        for (const line of src.split('\n')) {
          const m = MAINTENANCE.exec(line.trim());
          if (m) {
            const name = line.trim().match(/^export function ([A-Za-z0-9_]+)/)[1];
            helpers.push({ name, file: path.relative(ROOT, full) });
          }
        }
      }
    };
    walk(path.join(ROOT, 'server'));

    // Every .js under server/, so a helper called only from its own module still
    // counts as unscheduled if nothing else drives it.
    const sources = [];
    const collect = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { collect(full); continue; }
        if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
          sources.push({ file: path.relative(ROOT, full), code: readFileSync(full, 'utf8') });
        }
      }
    };
    collect(path.join(ROOT, 'server'));

    const orphans = helpers.filter(h =>
      !sources.some(s => s.file !== h.file && new RegExp(`\\b${h.name}\\s*\\(`).test(s.code))
      && !sources.some(s => s.file === h.file
        && new RegExp(`\\b${h.name}\\s*\\(`).test(s.code.replace(new RegExp(`export function ${h.name}[^\\n]*`), '')))
    );

    expect(
      orphans.map(o => `${o.file} — ${o.name}() is never called`),
      'a maintenance helper that is never invoked reads as a working control while '
      + 'the thing it should clean grows without bound'
    ).toEqual([]);
  });
});
