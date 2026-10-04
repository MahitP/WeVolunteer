import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOUNDER_EMAIL } from './ownerAllowlist.js';

/**
 * Service records start private, and the accounts that already exist are
 * brought into line with what the published documents told them.
 *
 * The Privacy Policy, Community Guidelines and Youth Safety Guidelines all say
 * a profile is private until the student turns sharing on. Migration 049
 * defaulted `hours_visibility` and `certificates_visibility` to 'public', so for
 * every account that promise was false. The owner's decision (2026-10-04,
 * docs/legal/15-PROFILE-VISIBILITY-DEFAULTS.md) was to change the code rather
 * than the documents, for new AND existing accounts, with one exemption: the
 * founder, who shows his own record to colleges and asked to keep it shown.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let db;
let up;

beforeEach(async () => {
  ({ up } = await import('./migrations/074_private_service_defaults.js'));
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT,
      hours_visibility TEXT NOT NULL DEFAULT 'public',
      certificates_visibility TEXT NOT NULL DEFAULT 'public'
    );
  `);
});

const add = (id, email, hours = 'public', certificates = 'public') =>
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(id, email, hours, certificates);

const settingsOf = (id) =>
  db.prepare('SELECT hours_visibility AS h, certificates_visibility AS c FROM users WHERE id = ?').get(id);

describe('migration 074 on existing accounts', () => {
  it('makes a public service record private', () => {
    add('s1', 'student@example.org');
    up(db);
    expect(settingsOf('s1')).toEqual({ h: 'private', c: 'private' });
  });

  it('flips each column on its own, whichever one was public', () => {
    add('s1', 'a@example.org', 'public', 'private');
    add('s2', 'b@example.org', 'private', 'public');
    up(db);
    expect(settingsOf('s1')).toEqual({ h: 'private', c: 'private' });
    expect(settingsOf('s2')).toEqual({ h: 'private', c: 'private' });
  });

  it('leaves the founder exactly as he was', () => {
    add('f', FOUNDER_EMAIL);
    up(db);
    expect(settingsOf('f')).toEqual({ h: 'public', c: 'public' });
  });

  it('recognises the founder however the address is cased or padded', () => {
    add('f', `  ${FOUNDER_EMAIL.toUpperCase()} `);
    up(db);
    expect(settingsOf('f')).toEqual({ h: 'public', c: 'public' });
  });

  it('does not exempt the platform account, which is not a person with a record', () => {
    add('p', 'wevolunteer.platform@gmail.com');
    up(db);
    expect(settingsOf('p')).toEqual({ h: 'private', c: 'private' });
  });

  it('flips an account with no address at all, rather than skipping it', () => {
    /* A deleted account is anonymised in place; a NULL email must not compare
       as "not the founder" by accident of three-valued logic and be left public. */
    add('d', null);
    up(db);
    expect(settingsOf('d')).toEqual({ h: 'private', c: 'private' });
  });

  it('is harmless to run twice', () => {
    add('s1', 'student@example.org');
    up(db);
    up(db);
    expect(settingsOf('s1')).toEqual({ h: 'private', c: 'private' });
  });

  it('skips a database too early to have the columns', () => {
    const early = new DatabaseSync(':memory:');
    early.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)');
    expect(() => up(early)).not.toThrow();
  });
});

/**
 * Every door into `users` says 'private' out loud.
 *
 * The column DEFAULT is still 'public' and stays that way: SQLite cannot change
 * a default without rebuilding `users`, the most foreign-keyed table in the
 * schema, and the PostgreSQL schema is generated from the SQLite one. So the
 * guarantee lives at the INSERT, and this test is what stops a new creation path
 * from inheriting the old default silently.
 *
 * Synthetic-data tools are listed rather than skipped by pattern, so a new file
 * in `bin/` is checked until somebody decides otherwise in this list.
 */
const SYNTHETIC = new Set([
  'bin/load-test.mjs', 'bin/search-bench.mjs', 'bin/events-query-probe.mjs',
  'bin/scale-probe.mjs', 'bin/backup-drill.mjs',
  /* Builds the synthetic dataset the scale and query benchmarks run against. */
  'server/testing/makeScaleDataset.mjs',
  /* Generates the PostgreSQL schema; its one INSERT is the system CLI actor. */
  'bin/generate-postgres-schema.mjs',
]);

function sourcesUnder(dir) {
  const out = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    const abs = path.join(ROOT, rel);
    if (statSync(abs).isDirectory()) {
      if (['migrations', 'node_modules', 'data'].includes(name)) continue;
      out.push(...sourcesUnder(rel));
    } else if (/\.(m?js)$/.test(name) && !/\.test\.m?js$/.test(name)) {
      out.push(rel);
    }
  }
  return out;
}

describe('account creation', () => {
  const files = [...sourcesUnder('server'), ...sourcesUnder('bin')]
    .filter(f => !SYNTHETIC.has(f) && f !== path.join('server', 'db', 'postgresSchema.js'));

  const inserts = files.flatMap((file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    return [...src.matchAll(/INSERT INTO users\s*\(([^)]*)\)/g)].map(m => ({ file, columns: m[1] }));
  });

  it('has creation paths to check, so this cannot pass by finding none', () => {
    expect(inserts.length).toBeGreaterThanOrEqual(3);
  });


  it.each(['hours_visibility', 'certificates_visibility'])(
    'writes %s explicitly on every path',
    (column) => {
      for (const { file, columns } of inserts) {
        expect(columns, `${file} creates an account without naming ${column}`).toContain(column);
      }
    },
  );
});
