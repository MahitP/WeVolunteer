/**
 * Migration 033, run twice, and run against a table that already has it.
 *
 * Two nullable ADD COLUMNs are about as small as a migration gets, and they are
 * still worth a suite for one reason: SQLite has no `ALTER TABLE ... ADD COLUMN
 * IF NOT EXISTS`, so an unguarded second run throws "duplicate column name" and
 * takes the boot down with it. Idempotency is the property every migration in
 * this repository has to prove (CLAUDE.md), and here it is the only thing that
 * can go wrong.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import migration from './migrations/033_distinguished_profiles.js';

const dir = mkdtempSync(path.join(tmpdir(), 'wev-mig033-'));
let db;

const columns = () => db.prepare('PRAGMA table_info(users)').all().map(c => c.name);

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `m-${Math.random().toString(36).slice(2)}.db`));
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT)`);
  db.prepare('INSERT INTO users (id, name, role) VALUES (?, ?, ?)').run('u1', 'Alice', 'student');
});

afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('migration 033 — distinguished profile fields', () => {
  it('declares the shape the registry requires', () => {
    expect(migration.version).toBe(33);
    expect(migration.name).toBe('distinguished_profiles');
    expect(typeof migration.fileUrl).toBe('string');
    /* Two ALTERs and no rebuild, so the runner's own transaction is correct. */
    expect(migration.ownTransaction).toBeUndefined();
  });

  it('adds both columns', () => {
    migration.up(db);
    expect(columns()).toContain('profile_headline');
    expect(columns()).toContain('profile_highlights');
  });

  it('is idempotent — a second run does not throw', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(columns().filter(c => c === 'profile_headline')).toHaveLength(1);
  });

  /* Nullable and defaulted to nothing. An account that has never written a
     headline should read as NULL, not as a cleared empty string. */
  it('leaves existing rows untouched, with both fields null', () => {
    migration.up(db);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('u1');
    expect(row.name).toBe('Alice');
    expect(row.profile_headline).toBeNull();
    expect(row.profile_highlights).toBeNull();
  });

  /* The columns carry no role and no persona: what makes a profile
     distinguished is decided at read time from `users.role`. A migration that
     wrote a per-row marker would have to be re-run every time somebody's role
     changed. */
  it('stores nothing about which accounts are distinguished', () => {
    migration.up(db);
    const added = columns().filter(c => c.startsWith('profile_'));
    expect(added).toEqual(['profile_headline', 'profile_highlights']);
  });
});
