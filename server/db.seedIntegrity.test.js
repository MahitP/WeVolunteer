import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { VALID_CATEGORIES } from './eventCategories.js';

/**
 * The demo seed, held to the same rules an organizer is held to.
 *
 * ── The bug ──
 *
 * `event-softball` — the seed's flagship event, and the one every demo and every
 * manual test opens first — was inserted with
 * `application_deadline = now + 30 days` and shifts at `now + 12 days`. So the
 * event details panel read:
 *
 *     When              Tue, 18 Aug, 1:00 PM – 7:00 PM
 *     Applications close Sat, 5 Sep, 12:27 PM
 *
 * Applications closing eighteen days after the shift was worked. It looks like a
 * date-handling bug and is not one: `validateEventPayload` has refused
 * `deadline > first shift start` since it was written, and `POST /api/events`
 * and `PUT /api/events/:id` both call it. Seeding is the one writer that does
 * not — it INSERTs straight into the table — so it was the one path that could
 * produce a row the validator would have rejected.
 *
 * ── Why this file rather than another case in validation.test.js ──
 *
 * Because the validator was never wrong. What was missing is any check that the
 * data this repository ships obeys the validator, and a comment in
 * `contentRoutes.js` already names that gap out loud: "seeded and migrated rows
 * do not go through that validator". This is the assertion that closes it, and
 * it is written against the rules rather than against `event-softball`, so it
 * covers every event the seed grows later.
 */
describe('the demo seed', () => {
  let dir, dbFile, db;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wev-seedcheck-'));
    dbFile = path.join(dir, 'demo.db');
    /**
     * A child process, matching `routes.seeding.test.js`. `db.js` is a module
     * with connection state and reads its path at import time, so seeding a
     * throwaway database from inside a worker that has already imported it —
     * or that another test file will import — is not something to attempt.
     */
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.WEV_DB_PATH = ${JSON.stringify(dbFile)};
      process.env.JWT_SECRET = 'test';
      process.env.DEMO_MODE = 'true';
      const { initDatabase, completeDatabaseInit } = await import('${process.cwd().replace(/\\/g, '/')}/server/db.js');
      initDatabase();
      await completeDatabaseInit();
    `], { cwd: process.cwd(), stdio: 'pipe' });
    db = new DatabaseSync(dbFile);
  });

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('produced events at all, so the assertions below are about something', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBeGreaterThan(0);
  });

  /** THE regression. Every seeded event, not just the one that was wrong. */
  it('closes applications no later than the first shift of the event starts', () => {
    const rows = db.prepare(`
      SELECT e.id, e.title, e.application_deadline AS deadline,
             MIN(s.start_datetime) AS first_start
        FROM events e
        JOIN slots s ON s.event_id = e.id
    GROUP BY e.id
    `).all();

    expect(rows.length).toBeGreaterThan(0);
    const inverted = rows.filter(r => Date.parse(r.deadline) > Date.parse(r.first_start));
    expect(
      inverted.map(r => `${r.title}: closes ${r.deadline}, first shift ${r.first_start}`),
      'a seeded event closes applications after its own first shift'
    ).toEqual([]);
  });

  it('gives every seeded event a deadline and a shift that parse as real dates', () => {
    const rows = db.prepare(`
      SELECT e.id, e.application_deadline AS deadline, s.start_datetime AS start, s.end_datetime AS end
        FROM events e JOIN slots s ON s.event_id = e.id
    `).all();
    for (const r of rows) {
      expect(Number.isNaN(Date.parse(r.deadline)), `${r.id} deadline`).toBe(false);
      expect(Number.isNaN(Date.parse(r.start)), `${r.id} slot start`).toBe(false);
      expect(Number.isNaN(Date.parse(r.end)), `${r.id} slot end`).toBe(false);
      expect(Date.parse(r.end), `${r.id} slot ends after it starts`).toBeGreaterThan(Date.parse(r.start));
    }
  });

  /**
   * The seed writes `category` directly, so it bypasses the route's
   * `VALID_CATEGORIES` check exactly as it bypassed the deadline rule. The CHECK
   * constraint would catch a bad value at boot — but as a constraint violation
   * during seeding, which surfaces as a stack trace rather than as a sentence.
   */
  it('files every seeded event under a category the platform admits', () => {
    const used = db.prepare('SELECT DISTINCT category FROM events').all().map(r => r.category);
    expect(used.length).toBeGreaterThan(0);
    for (const category of used) expect(VALID_CATEGORIES).toContain(category);
  });

  /**
   * An open event with no future shift is the state `contentRoutes.js`
   * documents as having kept worked-out events on the Opportunities page. The
   * seed exists to make the product demonstrable, and a demo whose only open
   * event is in the past demonstrates the opposite.
   */
  it('leaves at least one open event a student could still apply to', () => {
    const now = new Date().toISOString();
    const applyable = db.prepare(`
      SELECT COUNT(*) c FROM events e
       WHERE e.status = 'open'
         AND e.application_deadline > ?
         AND EXISTS (SELECT 1 FROM slots s WHERE s.event_id = e.id AND s.start_datetime > ?)
    `).get(now, now).c;
    expect(applyable).toBeGreaterThan(0);
  });
});
