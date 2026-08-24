import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The draw weighs the same hours the student's profile shows.
 *
 * ── The defect ──
 *
 * `creditedHoursFor` — the canonical definition, used by the profile, the
 * leaderboard and every total in the product — joins `events` and excludes
 * `status = 'cancelled'`. The Auto Select draw's own query did not join `events`
 * at all:
 *
 *     LEFT JOIN attendance att ON att.user_id = a.user_id AND att.present = 1
 *
 * So hours from a cancelled event counted in the draw and nowhere else. Two
 * numbers, both called credited hours, disagreeing.
 *
 * ── Why the direction is the point ──
 *
 * The weight curve rewards FEWER hours: `1.5 + 8.5 / (1 + 0.005h)` falls as
 * hours rise. Phantom hours therefore made a student LESS likely to be drawn —
 * so the bug quietly penalised somebody because an organizer cancelled an event
 * they had already turned up to. That is the worst available direction for it,
 * and it is invisible: the student sees the correct total on their profile and
 * has no way to know the draw used a different one.
 *
 * ── Why this is a correctness fix and not a tuning change ──
 *
 * The Volunteer Record Policy publishes the formula and says the input is
 * "total credited hours". `creditedHoursFor` is what credited hours means. The
 * same document already states the principle for the neighbouring term —
 * "neither is an event that was cancelled" — so the draw was disagreeing with
 * published policy rather than implementing a different intent.
 *
 * CHANGELOG.md records the precedent for exactly this shape: the hours weighting
 * was inert from launch because of a `total_hours` / `totalHours` alias
 * mismatch, and no test caught it because none asserted that the draw's numbers
 * were the right numbers. This is that lesson applied to the other end of the
 * same query.
 */

let db;
let computeDraw;
let creditedHoursFor;
let dir;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-cancelled-hours-'));
  process.env.WEV_DB_PATH = path.join(dir, 'draw.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  delete process.env.NODE_ENV;

  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  db = dbMod.db;

  ({ computeDraw } = await import('./services/autoSelect.js'));
  ({ creditedHoursFor } = await import('./volunteerStats.js'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.WEV_DB_PATH;
});

const iso = (daysFromNow) => new Date(Date.now() + daysFromNow * 864e5).toISOString();

async function student(id) {
  await db.prepare(`
    INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
    VALUES (?, ?, ?, 'x', ?, '11', 'student', ?)
  `).run(id, id, `${id}@example.org`, `Student ${id}`, iso(-400));
}

/**
 * An event with one slot, and an attendance row crediting `hours` to `userId`.
 * `status` is the EVENT's status, which is the whole subject here.
 */
async function historyEvent(id, userId, hours, status) {
  await db.prepare(`
    INSERT INTO events (id, title, description, category, location, organizer_id,
                        application_deadline, status, created_at)
    VALUES (?, ?, 'd', 'Other', 'Hall', ?, ?, ?, ?)
  `).run(id, `History ${id}`, userId, iso(-40), status, iso(-60));
  await db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, 'Shift', 'd', ?, ?, 5)
  `).run(`${id}-slot`, id, iso(-30), iso(-30));
  await db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, 1, ?)
  `).run(id, `${id}-slot`, userId, hours);
}

