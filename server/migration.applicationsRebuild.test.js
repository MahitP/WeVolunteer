/**
 * The `applications` rebuild must not depend on column ORDER.
 *
 * This rebuild (initDatabase's "allow 'withdrawn' status" step) copied with
 * `INSERT INTO applications_new SELECT * FROM applications`, which matches
 * columns positionally. Migration 001_authz_roles.js documents that exact
 * pattern failing for real on `users`: column order depends on the order
 * historical addColumnIfMissing() calls happened to run, and on the pilot
 * database `email_verified` sits before `account_status`/`deleted_at` while a
 * freshly seeded database has it after. `applications` gains `waitlist_order`
 * by the same mechanism, so it had the same exposure.
 *
 * The first test below is the one that matters: it builds the old table with
 * the columns transposed, which is precisely what a SELECT * copy silently
 * gets wrong and what an explicit column list gets right.
 *
 * Everything here runs against a throwaway in-memory-style temp database; the
 * real database files are never opened.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir, db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-apps-rebuild-'));
  db = new DatabaseSync(path.join(dir, 'a.db'));
  // Parents for applications' foreign keys. Minimal — only the columns the
  // rebuild's FKs actually point at.
  db.exec(`
    CREATE TABLE users  (id TEXT PRIMARY KEY);
    CREATE TABLE events (id TEXT PRIMARY KEY);
    CREATE TABLE slots  (id TEXT PRIMARY KEY);
    INSERT INTO users  (id) VALUES ('u1'), ('u2');
    INSERT INTO events (id) VALUES ('e1');
    INSERT INTO slots  (id) VALUES ('s1'), ('s2');
  `);
});

afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/**
 * The pre-'withdrawn' applications table, with `waitlist_order` and `applied_at`
 * TRANSPOSED relative to EXPECTED_APPLICATION_COLUMNS — the shape a database
 * ends up with when addColumnIfMissing() ran in a different order than a fresh
 * seed produces.
 */
function createLegacyApplications(columnsTransposed) {
  const tail = columnsTransposed
    ? 'waitlist_order INTEGER,\n applied_at TEXT NOT NULL'
    : 'applied_at TEXT NOT NULL,\n waitlist_order INTEGER';
  db.exec(`
    CREATE TABLE applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      status TEXT CHECK(status IN ('pending', 'accepted', 'waitlisted', 'rejected')) DEFAULT 'pending',
      ${tail},
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE,
      UNIQUE(user_id, slot_id)
    )
  `);
}

const APPLIED_AT = '2026-07-30T12:00:00.000Z';

const rebuild = async () =>
  (await import('./db.js')).rebuildApplicationsForWithdrawn;

