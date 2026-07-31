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
  ({ NOTIFICATION_RETENTION_DAYS, purgeExpiredNotifications } = utils);
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-07-30T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

function seed(rows) {
  db.exec('DELETE FROM notifications');
  const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const stmt = db.prepare(`
    INSERT INTO notifications (id, user_id, kind, priority, title, body, link, read, created_at)
    VALUES (?, ?, 'APPLICATION', ?, 't', 'b', NULL, 0, ?)
  `);
  rows.forEach(([id, priority, age]) => stmt.run(id, userId, priority, daysAgo(age)));
}

const surviving = () =>
  db.prepare('SELECT id FROM notifications ORDER BY id').all().map(r => r.id);

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
  it('deletes nothing that is still inside its window', () => {
    seed([
      ['low-fresh', 'LOW', 1],
      ['normal-fresh', 'NORMAL', 29],
      ['important-fresh', 'IMPORTANT', 89],
      ['critical-fresh', 'CRITICAL', 364]
    ]);
    expect(purgeExpiredNotifications(NOW)).toBe(0);
    expect(surviving()).toEqual(['critical-fresh', 'important-fresh', 'low-fresh', 'normal-fresh']);
  });

  it('deletes everything past its window', () => {
    seed([
      ['low-old', 'LOW', 31],
      ['normal-old', 'NORMAL', 91],
      ['important-old', 'IMPORTANT', 366],
      ['critical-old', 'CRITICAL', 366]
    ]);
    expect(purgeExpiredNotifications(NOW)).toBe(4);
    expect(surviving()).toEqual([]);
  });

  // The specific regression: IMPORTANT used to be immortal.
  it('bounds IMPORTANT and CRITICAL growth (they were previously never deleted)', () => {
    seed([
      ['important-ancient', 'IMPORTANT', 800],
      ['critical-ancient', 'CRITICAL', 800]
    ]);
    expect(purgeExpiredNotifications(NOW)).toBe(2);
    expect(surviving()).toEqual([]);
  });

  // The other half of the old rule: NORMAL was swept at 30 days, which threw
  // away the ordinary history that gives a season context.
  it('keeps a NORMAL notification that the old 30-day rule would have deleted', () => {
    seed([['normal-60d', 'NORMAL', 60]]);
    expect(purgeExpiredNotifications(NOW)).toBe(0);
    expect(surviving()).toEqual(['normal-60d']);
  });

  it('leaves an unrecognised priority alone rather than sweeping it on a default', () => {
    seed([['weird', 'URGENT_ISH', 5000]]);
    expect(purgeExpiredNotifications(NOW)).toBe(0);
    expect(surviving()).toEqual(['weird']);
  });

  it('is idempotent', () => {
    seed([['low-old', 'LOW', 40], ['low-fresh', 'LOW', 2]]);
    expect(purgeExpiredNotifications(NOW)).toBe(1);
    expect(purgeExpiredNotifications(NOW)).toBe(0);
    expect(surviving()).toEqual(['low-fresh']);
  });

  it('never touches the durable records a notification refers to', () => {
    const beforeHours = db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c;
    const beforeLedger = db.prepare('SELECT COUNT(*) AS c FROM hours_ledger').get().c;
    const beforeCerts = db.prepare('SELECT COUNT(*) AS c FROM certificates').get().c;
    seed([['important-ancient', 'IMPORTANT', 900]]);
    purgeExpiredNotifications(NOW);
    expect(db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c).toBe(beforeHours);
    expect(db.prepare('SELECT COUNT(*) AS c FROM hours_ledger').get().c).toBe(beforeLedger);
    expect(db.prepare('SELECT COUNT(*) AS c FROM certificates').get().c).toBe(beforeCerts);
  });
});
