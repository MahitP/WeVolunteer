#!/usr/bin/env node
/**
 * Phase 1 of the PostgreSQL migration: a verified backup and a baseline snapshot.
 *
 * READ-ONLY with respect to the source. It opens the live database read-only and
 * writes only into `migration/`. It cannot modify, vacuum in place, or delete the
 * database it is reading.
 *
 * ── Why VACUUM INTO rather than `cp` ──
 *
 * The database runs in WAL mode. A plain `cp` copies the main file while recent
 * committed transactions may still live in `-wal`, so the copy can be missing
 * writes that the application considers durable — and it fails silently, because
 * the result is a perfectly valid SQLite file that is merely out of date.
 * `VACUUM INTO` takes a read lock and emits a single consistent file with the WAL
 * folded in, which is what a backup has to mean.
 *
 * ── Why two backups and not one ──
 *
 * The binary copy is what a rollback restores. The `.sql` dump is what proves the
 * data is still readable if a future SQLite (or a corrupted page) will not open
 * the binary. They fail independently, which is the entire reason for having both.
 *
 * ── Why the verification step is not optional ──
 *
 * §7 of the migration brief: "Do not trust a backup simply because the command
 * exited successfully." So every artifact here is re-opened after writing,
 * integrity-checked, and its row counts compared table by table against the
 * source. A backup that has not been read back is a hypothesis.
 *
 * Usage:
 *   node bin/migration-baseline.mjs              # uses WEV_DB_PATH, else pilot.db
 *   node bin/migration-baseline.mjs --db path.db
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argIdx = process.argv.indexOf('--db');
const SOURCE = path.resolve(
  argIdx !== -1 ? process.argv[argIdx + 1] : (process.env.WEV_DB_PATH || path.join(ROOT, 'pilot.db'))
);

if (!fs.existsSync(SOURCE)) {
  console.error(`FATAL: no database at ${SOURCE}`);
  process.exit(1);
}

/* Timestamp is computed once and threaded through every artifact name, so one
   run produces one identifiable set rather than files a second apart. */
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BASE = path.join(ROOT, 'migration', 'backups', 'sqlite');
const DIRS = {
  original: path.join(BASE, 'original'),
  logical: path.join(BASE, 'logical'),
  checksums: path.join(BASE, 'checksums'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const sha256 = (file) => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
};

const open = (p) => new DatabaseSync(p, { readOnly: true });
const tablesOf = (db) => db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(r => r.name);
const countsOf = (db) => Object.fromEntries(
  tablesOf(db).map(t => [t, db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c])
);

console.log(`[baseline] source: ${SOURCE}`);
const src = open(SOURCE);

/* ── Integrity of the SOURCE, before anything is copied ────────────────────
   Backing up a corrupt database produces a faithful copy of the corruption.
   Checked first so the run stops here rather than manufacturing a clean-looking
   artifact from a bad original. */
const srcIntegrity = src.prepare('PRAGMA integrity_check').get().integrity_check;
if (srcIntegrity !== 'ok') {
  console.error(`FATAL: source failed integrity_check: ${srcIntegrity}`);
  process.exit(1);
}
const srcFkViolations = src.prepare('PRAGMA foreign_key_check').all();
console.log(`[baseline] source integrity ok, ${srcFkViolations.length} foreign-key violations`);

const srcCounts = countsOf(src);
const srcTables = Object.keys(srcCounts);
const srcTotal = Object.values(srcCounts).reduce((a, b) => a + b, 0);
console.log(`[baseline] ${srcTables.length} tables, ${srcTotal} rows`);

// ── 1. Binary backup, WAL folded in ─────────────────────────────────────────
const binPath = path.join(DIRS.original, `pilot-${STAMP}.db`);
src.exec(`VACUUM INTO '${binPath.replace(/'/g, "''")}'`);
console.log(`[baseline] binary  → ${path.relative(ROOT, binPath)}`);

// ── 2. Logical backup ───────────────────────────────────────────────────────
const sqlPath = path.join(DIRS.logical, `pilot-${STAMP}.sql`);
execFileSync('sqlite3', [SOURCE, '.dump'], {
  stdio: ['ignore', fs.openSync(sqlPath, 'w'), 'inherit'],
  maxBuffer: 1024 * 1024 * 512,
});
console.log(`[baseline] logical → ${path.relative(ROOT, sqlPath)}`);

// ── 3. Schema, indexes, foreign keys, triggers ──────────────────────────────
const schema = src.prepare(
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"
).all();
const schemaPath = path.join(DIRS.checksums, `schema-${STAMP}.json`);
fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

const foreignKeys = {};
const indexes = {};
for (const t of srcTables) {
  const fks = src.prepare(`PRAGMA foreign_key_list("${t}")`).all();
  if (fks.length) foreignKeys[t] = fks;
  const idx = src.prepare(`PRAGMA index_list("${t}")`).all();
  if (idx.length) indexes[t] = idx.map(i => ({
    name: i.name, unique: !!i.unique, origin: i.origin, partial: !!i.partial,
    columns: src.prepare(`PRAGMA index_info("${i.name}")`).all().map(c => c.name),
  }));
}

// ── 4. VERIFY the backups by reading them back ──────────────────────────────
console.log('[baseline] verifying artifacts…');

const bak = open(binPath);
const bakIntegrity = bak.prepare('PRAGMA integrity_check').get().integrity_check;
if (bakIntegrity !== 'ok') { console.error(`FATAL: binary backup integrity: ${bakIntegrity}`); process.exit(1); }

const bakCounts = countsOf(bak);
const mismatches = srcTables
  .filter(t => srcCounts[t] !== bakCounts[t])
  .map(t => `${t}: source ${srcCounts[t]} vs backup ${bakCounts[t]}`);
const missingTables = srcTables.filter(t => !(t in bakCounts));
if (mismatches.length || missingTables.length) {
  console.error('FATAL: binary backup does not match the source.');
  mismatches.forEach(m => console.error('  ' + m));
  missingTables.forEach(t => console.error(`  missing table: ${t}`));
  process.exit(1);
}
console.log(`[baseline]   binary  verified — ${srcTables.length}/${srcTables.length} tables, ${srcTotal} rows match`);

/**
 * The logical dump is verified by restoring it and counting the result, which is
 * the only check that distinguishes "the file exists" from "the file can rebuild
 * the database".
 *
 * ── Why the restore goes to `:memory:` and never to a file ──
 *
 * The obvious implementation writes a scratch `.db`, counts it, and deletes it.
 * That was the first implementation, and it was wrong twice over.
 *
 * It put a **complete second copy of every student's record on disk** — real
 * names, schools and service histories — for the sake of a row count, in a
 * directory chosen for convenience. And then it deleted that file with a bare
 * `unlinkSync`, which `server/tooling.scriptSafety.test.js` caught immediately:
 * no `bin/` script may delete a database without running the real-data content
 * check. Wiring the check in did not fix it either — the check looked at the
 * restored copy, correctly saw real accounts, and **refused to delete it**,
 * leaving the PII behind. The guard was right on both counts.
 *
 * Restoring into an in-memory database removes the problem rather than guarding
 * it: nothing is written, so nothing has to be deleted, and no copy of the data
 * outlives the process. The counts are produced by the same `sqlite3`
 * invocation that reads the dump.
 */
{
  /* One `sqlite3 :memory:` invocation: read the dump, then emit `table|count`
     for every table the source has. Table names come from the source schema and
     are quoted, not interpolated from user input. */
  const countSql = srcTables
    .map(t => `SELECT '${t}' AS t, COUNT(*) AS n FROM "${t}"`)
    .join(' UNION ALL ');

  /* The dump is fed on stdin rather than named with `.read`. sqlite3's dot
     commands do not quote their argument, so any path containing a space — and
     this repository lives under "New Projects/SBVolunteers App" — is parsed as
     two arguments and rejected with a bare "Usage: .read FILE". */
  const script = [
    fs.readFileSync(sqlPath, 'utf8'),
    '.mode list',
    '.separator |',
    `${countSql};`,
    '',
  ].join('\n');

  const out = execFileSync('sqlite3', [':memory:'], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });

  const rCounts = Object.fromEntries(
    out.trim().split('\n').filter(Boolean).map(line => {
      const i = line.lastIndexOf('|');
      return [line.slice(0, i), Number(line.slice(i + 1))];
    })
  );

  const rBad = srcTables.filter(t => srcCounts[t] !== rCounts[t]);
  if (rBad.length) {
    console.error('FATAL: logical dump does not restore to the same row counts.');
    rBad.forEach(t => console.error(`  ${t}: source ${srcCounts[t]} vs restored ${rCounts[t] ?? 'missing'}`));
    process.exit(1);
  }
  console.log(`[baseline]   logical verified — restored in memory and matched ${srcTables.length} tables`);
}

