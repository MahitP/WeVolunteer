import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHoursLedgerTable } from './hoursLedger.js';
import {
  createCheckinTable, finalizeAttendance, recordCheckins, getCheckins,
  computeEventCompletion, attendanceOnSlots, eventAttendanceCount,
  slotDuration, slotHasEnded
} from './attendance.js';

/**
 * In-memory schema mirroring the real one for the tables attendance touches.
 * Nothing here can reach server/sbvolunteers.db.
 */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, status TEXT);
    CREATE TABLE slots (
      id TEXT PRIMARY KEY, event_id TEXT, name TEXT,
      start_datetime TEXT, end_datetime TEXT, max_spots INTEGER
    );
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, user_id TEXT, event_id TEXT, slot_id TEXT, status TEXT
    );
    CREATE TABLE attendance (
      event_id TEXT NOT NULL, slot_id TEXT NOT NULL, user_id TEXT NOT NULL,
      present INTEGER CHECK(present IN (0,1)) NOT NULL,
      hours_awarded REAL NOT NULL,
      PRIMARY KEY(slot_id, user_id)
    );
  `);
  createHoursLedgerTable(db);
  createCheckinTable(db);
  return db;
}

const PAST_START = '2026-07-01T09:00:00.000Z';
const PAST_END = '2026-07-01T12:00:00.000Z';   // 3 hours, ended
const FUTURE_START = '2099-01-01T09:00:00.000Z';
const FUTURE_END = '2099-01-01T11:00:00.000Z'; // 2 hours, not yet
const NOW = '2026-07-21T12:00:00.000Z';

const ACTOR = { id: 'org1', role: 'organizer' };

function scenario(db, { slotEnd = PAST_END, slotStart = PAST_START, status = 'accepted' } = {}) {
  db.exec(`INSERT INTO users (id,name,role) VALUES ('u1','Priya Patel','student')`);
  db.exec(`INSERT INTO events (id,title,status) VALUES ('e1','Food Pantry','open')`);
  db.prepare('INSERT INTO slots (id,event_id,name,start_datetime,end_datetime,max_spots) VALUES (?,?,?,?,?,?)')
    .run('s1', 'e1', 'Box Packer', slotStart, slotEnd, 2);
  db.prepare('INSERT INTO applications (id,user_id,event_id,slot_id,status) VALUES (?,?,?,?,?)')
    .run('a1', 'u1', 'e1', 's1', status);
  return db.prepare('SELECT * FROM events WHERE id = ?').get('e1');
}

const hoursOf = (db, userId) =>
  db.prepare('SELECT COALESCE(SUM(hours_awarded),0) h FROM attendance WHERE user_id=? AND present=1').get(userId).h;

// rowid is insertion order, so this reads back in the order things happened
// even when several entries share a timestamp.
const ledgerRows = (db) => db.prepare('SELECT rowid AS seq, * FROM hours_ledger ORDER BY rowid').all();

// ─────────────────────────────────────────────────────────────────────────────

describe('slotDuration & slotHasEnded', () => {
  it('prices a slot from its duration with a floor', () => {
    expect(slotDuration({ start_datetime: PAST_START, end_datetime: PAST_END })).toBe(3);
    expect(slotDuration({ start_datetime: PAST_START, end_datetime: PAST_START })).toBe(0.1);
  });

  it('treats a slot as ended only once its end time has passed', () => {
    expect(slotHasEnded({ end_datetime: PAST_END }, NOW)).toBe(true);
    expect(slotHasEnded({ end_datetime: FUTURE_END }, NOW)).toBe(false);
  });
});

describe('L5 — hours cannot be credited before a shift has ended', () => {
  it('refuses finalisation for a shift still to come', () => {
    const db = makeDb();
    const event = scenario(db, { slotStart: FUTURE_START, slotEnd: FUTURE_END });

    const result = finalizeAttendance(db, {
      event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('shift_not_ended');
    expect(hoursOf(db, 'u1')).toBe(0);
    expect(ledgerRows(db)).toHaveLength(0);
  });
});

describe('L2 — no accidental over-crediting', () => {
  it('credits only volunteers explicitly named in the request', () => {
    const db = makeDb();
    const event = scenario(db);
    db.exec(`INSERT INTO users (id,name,role) VALUES ('u2','Leo Chen','student')`);
    db.prepare('INSERT INTO applications (id,user_id,event_id,slot_id,status) VALUES (?,?,?,?,?)')
      .run('a2', 'u2', 'e1', 's1', 'accepted');

    // Only u1 is named. u2 is accepted but unmentioned.
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });

    expect(hoursOf(db, 'u1')).toBe(3);
    expect(hoursOf(db, 'u2')).toBe(0);
    // Crucially: no row at all for u2, rather than a row marking them absent.
    expect(db.prepare("SELECT COUNT(*) c FROM attendance WHERE user_id='u2'").get().c).toBe(0);
  });

  it('an empty request credits nobody', () => {
    const db = makeDb();
    const event = scenario(db);
    const result = finalizeAttendance(db, { event, attendanceMap: {}, actor: ACTOR, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.credited).toEqual([]);
    expect(hoursOf(db, 'u1')).toBe(0);
  });
});

describe('L6 — a partial or stale request never marks anyone absent', () => {
  it('leaves unnamed existing credits untouched', () => {
    const db = makeDb();
    const event = scenario(db);
    db.exec(`INSERT INTO users (id,name,role) VALUES ('u2','Leo Chen','student')`);
    db.prepare('INSERT INTO applications (id,user_id,event_id,slot_id,status) VALUES (?,?,?,?,?)')
      .run('a2', 'u2', 'e1', 's1', 'accepted');

    finalizeAttendance(db, { event, attendanceMap: { a1: true, a2: true }, actor: ACTOR, now: NOW });
    expect(hoursOf(db, 'u1')).toBe(3);
    expect(hoursOf(db, 'u2')).toBe(3);

    // A second save that mentions only u1 — the old code would have zeroed u2.
    finalizeAttendance(db, {
      event, attendanceMap: { a1: true }, reason: 'recheck', actor: ACTOR, now: NOW
    });

    expect(hoursOf(db, 'u2')).toBe(3);
  });
});

describe('L1 / constraint 3 — attendance is historical, not application state', () => {
  it('keeps hours when the application is later withdrawn or rejected', () => {
    const db = makeDb();
    const event = scenario(db);

    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    expect(hoursOf(db, 'u1')).toBe(3);

    db.exec("UPDATE applications SET status = 'rejected' WHERE id = 'a1'");

    // Re-saving the event must not disturb the historical record.
    const result = finalizeAttendance(db, {
      event, attendanceMap: { a1: true }, reason: 'recheck', actor: ACTOR, now: NOW
    });

    expect(result.ok).toBe(true);
    expect(hoursOf(db, 'u1')).toBe(3);
  });

  it('still allows correcting the record of a volunteer since un-accepted', () => {
    const db = makeDb();
    const event = scenario(db);
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    db.exec("UPDATE applications SET status = 'waitlisted' WHERE id = 'a1'");

    const result = finalizeAttendance(db, {
      event, attendanceMap: { a1: false }, reason: 'Did not actually attend', actor: ACTOR, now: NOW
    });

    expect(result.ok).toBe(true);
    expect(hoursOf(db, 'u1')).toBe(0);
    expect(ledgerRows(db).at(-1).action).toBe('revoked');
  });

  it('refuses to invent a record for someone never accepted', () => {
    const db = makeDb();
    const event = scenario(db, { status: 'pending' });

    const result = finalizeAttendance(db, {
      event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toContainEqual({ applicationId: 'a1', why: 'not_accepted' });
    expect(hoursOf(db, 'u1')).toBe(0);
  });
});

describe('L4 / decision 3 — hours are snapshots and are never re-priced', () => {
  it('keeps the original credit after the slot duration is corrected', () => {
    const db = makeDb();
    const event = scenario(db);

    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    expect(hoursOf(db, 'u1')).toBe(3);

    // Organizer shortens the slot from 3h to 1h after the fact.
    db.prepare('UPDATE slots SET end_datetime = ? WHERE id = ?')
      .run('2026-07-01T10:00:00.000Z', 's1');

    // Toggle absent then present again — the stored value must survive.
    finalizeAttendance(db, { event, attendanceMap: { a1: false }, reason: 'x', actor: ACTOR, now: NOW });
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, reason: 'y', actor: ACTOR, now: NOW });

    expect(hoursOf(db, 'u1')).toBe(3); // not 1
  });
});

describe('decision 2 — corrections require a reason and an actor', () => {
  it('refuses to change an existing record without a reason', () => {
    const db = makeDb();
    const event = scenario(db);
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });

    const result = finalizeAttendance(db, {
      event, attendanceMap: { a1: false }, actor: ACTOR, now: NOW
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('reason_required');
    expect(result.corrections[0]).toMatchObject({ name: 'Priya Patel', from: 'present', to: 'absent' });
    expect(hoursOf(db, 'u1')).toBe(3); // nothing written
  });

  it('does not require a reason for a first-time credit', () => {
    const db = makeDb();
    const event = scenario(db);
    const result = finalizeAttendance(db, {
      event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW
    });
    expect(result.ok).toBe(true);
  });

  it('attributes every entry to an actor and stores the reason on corrections', () => {
    const db = makeDb();
    const event = scenario(db);
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    finalizeAttendance(db, {
      event, attendanceMap: { a1: false }, reason: 'Signed in but left early', actor: ACTOR, now: NOW
    });

    const rows = ledgerRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: 'credited', actor_id: 'org1', actor_role: 'organizer', reason: null });
    expect(rows[1]).toMatchObject({ action: 'revoked', actor_id: 'org1', reason: 'Signed in but left early' });
  });

  it('rejects a whitespace-only reason', () => {
    const db = makeDb();
    const event = scenario(db);
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    const result = finalizeAttendance(db, {
      event, attendanceMap: { a1: false }, reason: '   ', actor: ACTOR, now: NOW
    });
    expect(result.error).toBe('reason_required');
  });
});

describe('constraint 5 — every hours change writes a ledger entry', () => {
  it('writes exactly one entry per changed record and none for no-ops', () => {
    const db = makeDb();
    const event = scenario(db);

    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    expect(ledgerRows(db)).toHaveLength(1);

    // Saving the same value again changes nothing and should add no noise.
    const again = finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    expect(again.unchanged).toBe(1);
    expect(ledgerRows(db)).toHaveLength(1);
  });

  it('keeps ledger deltas in step with credited hours', () => {
    const db = makeDb();
    const event = scenario(db);

    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    finalizeAttendance(db, { event, attendanceMap: { a1: false }, reason: 'a', actor: ACTOR, now: NOW });
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, reason: 'b', actor: ACTOR, now: NOW });

    const sum = db.prepare('SELECT SUM(delta) d FROM hours_ledger WHERE user_id=?').get('u1').d;
    expect(Number(sum.toFixed(4))).toBe(hoursOf(db, 'u1'));
    expect(hoursOf(db, 'u1')).toBe(3);
  });

  it('records an absent-from-the-start mark with a zero delta', () => {
    const db = makeDb();
    const event = scenario(db);
    finalizeAttendance(db, { event, attendanceMap: { a1: false }, actor: ACTOR, now: NOW });

    const row = ledgerRows(db)[0];
    expect(row.action).toBe('credited');
    expect(row.delta).toBe(0);
    expect(row.hours_after).toBe(3); // what the shift was worth is not lost
    expect(hoursOf(db, 'u1')).toBe(0);
  });
});

describe('decision 5 — check-in is separate from awarding hours', () => {
  it('records marks during a shift without crediting anything', () => {
    const db = makeDb();
    const event = scenario(db, { slotStart: FUTURE_START, slotEnd: FUTURE_END });

    const result = recordCheckins(db, {
      event, checkinMap: { a1: true }, actor: ACTOR, now: NOW
    });

    expect(result.marked).toBe(1);
    expect(getCheckins(db, 'e1')).toHaveLength(1);
    // The whole point: no hours, no ledger entry.
    expect(hoursOf(db, 'u1')).toBe(0);
    expect(ledgerRows(db)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM attendance').get().c).toBe(0);
  });

  it('is freely re-editable', () => {
    const db = makeDb();
    const event = scenario(db);
    recordCheckins(db, { event, checkinMap: { a1: true }, actor: ACTOR, now: NOW });
    recordCheckins(db, { event, checkinMap: { a1: false }, actor: ACTOR, now: NOW });

    const marks = getCheckins(db, 'e1');
    expect(marks).toHaveLength(1);
    expect(marks[0].present).toBe(0);
    expect(ledgerRows(db)).toHaveLength(0);
  });

  it('ignores applications that are not accepted', () => {
    const db = makeDb();
    const event = scenario(db, { status: 'pending' });
    const result = recordCheckins(db, { event, checkinMap: { a1: true }, actor: ACTOR, now: NOW });
    expect(result.marked).toBe(0);
    expect(result.skipped).toEqual(['a1']);
  });
});

describe('decision 1 — multi-day events do not complete after the first shift', () => {
  function multiDay(db) {
    db.exec(`INSERT INTO users (id,name,role) VALUES ('u1','Priya','student'),('u2','Leo','student')`);
    db.exec(`INSERT INTO events (id,title,status) VALUES ('e1','Five Saturdays','open')`);
    db.prepare('INSERT INTO slots (id,event_id,name,start_datetime,end_datetime,max_spots) VALUES (?,?,?,?,?,?)')
      .run('day1', 'e1', 'Saturday 1', PAST_START, PAST_END, 5);
    db.prepare('INSERT INTO slots (id,event_id,name,start_datetime,end_datetime,max_spots) VALUES (?,?,?,?,?,?)')
      .run('day2', 'e1', 'Saturday 2', FUTURE_START, FUTURE_END, 5);
    db.prepare('INSERT INTO applications (id,user_id,event_id,slot_id,status) VALUES (?,?,?,?,?)')
      .run('a1', 'u1', 'e1', 'day1', 'accepted');
    db.prepare('INSERT INTO applications (id,user_id,event_id,slot_id,status) VALUES (?,?,?,?,?)')
      .run('a2', 'u2', 'e1', 'day2', 'accepted');
    return db.prepare('SELECT * FROM events WHERE id = ?').get('e1');
  }

  it('is not complete while later shifts remain', () => {
    const db = makeDb();
    const event = multiDay(db);

    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });

    const completion = computeEventCompletion(db, 'e1', NOW);
    expect(completion.complete).toBe(false);
    expect(completion.reason).toBe('shifts_remaining');
  });

  it('is not complete while an accepted volunteer has no record', () => {
    const db = makeDb();
    const event = multiDay(db);
    db.prepare('UPDATE slots SET start_datetime=?, end_datetime=? WHERE id=?')
      .run(PAST_START, PAST_END, 'day2'); // both shifts now over

    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });

    const completion = computeEventCompletion(db, 'e1', NOW);
    expect(completion.complete).toBe(false);
    expect(completion.reason).toBe('attendance_outstanding');
    expect(completion.outstanding).toBe(1);
  });

  it('completes once every shift has ended and everyone is accounted for', () => {
    const db = makeDb();
    const event = multiDay(db);
    db.prepare('UPDATE slots SET start_datetime=?, end_datetime=? WHERE id=?')
      .run(PAST_START, PAST_END, 'day2');

    finalizeAttendance(db, { event, attendanceMap: { a1: true, a2: false }, actor: ACTOR, now: NOW });

    expect(computeEventCompletion(db, 'e1', NOW).complete).toBe(true);
  });

  it('never auto-completes an event with no slots or no volunteers', () => {
    const db = makeDb();
    db.exec(`INSERT INTO events (id,title,status) VALUES ('empty','Empty','open')`);
    expect(computeEventCompletion(db, 'empty', NOW)).toMatchObject({ complete: false, reason: 'no_slots' });

    db.prepare('INSERT INTO slots (id,event_id,name,start_datetime,end_datetime,max_spots) VALUES (?,?,?,?,?,?)')
      .run('s9', 'empty', 'Shift', PAST_START, PAST_END, 2);
    expect(computeEventCompletion(db, 'empty', NOW)).toMatchObject({ complete: false, reason: 'no_volunteers' });
  });
});

describe('L3 / L7 — destructive paths are detectable before they run', () => {
  it('reports the volunteers a slot removal would harm', () => {
    const db = makeDb();
    const event = scenario(db);
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });

    const rows = attendanceOnSlots(db, ['s1']);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_name).toBe('Priya Patel');
    expect(rows[0].slot_name).toBe('Box Packer');
  });

  it('reports nothing for slots with no attendance', () => {
    const db = makeDb();
    scenario(db);
    expect(attendanceOnSlots(db, ['s1'])).toEqual([]);
    expect(attendanceOnSlots(db, [])).toEqual([]);
  });

  it('counts attendance so event deletion can be refused', () => {
    const db = makeDb();
    const event = scenario(db);
    expect(eventAttendanceCount(db, 'e1')).toBe(0);

    // Even an absent record blocks deletion — it is still part of the record.
    finalizeAttendance(db, { event, attendanceMap: { a1: false }, actor: ACTOR, now: NOW });
    expect(eventAttendanceCount(db, 'e1')).toBe(1);
  });
});

describe('request hygiene', () => {
  let db, event;
  beforeEach(() => { db = makeDb(); event = scenario(db); });

  it('ignores applications belonging to another event', () => {
    db.exec(`INSERT INTO events (id,title,status) VALUES ('e2','Other','open')`);
    db.prepare('INSERT INTO applications (id,user_id,event_id,slot_id,status) VALUES (?,?,?,?,?)')
      .run('other', 'u1', 'e2', 's1', 'accepted');

    const result = finalizeAttendance(db, {
      event, attendanceMap: { other: true }, actor: ACTOR, now: NOW
    });
    expect(result.skipped).toContainEqual({ applicationId: 'other', why: 'unknown_application' });
    expect(hoursOf(db, 'u1')).toBe(0);
  });

  it('ignores unknown application ids', () => {
    const result = finalizeAttendance(db, {
      event, attendanceMap: { nope: true }, actor: ACTOR, now: NOW
    });
    expect(result.ok).toBe(true);
    expect(result.credited).toEqual([]);
  });
});
