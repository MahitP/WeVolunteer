import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHoursLedgerTable, backfillHoursLedger, recordHoursChange, verifyLedgerParity } from './hoursLedger.js';
import { up as removeDuplicates } from './migrations/053_ledger_duplicate_backfill.js';

/**
 * The backfill counted the same credit twice.
 *
 * ── The bug ──
 *
 * `backfillHoursLedger` skipped an attendance row only when a ledger entry with
 * the id `migrate:<slot>:<user>` already existed. That made it idempotent
 * against its OWN rows and blind to everybody else's: a slot credited through
 * the attendance screen wrote a real entry, and the next boot found no matching
 * `migrate:` id and wrote a second entry for the same hours.
 *
 * `INSERT OR IGNORE` did not help, and could not — the two rows have different
 * primary keys, which is exactly why they both survived.
 *
 * Found on the pilot database: one student with fourteen attendance rows and
 * twenty-eight ledger rows, 419.44 ledger hours against 209.72 credited.
 *
 * ── Why this was never a wrong number for a student ──
 *
 * `attendance` is the source of truth and nothing reads the ledger to compute
 * credited hours. The damage was confined to `verifyLedgerParity`, which
 * reported it at every boot and on the admin dashboard — which is the parity
 * check doing its job, and the reason it exists.
 */

let db;

const HOURS = 2.5;

function seed() {
  db = new DatabaseSync(':memory:');
  createHoursLedgerTable(db);
  db.exec(`
    CREATE TABLE attendance (event_id TEXT, slot_id TEXT, user_id TEXT, present INTEGER, hours_awarded REAL);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE slots (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO users VALUES ('u1', 'Alex');
    INSERT INTO events VALUES ('e1', 'Cleanup');
    INSERT INTO slots VALUES ('s1', 'Morning');
    INSERT INTO attendance VALUES ('e1', 's1', 'u1', 1, ${HOURS});
  `);
}

/** What the attendance screen writes when an organizer marks somebody present. */
function creditThroughTheApp() {
  recordHoursChange(db, {
    userId: 'u1', eventId: 'e1', slotId: 's1',
    action: 'credited',
    presentBefore: null, hoursBefore: null,
    presentAfter: 1, hoursAfter: HOURS,
    actorId: 'org-1', actorRole: 'organizer',
    source: 'attendance_screen',
  });
}

const total = () =>
  db.prepare('SELECT COALESCE(SUM(delta), 0) AS t FROM hours_ledger WHERE user_id = ?').get('u1').t;
const rows = () =>
  db.prepare('SELECT COUNT(*) AS n FROM hours_ledger WHERE user_id = ?').get('u1').n;

beforeEach(seed);

describe('the backfill', () => {
  it('records an attendance row the ledger has never seen', () => {
    /* The control. Without it every assertion below would pass against a
       backfill that had simply stopped working. */
    const res = backfillHoursLedger(db);
    expect(res.inserted).toBe(1);
    expect(rows()).toBe(1);
    expect(total()).toBe(HOURS);
  });

  it('does not re-record a credit the app already wrote', () => {
    /**
     * THE regression. Before the fix this produced two rows and double the
     * hours, because the skip test asked "is there a row with MY id" rather than
     * "is this credit already recorded".
     */
    creditThroughTheApp();
    expect(rows()).toBe(1);

    const res = backfillHoursLedger(db);

    expect(res.inserted, 'the backfill duplicated a credit the app had already recorded').toBe(0);
    expect(res.skipped).toBe(1);
    expect(rows()).toBe(1);
    expect(total()).toBe(HOURS);
  });

  it('stays idempotent across repeated boots', () => {
    /* It runs on every start, so "twice" is not a hypothetical. */
    backfillHoursLedger(db);
    backfillHoursLedger(db);
    backfillHoursLedger(db);
    expect(rows()).toBe(1);
    expect(verifyLedgerParity(db).ok).toBe(true);
  });

  it('keeps the ledger in parity when both paths run in either order', () => {
    creditThroughTheApp();
    backfillHoursLedger(db);
    expect(verifyLedgerParity(db).ok).toBe(true);
  });
});

describe('migration 053, repairing what was already written', () => {
  /** Reproduces the exact pre-fix state: one real row and one migrated row. */
  function corrupt() {
    creditThroughTheApp();
    recordHoursChange(db, {
      id: 'migrate:s1:u1',
      userId: 'u1', eventId: 'e1', slotId: 's1',
      action: 'migrated',
      presentBefore: null, hoursBefore: null,
      presentAfter: 1, hoursAfter: HOURS,
      actorRole: 'system', source: 'migration',
    });
  }

  it('removes the migrated copy and restores parity', () => {
    corrupt();
    expect(rows()).toBe(2);
    expect(total()).toBe(HOURS * 2);
    expect(verifyLedgerParity(db).ok).toBe(false);

    removeDuplicates(db);

    expect(rows()).toBe(1);
    expect(total()).toBe(HOURS);
    expect(verifyLedgerParity(db).ok).toBe(true);
  });

  it('keeps the richer record, not whichever came first', () => {
    /* The real row carries an actor and before/after state; the migrated one
       carries NULLs and a reason saying prior history is unreconstructable. */
    corrupt();
    removeDuplicates(db);

    const kept = db.prepare('SELECT source, actor_id FROM hours_ledger WHERE user_id = ?').get('u1');
    expect(kept.source).toBe('attendance_screen');
    expect(kept.actor_id).toBe('org-1');
  });

  it('leaves a genuinely historical migrated row alone', () => {
    /**
     * The case that must NOT be swept up. Attendance that predates the ledger
     * has only ever had a migrated row, and it is the only record of those
     * hours — deleting it would be the data loss this migration exists to avoid
     * causing.
     */
    backfillHoursLedger(db);
    expect(rows()).toBe(1);

    removeDuplicates(db);

    expect(rows(), 'the only record of historical hours was deleted').toBe(1);
    expect(total()).toBe(HOURS);
  });

  it('does nothing to a database that was never affected', () => {
    creditThroughTheApp();
    const before = rows();
    removeDuplicates(db);
    expect(rows()).toBe(before);
  });
});