// ── 5. Baseline snapshot ────────────────────────────────────────────────────
/**
 * Per-table temporal and identity bounds.
 *
 * Discovered from the schema rather than hardcoded: the column is `id` on some
 * tables and `version` or a composite elsewhere, and a hardcoded list would
 * quietly skip whatever it did not know about.
 */
const perTable = {};
for (const t of srcTables) {
  const cols = src.prepare(`PRAGMA table_info("${t}")`).all();
  const names = cols.map(c => c.name);
  const entry = { row_count: srcCounts[t] };

  /**
   * Identity bounds, unless the identity IS a credential.
   *
   * `min_id`/`max_id` exist so a migration can be checked for truncation at
   * either end of a table. On most tables the key is a `user-<uuid>` and
   * printing it is harmless. On two it is not: `appeal_tokens.token` is a bearer
   * token and `revoked_sessions.jti` names real sessions — and this file is a
   * generated report that gets committed, read in reviews, and pasted into
   * tickets. §25 of the migration brief forbids exactly that.
   *
   * The bounds are still recorded for those tables, as a count and a hash of the
   * concatenated extremes, which is enough to detect truncation without
   * reproducing the value. Matched on the column NAME rather than a table
   * allow-list so a future credential column is redacted by default rather than
   * by somebody remembering to add it here.
   */
  const idCol = names.includes('id') ? 'id' : (cols.find(c => c.pk)?.name ?? null);
  if (idCol && srcCounts[t] > 0) {
    const r = src.prepare(`SELECT MIN("${idCol}") lo, MAX("${idCol}") hi FROM "${t}"`).get();
    entry.id_column = idCol;
    if (/token|hash|secret|code|password|jti|key/i.test(idCol)) {
      entry.id_redacted = true;
      entry.id_bounds_sha256 = crypto.createHash('sha256')
        .update(String(r.lo) + ' ' + String(r.hi)).digest('hex');
    } else {
      entry.min_id = r.lo; entry.max_id = r.hi;
    }
  }
  for (const tc of ['created_at', 'createdAt', 'occurred_at', 'timestamp']) {
    if (names.includes(tc) && srcCounts[t] > 0) {
      const r = src.prepare(`SELECT MIN("${tc}") lo, MAX("${tc}") hi FROM "${t}"`).get();
      entry.time_column = tc; entry.min_created_at = r.lo; entry.max_created_at = r.hi;
      break;
    }
  }
  entry.columns = names.length;
  perTable[t] = entry;
}

