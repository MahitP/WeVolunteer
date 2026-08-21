import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  createHoursLedgerTable,
  recordHoursChange,
  backfillHoursLedger,
  verifyLedgerParity,
  getLedgerForUser
} from './hoursLedger.js';

/**
 * Every test runs against a throwaway in-memory database with the minimum
 * schema the ledger touches. Nothing here can reach server/wevolunteer.db —
 * the module takes `db` as a parameter precisely so tests never open the real
 * file.
 */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE slots (id TEXT PRIMARY KEY, event_id TEXT, name TEXT);
    CREATE TABLE attendance (
      event_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      present INTEGER CHECK(present IN (0,1)) NOT NULL,
      hours_awarded REAL NOT NULL,
      PRIMARY KEY(slot_id, user_id)
    );
  `);
  createHoursLedgerTable(db);
  return db;
}

function seed(db) {
  db.exec(`
    INSERT INTO users (id, name, role) VALUES
      ('u1','Priya Patel','student'),
      ('u2','Leo Chen','student'),
      ('u3','Ethan Ellery','student');
    INSERT INTO events (id, title) VALUES ('e1','Food Pantry'), ('e2','Snack Shack');
    INSERT INTO slots (id, event_id, name) VALUES
      ('s1','e1','Box Packer'), ('s2','e2','Grill'), ('s3','e2','Litter');
  `);
}

const addAttendance = (db, slotId, userId, present, hours, eventId = 'e1') =>
  db.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?,?,?,?,?)')
    .run(eventId, slotId, userId, present, hours);

const creditedHours = (db, userId) =>
  db.prepare('SELECT COALESCE(SUM(hours_awarded),0) h FROM attendance WHERE user_id=? AND present=1').get(userId).h;

const ledgerSum = (db, userId) =>
  db.prepare('SELECT COALESCE(SUM(delta),0) d FROM hours_ledger WHERE user_id=?').get(userId).d;

// ─────────────────────────────────────────────────────────────────────────────

describe('createHoursLedgerTable', () => {
  it('is idempotent', () => {
    const db = makeDb();
    expect(() => {
      createHoursLedgerTable(db);
      createHoursLedgerTable(db);
    }).not.toThrow();
  });

  it('has no foreign keys, so an entry survives deletion of what it describes', async () => {
    const db = makeDb();
    seed(db);
    db.exec('PRAGMA foreign_keys = ON');

    await recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      userName: 'Priya Patel', eventTitle: 'Food Pantry', slotName: 'Box Packer',
      action: 'credited', presentAfter: 1, hoursAfter: 3,
      actorId: 'org1', actorRole: 'organizer', source: 'attendance_screen'
    });

    db.exec("DELETE FROM users WHERE id = 'u1'");
    db.exec("DELETE FROM events WHERE id = 'e1'");

    const rows = await getLedgerForUser(db, 'u1');
    expect(rows).toHaveLength(1);
    // The snapshot is what keeps an orphaned row meaningful.
    expect(rows[0].user_name).toBe('Priya Patel');
    expect(rows[0].event_title).toBe('Food Pantry');
    expect(rows[0].delta).toBe(3);
  });
});

describe('recordHoursChange', () => {
  let db;
  beforeEach(() => { db = makeDb(); seed(db); });

  it('computes delta from before/after rather than trusting the caller', async () => {
    const { delta } = await recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'credited', presentBefore: null, hoursBefore: null,
      presentAfter: 1, hoursAfter: 2.5,
      source: 'attendance_screen', actorRole: 'organizer', actorId: 'org1'
    });
    expect(delta).toBe(2.5);
  });

  it('treats absence as a zero-delta event, not a missing one', async () => {
    const { delta } = await recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'credited', presentAfter: 0, hoursAfter: 3,
      source: 'attendance_screen', actorRole: 'organizer', actorId: 'org1'
    });
    // hours_awarded is retained for absent volunteers; it just doesn't count.
    expect(delta).toBe(0);
    expect(db.prepare('SELECT hours_after FROM hours_ledger').get().hours_after).toBe(3);
  });

  it('produces a negative delta when a credit is revoked', async () => {
    const { delta } = await recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'revoked', presentBefore: 1, hoursBefore: 3,
      presentAfter: 0, hoursAfter: 3,
      source: 'admin_correction', actorRole: 'admin', actorId: 'admin1',
      reason: 'Marked present in error'
    });
    expect(delta).toBe(-3);
  });

  it('produces the difference when hours are adjusted', async () => {
    const { delta } = await recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'adjusted', presentBefore: 1, hoursBefore: 3,
      presentAfter: 1, hoursAfter: 4.5,
      source: 'admin_correction', actorRole: 'admin', actorId: 'admin1',
      reason: 'Shift ran late'
    });
    expect(delta).toBe(1.5);
  });

  it('rejects unknown actions and sources', async () => {
    const base = {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      presentAfter: 1, hoursAfter: 1, source: 'attendance_screen'
    };
    await expect(recordHoursChange(db, { ...base, action: 'deleted' }))
      .rejects.toThrow(/Unknown ledger action/);
    await expect(recordHoursChange(db, { ...base, action: 'credited', source: 'somewhere' }))
      .rejects.toThrow(/Unknown ledger source/);
  });

  it('requires the identifying triple', async () => {
    await expect(recordHoursChange(db, {
      userId: 'u1', eventId: 'e1',
      action: 'credited', presentAfter: 1, hoursAfter: 1, source: 'attendance_screen'
    })).rejects.toThrow(/requires userId, eventId and slotId/);
  });

  it('rounds to avoid floating point drift accumulating across entries', async () => {
    for (let i = 0; i < 10; i++) {
      await recordHoursChange(db, {
        userId: 'u1', eventId: 'e1', slotId: `s-${i}`,
        action: 'credited', presentAfter: 1, hoursAfter: 0.1,
        source: 'attendance_screen', actorRole: 'organizer', actorId: 'org1'
      });
    }
    expect(Number(ledgerSum(db, 'u1').toFixed(4))).toBe(1);
  });
});

describe('backfillHoursLedger', () => {
  let db;
  beforeEach(() => { db = makeDb(); seed(db); });

  it('writes one migrated entry per attendance row and never touches attendance', async () => {
    addAttendance(db, 's1', 'u1', 1, 3);
    addAttendance(db, 's2', 'u2', 1, 2, 'e2');
    addAttendance(db, 's3', 'u3', 0, 2, 'e2');

    const before = db.prepare('SELECT * FROM attendance ORDER BY slot_id').all();
    const result = await backfillHoursLedger(db);
    const after = db.prepare('SELECT * FROM attendance ORDER BY slot_id').all();

    expect(result).toEqual({ inserted: 3, skipped: 0, total: 3 });
    expect(after).toEqual(before); // attendance is untouched, byte for byte
  });

  it('is idempotent — re-running inserts nothing', async () => {
    addAttendance(db, 's1', 'u1', 1, 3);
    addAttendance(db, 's2', 'u2', 1, 2, 'e2');

    expect((await backfillHoursLedger(db)).inserted).toBe(2);
    expect(await backfillHoursLedger(db)).toEqual({ inserted: 0, skipped: 2, total: 2 });
    expect(await backfillHoursLedger(db)).toEqual({ inserted: 0, skipped: 2, total: 2 });

    expect(db.prepare('SELECT COUNT(*) c FROM hours_ledger').get().c).toBe(2);
  });

  it('uses an id derived from the attendance primary key', async () => {
    addAttendance(db, 's1', 'u1', 1, 3);
    await backfillHoursLedger(db);
    expect(db.prepare('SELECT id FROM hours_ledger').get().id).toBe('migrate:s1:u1');
  });

  it('does not invent history it cannot know', async () => {
    addAttendance(db, 's1', 'u1', 1, 3);
    await backfillHoursLedger(db, { now: '2026-07-21T12:00:00.000Z' });

    const row = db.prepare('SELECT * FROM hours_ledger').get();
    expect(row.present_before).toBeNull();
    expect(row.hours_before).toBeNull();
    expect(row.actor_id).toBeNull();
    expect(row.actor_role).toBe('system');
    expect(row.source).toBe('migration');
    expect(row.created_at).toBe('2026-07-21T12:00:00.000Z');
    expect(row.reason).toMatch(/not reconstructable/);
  });

  it('keeps migrated entries permanently distinguishable from observed ones', async () => {
    addAttendance(db, 's1', 'u1', 1, 3);
    await backfillHoursLedger(db);
    await recordHoursChange(db, {
      userId: 'u1', eventId: 'e2', slotId: 's2',
      action: 'credited', presentAfter: 1, hoursAfter: 2,
      source: 'attendance_screen', actorRole: 'organizer', actorId: 'org1'
    });

    const migrated = db.prepare("SELECT COUNT(*) c FROM hours_ledger WHERE source='migration'").get().c;
    const observed = db.prepare("SELECT COUNT(*) c FROM hours_ledger WHERE source!='migration'").get().c;
    expect({ migrated, observed }).toEqual({ migrated: 1, observed: 1 });
  });

  it('carries absent rows across with a zero delta', async () => {
    addAttendance(db, 's1', 'u1', 0, 3);
    await backfillHoursLedger(db);

    const row = db.prepare('SELECT * FROM hours_ledger').get();
    expect(row.delta).toBe(0);
    expect(row.present_after).toBe(0);
    expect(row.hours_after).toBe(3);
  });

  it('handles an empty attendance table', async () => {
    expect(await backfillHoursLedger(db)).toEqual({ inserted: 0, skipped: 0, total: 0 });
    expect((await verifyLedgerParity(db)).ok).toBe(true);
  });
});

describe('verifyLedgerParity', () => {
  let db;
  beforeEach(() => { db = makeDb(); seed(db); });

  it('passes after a clean backfill', async () => {
    addAttendance(db, 's1', 'u1', 1, 3);
    addAttendance(db, 's2', 'u2', 1, 2, 'e2');
    addAttendance(db, 's3', 'u3', 0, 2, 'e2');
    await backfillHoursLedger(db);

    const parity = await verifyLedgerParity(db);
    expect(parity.ok).toBe(true);
    expect(parity.mismatches).toEqual([]);
  });

  it('detects a ledger entry with no matching attendance', async () => {
    addAttendance(db, 's1', 'u1', 1, 3);
    await backfillHoursLedger(db);
    await recordHoursChange(db, {
      userId: 'u1', eventId: 'e2', slotId: 's2',
      action: 'credited', presentAfter: 1, hoursAfter: 5,
      source: 'attendance_screen', actorRole: 'organizer', actorId: 'org1'
    });

    const parity = await verifyLedgerParity(db);
    expect(parity.ok).toBe(false);
    expect(parity.mismatches).toEqual([{ userId: 'u1', ledgerTotal: 8, attendanceTotal: 3 }]);
  });

  it('detects attendance with no matching ledger entry', async () => {
    addAttendance(db, 's1', 'u1', 1, 3);
    // deliberately not backfilled
    const parity = await verifyLedgerParity(db);
    expect(parity.ok).toBe(false);
    expect(parity.mismatches).toEqual([{ userId: 'u1', ledgerTotal: 0, attendanceTotal: 3 }]);
  });

  it('holds as an invariant across an arbitrary sequence of changes', async () => {
    // Property check: however hours are mutated, as long as each mutation is
    // mirrored into the ledger, the two views must agree per user.
    const users = ['u1', 'u2', 'u3'];
    const upsert = db.prepare(`
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
      VALUES (?,?,?,?,?)
      ON CONFLICT(slot_id, user_id) DO UPDATE SET present=excluded.present, hours_awarded=excluded.hours_awarded
    `);

    let seedRng = 42;
    const rand = () => (seedRng = (seedRng * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let i = 0; i < 200; i++) {
      const userId = users[Math.floor(rand() * users.length)];
      const slotId = `s-${Math.floor(rand() * 8)}`;
      const present = rand() > 0.35 ? 1 : 0;
      const hours = Number((rand() * 5 + 0.1).toFixed(2));

      const prior = db.prepare('SELECT present, hours_awarded FROM attendance WHERE slot_id=? AND user_id=?')
        .get(slotId, userId);

      await upsert.run('e1', slotId, userId, present, hours);
      await recordHoursChange(db, {
        userId, eventId: 'e1', slotId,
        action: prior ? 'adjusted' : 'credited',
        presentBefore: prior ? prior.present : null,
        hoursBefore: prior ? prior.hours_awarded : null,
        presentAfter: present, hoursAfter: hours,
        source: 'attendance_screen', actorRole: 'organizer', actorId: 'org1'
      });
    }

    for (const userId of users) {
      expect(Number(ledgerSum(db, userId).toFixed(4)))
        .toBe(Number(creditedHours(db, userId).toFixed(4)));
    }
    expect((await verifyLedgerParity(db)).ok).toBe(true);
  });
});

describe('ledger is append-only in practice', () => {
  it('records a full history rather than overwriting', async () => {
    const db = makeDb();
    seed(db);

    await recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'credited', presentAfter: 1, hoursAfter: 3,
      source: 'attendance_screen', actorRole: 'organizer', actorId: 'org1',
      createdAt: '2026-07-01T10:00:00.000Z'
    });
    await recordHoursChange(db, {
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'revoked', presentBefore: 1, hoursBefore: 3, presentAfter: 0, hoursAfter: 3,
      source: 'admin_correction', actorRole: 'admin', actorId: 'admin1',
      reason: 'Did not actually attend',
      createdAt: '2026-07-02T10:00:00.000Z'
    });

    const history = await getLedgerForUser(db, 'u1');
    expect(history).toHaveLength(2);
    expect(history[0].action).toBe('revoked');   // newest first
    expect(history[1].action).toBe('credited');
    expect(Number(ledgerSum(db, 'u1').toFixed(4))).toBe(0);

    // The question the old schema could not answer.
    expect(history[0].actor_id).toBe('admin1');
    expect(history[0].reason).toBe('Did not actually attend');
  });
});
