import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHoursLedgerTable, recordHoursChange, verifyLedgerParity } from './hoursLedger.js';
import { createCheckinTable, finalizeAttendance } from './attendance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_DB = path.join(__dirname, 'wevolunteer.db');

function makeDb({ foreignKeys = true } = {}) {
  const db = new DatabaseSync(':memory:');
  if (!foreignKeys) db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, status TEXT);
    CREATE TABLE slots (
      id TEXT PRIMARY KEY, event_id TEXT, name TEXT,
      start_datetime TEXT, end_datetime TEXT, max_spots INTEGER,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    );
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, user_id TEXT, event_id TEXT, slot_id TEXT, status TEXT
    );
    CREATE TABLE attendance (
      event_id TEXT NOT NULL, slot_id TEXT NOT NULL, user_id TEXT NOT NULL,
      present INTEGER CHECK(present IN (0,1)) NOT NULL,
      hours_awarded REAL NOT NULL,
      PRIMARY KEY(slot_id, user_id),
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  createHoursLedgerTable(db);
  createCheckinTable(db);
  db.exec(`
    INSERT INTO users (id,name,role) VALUES ('u1','Priya Patel','student');
    INSERT INTO events (id,title,status) VALUES ('e1','Food Pantry','open');
    INSERT INTO slots (id,event_id,name,start_datetime,end_datetime,max_spots)
      VALUES ('s1','e1','Box Packer','2026-07-01T09:00:00.000Z','2026-07-01T12:00:00.000Z',2);
    INSERT INTO applications (id,user_id,event_id,slot_id,status) VALUES ('a1','u1','e1','s1','accepted');
  `);
  return db;
}

const NOW = '2026-07-21T12:00:00.000Z';
const ACTOR = { id: 'org1', role: 'organizer' };
const hoursOf = (db, u) =>
  db.prepare('SELECT COALESCE(SUM(hours_awarded),0) h FROM attendance WHERE user_id=? AND present=1').get(u).h;

// ─────────────────────────────────────────────────────────────────────────────

describe('hours adjustment readiness', () => {
  /**
   * There is no UI for correcting the *number of hours* on an existing credit —
   * only present/absent. These tests prove the data layer is already able to
   * carry such a correction, so building the workflow later is a UI and endpoint
   * job rather than a schema migration.
   */
  it('accepts an adjustment that changes hours while staying present', () => {
    const db = makeDb();
    const event = db.prepare('SELECT * FROM events WHERE id=?').get('e1');
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });

    db.prepare('UPDATE attendance SET hours_awarded = ? WHERE slot_id=? AND user_id=?').run(4.5, 's1', 'u1');
    const { delta } = recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      userName: 'Priya Patel', eventTitle: 'Food Pantry', slotName: 'Box Packer',
      action: 'adjusted',
      presentBefore: 1, hoursBefore: 3, presentAfter: 1, hoursAfter: 4.5,
      actorId: 'admin1', actorRole: 'admin',
      source: 'admin_correction', reason: 'Shift overran; organizer confirmed 4.5h'
    });

    expect(delta).toBe(1.5);
    expect(hoursOf(db, 'u1')).toBe(4.5);
    expect(verifyLedgerParity(db).ok).toBe(true);
  });

  it('supports a downward adjustment', () => {
    const db = makeDb();
    const event = db.prepare('SELECT * FROM events WHERE id=?').get('e1');
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });

    db.prepare('UPDATE attendance SET hours_awarded = ? WHERE slot_id=? AND user_id=?').run(1, 's1', 'u1');
    recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'adjusted', presentBefore: 1, hoursBefore: 3, presentAfter: 1, hoursAfter: 1,
      actorId: 'admin1', actorRole: 'admin', source: 'admin_correction', reason: 'Left early'
    });

    expect(hoursOf(db, 'u1')).toBe(1);
    expect(verifyLedgerParity(db).ok).toBe(true);
  });

  it('carries the attribution an adjustment workflow will need', () => {
    const db = makeDb();
    recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'adjusted', presentBefore: 1, hoursBefore: 3, presentAfter: 1, hoursAfter: 2,
      actorId: 'admin1', actorRole: 'admin', source: 'admin_correction',
      reason: 'Corrected after review'
    });
    const row = db.prepare('SELECT * FROM hours_ledger').get();
    expect(row).toMatchObject({
      action: 'adjusted', actor_id: 'admin1', actor_role: 'admin',
      source: 'admin_correction', reason: 'Corrected after review',
      hours_before: 3, hours_after: 2, delta: -1
    });
  });

  it('exposes admin_correction as a first-class source, distinct from routine saves', () => {
    const db = makeDb();
    const event = db.prepare('SELECT * FROM events WHERE id=?').get('e1');
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'adjusted', presentBefore: 1, hoursBefore: 3, presentAfter: 1, hoursAfter: 3,
      actorId: 'admin1', actorRole: 'admin', source: 'admin_correction', reason: 'no-op review'
    });
    const bySource = db.prepare('SELECT source, COUNT(*) c FROM hours_ledger GROUP BY source').all();
    expect(bySource).toEqual(expect.arrayContaining([
      { source: 'attendance_screen', c: 1 },
      { source: 'admin_correction', c: 1 }
    ]));
  });
});