/**
 * Application-level invariants.
 *
 * Row counts alone cannot detect a migration that moved every row and broke
 * every relationship, so these are the semantic questions: not "how many
 * applications" but "how many applications point at a user that exists". Each is
 * a number that must be identical after the migration, and several are
 * deliberately expressed as "count of things that should be zero".
 */
const q = (sql) => { try { return src.prepare(sql).get().v; } catch (e) { return { error: e.message }; } };
const invariants = {
  users_total: q('SELECT COUNT(*) v FROM users'),
  users_active: q("SELECT COUNT(*) v FROM users WHERE email NOT LIKE 'deleted_%'"),
  users_deleted_tombstones: q("SELECT COUNT(*) v FROM users WHERE email LIKE 'deleted_%'"),
  users_by_role: Object.fromEntries(
    src.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all().map(r => [r.role, r.c])
  ),
  users_tfa_enabled: q('SELECT COUNT(*) v FROM users WHERE tfa_enabled = 1'),
  users_with_tfa_secret: q('SELECT COUNT(*) v FROM users WHERE tfa_secret IS NOT NULL'),
  recovery_codes_total: q('SELECT COUNT(*) v FROM recovery_codes'),
  recovery_codes_unused: q('SELECT COUNT(*) v FROM recovery_codes WHERE used_at IS NULL'),

  organizations_total: q('SELECT COUNT(*) v FROM organizations'),
  organization_members_total: q('SELECT COUNT(*) v FROM organization_members'),
  organization_bans_active: q('SELECT COUNT(*) v FROM organization_bans WHERE lifted_at IS NULL'),

  events_total: q('SELECT COUNT(*) v FROM events'),
  events_cancelled: q("SELECT COUNT(*) v FROM events WHERE status = 'cancelled'"),
  slots_total: q('SELECT COUNT(*) v FROM slots'),

  applications_total: q('SELECT COUNT(*) v FROM applications'),
  applications_accepted: q("SELECT COUNT(*) v FROM applications WHERE status = 'accepted'"),
  applications_waitlisted: q("SELECT COUNT(*) v FROM applications WHERE status = 'waitlisted'"),
  applications_withdrawn: q("SELECT COUNT(*) v FROM applications WHERE status = 'withdrawn'"),

  attendance_total: q('SELECT COUNT(*) v FROM attendance'),
  attendance_present: q('SELECT COUNT(*) v FROM attendance WHERE present = 1'),
  hours_ledger_total: q('SELECT COUNT(*) v FROM hours_ledger'),
  /* `delta` is the ledger's unit of change; there is no `hours` column. The sum
     of deltas is the derived-hours invariant the platform is built on, so it is
     the single most important number in this file to see unchanged. */
  hours_ledger_delta_sum: q('SELECT COALESCE(SUM(delta), 0) v FROM hours_ledger'),
  hours_ledger_final_sum: q('SELECT COALESCE(SUM(hours_after), 0) v FROM hours_ledger'),
  external_hours_total: q('SELECT COUNT(*) v FROM external_hours'),
  external_hours_sum: q('SELECT COALESCE(SUM(hours), 0) v FROM external_hours'),
  certificates_total: q('SELECT COUNT(*) v FROM certificates'),

  notifications_total: q('SELECT COUNT(*) v FROM notifications'),
  notifications_unread: q('SELECT COUNT(*) v FROM notifications WHERE read = 0'),

  admin_audit_logs_total: q('SELECT COUNT(*) v FROM admin_audit_logs'),
  security_audit_logs_total: q('SELECT COUNT(*) v FROM security_audit_logs'),
  moderation_actions_total: q('SELECT COUNT(*) v FROM moderation_actions'),
  appeals_total: q('SELECT COUNT(*) v FROM appeals'),
  reports_total: q('SELECT COUNT(*) v FROM reports'),
  report_evidence_total: q('SELECT COUNT(*) v FROM report_evidence'),

  legal_documents_total: q('SELECT COUNT(*) v FROM legal_documents'),
  legal_acceptances_total: q('SELECT COUNT(*) v FROM legal_acceptances'),
  legal_revisions_total: q('SELECT COUNT(*) v FROM legal_document_revisions'),

  schema_migrations_head: q('SELECT MAX(version) v FROM schema_migrations'),
  schema_migrations_count: q('SELECT COUNT(*) v FROM schema_migrations'),

  /* Referential invariants — every one of these must stay 0. Named for what
     going wrong would mean, not for the query. */
  orphan_applications_user: q('SELECT COUNT(*) v FROM applications a LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL'),
  orphan_applications_event: q('SELECT COUNT(*) v FROM applications a LEFT JOIN events e ON e.id = a.event_id WHERE e.id IS NULL'),
  orphan_attendance_user: q('SELECT COUNT(*) v FROM attendance a LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL'),
  orphan_hours_user: q('SELECT COUNT(*) v FROM hours_ledger h LEFT JOIN users u ON u.id = h.user_id WHERE u.id IS NULL'),
  orphan_notifications_user: q('SELECT COUNT(*) v FROM notifications n LEFT JOIN users u ON u.id = n.user_id WHERE u.id IS NULL'),
  orphan_org_members_user: q('SELECT COUNT(*) v FROM organization_members m LEFT JOIN users u ON u.id = m.user_id WHERE u.id IS NULL'),
  orphan_org_members_org: q('SELECT COUNT(*) v FROM organization_members m LEFT JOIN organizations o ON o.id = m.organization_id WHERE o.id IS NULL'),
  orphan_audit_actor: q('SELECT COUNT(*) v FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.admin_id WHERE l.admin_id IS NOT NULL AND u.id IS NULL'),
};