describe('applications rebuild (withdrawn status)', () => {
  it('copies values into the right columns when column order differs', async () => {
    createLegacyApplications(true);
    db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, waitlist_order, applied_at)
                VALUES ('a1', 'u1', 'e1', 's1', 'accepted', 7, ?)`).run(APPLIED_AT);

    await (await rebuild())(db);

    const row = db.prepare('SELECT * FROM applications WHERE id = ?').get('a1');
    // A SELECT * copy would have written 7 into applied_at and the timestamp
    // into waitlist_order, because the destination table lists them the other
    // way round. Both assertions fail under the old code.
    expect(row.applied_at).toBe(APPLIED_AT);
    expect(row.waitlist_order).toBe(7);
    expect(row.status).toBe('accepted');
    expect(row.user_id).toBe('u1');
  });

  it('admits the withdrawn status afterwards, which is the point of the rebuild', async () => {
    createLegacyApplications(false);
    db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
                VALUES ('a1', 'u1', 'e1', 's1', 'pending', ?, NULL)`).run(APPLIED_AT);

    await (await rebuild())(db);

    expect(() => db.prepare("UPDATE applications SET status = 'withdrawn' WHERE id = 'a1'").run())
      .not.toThrow();
    expect(db.prepare("SELECT status FROM applications WHERE id = 'a1'").get().status).toBe('withdrawn');
  });

  it('preserves every row and the constraints the table carried', async () => {
    createLegacyApplications(false);
    db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
                VALUES ('a1', 'u1', 'e1', 's1', 'pending', ?, NULL)`).run(APPLIED_AT);
    db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
                VALUES ('a2', 'u2', 'e1', 's2', 'waitlisted', ?, 1)`).run(APPLIED_AT);

    await (await rebuild())(db);

    expect(db.prepare('SELECT COUNT(*) c FROM applications').get().c).toBe(2);
    // UNIQUE(user_id, slot_id) must survive the rebuild.
    expect(() => db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
                             VALUES ('a3', 'u1', 'e1', 's1', 'pending', ?)`).run(APPLIED_AT)).toThrow();
  });

  it('refuses to run when the table has a column it does not know about', async () => {
    createLegacyApplications(false);
    db.exec('ALTER TABLE applications ADD COLUMN referral_source TEXT');
    db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, referral_source)
                VALUES ('a1', 'u1', 'e1', 's1', 'pending', ?, 'poster')`).run(APPLIED_AT);

    // The old SELECT * copy would have thrown on the column-count mismatch, but
    // an explicit list would silently DROP the column instead. Refusing is the
    // only outcome that neither loses data nor pretends nothing happened.
    await expect((async () => (await rebuild())(db))()).rejects.toThrow(/unexpected columns \[referral_source\]/);

    // Nothing was touched: the original table and its data are intact.
    expect(db.prepare("SELECT referral_source FROM applications WHERE id = 'a1'").get().referral_source)
      .toBe('poster');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'applications_new'").get())
      .toBeUndefined();
  });

  it('refuses to run when an expected column is absent', async () => {
    // i.e. the addColumnIfMissing() pass has not run yet.
    db.exec(`
      CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        status TEXT CHECK(status IN ('pending', 'accepted')) DEFAULT 'pending',
        applied_at TEXT NOT NULL
      )
    `);

    await expect((async () => (await rebuild())(db))()).rejects.toThrow(/missing expected columns \[waitlist_order\]/);
  });

  it('leaves application_conflicts rows intact through the DROP TABLE', async () => {
    createLegacyApplications(false);
    db.exec(`
      CREATE TABLE application_conflicts (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        conflicting_application_id TEXT NOT NULL,
        conflict_type TEXT NOT NULL,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE,
        FOREIGN KEY(conflicting_application_id) REFERENCES applications(id) ON DELETE CASCADE
      )
    `);
    db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
                VALUES ('a1', 'u1', 'e1', 's1', 'pending', ?, NULL)`).run(APPLIED_AT);
    db.prepare(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at, waitlist_order)
                VALUES ('a2', 'u2', 'e1', 's2', 'pending', ?, NULL)`).run(APPLIED_AT);
    db.prepare(`INSERT INTO application_conflicts
                (id, application_id, conflicting_application_id, conflict_type, created_at)
                VALUES ('c1', 'a1', 'a2', 'pending', ?)`).run(APPLIED_AT);

    // application_conflicts cascades from applications, so DROP TABLE
    // applications can empty it whenever foreign keys are enforced. Either the
    // rows survive or the rebuild throws — silently losing them is the one
    // outcome this must never produce.
    let threw = null;
    try { (await rebuild())(db); } catch (err) { threw = err; }

    if (threw) {
      expect(threw.message).toMatch(/application_conflicts lost rows/);
      // The throw rolled the rebuild back, so nothing was actually lost.
      expect(db.prepare('SELECT COUNT(*) c FROM application_conflicts').get().c).toBe(1);
    } else {
      expect(db.prepare('SELECT COUNT(*) c FROM application_conflicts').get().c).toBe(1);
      expect(db.prepare('SELECT COUNT(*) c FROM applications').get().c).toBe(2);
    }
  });
});
