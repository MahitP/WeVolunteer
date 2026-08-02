import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Spent step-up challenges must not accumulate.
 *
 * `reauth_challenges` gets a row per sensitive action a user starts — including
 * every abandoned modal — and each row carries `ip_hash`, so an unbounded table
 * is both a growth problem and a needless retention of network metadata about
 * minors. A challenge is worthless the moment it expires: it cannot be granted
 * and it cannot be consumed.
 *
 * The window is deliberately not zero. Deleting a row the instant it expires
 * would turn "your verification timed out, please try again" into "no such
 * challenge", which is the same message a forged id gets — so the honest
 * explanation would be lost exactly when a real user hits it.
 *
 * Both halves are pinned here, in the shape of notificationRetention.test.js:
 * nothing inside the window is deleted, nothing outside it survives, and the
 * scheduled sweep actually drives it.
 */

let dir;

async function fresh() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-reauth-ret-'));
  process.env.WEV_DB_PATH = path.join(dir, 'reauth.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  process.env.APP_URL = 'http://localhost:5173';
  process.env.DEMO_MODE = 'true';
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  const utils = await import('./utils.js');
  const reauth = await import('./reauth.js');
  return { db: dbMod.db, utils, reauth };
}

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const NOW = new Date('2026-07-30T12:00:00.000Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000).toISOString();

/** A challenge whose window closed `n` minutes ago (negative = still open). */
function challenge(db, id, expiredMinutesAgo) {
  const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare(`
    INSERT INTO reauth_challenges (id, user_id, action, params_hash, session_jti, created_at, expires_at, attempts)
    VALUES (?, ?, 'account.delete', 'hash', 'jti', ?, ?, 0)
  `).run(id, userId, minutesAgo(expiredMinutesAgo + 5), minutesAgo(expiredMinutesAgo));
}

const surviving = (db) =>
  db.prepare('SELECT id FROM reauth_challenges ORDER BY id').all().map(r => r.id);

describe('sweepExpiredChallenges', () => {
  it('declares a finite, positive retention window', async () => {
    const { reauth } = await fresh();
    expect(Number.isFinite(reauth.CHALLENGE_RETENTION_MS)).toBe(true);
    expect(reauth.CHALLENGE_RETENTION_MS).toBeGreaterThan(0);
    // Longer than the challenge's own life, so "expired" stays explainable for
    // at least as long as a challenge can exist.
    expect(reauth.CHALLENGE_RETENTION_MS).toBeGreaterThan(reauth.CHALLENGE_TTL_MS);
  });

  it('keeps a live challenge', async () => {
    const { db, reauth } = await fresh();
    challenge(db, 'live', -3);      // expires three minutes from NOW

    expect(reauth.sweepExpiredChallenges(db, NOW)).toBe(0);
    expect(surviving(db)).toEqual(['live']);
  });

  it('keeps a just-expired challenge, so it can still say "expired"', async () => {
    const { db, reauth } = await fresh();
    challenge(db, 'recent', 2);

    expect(reauth.sweepExpiredChallenges(db, NOW)).toBe(0);
    expect(surviving(db)).toEqual(['recent']);
  });

  it('deletes challenges past the retention window', async () => {
    const { db, reauth } = await fresh();
    challenge(db, 'ancient', 60 * 24);
    challenge(db, 'old', 90);
    challenge(db, 'live', -1);

    expect(reauth.sweepExpiredChallenges(db, NOW)).toBe(2);
    expect(surviving(db)).toEqual(['live']);
  });

  it('is idempotent', async () => {
    const { db, reauth } = await fresh();
    challenge(db, 'old', 300);
    challenge(db, 'live', -1);

    expect(reauth.sweepExpiredChallenges(db, NOW)).toBe(1);
    expect(reauth.sweepExpiredChallenges(db, NOW)).toBe(0);
    expect(surviving(db)).toEqual(['live']);
  });
});

describe('the maintenance sweep actually runs it', () => {
  it('runNotificationSweep purges challenges past the window', async () => {
    const { db, utils } = await fresh();
    // Backdated far enough that the sweep's own `new Date()` is well past the
    // retention window, whatever the wall clock says when this runs.
    const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
    db.prepare(`
      INSERT INTO reauth_challenges (id, user_id, action, params_hash, session_jti, created_at, expires_at, attempts)
      VALUES ('swept', ?, 'account.delete', 'hash', 'jti', ?, ?, 0)
    `).run(
      userId,
      new Date(Date.now() - 30 * 86400_000).toISOString(),
      new Date(Date.now() - 29 * 86400_000).toISOString()
    );

    utils.runNotificationSweep();

    expect(surviving(db), 'the sweep did not purge spent challenges').toEqual([]);
  });

  it('leaves a live challenge alone when sweeping', async () => {
    const { db, utils } = await fresh();
    const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
    db.prepare(`
      INSERT INTO reauth_challenges (id, user_id, action, params_hash, session_jti, created_at, expires_at, attempts)
      VALUES ('live', ?, 'account.delete', 'hash', 'jti', ?, ?, 0)
    `).run(userId, new Date().toISOString(), new Date(Date.now() + 5 * 60_000).toISOString());

    utils.runNotificationSweep();

    expect(surviving(db), 'the sweep deleted a challenge a user is still answering').toEqual(['live']);
  });
});
