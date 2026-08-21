/**
 * Auto Select scheduler.
 *
 * ── The operational failure this closes ──
 *
 * Auto Select required an organizer to press two buttons after the deadline: draw,
 * then confirm. If they forgot, every applicant stayed `pending` forever. The
 * organizer received one `DECISION_NEEDED` notification, deduped on
 * `awaiting-decision:<eventId>`, so if they missed it they were never told again.
 * Students experience that as being ignored, and there is no recovery path except a
 * human noticing.
 *
 * ── The design, and what it deliberately does NOT change ──
 *
 * The scheduler is a SAFETY NET, not a replacement for the organizer:
 *
 *   • It waits a grace period after the deadline (`AUTO_SELECT_GRACE_HOURS`,
 *     default 24) so an organizer who intends to review the draw still has a full
 *     day to do it themselves. Running the instant the deadline passes would take
 *     that away.
 *   • It reuses `computeDraw` and `applyRun` — the same functions the manual routes
 *     call, with the same seed formula and the same weighting — so fairness is
 *     literally the same code, not a parallel implementation that can drift.
 *   • If the organizer already drew but never confirmed, the scheduler confirms
 *     THEIR draw rather than drawing again. That is the result they generated and
 *     possibly already looked at; replacing it would be the scheduler overriding a
 *     human decision.
 *   • It tells the organizer it ran, so an automatic selection is never silent.
 *
 * ── Idempotency ──
 *
 * The durable guard is `auto_select_runs.is_confirmed = 1`, which the manual route
 * already treats as terminal. Once a run is confirmed, no further automatic draw is
 * possible for that event — which is what makes this restart-safe without any extra
 * bookkeeping: the state lives in the database, not in the process.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let dir;

/**
 * `enabled` has to be passed here rather than set after the fact.
 *
 * autoSelectScheduler.js reads `AUTO_SELECT_SCHEDULER` and the grace period once, at
 * import — the same convention config.js and db.js follow, and the reason
 * vitest.config.js pins `isolate: true`. Setting the variable after importing has no
 * effect, which is what made the first version of the off-switch test fail against
 * correct code.
 */