describe('soft-delete requirement — characterising the residual cascade risk', () => {
  /**
   * These tests do NOT assert desired behaviour. They pin down what the schema
   * actually does today, so the residual risk is visible in the suite rather
   * than only in a document, and so that whoever implements soft-delete has a
   * failing test telling them the behaviour changed on purpose.
   *
   * Application routes into this are all blocked (event deletion 409s once
   * attendance exists; organizer denial is scoped to unapproved organizers).
   * What remains is direct database access.
   */
  it('DOCUMENTS: deleting a user still destroys their attendance via CASCADE', () => {
    const db = makeDb();
    const event = db.prepare('SELECT * FROM events WHERE id=?').get('e1');
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    expect(hoursOf(db, 'u1')).toBe(3);

    db.exec("DELETE FROM users WHERE id = 'u1'");

    // If this ever starts failing, soft-delete has landed — update the docs.
    expect(hoursOf(db, 'u1')).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM attendance WHERE user_id='u1'").get().c).toBe(0);
  });

  it('DOCUMENTS: the ledger survives that deletion, so the loss is at least evidenced', () => {
    const db = makeDb();
    const event = db.prepare('SELECT * FROM events WHERE id=?').get('e1');
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });

    db.exec("DELETE FROM users WHERE id = 'u1'");
    db.exec("DELETE FROM events WHERE id = 'e1'");

    const rows = db.prepare('SELECT * FROM hours_ledger WHERE user_id = ?').all('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_name).toBe('Priya Patel');
    expect(rows[0].event_title).toBe('Food Pantry');
    expect(rows[0].delta).toBe(3);
    // Parity is deliberately broken here — that asymmetry is the alarm.
    expect(verifyLedgerParity(db).ok).toBe(false);
  });

  it('DOCUMENTS: parity verification detects hours destroyed behind the API', () => {
    const db = makeDb();
    const event = db.prepare('SELECT * FROM events WHERE id=?').get('e1');
    finalizeAttendance(db, { event, attendanceMap: { a1: true }, actor: ACTOR, now: NOW });
    expect(verifyLedgerParity(db).ok).toBe(true);

    db.exec("DELETE FROM attendance WHERE user_id = 'u1'");

    const parity = verifyLedgerParity(db);
    expect(parity.ok).toBe(false);
    expect(parity.mismatches).toEqual([{ userId: 'u1', ledgerTotal: 3, attendanceTotal: 0 }]);
  });
});

describe('production schema invariants', () => {
  const hasRealDb = fs.existsSync(REAL_DB);
  const maybe = hasRealDb ? it : it.skip;

  maybe('enforces foreign keys, which the cascade guarantees depend on', () => {
    const db = new DatabaseSync(REAL_DB);
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });

  maybe('carries the indexes the hot read paths rely on', () => {
    const db = new DatabaseSync(REAL_DB);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
    for (const required of [
      'idx_attendance_user',       // every hours total
      'idx_applications_event',    // applicant queues
      'idx_ledger_user',           // a volunteer's hours history
      'idx_ledger_event',
      'idx_notifications_user'
    ]) {
      expect(names).toContain(required);
    }
  });

  maybe('keeps the attendance primary key on (slot_id, user_id)', () => {
    const db = new DatabaseSync(REAL_DB);
    const pk = db.prepare('PRAGMA table_info(attendance)').all()
      .filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    // The upsert's ON CONFLICT target depends on exactly this.
    expect(pk).toEqual(['slot_id', 'user_id']);
  });

  maybe('constrains present and status columns rather than trusting callers', () => {
    const db = new DatabaseSync(REAL_DB);
    const sql = (t) => db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(t).sql;
    expect(sql('attendance')).toMatch(/CHECK\(present IN \(0, ?1\)\)/);
    expect(sql('applications')).toMatch(/CHECK\(status IN/);
    expect(sql('events')).toMatch(/CHECK\(status IN/);
    expect(sql('hours_ledger')).toMatch(/CHECK\(action IN/);
    expect(sql('hours_ledger')).toMatch(/CHECK\(source IN/);
  });

  maybe('has no foreign keys on the ledger, so it outlives what it describes', () => {
    const db = new DatabaseSync(REAL_DB);
    expect(db.prepare('PRAGMA foreign_key_list(hours_ledger)').all()).toEqual([]);
  });
});
