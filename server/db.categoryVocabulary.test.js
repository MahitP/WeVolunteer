import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { VALID_CATEGORIES, CATEGORY_GROUPS, categoryLabel, categoryGroup } from './eventCategories.js';
import migration057, { up as widenEventCategories } from './migrations/057_widen_event_categories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * One vocabulary, written in four places, asserted to be one vocabulary.
 *
 * `events.category` is an enum with no lookup table, so the list of legal values
 * exists as a literal in each place that has to know it:
 *
 *   1. `server/eventCategories.js`   — the source, and what the routes validate against
 *   2. `server/db.js`                — the CHECK on a database created from scratch
 *   3. migration 057                 — the CHECK on a database that already existed
 *   4. `server/db/postgresSchema.js` — generated from (2), so covered by its own test
 *
 * They fail differently and that is the point. A value in (1) and not in (2)
 * publishes fine in development and throws a constraint violation the first time
 * anybody uses it on a fresh install. A value in (1) and not in (3) works on
 * every new database and fails only on the pilot — the one database with real
 * students on it. Neither surfaces as anything but a 500 on the publish button.
 *
 * So the vocabulary is compared against the DDL that two different code paths
 * actually produce, rather than against a fifth copy written here.
 */

/** The `category` CHECK list, read back out of a real database's stored DDL. */
function categoriesInCheckConstraint(ddl) {
  const check = /category\s+TEXT\s+CHECK\(category IN \(([^)]*)\)\)/.exec(ddl);
  if (!check) throw new Error(`No category CHECK found in:\n${ddl}`);
  return check[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

/** A database with `events` exactly as `db.js` creates it from nothing. */
function freshEventsDdl() {
  const source = readFileSync(path.join(__dirname, 'db.js'), 'utf8');
  const create = /CREATE TABLE IF NOT EXISTS events \([\s\S]*?\n {4}\)/.exec(source);
  if (!create) throw new Error('Could not find the events CREATE TABLE in db.js');
  return create[0];
}

describe('the event category vocabulary', () => {
  it('is not empty, and every value is unique', () => {
    expect(VALID_CATEGORIES.length).toBeGreaterThan(0);
    expect(new Set(VALID_CATEGORIES).size).toBe(VALID_CATEGORIES.length);
  });

  /**
   * The compatibility promise, stated as a test rather than as a comment.
   *
   * These five are the entire vocabulary as it shipped, and rows carry them.
   * Removing or re-spelling one does not "clean up the list" — it makes every
   * event holding it fail the CHECK on the next rebuild, and silently re-files
   * the event the next time anybody opens an edit form. A future change that
   * genuinely needs to retire one of these has to migrate the rows first, and
   * deleting this assertion is how it announces that.
   */
  it('still contains every value the platform shipped with', () => {
    for (const original of ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other']) {
      expect(VALID_CATEGORIES).toContain(original);
    }
  });

  it('gives every value a label and a group', () => {
    for (const value of VALID_CATEGORIES) {
      expect(categoryLabel(value), `${value} has no label`).toBeTruthy();
      expect(categoryGroup(value), `${value} is in no group`).toBeTruthy();
    }
  });

  it('puts each value in exactly one group', () => {
    const seen = new Map();
    for (const { group, categories } of CATEGORY_GROUPS) {
      for (const { value } of categories) {
        expect(seen.has(value), `${value} appears in two groups`).toBe(false);
        seen.set(value, group);
      }
    }
  });

  it('renders an unknown stored value as itself rather than as nothing', () => {
    expect(categoryLabel('Ballooning')).toBe('Ballooning');
    expect(categoryGroup('Ballooning')).toBe('');
  });
});

describe('the CHECK constraint a fresh database gets', () => {
  it('admits exactly the vocabulary', () => {
    expect(categoriesInCheckConstraint(freshEventsDdl())).toEqual([...VALID_CATEGORIES]);
  });
});

describe('migration 057, on a database that already exists', () => {
  let dir, db;

  /** `events` as it was before this migration, plus one cascading child. */
  const openLegacyDb = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wev-cat-'));
    db = new DatabaseSync(path.join(dir, 'm.db'));
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT CHECK(category IN ('School', '5K', 'Food Pantry', 'Fundraiser', 'Other')) NOT NULL,
        location TEXT NOT NULL,
        application_deadline TEXT NOT NULL,
        organizer_id TEXT NOT NULL,
        status TEXT CHECK(status IN ('open', 'closed', 'completed', 'cancelled')) DEFAULT 'open',
        auto_approve INTEGER DEFAULT 0,
        selection_summary TEXT,
        created_at TEXT NOT NULL, instructions TEXT,
        attendee_visibility TEXT NOT NULL DEFAULT 'accepted',
        address TEXT, latitude REAL, longitude REAL,
        organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
        credits_hours INTEGER NOT NULL DEFAULT 1,
        audience TEXT NOT NULL DEFAULT 'everyone',
        FOREIGN KEY(organizer_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_events_organizer ON events(organizer_id);
      CREATE TABLE slots (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT NOT NULL,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      );
      CREATE TABLE attendance (
        event_id TEXT NOT NULL, slot_id TEXT NOT NULL, user_id TEXT NOT NULL,
        present INTEGER NOT NULL, hours_awarded REAL NOT NULL,
        PRIMARY KEY(slot_id, user_id),
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      );
      INSERT INTO users (id, name) VALUES ('u1', 'Jordan Whitfield');
      INSERT INTO events
        (id, title, description, category, location, application_deadline, organizer_id, created_at)
      VALUES
        ('e1', 'Snack Shack', 'Grill', 'Other',       'Park', '2026-09-01T00:00:00.000Z', 'u1', '2026-08-01T00:00:00.000Z'),
        ('e2', 'Charity 5K',  'Run',   '5K',          'Park', '2026-09-01T00:00:00.000Z', 'u1', '2026-08-01T00:00:00.000Z'),
        ('e3', 'Boxing Day',  'Pack',  'Food Pantry', 'Hall', '2026-09-01T00:00:00.000Z', 'u1', '2026-08-01T00:00:00.000Z');
      INSERT INTO slots (id, event_id, name) VALUES ('s1', 'e1', 'Morning'), ('s2', 'e2', 'Water station');
      INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
        VALUES ('e1', 's1', 'u1', 1, 2.5);
    `);
    return db;
  };

  const close = () => { db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); };

  it('is registered under a version nothing else uses, and owns its transaction', () => {
    expect(migration057.version).toBe(57);
    /* `PRAGMA foreign_keys = OFF` is a silent no-op inside an open transaction,
       and this rebuild's whole safety rests on it taking effect. */
    expect(migration057.ownTransaction).toBe(true);
  });

  it('widens the CHECK to exactly the vocabulary', () => {
    try {
      widenEventCategories(openLegacyDb());
      const ddl = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
      ).get().sql;
      expect(categoriesInCheckConstraint(ddl)).toEqual([...VALID_CATEGORIES]);
    } finally { close(); }
  });

  it('keeps every event, with its category and its other columns intact', () => {
    try {
      widenEventCategories(openLegacyDb());
      const rows = db.prepare('SELECT id, title, category, audience, credits_hours FROM events ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'e1', title: 'Snack Shack', category: 'Other', audience: 'everyone', credits_hours: 1 },
        { id: 'e2', title: 'Charity 5K', category: '5K', audience: 'everyone', credits_hours: 1 },
        { id: 'e3', title: 'Boxing Day', category: 'Food Pantry', audience: 'everyone', credits_hours: 1 },
      ]);
    } finally { close(); }
  });

  /**
   * THE regression this migration could cause, and the only one that would be
   * unrecoverable. `events` has eleven ON DELETE CASCADE children; dropping it
   * with foreign keys live empties every one of them, commits, and reports
   * success. `attendance` is students' credited service hours.
   */
  it('does not cascade-delete its children', () => {
    try {
      widenEventCategories(openLegacyDb());
      expect(db.prepare('SELECT COUNT(*) c FROM slots').get().c).toBe(2);
      expect(db.prepare('SELECT COUNT(*) c FROM attendance').get().c).toBe(1);
      expect(db.prepare('SELECT hours_awarded FROM attendance').get().hours_awarded).toBe(2.5);
    } finally { close(); }
  });

  it('leaves the foreign keys valid and the indexes in place', () => {
    try {
      widenEventCategories(openLegacyDb());
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'"
      ).all().map(r => r.name);
      expect(indexes).toContain('idx_events_organizer');
    } finally { close(); }
  });

  it('accepts a new category afterwards, and still refuses one outside the list', () => {
    try {
      widenEventCategories(openLegacyDb());
      const insert = db.prepare(`
        INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, created_at)
        VALUES (?, 'T', 'D', ?, 'L', '2026-09-01T00:00:00.000Z', 'u1', '2026-08-01T00:00:00.000Z')
      `);
      insert.run('e4', 'Animals');
      expect(db.prepare("SELECT category FROM events WHERE id = 'e4'").get().category).toBe('Animals');
      expect(() => insert.run('e5', 'Ballooning')).toThrow();
    } finally { close(); }
  });

  it('is a no-op on a second run', () => {
    try {
      widenEventCategories(openLegacyDb());
      widenEventCategories(db);
      expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBe(3);
      expect(db.prepare('SELECT COUNT(*) c FROM slots').get().c).toBe(2);
    } finally { close(); }
  });

  /**
   * The explicit column copy would silently DROP a column this migration has
   * never heard of. Failing loudly is the only safe answer: the data in it
   * belongs to somebody.
   */
  it('refuses to run against a table carrying a column it does not know', () => {
    try {
      openLegacyDb();
      db.exec('ALTER TABLE events ADD COLUMN sponsor_note TEXT');
      expect(() => widenEventCategories(db)).toThrow(/unexpected columns \[sponsor_note\]/);
      /* And nothing was touched on the way to refusing. */
      expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBe(3);
    } finally { close(); }
  });

  it('does nothing at all on a database that has no events table yet', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'wev-cat-empty-'));
    const empty = new DatabaseSync(path.join(d, 'm.db'));
    try {
      expect(() => widenEventCategories(empty)).not.toThrow();
    } finally {
      empty.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
