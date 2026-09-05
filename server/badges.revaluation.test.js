import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/**
 * Badges must be re-evaluated when a record gets WORSE, not only when it gets
 * better.
 *
 * ── The gap this exists to close ──
 *
 * `evaluateBadges` was called in exactly one place: the loop over volunteers
 * being CREDITED hours. `finalizeAttendance` returns two lists — `credited` and
 * `revoked` — and the revoked loop dispatched a notification and moved on.
 *
 * So the single event that should ever REMOVE a badge was the one path that did
 * not check. Marking somebody absent changes the denominator their reliability
 * is computed from, and taking hours back can drop them below an hour tier —
 * and neither recomputed anything. `evaluateBadges` has always known how to
 * withdraw an automatically-awarded badge; it was simply never asked.
 *
 * That mattered little when every badge was monotonic. It matters now: the
 * reliability badge is designed to be lost and regained, and a credential that
 * can only ever be granted is not a status indicator, it is a trophy.
 */

/**
 * `db.js` opens its connection at IMPORT time, not on first use.
 *
 * This file imports it only to replace the `db` export with the in-memory
 * schema below — but the import has already run `openConnection()` by then, and
 * with `WEV_DB_PATH` unset that resolves to `server/wevolunteer.db`, a real file
 * shared by every worker in the pool. Alone that is invisible. Under a full-suite
 * run several workers open it at once and collide on the WAL/PRAGMA setup, which
 * surfaces here as an intermittent `Error: database is locked` in a test that
 * passes every time it is run on its own.
 *
 * Set before the dynamic import in `beforeAll`, and at module scope rather than
 * inside it, so a later static import of anything reaching `db.js` cannot get in
 * first. `:memory:` is a SQLite locator that `db.js` passes through unresolved —
 * see the `isSqliteLocator` guard there — so nothing is written to disk and the
 * connection is private to this worker.
 */
process.env.WEV_DB_PATH = ':memory:';

let db;
let badgeService;
let reliability;

/* An isolated schema — these tests write attendance directly and must never be
   able to reach a real database. */
