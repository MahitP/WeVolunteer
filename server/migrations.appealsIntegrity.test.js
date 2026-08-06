/**
 * Migration 015 — appeals integrity.
 *
 * The registry requires an idempotency test for every migration. This file goes
 * further in one direction on purpose: the reason 015 exists is that a student's
 * statement was destroyed by the ruling on it, so the backfill's refusal to
 * fabricate a statement for an already-decided appeal is asserted as carefully as
 * the recovery of a recoverable one.
 *
 * Runs against an in-memory database built from the same DDL 014 wrote, rather
 * than booting the app: a migration test that needs a server is a migration test
 * nobody runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import migration from './migrations/015_appeals_integrity.js';

/** The schema exactly as migrations 012 and 014 leave it, minus what 015 adds. */
function seedPre015(db) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT, account_status TEXT DEFAULT 'active'
    );
    CREATE TABLE reports (
      id TEXT PRIMARY KEY, status TEXT, priority TEXT, resolution TEXT
    );
    CREATE TABLE moderation_actions (
      id               TEXT PRIMARY KEY,
      report_id        TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
      actor_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
      action           TEXT NOT NULL,
      old_status       TEXT, new_status     TEXT,
      old_priority     TEXT, new_priority   TEXT,
      old_resolution   TEXT, new_resolution TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE TABLE appeals (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      report_id    TEXT REFERENCES reports(id) ON DELETE RESTRICT,
      status       TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved')),
      decision     TEXT CHECK(decision IS NULL OR decision IN ('stands','reversed')),
      reasoning    TEXT,
      reviewer_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE TABLE appeal_tokens (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
    );
    INSERT INTO users (id, name) VALUES ('u-student','Student'), ('u-admin','Admin');
    INSERT INTO reports (id, status) VALUES ('rep-1','open');
  `);
}

const insertAppeal = (db, { id, decision = null, reasoning, status = 'open' }) =>
  db.prepare(`INSERT INTO appeals (id, user_id, status, decision, reasoning, created_at, updated_at)
              VALUES (?, 'u-student', ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`)
    .run(id, status, decision, reasoning);

const columns = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const triggers = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r => r.name);

let db;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  seedPre015(db);
});

describe('migration 015 — schema', () => {
  it('adds statement, decided_at, subject and subject_ref to appeals', () => {
    expect(columns(db, 'appeals')).not.toContain('statement');
    migration.up(db);
    for (const c of ['statement', 'decided_at', 'subject', 'subject_ref']) {
      expect(columns(db, 'appeals')).toContain(c);
    }
  });

  it('creates appeal_events with the columns the history needs', () => {
    migration.up(db);
    expect(columns(db, 'appeal_events')).toEqual(
      expect.arrayContaining(['id', 'appeal_id', 'actor_id', 'actor_role', 'action', 'from_status', 'to_status', 'note', 'created_at'])
    );
  });

  it('creates the appeal_tokens user index', () => {
    migration.up(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='appeal_tokens'").all();
    expect(idx.map(i => i.name)).toContain('idx_appeal_tokens_user');
  });

  it('throws a directed error when 014 has not run', () => {
    const bare = new DatabaseSync(':memory:');
    bare.exec('CREATE TABLE appeals (id TEXT PRIMARY KEY)');
    expect(() => migration.up(bare)).toThrow(/missing expected columns/);
  });
});

describe('migration 015 — the backfill', () => {
  it('recovers the statement of an appeal that has NOT been decided', () => {
    insertAppeal(db, { id: 'ap-open', reasoning: 'I was not the person using that account.' });
    migration.up(db);
    const row = db.prepare("SELECT statement, reasoning FROM appeals WHERE id='ap-open'").get();
    expect(row.statement).toBe('I was not the person using that account.');
    // `reasoning` is left alone: from here it means the reviewer's text, and the
    // route overwrites it. Clearing it now would delete the only copy we just made.
    expect(row.reasoning).toBe('I was not the person using that account.');
  });

  it('refuses to fabricate a statement for an appeal that WAS decided', () => {
    // This row's `reasoning` is the moderator's text — the student's is already
    // gone. Copying it across would invent a defence the student never made.
    insertAppeal(db, {
      id: 'ap-decided', status: 'resolved', decision: 'stands',
      reasoning: 'Reviewed the logs; the original decision is correct.',
    });
    migration.up(db);
    const row = db.prepare("SELECT statement FROM appeals WHERE id='ap-decided'").get();
    expect(row.statement).toBeNull();
  });

  it('defaults subject to suspension for pre-015 rows', () => {
    insertAppeal(db, { id: 'ap-open', reasoning: 'x' });
    migration.up(db);
    expect(db.prepare("SELECT subject FROM appeals WHERE id='ap-open'").get().subject).toBe('suspension');
  });
});

describe('migration 015 — idempotency', () => {
  it('up() twice is a no-op the second time', () => {
    insertAppeal(db, { id: 'ap-open', reasoning: 'original words' });
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const row = db.prepare("SELECT statement FROM appeals WHERE id='ap-open'").get();
    expect(row.statement).toBe('original words');
    expect(db.prepare('SELECT COUNT(*) c FROM appeals').get().c).toBe(1);
  });

  it('a second run does not re-backfill a statement the reviewer has since replaced', () => {
    // The failure this guards: run 1 backfills, the appeal is then decided (so
    // `reasoning` becomes the moderator's text), and a re-run would copy the
    // moderator's sentence over the student's preserved statement.
    insertAppeal(db, { id: 'ap-open', reasoning: 'the student original words' });
    migration.up(db);
    db.prepare("UPDATE appeals SET reasoning = 'moderator decision text', decision = 'stands' WHERE id='ap-open'").run();

    migration.up(db);
    expect(db.prepare("SELECT statement FROM appeals WHERE id='ap-open'").get().statement)
      .toBe('the student original words');
  });

  it('re-running does not duplicate triggers or indexes', () => {
    migration.up(db);
    const before = triggers(db).length;
    migration.up(db);
    expect(triggers(db).length).toBe(before);
  });
});

describe('migration 015 — immutability', () => {
  beforeEach(() => {
    migration.up(db);
    // Inserted AFTER up(), i.e. the way the post-015 route writes one: `statement`
    // is supplied directly rather than recovered by the backfill.
    insertAppeal(db, { id: 'ap-1', reasoning: null });
    db.prepare("UPDATE appeals SET statement = 'the students own words' WHERE id='ap-1'").run();
  });

  it('freezes the appellant statement against UPDATE', () => {
    expect(() => db.prepare("UPDATE appeals SET statement='rewritten' WHERE id='ap-1'").run())
      .toThrow(/evidence/);
  });

  it('freezes user_id, subject_ref and created_at', () => {
    for (const sql of [
      "UPDATE appeals SET user_id='u-admin' WHERE id='ap-1'",
      "UPDATE appeals SET subject_ref='other' WHERE id='ap-1'",
      "UPDATE appeals SET created_at='2020-01-01' WHERE id='ap-1'",
    ]) {
      expect(() => db.prepare(sql).run()).toThrow(/only the review workflow may change/);
    }
  });

  it('permits a NULL statement to be filled in, but never rewritten', () => {
    // The backfill's one legitimate write, and the destruction it must prevent.
    insertAppeal(db, { id: 'ap-2', reasoning: null });
    expect(() => db.prepare("UPDATE appeals SET statement='recovered' WHERE id='ap-2'").run()).not.toThrow();
    expect(() => db.prepare("UPDATE appeals SET statement='rewritten' WHERE id='ap-2'").run())
      .toThrow(/never overwritten/);
  });

  it('records the reviewer name once and refuses to rewrite it', () => {
    db.prepare("UPDATE appeals SET reviewer_name_snapshot='Ms Chen' WHERE id='ap-1'").run();
    expect(() => db.prepare("UPDATE appeals SET reviewer_name_snapshot='Someone Else' WHERE id='ap-1'").run())
      .toThrow(/published to the appellant/);
  });

  it('freezes the suspension snapshot, so lifting a suspension cannot erase what was appealed', () => {
    // The snapshot is written at INSERT time by the submission route — the whole
    // point is that no later UPDATE, from any path, can take it away again.
    db.prepare(`INSERT INTO appeals (id, user_id, status, statement, suspension_reason_snapshot,
                                     suspended_by_name_snapshot, created_at, updated_at)
                VALUES ('ap-snap','u-student','open','words','messaged a student off-platform',
                        'Ms Chen','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`).run();
    for (const col of ['suspension_reason_snapshot', 'suspended_by_name_snapshot']) {
      expect(() => db.prepare(`UPDATE appeals SET ${col}=NULL WHERE id='ap-snap'`).run())
        .toThrow(/only the review workflow may change/);
    }
    expect(db.prepare("SELECT suspension_reason_snapshot s FROM appeals WHERE id='ap-snap'").get().s)
      .toBe('messaged a student off-platform');
  });

  it('still permits the review workflow to write its own columns', () => {
    expect(() => db.prepare(`
      UPDATE appeals SET status='resolved', decision='stands', reasoning='reviewer text',
                         reviewer_id='u-admin', decided_at='2026-08-06T00:00:00Z',
                         updated_at='2026-08-06T00:00:00Z'
       WHERE id='ap-1'
    `).run()).not.toThrow();
    expect(db.prepare("SELECT statement FROM appeals WHERE id='ap-1'").get().statement)
      .toBe('the students own words');
  });

  it('refuses DELETE of an appeal', () => {
    expect(() => db.prepare("DELETE FROM appeals WHERE id='ap-1'").run())
      .toThrow(/never deleted/);
  });

  it('does NOT freeze reviewer_id, so an FK SET NULL cannot abort the retention sweep', () => {
    // reviewer_id is ON DELETE SET NULL. A SET NULL performs a real UPDATE and
    // fires BEFORE UPDATE OF triggers — naming it would turn deleting a former
    // moderator's account into a nightly sweep failure.
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare("UPDATE appeals SET reviewer_id='u-admin' WHERE id='ap-1'").run();
    expect(() => db.prepare("DELETE FROM users WHERE id='u-admin'").run()).not.toThrow();
    expect(db.prepare("SELECT reviewer_id FROM appeals WHERE id='ap-1'").get().reviewer_id).toBeNull();
  });
});

