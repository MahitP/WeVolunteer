#!/usr/bin/env node
/**
 * Does this database have the shape the migrations would build? Read-only.
 *
 *     node bin/schema-check.mjs /var/lib/wevolunteer/wevolunteer.db
 *
 * ── Why this exists ──
 *
 * The longest 2FA outage this platform had was not in any code. pilot.db carried
 * a `tfa_login_attempts` table created outside the migration system, keyed on
 * `preauth_jti`. Migration 025's `CREATE TABLE IF NOT EXISTS` saw a table of that
 * name and did nothing, so every second-factor sign-in — authenticator, email
 * and recovery code alike — ran `INSERT … ON CONFLICT(token_hash)` against a
 * table with no such key, and threw. Migration 055 repaired that one table. What
 * nothing could do was find the next one: every test builds a fresh database,
 * so a drift that exists only in a long-lived one is invisible to the suite.
 *
 * ── What it compares ──
 *
 * It builds a throwaway database the way the server does — every migration, in
 * order — and compares the target against it, table by table: columns, their
 * declared types and NOT NULL, the primary key, and every unique key (which is
 * what an `ON CONFLICT` clause depends on, and what drifted). Extra tables and
 * extra columns are reported but do not fail the check: an additive leftover is
 * untidy, not broken. A missing column, a different type, or a unique key that
 * differs is drift, and exits 1.
 *
 * ── Safety ──
 *
 * The target is opened `mode=ro`. Nothing is written to it, so this is safe to
 * run against production — which is the point. SQLite only; on PostgreSQL the
 * schema is generated from the same migrations and checked by the drift test.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node bin/schema-check.mjs <path-to-sqlite-database>');
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`No database at ${target}.`);
  process.exit(2);
}

/* ── The reference: what the migrations build ─────────────────────────────── */

/* In memory, so this tool creates no file and has none to delete: it writes
   nothing anywhere, which is what lets it be run against production. */
process.env.WEV_DB_PATH = ':memory:';
process.env.DATABASE_ENGINE = 'sqlite';
process.env.DATABASE_URL = '';
delete process.env.DEMO_MODE; // the reference holds shape, never demo rows
/* Throwaway secrets for the throwaway reference, so importing the server's
   config does not print warnings about the operator's environment — this tool
   signs nothing and encrypts nothing. */
const { randomBytes } = await import('node:crypto');
process.env.JWT_SECRET ||= randomBytes(48).toString('base64');
process.env.TFA_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');

const quietLog = console.log;
console.log = () => {};
let refDb;
try {
  const { initDatabase, completeDatabaseInit, db } = await import('../server/db.js');
  initDatabase();
  await completeDatabaseInit();
  refDb = db;
} finally {
  console.log = quietLog;
}

/* ── Reading a schema ──────────────────────────────────────────────────────── */

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** `all(sql)` answers rows, now or as a promise — the reference is read through
    the server's own connection, the target through a read-only one. */
async function readSchema({ all }) {
  const tables = new Map();
  const names = (await all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )).map(r => r.name);
  for (const name of names) {
    const columns = new Map((await all(`PRAGMA table_info(${quote(name)})`)).map(c => [c.name, {
      type: String(c.type || '').toUpperCase(),
      notnull: Number(c.notnull) === 1,
      pk: Number(c.pk),
    }]));
    const uniqueKeys = new Set();
    for (const idx of await all(`PRAGMA index_list(${quote(name)})`)) {
      if (Number(idx.unique) !== 1) continue;
      const cols = (await all(`PRAGMA index_info(${quote(idx.name)})`)).map(c => c.name);
      uniqueKeys.add(`(${cols.join(', ')})${Number(idx.partial) === 1 ? ' partial' : ''}`);
    }
    /* A rowid table's INTEGER PRIMARY KEY has no index entry, so the primary key
       is recorded from the column list as its own key. */
    const pkCols = [...columns.entries()].filter(([, c]) => c.pk > 0).sort((a, b) => a[1].pk - b[1].pk).map(([n]) => n);
    if (pkCols.length) uniqueKeys.add(`(${pkCols.join(', ')}) primary`);
    tables.set(name, { columns, uniqueKeys });
  }
  return tables;
}

const targetDb = new DatabaseSync(`file:${path.resolve(target)}?mode=ro`, { readOnly: true });
const reference = await readSchema({ all: (sql) => refDb.prepare(sql).all() });
const actual = await readSchema({ all: (sql) => targetDb.prepare(sql).all() });

/* Pending is not drift. A database a few migrations behind is the normal state
   of a server that has not booted since a deploy — it applies them on start.
   Only a difference the APPLIED migrations should have produced is drift. */
async function appliedVersions(all) {
  try {
    return new Set((await all('SELECT version FROM schema_migrations')).map(r => Number(r.version)));
  } catch { return new Set(); }
}
const refVersions = await appliedVersions((sql) => refDb.prepare(sql).all());
const gotVersions = await appliedVersions((sql) => targetDb.prepare(sql).all());
const pending = [...refVersions].filter(v => !gotVersions.has(v)).sort((a, b) => a - b);
targetDb.close();
refDb.close?.();

/* ── Comparing ─────────────────────────────────────────────────────────────── */

const drift = [];
const notes = [];

for (const [table, ref] of reference) {
  const got = actual.get(table);
  if (!got) { drift.push(`${table}: missing — the migrations create it`); continue; }

  for (const [col, want] of ref.columns) {
    const have = got.columns.get(col);
    if (!have) { drift.push(`${table}.${col}: missing`); continue; }
    if (have.type !== want.type) drift.push(`${table}.${col}: declared ${have.type || '(none)'}, migrations declare ${want.type || '(none)'}`);
    if (have.notnull !== want.notnull) drift.push(`${table}.${col}: ${have.notnull ? 'NOT NULL' : 'nullable'}, migrations make it ${want.notnull ? 'NOT NULL' : 'nullable'}`);
  }
  for (const col of got.columns.keys()) {
    if (!ref.columns.has(col)) notes.push(`${table}.${col}: not created by any migration`);
  }
  for (const key of ref.uniqueKeys) {
    if (!got.uniqueKeys.has(key)) drift.push(`${table}: unique key ${key} is missing — an ON CONFLICT on it will throw`);
  }
  for (const key of got.uniqueKeys) {
    if (!ref.uniqueKeys.has(key)) drift.push(`${table}: has unique key ${key}, which the migrations do not create`);
  }
}
for (const table of actual.keys()) {
  if (!reference.has(table)) notes.push(`${table}: table not created by any migration`);
}

console.log(`Schema check: ${path.resolve(target)} (opened read-only)`);
console.log(`Compared ${reference.size} tables against a database built from the migrations.`);
if (notes.length) {
  console.log(`\nNoted, not failing (${notes.length}):`);
  for (const n of notes) console.log(`  · ${n}`);
}
if (pending.length) {
  console.log(`\n${pending.length} migration(s) not yet applied here: ${pending.join(', ')}.`);
  console.log('The server applies them when it next starts. The differences below are what they will');
  console.log('change; re-run this after a restart to see whether anything remains.');
}
if (drift.length) {
  console.log(`\n${pending.length ? 'DIFFERENCES' : 'DRIFT'} (${drift.length}) — this database does not have the shape the code expects:`);
  for (const d of drift) console.log(`  ✗ ${d}`);
  if (!pending.length) console.log('\nEvery migration has been applied, so this is drift. Repair it with an additive migration, as 055\ndid for tfa_login_attempts. Do not hand-edit production.');
  process.exit(1);
}
console.log('\nOK — the schema matches what the migrations build.');