function makeDb() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, organizer_id TEXT, status TEXT DEFAULT 'open');
    CREATE TABLE slots (id TEXT PRIMARY KEY, event_id TEXT, start_datetime TEXT, end_datetime TEXT);
    CREATE TABLE applications (id TEXT PRIMARY KEY, user_id TEXT, event_id TEXT, slot_id TEXT, status TEXT, applied_at TEXT);
    CREATE TABLE attendance (event_id TEXT, slot_id TEXT, user_id TEXT, present INTEGER, hours_awarded REAL,
      PRIMARY KEY (slot_id, user_id));
    CREATE TABLE external_hours (id TEXT PRIMARY KEY, user_id TEXT, hours REAL, occurred_on TEXT);
    CREATE TABLE badges (id TEXT PRIMARY KEY, name TEXT, description TEXT, icon TEXT, category TEXT,
      criteria_type TEXT, criteria_value INTEGER, active INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE user_badges (id TEXT PRIMARY KEY, user_id TEXT, badge_id TEXT, earned_at TEXT, awarded_by TEXT,
      UNIQUE(user_id, badge_id));
    CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, priority TEXT, title TEXT,
      body TEXT, link TEXT, read INTEGER DEFAULT 0, created_at TEXT, dedupe_key TEXT);
    CREATE TABLE notification_preferences (user_id TEXT PRIMARY KEY, prefs TEXT);
  `);
  return database;
}

const PAST = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

let n = 0;

/** An accepted, completed commitment. `present: null` leaves it unconfirmed. */
function commitment(userId, { present = 1, hours = 3, daysAgo = 30 } = {}) {
  n += 1;
  const eventId = `ev${n}`;
  const slotId = `sl${n}`;
  const when = PAST(daysAgo);
  db.prepare('INSERT INTO events (id, organizer_id, status) VALUES (?, ?, ?)').run(eventId, 'org-1', 'open');
  db.prepare('INSERT INTO slots (id, event_id, start_datetime, end_datetime) VALUES (?, ?, ?, ?)')
    .run(slotId, eventId, when, when);
  db.prepare('INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`ap${n}`, userId, eventId, slotId, 'accepted', when);
  if (present !== null) {
    db.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, slotId, userId, present, present ? hours : 0);
  }
  return { eventId, slotId };
}

/** Flips an existing commitment to absent, the way finalisation revokes one. */
function markAbsent(slotId, userId) {
  db.prepare('UPDATE attendance SET present = 0, hours_awarded = 0 WHERE slot_id = ? AND user_id = ?')
    .run(slotId, userId);
}

const holds = (userId, badgeId) =>
  !!db.prepare('SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ?').get(userId, badgeId);

function seedBadge({ id, criteria_type, criteria_value }) {
  db.prepare(`
    INSERT INTO badges (id, name, description, icon, category, criteria_type, criteria_value, active, created_at)
    VALUES (?, ?, 'Fixture', '*', 'Fixture', ?, ?, 1, ?)
  `).run(id, id, criteria_type, criteria_value, new Date().toISOString());
  return id;
}

beforeAll(async () => {
  db = makeDb();
  /* The service reads the module-scope `db`, so it is stubbed before import. */
  const dbModule = await import('./db.js');
  Object.defineProperty(dbModule, 'db', { value: db, configurable: true });
  ({ badgeService } = await import('./services/badgeService.js'));
  reliability = await import('./reliability.js');
});

afterAll(() => { db?.close?.(); });

beforeEach(() => {
  for (const table of ['user_badges', 'badges', 'attendance', 'applications', 'slots', 'events', 'users', 'notifications']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').run('vol', 'Test Volunteer', PAST(400));
});

describe('a badge that can be lost', () => {
  it('is withdrawn once absences drop the volunteer below the threshold', async () => {
    const badge = seedBadge({ id: 'reliable', criteria_type: 'attendance_rate', criteria_value: 90 });

    const slots = [];
    for (let i = 0; i < 8; i += 1) slots.push(commitment('vol', { daysAgo: 60 - i }));

    await badgeService.evaluateBadges('vol');
    expect(holds('vol', badge), 'eight for eight should earn it').toBe(true);

    /* The four most recent commitments become absences — the shape of somebody
       who has stopped turning up. */
    for (const s of slots.slice(-4)) markAbsent(s.slotId, 'vol');

    await badgeService.evaluateBadges('vol');
    const after = await reliability.reliabilityOf(db, 'vol');
    expect(holds('vol', badge), `score=${after.score} recorded=${after.recorded}`).toBe(false);
  });

  it('is returned when the volunteer starts turning up again', async () => {
    /* Recovery is the other half. A badge that can be lost but not regained
       punishes a bad term for ever. */
    const badge = seedBadge({ id: 'reliable', criteria_type: 'attendance_rate', criteria_value: 90 });

    for (let i = 0; i < 6; i += 1) commitment('vol', { present: 0, daysAgo: 300 - i });
    await badgeService.evaluateBadges('vol');
    expect(holds('vol', badge)).toBe(false);

    for (let i = 0; i < 20; i += 1) commitment('vol', { present: 1, daysAgo: 100 - i * 4 });
    await badgeService.evaluateBadges('vol');

    const after = await reliability.reliabilityOf(db, 'vol');
    expect(holds('vol', badge), `score=${after.score}`).toBe(true);
  });

  it('is withdrawn when credited hours are taken back below a tier', async () => {
    const badge = seedBadge({ id: 'ten-hours', criteria_type: 'hours', criteria_value: 10 });

    const a = commitment('vol', { hours: 6, daysAgo: 30 });
    commitment('vol', { hours: 6, daysAgo: 20 });

    await badgeService.evaluateBadges('vol');
    expect(holds('vol', badge), 'twelve hours should earn a ten-hour tier').toBe(true);

    markAbsent(a.slotId, 'vol');
    await badgeService.evaluateBadges('vol');

    expect(holds('vol', badge), 'six hours no longer reaches ten').toBe(false);
  });

  it('never withdraws a badge an administrator granted by hand', async () => {
    /* The distinction `meetsCriteria` returns `null` for. A manual award is
       somebody's judgement and this sweep has no standing to overrule it. */
    const badge = seedBadge({ id: 'manual', criteria_type: 'manual', criteria_value: 0 });
    db.prepare('INSERT INTO user_badges (id, user_id, badge_id, earned_at, awarded_by) VALUES (?, ?, ?, ?, ?)')
      .run('ub-manual', 'vol', badge, new Date().toISOString(), 'admin-1');

    await badgeService.evaluateBadges('vol');

    expect(holds('vol', badge)).toBe(true);
  });

  it('leaves the attendance record itself untouched when it withdraws', async () => {
    /* Losing a badge is a change of status, not a change of history. */
    const badge = seedBadge({ id: 'reliable', criteria_type: 'attendance_rate', criteria_value: 90 });
    const slots = [];
    for (let i = 0; i < 8; i += 1) slots.push(commitment('vol', { daysAgo: 60 - i }));
    await badgeService.evaluateBadges('vol');

    for (const s of slots.slice(-4)) markAbsent(s.slotId, 'vol');
    await badgeService.evaluateBadges('vol');

    const rows = db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE user_id = ?').get('vol').c;
    expect(rows).toBe(8);
    expect(holds('vol', badge)).toBe(false);
  });
});
