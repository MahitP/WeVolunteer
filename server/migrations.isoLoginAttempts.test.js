/**
 * Migration 056, and the lockout it is there to keep continuous.
 *
 * The rate limiter compares `tfa_login_attempts.last_attempt_at` against a
 * cutoff, as text. The column used to hold SQLite's `2026-08-16 17:53:04` and
 * now holds the application's `2026-08-16T17:53:04.120Z`.
 *
 * Those two do not compare correctly, and the direction matters. At position 10
 * the old format has a space (0x20) and the cutoff has `T` (0x54), so an
 * unconverted row sorts BELOW every same-day cutoff no matter how recent it
 * actually is — a failure from thirty seconds ago reads as older than fifteen
 * minutes and drops out of the window. (An older date is excluded anyway, on the
 * date digits, so the harm is confined to rows that should still count.)
 *
 * The consequence is a lost rate limit, not a stuck one: on the day of the
 * deploy every attempt already recorded stops counting, and anybody part-way
 * through guessing a second factor gets their budget back. That is why the rows
 * are converted rather than deleted — deleting them hands out exactly the same
 * free reset the conversion exists to prevent.
 *
 * So the migration is not tidying. It is what keeps an in-progress lockout
 * continuous across the upgrade, and these tests are about the values the
 * comparison sees, not about the migration having run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import migration from './migrations/056_iso_login_attempt_timestamps.js';

let dir;
let db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-056-'));
  db = new DatabaseSync(path.join(dir, 'm.db'));
  db.exec(`
    CREATE TABLE tfa_login_attempts (
      token_hash      TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT
    )
  `);
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const insert = (hash, at) => db
  .prepare('INSERT INTO tfa_login_attempts (token_hash, user_id, attempts, last_attempt_at) VALUES (?, ?, 1, ?)')
  .run(hash, 'u1', at);

const stamps = () => db
  .prepare('SELECT token_hash, last_attempt_at FROM tfa_login_attempts ORDER BY token_hash')
  .all();

describe('migration 056', () => {
  it('rewrites a SQLite-format timestamp as ISO-8601', () => {
    insert('a', '2026-08-16 17:53:04');
    migration.up(db);
    expect(stamps()[0].last_attempt_at).toBe('2026-08-16T17:53:04.000Z');
  });

  /**
   * The defect itself, expressed as the comparison the rate limiter makes.
   *
   * A failure recorded thirty seconds ago is unambiguously inside a
   * fifteen-minute window. In the old format it is not seen at all, because the
   * space at position 10 sorts below the cutoff's `T`.
   */
  it('makes a recent attempt visible to the window again', () => {
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
    insert('recent', thirtySecondsAgo.toISOString().replace('T', ' ').slice(0, 19));

    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const counted = () => db
      .prepare('SELECT COUNT(*) AS n FROM tfa_login_attempts WHERE last_attempt_at > ?')
      .get(cutoff).n;

    expect(counted(), 'the defect: a 30-second-old attempt is invisible to a 15-minute window').toBe(0);
    migration.up(db);
    expect(counted(), 'after conversion the attempt counts, and the limiter holds').toBe(1);
  });

  /**
   * The other direction, which is safe either way and is asserted so that the
   * fix is not mistaken for something broader: a genuinely old attempt is
   * excluded before and after, because the DATE digits differ long before
   * position 10 is reached.
   */
  it('still excludes an attempt from last year', () => {
    insert('ancient', '2025-01-01 00:00:00');
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const counted = () => db
      .prepare('SELECT COUNT(*) AS n FROM tfa_login_attempts WHERE last_attempt_at > ?')
      .get(cutoff).n;

    expect(counted()).toBe(0);
    migration.up(db);
    expect(counted()).toBe(0);
  });

  it('leaves a live attempt inside the window', () => {
    const recent = new Date(Date.now() - 60 * 1000);
    /* Written in the old format, the way the pre-migration route wrote it. */
    insert('fresh', recent.toISOString().replace('T', ' ').slice(0, 19));
    migration.up(db);

    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const n = db.prepare('SELECT COUNT(*) AS n FROM tfa_login_attempts WHERE last_attempt_at > ?')
      .get(cutoff).n;
    expect(n, 'an in-progress rate limit was reset by the upgrade — a free retry mid-attack').toBe(1);
  });

  /**
   * Idempotence, and the specific corruption a second pass would cause:
   * `datetime()` given an ISO-8601 string drops the milliseconds, so an
   * already-converted `…:04.120Z` would come back as `…:04.000Z`.
   */
  it('does not touch a row that is already ISO-8601', () => {
    insert('done', '2026-08-16T17:53:04.120Z');
    migration.up(db);
    migration.up(db);
    expect(stamps()[0].last_attempt_at).toBe('2026-08-16T17:53:04.120Z');
  });

  it('converts a mixed table completely, and only once', () => {
    insert('old', '2026-08-16 17:53:04');
    insert('new', '2026-08-16T18:00:00.500Z');
    migration.up(db);
    migration.up(db);

    expect(stamps()).toEqual([
      { token_hash: 'new', last_attempt_at: '2026-08-16T18:00:00.500Z' },
      { token_hash: 'old', last_attempt_at: '2026-08-16T17:53:04.000Z' },
    ]);
  });

  it('leaves a NULL alone rather than inventing a time', () => {
    insert('null', null);
    migration.up(db);
    expect(stamps()[0].last_attempt_at).toBeNull();
  });

  /**
   * A database old enough to lack the table at all — anything before migration
   * 025 — must boot, not crash. The table is created in the new format when 025
   * runs, so there is nothing here to convert.
   */
  it('is a no-op when the table does not exist', () => {
    db.exec('DROP TABLE tfa_login_attempts');
    expect(() => migration.up(db)).not.toThrow();
  });
});
