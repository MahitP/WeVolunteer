import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Retention cover for the audit finding that the sweep was one-sided.
 *
 * It deleted NORMAL and LOW after 30 days and kept IMPORTANT and CRITICAL
 * forever — so the priorities that are dispatched most often (acceptance,
 * reminders, promotions and credited hours are all IMPORTANT) were the only ones
 * that never shrank, and the notifications table grew without bound.
 *
 * Every priority now has a finite window. These tests pin both halves: nothing
 * inside its window is deleted, and nothing outside it survives.
 */

let db, NOTIFICATION_RETENTION_DAYS, purgeExpiredNotifications, dir;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-retention-'));
  process.env.WEV_DB_PATH = path.join(dir, 'retention.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  process.env.DEMO_MODE = 'true';
  const dbMod = await import('./db.js');
  const utils = await import('./utils.js');
  db = dbMod.db;
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  ({ NOTIFICATION_RETENTION_DAYS, purgeExpiredNotifications } = utils);
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-07-30T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

async function seed(rows) {
  await db.exec('DELETE FROM notifications');
  const userId = (await db.prepare('SELECT id FROM users LIMIT 1').get()).id;
  const stmt = db.prepare(`
    INSERT INTO notifications (id, user_id, kind, priority, title, body, link, read, created_at)
    VALUES (?, ?, 'APPLICATION', ?, 't', 'b', NULL, 0, ?)
  `);
  /* A loop rather than `forEach`: the callback cannot await, so every insert
     would be an unhandled promise racing the assertion below it. */
  for (const [id, priority, age] of rows) await stmt.run(id, userId, priority, daysAgo(age));
}

const surviving = async () =>
  (await db.prepare('SELECT id FROM notifications ORDER BY id').all()).map(r => r.id);

describe('every priority has a finite retention window', () => {
  it('declares a window for all four priorities', () => {
    expect(Object.keys(NOTIFICATION_RETENTION_DAYS).sort())
      .toEqual(['CRITICAL', 'IMPORTANT', 'LOW', 'NORMAL']);
    for (const [p, days] of Object.entries(NOTIFICATION_RETENTION_DAYS)) {
      expect(Number.isFinite(days), `${p} must be finite`).toBe(true);
      expect(days, `${p} must be positive`).toBeGreaterThan(0);
    }
  });

  it('keeps important things longer than incidental ones', () => {
    const r = NOTIFICATION_RETENTION_DAYS;
    expect(r.LOW).toBeLessThanOrEqual(r.NORMAL);
    expect(r.NORMAL).toBeLessThanOrEqual(r.IMPORTANT);
    expect(r.IMPORTANT).toBeLessThanOrEqual(r.CRITICAL);
  });
});

describe('purgeExpiredNotifications', () => {
  it('deletes nothing that is still inside its window', async () => {
    await seed([
      ['low-fresh', 'LOW', 1],
      ['normal-fresh', 'NORMAL', 29],
      ['important-fresh', 'IMPORTANT', 89],
      ['critical-fresh', 'CRITICAL', 364]
    ]);
    expect(await purgeExpiredNotifications(NOW)).toBe(0);
    expect(await surviving()).toEqual(['critical-fresh', 'important-fresh', 'low-fresh', 'normal-fresh']);
  });

  it('deletes everything past its window', async () => {
    await seed([
      ['low-old', 'LOW', 31],
      ['normal-old', 'NORMAL', 91],
      ['important-old', 'IMPORTANT', 366],
      ['critical-old', 'CRITICAL', 366]
    ]);
    expect(await purgeExpiredNotifications(NOW)).toBe(4);
    expect(await surviving()).toEqual([]);
  });

  // The specific regression: IMPORTANT used to be immortal.
  it('bounds IMPORTANT and CRITICAL await growth(they were previously never deleted)', async () => {
    await seed([
      ['important-ancient', 'IMPORTANT', 800],
      ['critical-ancient', 'CRITICAL', 800]
    ]);
    expect(await purgeExpiredNotifications(NOW)).toBe(2);
    expect(await surviving()).toEqual([]);
  });

  // The other half of the old rule: NORMAL was swept at 30 days, which threw
  // away the ordinary history that gives a season context.
  it('keeps a NORMAL notification that the old 30-day rule would have deleted', async () => {
    await seed([['normal-60d', 'NORMAL', 60]]);
    expect(await purgeExpiredNotifications(NOW)).toBe(0);
    expect(await surviving()).toEqual(['normal-60d']);
  });

  it('leaves an unrecognised priority alone rather than sweeping it on a default', async () => {
    await seed([['weird', 'URGENT_ISH', 5000]]);
    expect(await purgeExpiredNotifications(NOW)).toBe(0);
    expect(await surviving()).toEqual(['weird']);
  });

  it('is idempotent', async () => {
    await seed([['low-old', 'LOW', 40], ['low-fresh', 'LOW', 2]]);
    expect(await purgeExpiredNotifications(NOW)).toBe(1);
    expect(await purgeExpiredNotifications(NOW)).toBe(0);
    expect(await surviving()).toEqual(['low-fresh']);
  });

  it('never touches the durable records a notification refers to', async () => {
    const beforeHours = (await db.prepare('SELECT COUNT(*) AS c FROM attendance').get()).c;
    const beforeLedger = (await db.prepare('SELECT COUNT(*) AS c FROM hours_ledger').get()).c;
    const beforeCerts = (await db.prepare('SELECT COUNT(*) AS c FROM certificates').get()).c;
    await seed([['important-ancient', 'IMPORTANT', 900]]);
    await purgeExpiredNotifications(NOW);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM attendance').get()).c).toBe(beforeHours);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM hours_ledger').get()).c).toBe(beforeLedger);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM certificates').get()).c).toBe(beforeCerts);
  });
});