/** An open event with one slot of one spot, and every `userIds` entry pending. */
async function drawableEvent(id, userIds) {
  await db.prepare(`
    INSERT INTO events (id, title, description, category, location, organizer_id,
                        application_deadline, status, auto_approve, created_at)
    VALUES (?, 'Draw', 'd', 'Other', 'Hall', 'org-1', ?, 'open', 1, ?)
  `).run(id, iso(-1), iso(-10));
  await db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, 'Shift', 'd', ?, ?, 1)
  `).run(`${id}-slot`, id, iso(5), iso(5));
  for (const userId of userIds) {
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(`${id}-app-${userId}`, userId, id, `${id}-slot`, iso(-2));
  }
}

describe('hours from a cancelled event do not reach the draw', () => {
  beforeAll(async () => {
    await db.prepare(`
      INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
      VALUES ('org-1', 'org1', 'org1@example.org', 'x', 'Org One', 'Adult', 'organizer', ?)
    `).run(iso(-400));

    await student('stu-clean');
    await student('stu-cancelled');
    /* Identical CREDITED history — none — but one of them turned up to a
       thousand hours' worth of an event that was later cancelled. */
    await historyEvent('ev-gone', 'stu-cancelled', 1000, 'cancelled');
  });

  it('the profile excludes them, which is the definition the draw has to match', async () => {
    expect(await creditedHoursFor(db, 'stu-cancelled')).toBe(0);
    expect(await creditedHoursFor(db, 'stu-clean')).toBe(0);
  });

  it('weighs the two applicants as equals, because they have equal credited hours', async () => {
    /**
     * A lottery, so this is a rate rather than an outcome — the same shape as
     * the 200-run case in `capacity.baseline.test.js`, and for the same reason.
     *
     * Both applicants have zero credited hours, so a correct draw gives each
     * weight 10.0 and each wins about half the time. If cancelled hours leak,
     * `stu-cancelled` is weighed at 1000 hours — weight 2.92 — and wins about
     * 23% instead. The bound below sits between those two, well clear of both.
     */
    const RUNS = 200;
    let cancelledWins = 0;

    for (let i = 0; i < RUNS; i++) {
      await db.prepare('DELETE FROM applications').run();
      await db.prepare('DELETE FROM slots WHERE event_id = ?').run('ev-draw');
      await db.prepare('DELETE FROM events WHERE id = ?').run('ev-draw');
      await drawableEvent('ev-draw', ['stu-clean', 'stu-cancelled']);

      const { selectedIds } = await computeDraw(db, 'ev-draw', { runNumber: i + 1 });
      expect(selectedIds, 'exactly one spot').toHaveLength(1);
      if (selectedIds[0] === 'ev-draw-app-stu-cancelled') cancelledWins++;
    }

    const rate = ((cancelledWins / RUNS) * 100).toFixed(1);
    expect(
      cancelledWins,
      `the applicant whose only history is a CANCELLED event won ${cancelledWins}/${RUNS} `
      + `(${rate}%). Equal credited hours should give ~50%; ~23% means the draw counted `
      + 'hours the student\'s own profile does not show, and penalised them for an event '
      + 'somebody else cancelled',
    ).toBeGreaterThan(70);
  });
});

describe('every hours aggregation in the selection paths uses credited hours', () => {
  /**
   * The deterministic half, and the one that covers all four sites.
   *
   * Four separate queries summed `attendance.hours_awarded` — the draw's
   * weighting query, the two selection-summary queries, and the Equalizer's.
   * None joined `events`, so all four disagreed with `creditedHoursFor`. A
   * behavioural test reaches one of them at a time; this reaches every one, and
   * fails on a fifth copy written next month.
   */
  it('has no attendance sum that omits the cancelled-event exclusion', async () => {
    const { readFileSync } = await import('node:fs');
    const files = [
      'server/services/autoSelect.js',
      'server/routes/eventRoutes.js',
    ];

    const offenders = [];
    for (const rel of files) {
      const source = readFileSync(path.join(process.cwd(), rel), 'utf8');
      /* Each SQL statement that sums awarded hours, with the surrounding query
         text it belongs to. A statement mentioning the sum must also mention the
         exclusion. */
      const statements = source.split(/`/).filter(chunk => /SUM\(\s*a?t?t?\.?hours_awarded/.test(chunk));
      for (const statement of statements) {
        if (!/status\s*<>\s*'cancelled'/.test(statement)) {
          offenders.push(`${rel}: ${statement.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
        }
      }
    }

    expect(
      offenders,
      'These sum awarded hours without excluding cancelled events, so they disagree '
      + "with creditedHoursFor and with the formula published in the Volunteer Record "
      + 'Policy. Use the correlated-subquery form already in autoSelect.js.'
    ).toEqual([]);
  });
});
