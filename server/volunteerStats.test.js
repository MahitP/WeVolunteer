/**
 * The participation counts, at their boundaries.
 *
 * ── Why these are unit tests against a hand-built database ──
 *
 * Each assertion below is a DEFINITION, not a behaviour: what "signed up"
 * counts, and — more importantly — what it does not. Driving them through the
 * HTTP API would mean setting each case up through the application lifecycle,
 * which for "an accepted application to an event that was later cancelled" is
 * several requests of ceremony around a single row. Building the rows directly
 * makes the case being tested the only thing in the test.
 *
 * The definitions themselves, and the reasoning for each boundary, live in the
 * header of volunteerStats.js.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dir, db, volunteerStats, attendanceRecordsFor, lastVolunteeredAt, externalHoursSummary;

const PAST = '2026-01-10T12:00:00.000Z';
const PAST_END = '2026-01-10T16:00:00.000Z';
const FUTURE = '2099-01-10T12:00:00.000Z';
const FUTURE_END = '2099-01-10T16:00:00.000Z';
const NOW = '2026-06-01T00:00:00.000Z';

/** The minimum schema these functions touch, and nothing else. */
function schema(handle) {
  handle.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, status TEXT DEFAULT 'open', credits_hours INTEGER DEFAULT 1);
    CREATE TABLE slots (id TEXT PRIMARY KEY, event_id TEXT, start_datetime TEXT, end_datetime TEXT);
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, user_id TEXT, event_id TEXT, slot_id TEXT, status TEXT
    );
    CREATE TABLE attendance (
      event_id TEXT, slot_id TEXT, user_id TEXT, present INTEGER, hours_awarded REAL,
      PRIMARY KEY (slot_id, user_id)
    );
    /* No status column: an external entry is self-reported and there is nothing
       else it can be. Mirrors migration 032's rebuild of the real table. */
    CREATE TABLE external_hours (
      id TEXT PRIMARY KEY, user_id TEXT, occurred_on TEXT, hours REAL
    );
  `);
  handle.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u1', 'Volunteer');
}

/** Builds one event with one slot, and optionally an application + attendance. */
function scenario(handle, {
  event, eventStatus = 'open', start = PAST, end = PAST_END,
  applicationStatus = null, present = null, hours = 4,
}) {
  handle.prepare('INSERT INTO events (id, status) VALUES (?, ?)').run(event, eventStatus);
  handle.prepare('INSERT INTO slots (id, event_id, start_datetime, end_datetime) VALUES (?, ?, ?, ?)')
    .run(`${event}-s`, event, start, end);
  if (applicationStatus) {
    handle.prepare('INSERT INTO applications (id, user_id, event_id, slot_id, status) VALUES (?, ?, ?, ?, ?)')
      .run(`${event}-a`, 'u1', event, `${event}-s`, applicationStatus);
  }
  if (present !== null) {
    handle.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)')
      .run(event, `${event}-s`, 'u1', present, present === 1 ? hours : 0);
  }
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-stats-'));
  ({ volunteerStats, attendanceRecordsFor, lastVolunteeredAt, externalHoursSummary } = await import('./volunteerStats.js'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `t-${Math.random().toString(36).slice(2)}.db`));
  schema(db);
});

const stats = () => volunteerStats(db, 'u1', { now: NOW });

describe('what counts as signed up', () => {
  it('counts an accepted application to a shift that has ended', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 1 });
    expect(stats().eventsSignedUp).toBe(1);
  });

  /**
   * Withdrawing does not count. The API refuses to withdraw an accepted
   * application once the shift has started, so a withdrawal is by construction
   * a place given back in time for somebody else to take. Counting it would
   * teach students to no-show instead of withdrawing.
   */
  it('does not count a withdrawal', () => {
    scenario(db, { event: 'e1', applicationStatus: 'withdrawn' });
    expect(stats().eventsSignedUp).toBe(0);
  });

  /** Being turned down is not something to answer for on a public profile. */
  it('does not count a rejected or waitlisted application', () => {
    scenario(db, { event: 'e1', applicationStatus: 'rejected' });
    scenario(db, { event: 'e2', applicationStatus: 'waitlisted' });
    scenario(db, { event: 'e3', applicationStatus: 'pending' });
    expect(stats().eventsSignedUp).toBe(0);
  });

  /** Nobody turned up to nothing, because there was nothing to turn up to. */
  it('does not count a cancelled event, on either side', () => {
    scenario(db, { event: 'e1', eventStatus: 'cancelled', applicationStatus: 'accepted', present: 0 });
    const s = stats();
    expect(s.eventsSignedUp).toBe(0);
    expect(s.eventsAttended).toBe(0);
    expect(s.eventsAbsent).toBe(0);
  });

  /** A commitment, not yet an outcome. */
  it('does not count a shift that has not happened yet', () => {
    scenario(db, { event: 'e1', start: FUTURE, end: FUTURE_END, applicationStatus: 'accepted' });
    expect(stats().eventsSignedUp).toBe(0);
  });

  it('counts an event once however many of its shifts were worked', () => {
    db.prepare('INSERT INTO events (id, status) VALUES (?, ?)').run('e1', 'open');
    for (const n of [1, 2, 3]) {
      db.prepare('INSERT INTO slots (id, event_id, start_datetime, end_datetime) VALUES (?, ?, ?, ?)')
        .run(`s${n}`, 'e1', PAST, PAST_END);
      db.prepare('INSERT INTO applications (id, user_id, event_id, slot_id, status) VALUES (?, ?, ?, ?, ?)')
        .run(`a${n}`, 'u1', 'e1', `s${n}`, 'accepted');
      db.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)')
        .run('e1', `s${n}`, 'u1', 1, 2);
    }
    const s = stats();
    expect(s.eventsSignedUp).toBe(1);
    expect(s.eventsAttended).toBe(1);
    expect(s.hoursCredited).toBe(6);
  });
});

describe('attendance is the organizer\'s record, not the signup', () => {
  it('counts present = 1 as attended', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 1 });
    expect(stats().eventsAttended).toBe(1);
    expect(stats().eventsAbsent).toBe(0);
  });

  it('counts present = 0 as absent', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 0 });
    expect(stats().eventsAttended).toBe(0);
    expect(stats().eventsAbsent).toBe(1);
  });

  /**
   * THE rule this whole module exists to enforce. An organizer who never gets
   * round to confirming attendance must not thereby mark their volunteers
   * absent — and the number is published so the gap is legible as "not
   * confirmed yet" rather than as a no-show.
   */
  it('never reads a missing attendance record as absence', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted' });
    const s = stats();
    expect(s.eventsSignedUp).toBe(1);
    expect(s.eventsAttended).toBe(0);
    expect(s.eventsAbsent).toBe(0);
    expect(s.eventsAwaitingRecord).toBe(1);
  });

  it('treats a mixed-shift event as attended, not as both', () => {
    db.prepare('INSERT INTO events (id, status) VALUES (?, ?)').run('e1', 'open');
    for (const [n, present] of [['1', 1], ['2', 0]]) {
      db.prepare('INSERT INTO slots (id, event_id, start_datetime, end_datetime) VALUES (?, ?, ?, ?)')
        .run(`s${n}`, 'e1', PAST, PAST_END);
      db.prepare('INSERT INTO applications (id, user_id, event_id, slot_id, status) VALUES (?, ?, ?, ?, ?)')
        .run(`a${n}`, 'u1', 'e1', `s${n}`, 'accepted');
      db.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)')
        .run('e1', `s${n}`, 'u1', present, present ? 3 : 0);
    }
    const s = stats();
    expect(s.eventsAttended).toBe(1);
    expect(s.eventsAbsent).toBe(0);
  });

  it('keeps the identity signedUp = attended + absent + awaiting', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 1 });
    scenario(db, { event: 'e2', applicationStatus: 'accepted', present: 0 });
    scenario(db, { event: 'e3', applicationStatus: 'accepted' });
    const s = stats();
    expect(s.eventsSignedUp).toBe(s.eventsAttended + s.eventsAbsent + s.eventsAwaitingRecord);
    expect(s).toMatchObject({ eventsSignedUp: 3, eventsAttended: 1, eventsAbsent: 1, eventsAwaitingRecord: 1 });
  });

  /**
   * Attendance can outlive the application it came from: removing a slot from
   * an event deletes its applications and deliberately never touches
   * attendance. A profile is the wrong place to surface that as "-1".
   */
  it('clamps awaiting at zero when attendance outlives its application', () => {
    scenario(db, { event: 'e1', present: 1 });
    expect(stats().eventsAwaitingRecord).toBe(0);
  });
});

describe('credited hours', () => {
  it('sums only shifts the volunteer was present for', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 1, hours: 4.5 });
    scenario(db, { event: 'e2', applicationStatus: 'accepted', present: 0 });
    expect(stats().hoursCredited).toBe(4.5);
  });

  it('is zero, not null, for somebody who has never volunteered', () => {
    expect(stats().hoursCredited).toBe(0);
    expect(stats().eventsSignedUp).toBe(0);
  });

  /**
   * The security property. External hours are self-attested; if they counted
   * as credited hours, a student could write their own service record — and
   * because the Auto Select curve rewards FEWER hours, could also sabotage a
   * rival's odds by inflating theirs.
   */
  it('never includes external hours', () => {
    db.prepare('INSERT INTO external_hours (id, user_id, occurred_on, hours) VALUES (?, ?, ?, ?)')
      .run('x1', 'u1', '2026-03-01', 40);
    db.prepare('INSERT INTO external_hours (id, user_id, occurred_on, hours) VALUES (?, ?, ?, ?)')
      .run('x2', 'u1', '2026-03-02', 900);
    expect(stats().hoursCredited).toBe(0);
  });
});

describe('last volunteered', () => {
  it('is null for somebody who never has', () => {
    expect(lastVolunteeredAt(db, 'u1')).toBeNull();
  });

  it('is the end of the most recent shift actually attended', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 1 });
    expect(lastVolunteeredAt(db, 'u1')).toBe(PAST_END);
  });

  it('ignores a shift the volunteer was marked absent for', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 0 });
    expect(lastVolunteeredAt(db, 'u1')).toBeNull();
  });

  /**
   * Otherwise the date would be one anybody could set to today by typing it —
   * on a figure that appears on a public profile, where a reader takes it as
   * evidence that somebody is still active.
   */
  it('ignores external service entirely', () => {
    db.prepare('INSERT INTO external_hours (id, user_id, occurred_on, hours) VALUES (?, ?, ?, ?)')
      .run('x1', 'u1', '2099-05-20', 3);
    expect(lastVolunteeredAt(db, 'u1')).toBeNull();
  });

  it('is unmoved by an external entry when real attendance exists', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 1 });
    db.prepare('INSERT INTO external_hours (id, user_id, occurred_on, hours) VALUES (?, ?, ?, ?)')
      .run('x1', 'u1', '2099-05-20', 3);
    expect(lastVolunteeredAt(db, 'u1')).toBe(PAST_END);
  });
});

describe('the external summary', () => {
  it('is zero and empty for somebody with no entries', () => {
    expect(externalHoursSummary(db, 'u1')).toEqual({ selfReportedHours: 0, entries: 0 });
  });

  /* One total, because there is one kind of entry. A `verifiedHours` half would
     be a review workflow reappearing as a field name. */
  it('totals every entry as self-reported, with no verified split', () => {
    db.prepare('INSERT INTO external_hours (id, user_id, occurred_on, hours) VALUES (?, ?, ?, ?)')
      .run('x1', 'u1', '2026-05-20', 3.25);
    db.prepare('INSERT INTO external_hours (id, user_id, occurred_on, hours) VALUES (?, ?, ?, ?)')
      .run('x2', 'u1', '2026-05-21', 1.5);
    const summary = externalHoursSummary(db, 'u1');
    expect(summary).toEqual({ selfReportedHours: 4.75, entries: 2 });
    expect(summary).not.toHaveProperty('verifiedHours');
  });

  it('counts only the volunteer asked about', () => {
    db.prepare('INSERT INTO external_hours (id, user_id, occurred_on, hours) VALUES (?, ?, ?, ?)')
      .run('x1', 'u2', '2026-05-20', 8);
    expect(externalHoursSummary(db, 'u1')).toEqual({ selfReportedHours: 0, entries: 0 });
  });
});

describe('the batch query Auto Select uses', () => {
  it('returns nothing for an empty or all-unknown id list', () => {
    expect(attendanceRecordsFor(db, []).size).toBe(0);
    expect(attendanceRecordsFor(db, [null, undefined]).size).toBe(0);
  });

  /**
   * A MISS means "no recorded history", which reliabilityMultiplier treats as
   * neutral. Returning a zeroed row instead would make every volunteer the
   * system knows nothing about look like a total no-show.
   */
  it('omits a volunteer with no attendance rather than zeroing them', () => {
    expect(attendanceRecordsFor(db, ['u1']).has('u1')).toBe(false);
  });

  it('agrees exactly with the single-user counts', () => {
    scenario(db, { event: 'e1', applicationStatus: 'accepted', present: 1 });
    scenario(db, { event: 'e2', applicationStatus: 'accepted', present: 0 });
    const one = stats();
    const many = attendanceRecordsFor(db, ['u1', 'u1']).get('u1');
    expect(many).toEqual({
      attended: one.eventsAttended, absent: one.eventsAbsent,
      recorded: one.eventsAttended + one.eventsAbsent,
    });
  });

  it('excludes cancelled events, matching the single-user query', () => {
    scenario(db, { event: 'e1', eventStatus: 'cancelled', applicationStatus: 'accepted', present: 0 });
    expect(attendanceRecordsFor(db, ['u1']).has('u1')).toBe(false);
  });
});