describe('migration 015 — moderation_actions is finally append-only', () => {
  beforeEach(() => {
    migration.up(db);
    db.prepare(`INSERT INTO moderation_actions (id, report_id, actor_id, action, created_at)
                VALUES ('ma-1','rep-1','u-admin','filed','2026-08-01T00:00:00Z')`).run();
  });

  it('refuses UPDATE', () => {
    expect(() => db.prepare("UPDATE moderation_actions SET action='tampered' WHERE id='ma-1'").run())
      .toThrow(/append-only/);
  });

  it('refuses DELETE', () => {
    expect(() => db.prepare("DELETE FROM moderation_actions WHERE id='ma-1'").run())
      .toThrow(/append-only/);
  });

  it('still permits INSERT, including from the reports_audit trigger path', () => {
    expect(() => db.prepare(`INSERT INTO moderation_actions (id, report_id, action, created_at)
                             VALUES ('ma-2','rep-1','updated','2026-08-02T00:00:00Z')`).run()).not.toThrow();
  });

  it('does NOT freeze actor_id, so deleting a former moderator still works', () => {
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => db.prepare("DELETE FROM users WHERE id='u-admin'").run()).not.toThrow();
    expect(db.prepare("SELECT actor_id FROM moderation_actions WHERE id='ma-1'").get().actor_id).toBeNull();
  });
});

describe('migration 015 — appeal_events is append-only', () => {
  beforeEach(() => {
    migration.up(db);
    insertAppeal(db, { id: 'ap-1', reasoning: 'words' });
    db.prepare(`INSERT INTO appeal_events (id, appeal_id, actor_id, action, to_status, created_at)
                VALUES ('ev-1','ap-1','u-student','submitted','open','2026-08-01T00:00:00Z')`).run();
  });

  it('refuses UPDATE and DELETE', () => {
    expect(() => db.prepare("UPDATE appeal_events SET action='x' WHERE id='ev-1'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM appeal_events WHERE id='ev-1'").run()).toThrow(/append-only/);
  });

  it('permits appending further events', () => {
    expect(() => db.prepare(`INSERT INTO appeal_events (id, appeal_id, action, from_status, to_status, created_at)
                             VALUES ('ev-2','ap-1','decided','reviewing','resolved','2026-08-02T00:00:00Z')`).run())
      .not.toThrow();
  });
});