async function fresh({ graceHours, enabled } = {}) {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-autosched-'));
  process.env.WEV_DB_PATH = path.join(dir, 'sched.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  process.env.APP_URL = 'http://localhost:5173';
  if (graceHours !== undefined) process.env.AUTO_SELECT_GRACE_HOURS = String(graceHours);
  else delete process.env.AUTO_SELECT_GRACE_HOURS;
  if (enabled === false) process.env.AUTO_SELECT_SCHEDULER = 'false';
  else delete process.env.AUTO_SELECT_SCHEDULER;
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  const sched = await import('./services/autoSelectScheduler.js');
  const autoSelect = await import('./services/autoSelect.js');
  return { db: dbMod.db, sched, autoSelect };
}

const HOUR = 3600_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

/**
 * An Auto Select event whose deadline passed `deadlineHoursAgo` hours ago, with
 * `applicants` pending applications on one slot of `maxSpots` capacity.
 */
async function seedEvent(db, {
  id = 'ev-auto',
  maxSpots = 2,
  applicants = 5,
  deadlineHoursAgo = 48,
  autoApprove = 1,
  status = 'open'
} = {}) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO users (id, username, email, password_hash, name, grade, role, verified, email_verified, created_at)
    VALUES (?, ?, ?, 'x', 'Org', 'Adult', 'organizer', 1, 1, ?)
  `).run(`${id}-org`, `${id}-org`, `${id}-org@example.org`, now);

  await db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, status, auto_approve, created_at)
    VALUES (?, ?, 'd', 'School', 'L', ?, ?, ?, ?, ?)
  `).run(id, `Event ${id}`, iso(-deadlineHoursAgo * HOUR), `${id}-org`, status, autoApprove, now);

  const slotId = `${id}-slot`;
  await db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, 'Shift', 'd', ?, ?, ?)
  `).run(slotId, id, iso(10 * 24 * HOUR), iso(10 * 24 * HOUR + 2 * HOUR), maxSpots);

  for (let i = 0; i < applicants; i++) {
    const uid = `${id}-u${i}`;
    await db.prepare(`
      INSERT INTO users (id, username, email, password_hash, name, grade, role, verified, email_verified, created_at)
      VALUES (?, ?, ?, 'x', ?, '10', 'student', 1, 1, ?)
    `).run(uid, uid, `${uid}@example.org`, `Student ${i}`, now);
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(`${id}-a${i}`, uid, id, slotId, now);
  }
  return { eventId: id, slotId };
}

const statuses = async (db, eventId) => (await db.prepare(
  'SELECT status, COUNT(*) AS c FROM applications WHERE event_id = ? GROUP BY status'
).all(eventId)).reduce((a, r) => { a[r.status] = r.c; return a; }, {});

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.AUTO_SELECT_GRACE_HOURS;
  delete process.env.AUTO_SELECT_SCHEDULER;
  vi.restoreAllMocks();
});

describe('selecting which events are due', () => {
  it('picks an Auto Select event whose deadline passed beyond the grace period', async () => {
    const { db, sched } = await fresh({ graceHours: 24 });
    await seedEvent(db, { id: 'ev-due', deadlineHoursAgo: 48 });

    expect((await sched.findDueEvents(db)).map(e => e.id)).toContain('ev-due');
  });

  it('leaves an event alone while it is still inside the grace period', async () => {
    const { db, sched } = await fresh({ graceHours: 24 });
    await seedEvent(db, { id: 'ev-fresh', deadlineHoursAgo: 2 });

    // The organizer gets a full day to run the draw themselves before the safety
    // net fires. Running immediately would remove their chance to review.
    expect((await sched.findDueEvents(db)).map(e => e.id)).not.toContain('ev-fresh');
  });

  it('ignores events whose deadline has not passed at all', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-open', deadlineHoursAgo: -48 });

    // A draw before the deadline excludes students who may still apply.
    expect((await sched.findDueEvents(db)).map(e => e.id)).not.toContain('ev-open');
  });

  it('ignores events that are not Auto Select', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-manual', autoApprove: 0 });

    expect((await sched.findDueEvents(db)).map(e => e.id)).not.toContain('ev-manual');
  });

  it('ignores cancelled and completed events', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-cancelled', status: 'cancelled' });
    await seedEvent(db, { id: 'ev-completed', status: 'completed' });

    const due = (await sched.findDueEvents(db)).map(e => e.id);
    expect(due).not.toContain('ev-cancelled');
    expect(due).not.toContain('ev-completed');
  });

  it('ignores an event with no pending applications', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-empty', applicants: 0 });

    // Nothing to decide; running would create a confirmed run for no reason and
    // close the event out from under the organizer.
    expect((await sched.findDueEvents(db)).map(e => e.id)).not.toContain('ev-empty');
  });

  it('ignores an event whose selection is already confirmed', async () => {
    const { db, sched, autoSelect } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-done' });

    await autoSelect.runAndConfirm(db, 'ev-done', { source: 'scheduler' });

    // The durable idempotency guard. This is also what makes the scheduler
    // restart-safe: the state is a row, not a process variable.
    expect((await sched.findDueEvents(db)).map(e => e.id)).not.toContain('ev-done');
  });
});

describe('running the scheduler', () => {
  it('selects volunteers and applies the result', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-run', maxSpots: 2, applicants: 5 });

    const result = await sched.runAutoSelectSweep(db);

    expect(result.executed).toBe(1);
    const s = await statuses(db, 'ev-run');
    expect(s.accepted).toBe(2);
    expect(s.waitlisted).toBe(3);
    expect(s.pending).toBeUndefined();
  });

  it('marks the run confirmed so it is terminal', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-confirm' });

    await sched.runAutoSelectSweep(db);

    const run = await db.prepare('SELECT * FROM auto_select_runs WHERE event_id = ?').get('ev-confirm');
    expect(run.is_confirmed).toBe(1);
    expect(run.run_number).toBe(1);
  });

  it('records that the scheduler, not a human, made the selection', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-attrib' });

    await sched.runAutoSelectSweep(db);

    // A district asking "who chose these volunteers" must be able to tell an
    // automatic draw from an organizer's.
    const summary = JSON.parse((await db.prepare('SELECT selection_summary FROM events WHERE id = ?').get('ev-attrib')).selection_summary);
    expect(summary.executedBy).toBe('scheduler');
  });

  it('notifies the organizer that it ran automatically', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-notify' });

    await sched.runAutoSelectSweep(db);

    const notes = await db.prepare('SELECT * FROM notifications WHERE user_id = ?').all('ev-notify-org');
    expect(notes.length, 'the organizer was not told the draw ran without them').toBeGreaterThan(0);
  });

  it('notifies the selected and waitlisted students', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-students', maxSpots: 1, applicants: 3 });

    await sched.runAutoSelectSweep(db);

    const notified = (await db.prepare(`
      SELECT COUNT(DISTINCT user_id) AS c FROM notifications
      WHERE user_id LIKE 'ev-students-u%'
    `).get()).c;
    expect(notified).toBe(3);
  });
});

describe('idempotency and double-execution', () => {
  it('a second sweep does nothing', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-twice', maxSpots: 2, applicants: 5 });

    expect((await sched.runAutoSelectSweep(db)).executed).toBe(1);
    const after1 = await statuses(db, 'ev-twice');

    expect((await sched.runAutoSelectSweep(db)).executed).toBe(0);
    expect(await statuses(db, 'ev-twice')).toEqual(after1);

    // Exactly one run row, ever.
    expect((await db.prepare('SELECT COUNT(*) AS c FROM auto_select_runs WHERE event_id = ?').get('ev-twice')).c).toBe(1);
  });

  it('does not duplicate notifications on a second sweep', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-nodup', maxSpots: 1, applicants: 3 });

    await sched.runAutoSelectSweep(db);
    const before = (await db.prepare('SELECT COUNT(*) AS c FROM notifications').get()).c;
    await sched.runAutoSelectSweep(db);
    const after = (await db.prepare('SELECT COUNT(*) AS c FROM notifications').get()).c;

    expect(after).toBe(before);
  });

  it('never reselects an already-accepted volunteer or exceeds capacity', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    const { slotId } = await seedEvent(db, { id: 'ev-partial', maxSpots: 3, applicants: 4 });

    // The organizer already hand-accepted one applicant before the deadline.
    await db.prepare("UPDATE applications SET status = 'accepted' WHERE id = ?").run('ev-partial-a0');

    await sched.runAutoSelectSweep(db);

    const s = await statuses(db, 'ev-partial');
    // 3 spots, one already taken -> exactly 2 more accepted, never 3.
    expect(s.accepted).toBe(3);
    expect(s.waitlisted).toBe(1);

    const accepted = (await db.prepare(
      "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
    ).get(slotId)).c;
    const max = (await db.prepare('SELECT max_spots FROM slots WHERE id = ?').get(slotId)).max_spots;
    expect(accepted).toBeLessThanOrEqual(max);
  });

  it('confirms the organizer\'s existing draft rather than drawing again', async () => {
    const { db, sched, autoSelect } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-draft', maxSpots: 2, applicants: 5 });

    // The organizer drew but never pressed confirm.
    const draft = await autoSelect.computeDraw(db, 'ev-draft', { runNumber: 1 });
    await autoSelect.recordRun(db, 'ev-draft', draft, { runNumber: 1, reason: null });
    const draftSelected = JSON.parse(
      (await db.prepare('SELECT selected_ids FROM auto_select_runs WHERE event_id = ?').get('ev-draft')).selected_ids
    );

    await sched.runAutoSelectSweep(db);

    // Their draw is what gets applied — the scheduler must not override a human's
    // result with a fresh one they never saw.
    const runs = await db.prepare('SELECT * FROM auto_select_runs WHERE event_id = ?').all('ev-draft');
    expect(runs).toHaveLength(1);
    expect(runs[0].is_confirmed).toBe(1);

    const acceptedIds = (await db.prepare(
      "SELECT id FROM applications WHERE event_id = ? AND status = 'accepted' ORDER BY id"
    ).all('ev-draft')).map(r => r.id);
    expect(acceptedIds).toEqual([...draftSelected].sort());
  });

  it('overlapping sweeps cannot both execute', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-overlap', maxSpots: 2, applicants: 5 });

    // Re-entrancy: a slow sweep still running when the next interval fires.
    /* Both started before either is awaited — `sweepInFlight` is set before the
       first await, so the second must still report `skipped`. */
    const results = await Promise.all([sched.runAutoSelectSweep(db), sched.runAutoSelectSweep(db)]);
    const total = results.reduce((n, r) => n + r.executed, 0);

    expect(total, 'the same event was drawn twice').toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM auto_select_runs').get()).c).toBe(1);
  });
});

describe('fairness is unchanged', () => {
  it('produces the same selection as the manual route for the same run number', async () => {
    const { db, autoSelect } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-fair', maxSpots: 2, applicants: 6 });

    // The seed is `${eventId}:${slotId}:run-${runNumber}`, so a draw is
    // deterministic for a given event/slot/run. Two computations of run 1 must
    // agree — that is what guarantees the scheduler cannot draw "differently"
    // from the organizer.
    const a = await autoSelect.computeDraw(db, 'ev-fair', { runNumber: 1 });
    const b = await autoSelect.computeDraw(db, 'ev-fair', { runNumber: 1 });

    expect(a.selectedIds).toEqual(b.selectedIds);
    expect(a.waitlistIds).toEqual(b.waitlistIds);
    expect(a.selectedIds).toHaveLength(2);
  });
});

describe('resilience', () => {
  it('one failing event does not stop the others', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-ok1', maxSpots: 1, applicants: 2 });
    await seedEvent(db, { id: 'ev-ok2', maxSpots: 1, applicants: 2 });

    // Force the first event processed to throw, whichever it is.
    /**
     * Poisoned on the DRIVER, not on the `db` handle.
     *
     * `applyRun` became async in wave 6, and its transaction now runs on its own
     * connection — PostgreSQL pins a pooled client, SQLite opens a second
     * connection to the same file. A spy on `db.prepare` therefore never sees
     * the statement any more, and this test silently stopped simulating any
     * failure at all: it reported 0 failures and passed nothing.
     *
     * Spying on `DatabaseSync.prototype` catches whichever connection issues it,
     * which is both what this test meant all along and less coupled to the
     * implementation than the handle-level spy was.
     */
    const realPrepare = DatabaseSync.prototype.prepare;
    let poisoned = false;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (sql) {
      if (!poisoned && /UPDATE auto_select_runs SET is_confirmed/.test(sql)) {
        poisoned = true;
        throw new Error('simulated failure');
      }
      return realPrepare.call(this, sql);
    });

    const result = await sched.runAutoSelectSweep(db);
    vi.restoreAllMocks();

    expect(result.failed).toBe(1);
    expect(result.executed, 'a failure on one event aborted the whole sweep').toBe(1);
  });

  it('the sweep never throws, so the interval cannot kill the process', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-throw' });

    vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('database is locked'); });
    /* Now a promise: a rejection fails the test just as a throw did. */
    await sched.runAutoSelectSweep(db);
  });

  it('a failed event is retried on the next sweep', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-retry', maxSpots: 1, applicants: 2 });

    /**
     * Poisoned on the DRIVER, not on the `db` handle.
     *
     * `applyRun` became async in wave 6, and its transaction now runs on its own
     * connection — PostgreSQL pins a pooled client, SQLite opens a second
     * connection to the same file. A spy on `db.prepare` therefore never sees
     * the statement any more, and this test silently stopped simulating any
     * failure at all: it reported 0 failures and passed nothing.
     *
     * Spying on `DatabaseSync.prototype` catches whichever connection issues it,
     * which is both what this test meant all along and less coupled to the
     * implementation than the handle-level spy was.
     */
    const realPrepare = DatabaseSync.prototype.prepare;
    let fail = true;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (sql) {
      if (fail && /UPDATE auto_select_runs SET is_confirmed/.test(sql)) throw new Error('transient');
      return realPrepare.call(this, sql);
    });
    await sched.runAutoSelectSweep(db);
    expect((await statuses(db, 'ev-retry')).pending).toBe(2);

    fail = false;
    const second = await sched.runAutoSelectSweep(db);
    vi.restoreAllMocks();

    // No dead-lettering: the guard is "is there a confirmed run", so a failure
    // leaves the event due and it simply runs again 15 minutes later.
    expect(second.executed).toBe(1);
    expect((await statuses(db, 'ev-retry')).accepted).toBe(1);
  });
});

describe('the scheduler can be turned off', () => {
  it('respects AUTO_SELECT_SCHEDULER=false', async () => {
    const { db, sched } = await fresh({ graceHours: 0, enabled: false });
    await seedEvent(db, { id: 'ev-off' });

    const started = sched.startAutoSelectScheduler(db);
    expect(started).toBeNull();
    sched.stopAutoSelectScheduler();

    // A district that wants selection to stay entirely manual must be able to say so.
    expect((await statuses(db, 'ev-off')).pending).toBe(5);
  });

  it('starts and stops cleanly', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    const timer = sched.startAutoSelectScheduler(db);
    expect(timer).not.toBeNull();
    expect(sched.startAutoSelectScheduler(db)).toBe(timer); // idempotent
    sched.stopAutoSelectScheduler();
  });

  it('runs a catch-up sweep at startup', async () => {
    const { db, sched } = await fresh({ graceHours: 0 });
    await seedEvent(db, { id: 'ev-startup', maxSpots: 1, applicants: 2 });

    // Startup recovery: a draw that came due while the process was down must not
    // wait a further 15 minutes.
    /* The catch-up sweep became async with `applyRun`. It is deliberately not
       awaited at boot — the server must not block on it — so the test awaits the
       handle the scheduler exposes rather than racing it. */
    const timer = sched.startAutoSelectScheduler(db);
    await timer.startupSweep;
    sched.stopAutoSelectScheduler();

    expect((await statuses(db, 'ev-startup')).accepted).toBe(1);
  });
});
