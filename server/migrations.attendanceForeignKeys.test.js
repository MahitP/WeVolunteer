import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import migration from './migrations/038_attendance_foreign_keys.js';

/**
 * The attendance foreign-key migration.
 *
 * A table rebuild on tables that hold real records, so the assertions that
 * matter are about what SURVIVES it — every row, every column, every index —
 * not about the constraint appearing.
 *
 * ── Why the rebuild is safe to do at all ──
 *
 * `PRAGMA foreign_key_check` over the production database returns nothing:
 * every declared relationship is already satisfied. This migration nonetheless
 * checks its own two tables first and REFUSES rather than deleting, because a
 * migration that silently drops the evidence of a bug is worse than one that
 * stops.
 */

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE slots (id TEXT PRIMARY KEY, event_id TEXT);
    CREATE TABLE attendance_checkin (
      event_id TEXT NOT NULL, slot_id TEXT NOT NULL, user_id TEXT NOT NULL,
      present INTEGER CHECK(present IN (0,1)) NOT NULL,
      marked_by TEXT, marked_at TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY(slot_id, user_id)
    );
    CREATE INDEX idx_checkin_event ON attendance_checkin(event_id);
    CREATE TABLE checkin_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, application_id TEXT NOT NULL,
      event_id TEXT NOT NULL, slot_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','used','replaced')),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT
    );
    CREATE UNIQUE INDEX idx_checkin_tokens_live ON checkin_tokens(application_id) WHERE status = 'pending';
    CREATE INDEX idx_checkin_tokens_expiry ON checkin_tokens(expires_at);

    INSERT INTO users (id, name) VALUES ('u1', 'Volunteer One'), ('u2', 'Volunteer Two');
    INSERT INTO events (id, title) VALUES ('e1', 'Food Drive');
    INSERT INTO slots (id, event_id) VALUES ('s1', 'e1'), ('s2', 'e1');
  `);
  return db;
}

/** A check-in mark, with provenance worth preserving. */
function seedMarks(db) {
  db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_by, marked_at, method)
              VALUES ('e1','s1','u1',1,'org-1','2026-08-01T10:00:00.000Z','qr')`).run();
  db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_by, marked_at, method)
              VALUES ('e1','s2','u2',0,'org-1','2026-08-01T11:00:00.000Z','manual')`).run();
}

function seedTokens(db) {
  db.prepare(`INSERT INTO checkin_tokens
    (id, token_hash, application_id, event_id, slot_id, user_id, status, created_at, expires_at, resolved_at, resolved_by)
    VALUES ('t1','hash-1','app-1','e1','s1','u1','used','2026-08-01T10:00:00.000Z','2026-08-01T10:05:00.000Z','2026-08-01T10:02:00.000Z','org-1')`).run();
  db.prepare(`INSERT INTO checkin_tokens
    (id, token_hash, application_id, event_id, slot_id, user_id, status, created_at, expires_at, resolved_at, resolved_by)
    VALUES ('t2','hash-2','app-2','e1','s2','u2','pending','2026-08-01T11:00:00.000Z','2026-08-01T11:05:00.000Z',NULL,NULL)`).run();
}

const fks = (db, table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all();
const indexes = (db, table) => db.prepare(`PRAGMA index_list(${table})`).all().map(i => i.name).sort();

let db;
beforeEach(() => { db = makeDb(); });

describe('migration 038', () => {
  describe('attendance_checkin', () => {
    it('gains foreign keys on event, slot and user', () => {
      migration.up(db);
      const columns = fks(db, 'attendance_checkin').map(f => f.from).sort();
      expect(columns).toEqual(['event_id', 'slot_id', 'user_id']);
    });

    it('cascades on delete, matching the attendance table it sits beside', () => {
      migration.up(db);
      for (const fk of fks(db, 'attendance_checkin')) {
        expect(fk.on_delete, `${fk.from} should cascade`).toBe('CASCADE');
      }
    });

    it('preserves every row', () => {
      seedMarks(db);
      migration.up(db);
      expect(db.prepare('SELECT COUNT(*) AS c FROM attendance_checkin').get().c).toBe(2);
    });

    it('preserves QR provenance, the marker and the timestamp', () => {
      /* The whole reason `method` exists is so an organizer asked "were those
         six really here?" can tell a scanned mark from a typed one. A rebuild
         that dropped it would silently answer no. */
      seedMarks(db);
      migration.up(db);

      const row = db.prepare('SELECT * FROM attendance_checkin WHERE slot_id = ?').get('s1');
      expect(row.method).toBe('qr');
      expect(row.marked_by).toBe('org-1');
      expect(row.marked_at).toBe('2026-08-01T10:00:00.000Z');
      expect(row.present).toBe(1);
    });

    it('preserves an absence as an absence', () => {
      seedMarks(db);
      migration.up(db);
      expect(db.prepare('SELECT present FROM attendance_checkin WHERE slot_id = ?').get('s2').present).toBe(0);
    });

    it('keeps its index', () => {
      seedMarks(db);
      migration.up(db);
      /* A DROP TABLE takes the index with it, and a lost index is a silent
         performance regression nothing else would catch. */
      expect(indexes(db, 'attendance_checkin')).toContain('idx_checkin_event');
    });

    it('keeps the primary key, so a second mark still upserts', () => {
      seedMarks(db);
      migration.up(db);

      db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_by, marked_at, method)
                  VALUES ('e1','s1','u1',0,'org-2','2026-08-02T10:00:00.000Z','manual')
                  ON CONFLICT(slot_id, user_id) DO UPDATE SET present = excluded.present`).run();

      expect(db.prepare('SELECT COUNT(*) AS c FROM attendance_checkin').get().c).toBe(2);
      expect(db.prepare('SELECT present FROM attendance_checkin WHERE slot_id = ?').get('s1').present).toBe(0);
    });

    it('keeps the method default for a row that does not name one', () => {
      migration.up(db);
      db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_at)
                  VALUES ('e1','s1','u1',1,'2026-08-01T10:00:00.000Z')`).run();
      expect(db.prepare('SELECT method FROM attendance_checkin').get().method).toBe('manual');
    });
  });

  describe('checkin_tokens', () => {
    it('gains foreign keys on event, slot and user', () => {
      migration.up(db);
      expect(fks(db, 'checkin_tokens').map(f => f.from).sort()).toEqual(['event_id', 'slot_id', 'user_id']);
    });

    it('does NOT constrain application_id', () => {
      /**
       * Deliberate. A token is resolved by re-reading the application and
       * re-checking it, so a dangling id already resolves to a refusal — and
       * cascading on it would delete a spent token's row, which is the only
       * durable record of who scanned what.
       */
      expect(fks(db, 'checkin_tokens').map(f => f.from)).not.toContain('application_id');
    });

    it('preserves every row and its resolution', () => {
      seedTokens(db);
      migration.up(db);

      const used = db.prepare('SELECT * FROM checkin_tokens WHERE id = ?').get('t1');
      expect(used.status).toBe('used');
      expect(used.resolved_by).toBe('org-1');
      expect(used.token_hash).toBe('hash-1');
    });

    it('keeps the partial unique index that allows only one live code', () => {
      /* Without it, "retire the old, insert the new" races into two live codes
         for one signup — exactly what single-use exists to prevent. */
      seedTokens(db);
      migration.up(db);
      expect(indexes(db, 'checkin_tokens')).toContain('idx_checkin_tokens_live');

      expect(() => db.prepare(`INSERT INTO checkin_tokens
        (id, token_hash, application_id, event_id, slot_id, user_id, status, created_at, expires_at)
        VALUES ('t3','hash-3','app-2','e1','s2','u2','pending','x','y')`).run())
        .toThrow();
    });

    it('keeps the expiry index the sweep scans', () => {
      migration.up(db);
      expect(indexes(db, 'checkin_tokens')).toContain('idx_checkin_tokens_expiry');
    });

    it('keeps token_hash unique', () => {
      seedTokens(db);
      migration.up(db);
      expect(() => db.prepare(`INSERT INTO checkin_tokens
        (id, token_hash, application_id, event_id, slot_id, user_id, status, created_at, expires_at)
        VALUES ('t9','hash-1','app-9','e1','s1','u1','pending','x','y')`).run())
        .toThrow();
    });
  });

  describe('idempotency', () => {
    it('runs twice without changing anything', () => {
      seedMarks(db);
      seedTokens(db);
      migration.up(db);

      const marks = db.prepare('SELECT * FROM attendance_checkin ORDER BY slot_id').all();
      const tokens = db.prepare('SELECT * FROM checkin_tokens ORDER BY id').all();

      migration.up(db);

      expect(db.prepare('SELECT * FROM attendance_checkin ORDER BY slot_id').all()).toEqual(marks);
      expect(db.prepare('SELECT * FROM checkin_tokens ORDER BY id').all()).toEqual(tokens);
    });

    it('does not rebuild a table that already has its keys', () => {
      migration.up(db);
      const before = fks(db, 'attendance_checkin').length;
      migration.up(db);
      /* A second rebuild would duplicate nothing visible but would rewrite the
         table for no reason, and on a large one that is real downtime. */
      expect(fks(db, 'attendance_checkin').length).toBe(before);
    });

    it('runs on empty tables', () => {
      expect(() => migration.up(db)).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS c FROM attendance_checkin').get().c).toBe(0);
    });
  });

  describe('orphan detection', () => {
    it('refuses rather than deleting a mark whose slot has vanished', () => {
      db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_at)
                  VALUES ('e1','ghost-slot','u1',1,'2026-08-01T10:00:00.000Z')`).run();

      expect(() => migration.up(db)).toThrow(/orphaned rows/i);
      /* And the row is still there to be investigated. */
      expect(db.prepare('SELECT COUNT(*) AS c FROM attendance_checkin').get().c).toBe(1);
    });

    it('names the table and column so the row can be found', () => {
      db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_at)
                  VALUES ('ghost-event','s1','u1',1,'2026-08-01T10:00:00.000Z')`).run();
      expect(() => migration.up(db)).toThrow(/attendance_checkin\.event_id/);
    });

    it('refuses for an orphaned token too', () => {
      db.prepare(`INSERT INTO checkin_tokens
        (id, token_hash, application_id, event_id, slot_id, user_id, status, created_at, expires_at)
        VALUES ('t1','h1','app-1','e1','s1','ghost-user','pending','x','y')`).run();
      expect(() => migration.up(db)).toThrow(/checkin_tokens\.user_id/);
    });

    it('leaves both tables unconstrained when it refuses', () => {
      /* A half-applied migration is worse than one that did not run. */
      db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_at)
                  VALUES ('e1','ghost-slot','u1',1,'2026-08-01T10:00:00.000Z')`).run();

      expect(() => migration.up(db)).toThrow();
      expect(fks(db, 'attendance_checkin')).toHaveLength(0);
      expect(fks(db, 'checkin_tokens')).toHaveLength(0);
    });
  });

  describe('the constraints actually work once enforcement is on', () => {
    it('cascades a check-in mark when its slot is deleted', () => {
      seedMarks(db);
      migration.up(db);
      db.exec('PRAGMA foreign_keys = ON');

      db.prepare('DELETE FROM slots WHERE id = ?').run('s1');

      expect(db.prepare('SELECT COUNT(*) AS c FROM attendance_checkin WHERE slot_id = ?').get('s1').c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM attendance_checkin WHERE slot_id = ?').get('s2').c).toBe(1);
    });

    it('rejects a mark for an event that does not exist', () => {
      migration.up(db);
      db.exec('PRAGMA foreign_keys = ON');

      expect(() => db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_at)
                               VALUES ('nope','s1','u1',1,'2026-08-01T10:00:00.000Z')`).run())
        .toThrow(/FOREIGN KEY/i);
    });

    it('is inert while enforcement is off, which is the state today', () => {
      /**
       * Recorded rather than asserted as desirable. `PRAGMA foreign_keys`
       * defaults to OFF and db.js never sets it, so every cascade in this
       * schema — including the ones `attendance` has always declared — is
       * currently documentation. Enabling it is a separate change.
       */
      migration.up(db);
      db.exec('PRAGMA foreign_keys = OFF');

      expect(() => db.prepare(`INSERT INTO attendance_checkin (event_id, slot_id, user_id, present, marked_at)
                               VALUES ('nope','s1','u1',1,'2026-08-01T10:00:00.000Z')`).run())
        .not.toThrow();
    });
  });
});
