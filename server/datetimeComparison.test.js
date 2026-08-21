/**
 * ISO timestamps must not be compared against SQLite's `datetime('now')`.
 *
 * ── The defect ──
 *
 * The application writes every timestamp with `new Date().toISOString()`, which
 * produces `2026-07-31T16:54:33.000Z`. SQLite's `datetime('now')` produces
 * `2026-07-31 17:55:37` — same calendar layout, but a SPACE at index 10 where ISO
 * has a `T`, and no fractional part or zone suffix.
 *
 * SQLite compares TEXT lexicographically. `'T'` is 0x54 and `' '` is 0x20, so for
 * any two timestamps landing on the SAME calendar date the ISO value always sorts
 * GREATER — whatever the actual clock times are. Measured:
 *
 *     shift EARLIER today (already over)   string: future   correct: past   ← wrong
 *     shift LATER today (still upcoming)   string: future   correct: future
 *     shift YESTERDAY                      string: past     correct: past
 *     shift TOMORROW                       string: future   correct: future
 *
 * So the comparison is right on every date except today, and wrong for the whole of
 * today — which is precisely the day a shift happens and the day a student looks at
 * their dashboard.
 *
 * ── Why it matters ──
 *
 * Four sites were affected:
 *
 *   userRoutes.js:64        "Upcoming confirmed shifts" on a volunteer profile
 *   contentRoutes.js:395    the `upcoming` count in GET /api/stats/volunteer
 *   accountRoutes.js:123    which organizers are told a spot was released on delete
 *   exportWorker.js:146     which completed data exports have expired
 *
 * The first two put visibly wrong information in front of students: a shift they
 * finished this morning is still listed as upcoming until midnight. The last one is
 * a retention issue — an export archive holding a student's complete personal record
 * (profile, messages, attendance, certificates) outlives its stated seven days by up
 * to a day, because the row is only swept once the date portion differs.
 *
 * Nothing is lost or mis-credited: the hours path compares in JavaScript with real
 * Date objects, so credited hours are unaffected.
 *
 * ── The fix ──
 *
 * Bind `new Date().toISOString()` instead of using `datetime('now')`, so both sides
 * are the same format. That is already the established pattern everywhere else —
 * `runNotificationSweep` passes `now.toISOString()` as a bind parameter — so this
 * makes the four outliers consistent rather than introducing a new convention.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { startTestServer } from './testServer.js';

const ROOT = process.cwd();

/** ISO string offset from now, exactly as the application writes timestamps. */
const isoFromNow = (ms) => new Date(Date.now() + ms).toISOString();

const HOUR = 3600_000;

describe('the raw comparison semantics', () => {
  it('demonstrates that lexicographic comparison misclassifies same-day timestamps', async () => {
    // Pinned as executable documentation of the root cause, so nobody has to
    // rediscover why binding an ISO string matters.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    
    // Explicit same-day strings demonstrate the separator bug without UTC rollover flakes
    const sqliteNow = '2026-07-31 20:00:00';
    const isoEarlier = '2026-07-31T16:00:00.000Z';

    const wrong = db.prepare("SELECT ? > ? AS isFuture").get(isoEarlier, sqliteNow).isFuture;
    
    const endedEarlierToday = isoFromNow(-4 * HOUR);
    const right = db.prepare("SELECT julianday(?) > julianday('now') AS isFuture").get(endedEarlierToday).isFuture;
    const bound = db.prepare('SELECT ? > ? AS "isFuture"').get(endedEarlierToday, new Date().toISOString()).isFuture;

    expect(wrong).toBe(1);  // the bug: a finished shift looks like a future one
    expect(right).toBe(0);
    expect(bound).toBe(0);  // the fix
    db.close();
  });
});