const baseline = {
  generated_at: new Date().toISOString(),
  source: { path: SOURCE, bytes: fs.statSync(SOURCE).size, sha256: sha256(SOURCE) },
  artifacts: {
    binary: { path: path.relative(ROOT, binPath), bytes: fs.statSync(binPath).size, sha256: sha256(binPath), verified: true },
    logical: { path: path.relative(ROOT, sqlPath), bytes: fs.statSync(sqlPath).size, sha256: sha256(sqlPath), verified: true },
    schema: { path: path.relative(ROOT, schemaPath), sha256: sha256(schemaPath) },
  },
  totals: {
    tables: srcTables.length,
    rows: srcTotal,
    indexes: schema.filter(s => s.type === 'index').length,
    triggers: schema.filter(s => s.type === 'trigger').length,
    views: schema.filter(s => s.type === 'view').length,
    foreign_key_violations: srcFkViolations.length,
  },
  tables: perTable,
  foreign_keys: foreignKeys,
  indexes,
  invariants,
};

const outPath = path.join(ROOT, 'POSTGRES_MIGRATION_BASELINE.json');
fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2));

const checksumPath = path.join(DIRS.checksums, `checksums-${STAMP}.txt`);
fs.writeFileSync(checksumPath, [
  `# WeVolunteer migration baseline ${STAMP}`,
  `${baseline.source.sha256}  ${path.relative(ROOT, SOURCE)}`,
  `${baseline.artifacts.binary.sha256}  ${baseline.artifacts.binary.path}`,
  `${baseline.artifacts.logical.sha256}  ${baseline.artifacts.logical.path}`,
  `${baseline.artifacts.schema.sha256}  ${baseline.artifacts.schema.path}`,
  '',
].join('\n'));

console.log(`[baseline] snapshot → ${path.relative(ROOT, outPath)}`);
console.log(`[baseline] checksums → ${path.relative(ROOT, checksumPath)}`);
console.log('');
console.log(`[baseline] OK — ${srcTables.length} tables, ${srcTotal} rows, both backups read back and matched.`);
