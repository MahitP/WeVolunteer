import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHoursLedgerTable,
  backfillHoursLedger,
  verifyLedgerParity
} from './hoursLedger.js';

/**
 * Tier 0 — the backwards-compatibility gate.
 *
 * The migration is rehearsed against a COPY of the real database rather than a
 * synthetic fixture, because the thing being protected is real volunteer
 * records, and a fixture can only prove the migration works on data we invented.
 *
 * Every test here works on a temp copy. The real file is opened read-only and
 * never written.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_DB = path.join(__dirname, 'wevolunteer.db');

/**
 * This deliberately does NOT pin to a hardcoded set of totals.
 *
 * An earlier version did, using numbers captured from the live database. That
 * was wrong: `wevolunteer.db` is demo data that anyone can legitimately reset,
 * so the constant went stale the first time someone pressed the reset button
 * and the suite failed for a reason that had nothing to do with the code.
 *
 * The property actually worth protecting is *invariance*: whatever this
 * database currently holds, migrating it must not change a single volunteer's
 * hours. That holds no matter what the data is, so it stays true across resets
 * and remains meaningful in CI. `expectMeaningfulSnapshot` stops it passing
 * vacuously on an empty database.
 */
function expectMeaningfulSnapshot(snap) {
  const totals = Object.values(snap);
  expect(totals.length).toBeGreaterThan(0);
  expect(totals.some(h => h > 0)).toBe(true);
}

/**
 * Copy the real database somewhere disposable, and put it back into its
 * pre-migration state.
 *
 * The running dev server migrates the real file on boot, so a plain copy is
 * already migrated and a "rehearsal" against it would insert nothing and prove
 * nothing. Dropping the ledger on the copy is what makes this an honest
 * rehearsal of the first run. `attendance` — the thing under protection — is
 * never touched by this, only the additive table.
 */
function copyRealDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-migration-'));
  const dest = path.join(dir, 'copy.db');

  // The `-wal` sidecar has to come with it.
  //
  // The database runs in WAL mode, so commits live in `<db>-wal` until a
  // checkpoint folds them into the main file. Copying the `.db` alone yields a
  // file that opens cleanly and is missing every recent write — which is
  // exactly what happened here: against a freshly seeded database the main
  // file was 4 KB with all 14 users still in the WAL, so this rehearsal ran
  // against an empty copy and every assertion failed.
  //
  // Copying the sidecars alongside it lets the copy replay the WAL on open.
  // Deliberately NOT checkpointing the source instead: a checkpoint is a write,
  // and this rehearsal must never modify the real file.
  fs.copyFileSync(REAL_DB, dest);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(REAL_DB + suffix)) {
      fs.copyFileSync(REAL_DB + suffix, dest + suffix);
    }
  }

  const db = new DatabaseSync(dest);
  db.exec('DROP TABLE IF EXISTS hours_ledger');
  db.close();

  return { dest, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Credited hours per volunteer, the way every read path in the app derives it. */
function snapshot(db) {
  const rows = db.prepare(`
    SELECT u.name, COALESCE(SUM(CASE WHEN a.present = 1 THEN a.hours_awarded END), 0) AS hours
    FROM users u
    LEFT JOIN attendance a ON a.user_id = u.id
    WHERE u.role = 'student'
    GROUP BY u.id
    HAVING hours > 0
    ORDER BY u.name
  `).all();
  return Object.fromEntries(rows.map(r => [r.name, Number(r.hours.toFixed(4))]));
}

/** Full contents of attendance, for byte-level comparison. */
const dumpAttendance = (db) => db.prepare(
  'SELECT * FROM attendance ORDER BY slot_id, user_id'
).all();

const describeIfRealDb = fs.existsSync(REAL_DB) ? describe : describe.skip;

describeIfRealDb('migration rehearsal against a copy of the real database', () => {
  it('has volunteer hours worth protecting', () => {
    const { dest, cleanup } = copyRealDb();
    try {
      expectMeaningfulSnapshot(snapshot(new DatabaseSync(dest)));
    } finally { cleanup(); }
  });

  it('leaves every volunteer total byte-identical after migrating', () => {
    const { dest, cleanup } = copyRealDb();
    try {
      const db = new DatabaseSync(dest);

      const before = snapshot(db);
      const attendanceBefore = dumpAttendance(db);

      createHoursLedgerTable(db);
      backfillHoursLedger(db);

      expectMeaningfulSnapshot(before);
      expect(snapshot(db)).toEqual(before);
      // Not merely equal totals — the same rows.
      expect(dumpAttendance(db)).toEqual(attendanceBefore);
    } finally { cleanup(); }
  });

  it('reaches parity between ledger and attendance', () => {
    const { dest, cleanup } = copyRealDb();
    try {
      const db = new DatabaseSync(dest);
      createHoursLedgerTable(db);
      const result = backfillHoursLedger(db);

      const attendanceCount = db.prepare('SELECT COUNT(*) c FROM attendance').get().c;
      expect(result.inserted).toBe(attendanceCount);

      const parity = verifyLedgerParity(db);
      expect(parity.mismatches).toEqual([]);
      expect(parity.ok).toBe(true);
    } finally { cleanup(); }
  });

  it('is idempotent — running three times changes nothing after the first', () => {
    const { dest, cleanup } = copyRealDb();
    try {
      const db = new DatabaseSync(dest);
      createHoursLedgerTable(db);

      const before = snapshot(db);
      const first = backfillHoursLedger(db);
      const ledgerAfterFirst = db.prepare('SELECT * FROM hours_ledger ORDER BY id').all();

      const second = backfillHoursLedger(db);
      const third = backfillHoursLedger(db);

      expect(second.inserted).toBe(0);
      expect(third.inserted).toBe(0);
      expect(second.skipped).toBe(first.inserted);
      expect(db.prepare('SELECT * FROM hours_ledger ORDER BY id').all()).toEqual(ledgerAfterFirst);
      expect(snapshot(db)).toEqual(before);
    } finally { cleanup(); }
  });

  it('re-running createHoursLedgerTable does not disturb existing entries', () => {
    const { dest, cleanup } = copyRealDb();
    try {
      const db = new DatabaseSync(dest);
      createHoursLedgerTable(db);
      backfillHoursLedger(db);
      const before = db.prepare('SELECT * FROM hours_ledger ORDER BY id').all();

      createHoursLedgerTable(db);

      expect(db.prepare('SELECT * FROM hours_ledger ORDER BY id').all()).toEqual(before);
    } finally { cleanup(); }
  });

  it('is fully reversible — dropping the ledger restores the original state', () => {
    const { dest, cleanup } = copyRealDb();
    try {
      const db = new DatabaseSync(dest);
      const attendanceBefore = dumpAttendance(db);
      const before = snapshot(db);

      createHoursLedgerTable(db);
      backfillHoursLedger(db);
      db.exec('DROP TABLE hours_ledger');

      expect(dumpAttendance(db)).toEqual(attendanceBefore);
      expect(snapshot(db)).toEqual(before);
    } finally { cleanup(); }
  });

  it('preserves the retained hours value on rows marked absent', () => {
    const { dest, cleanup } = copyRealDb();
    try {
      const db = new DatabaseSync(dest);
      createHoursLedgerTable(db);
      backfillHoursLedger(db);

      // The seed contains an absent volunteer carrying hours_awarded = 3.
      const absent = db.prepare('SELECT * FROM hours_ledger WHERE present_after = 0').all();
      expect(absent.length).toBeGreaterThan(0);
      for (const row of absent) {
        expect(row.delta).toBe(0);          // does not count toward a total
        expect(row.hours_after).toBeGreaterThan(0); // but the value is not lost
      }
    } finally { cleanup(); }
  });
});