describe('a shift that ended earlier today is not reported as upcoming', () => {
  let srv, student;

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login('leo.chen@example.com');
  }, 60000);
  afterAll(async () => { await srv?.close(); });

  /**
   * Builds an accepted application on a shift that started and ended earlier today.
   *
   * Written straight to the database rather than through the API because the API
   * (correctly) refuses to create an event whose deadline is in the past — the
   * scenario under test is one that arises from the passage of time, not from a
   * request.
   */
  async function acceptedShiftEndedEarlierToday(userId) {
    const { db } = await import('./db.js');
    const now = new Date();
    const eventId = `event-dt-${now.getTime()}`;
    const slotId = `slot-dt-${now.getTime()}`;
    const appId = `app-dt-${now.getTime()}`;

    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, created_at)
      VALUES (?, 'Earlier Today', 'd', 'School', 'L', ?, 'user-org-1', 'open', ?)
    `).run(eventId, isoFromNow(-6 * HOUR), now.toISOString());

    // Started 4h ago, ended 2h ago — unambiguously over, and unambiguously today.
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Morning', 'd', ?, ?, 5)
    `).run(slotId, eventId, isoFromNow(-4 * HOUR), isoFromNow(-2 * HOUR));

    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'accepted', ?)
    `).run(appId, userId, eventId, slotId, isoFromNow(-8 * HOUR));

    return { eventId, slotId, appId };
  }

  it('excludes it from the profile\'s upcoming shifts', async () => {
    const me = (await srv.call('GET', '/api/auth/me', undefined, student)).body;
    const { eventId } = await acceptedShiftEndedEarlierToday(me.id);

    const res = await srv.call('GET', `/api/users/${me.id}/profile`, undefined, student);

    expect(res.status).toBe(200);
    const upcoming = res.body.upcoming || res.body.upcomingShifts || [];
    const ids = upcoming.map(u => u.event_id || u.eventId);
    expect(ids, 'a shift that ended two hours ago is listed as upcoming').not.toContain(eventId);
  });

  it('excludes it from the volunteer stats upcoming count', async () => {
    const me = (await srv.call('GET', '/api/auth/me', undefined, student)).body;

    /**
     * `upcomingCount`, not `upcoming`.
     *
     * This read `body.upcoming`, which the endpoint has never returned — so
     * both sides were `undefined` and the assertion was
     * `expect(undefined).toBe(undefined)`. It has been vacuously green since it
     * was written, which is worse than absent: the suite claimed this figure
     * was covered.
     */
    const read = async () =>
      (await srv.call('GET', '/api/stats/volunteer', undefined, student)).body.upcomingCount;

    const before = await read();
    expect(before, 'the endpoint no longer returns upcomingCount').toBeTypeOf('number');

    await acceptedShiftEndedEarlierToday(me.id);
    const after = await read();

    expect(after, 'the upcoming count grew for a shift that already finished').toBe(before);
  });

  it('still counts a shift LATER today as upcoming', async () => {
    // The other half of the contract: fixing the comparison must not start hiding
    // genuinely upcoming shifts, which would be a worse bug than the one being fixed.
    const { db } = await import('./db.js');
    const me = (await srv.call('GET', '/api/auth/me', undefined, student)).body;
    const now = new Date();
    const eventId = `event-later-${now.getTime()}`;
    const slotId = `slot-later-${now.getTime()}`;

    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, created_at)
      VALUES (?, 'Later Today', 'd', 'School', 'L', ?, 'user-org-1', 'open', ?)
    `).run(eventId, isoFromNow(HOUR), now.toISOString());
    await db.prepare(`
      INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
      VALUES (?, ?, 'Evening', 'd', ?, ?, 5)
    `).run(slotId, eventId, isoFromNow(3 * HOUR), isoFromNow(5 * HOUR));
    await db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, 'accepted', ?)
    `).run(`app-later-${now.getTime()}`, me.id, eventId, slotId, now.toISOString());

    const res = await srv.call('GET', `/api/users/${me.id}/profile`, undefined, student);
    const ids = (res.body.upcoming || []).map(u => u.event_id || u.eventId);
    expect(ids, 'a shift starting in three hours is missing from upcoming').toContain(eventId);
  });
});

describe('an export that expired earlier today is cleaned up', () => {
  let dir;

  beforeEach(() => { dir = null; });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sweeps a completed export whose expiry passed hours ago', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wev-dt-export-'));
    process.env.WEV_DB_PATH = path.join(dir, 'dt.db');
    process.env.JWT_SECRET = 'x'.repeat(48);
    delete process.env.NODE_ENV;

    vi.resetModules();
    const dbMod = await import('./db.js');
    dbMod.initDatabase();
    await dbMod.completeDatabaseInit();
    const db = dbMod.db;
    const worker = await import('./workers/exportWorker.js');

    const now = new Date().toISOString();
    /* `DO NOTHING` on both: these ids are fixed, and the file's schema namespace
       outlives a single test, so a re-run would otherwise collide on the
       primary key rather than on anything this test is about. */
    await db.prepare(`
      INSERT INTO users (id, username, email, password_hash, name, grade, role, created_at)
      VALUES ('u-dt','u-dt','u-dt@example.org','x','DT','11','student',?)
      ON CONFLICT (id) DO NOTHING
    `).run(now);
    await db.prepare(`
      INSERT INTO data_export_jobs (id, user_id, status, file_location, created_at, completed_at, expires_at)
      VALUES ('exp-dt','u-dt','completed', NULL, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET status = 'completed', expires_at = excluded.expires_at
    `).run(isoFromNow(-8 * HOUR), isoFromNow(-8 * HOUR), isoFromNow(-3 * HOUR));

    await worker.cleanupExpiredExports();

    const row = await db.prepare('SELECT status FROM data_export_jobs WHERE id = ?').get('exp-dt');
    expect(
      row.status,
      'an export that expired three hours ago is still marked completed, so a '
      + "student's full personal archive outlives its stated retention"
    ).toBe('expired');
  });
});

describe('no query compares an ISO column against SQLite\'s datetime(\'now\')', () => {
  /**
   * Static guard. The four sites were found by reading; this stops a fifth appearing.
   *
   * Scoped to comparison operators so an unrelated legitimate use — a default value,
   * or a column being SET to `datetime('now')` — is not flagged. Only `<`, `>`, `<=`
   * and `>=` against `datetime('now')` are wrong, and they are wrong wherever the
   * other side is one of this schema's ISO-valued columns.
   */
  it('has no comparison operator against datetime(\'now\') in server code', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        const src = readFileSync(full, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (/[<>]=?\s*datetime\('now'\)/.test(line) || /datetime\('now'\)\s*[<>]=?/.test(line)) {
            offenders.push(`${path.relative(ROOT, full)}:${i + 1} — ${line.trim()}`);
          }
        });
      }
    };
    walk(path.join(ROOT, 'server'));

    expect(
      offenders,
      'these compare an ISO-8601 column against SQLite\'s space-separated '
      + `'${new Date().toISOString()}', which misclassifies every timestamp on today's date. `
      + 'Bind new Date().toISOString() instead.'
    ).toEqual([]);
  });
});
