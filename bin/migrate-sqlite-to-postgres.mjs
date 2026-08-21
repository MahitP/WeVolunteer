/**
 * Copy a SQLite database into a fresh PostgreSQL one, and prove it arrived.
 *
 *   node bin/migrate-sqlite-to-postgres.mjs --source pilot.db \
 *        --target postgres://user@localhost:5432/wv_migration_dryrun --apply
 *
 * Without `--apply` it reports what it WOULD do and touches nothing.
 *
 * ── What this is for ──
 *
 * The application can run on PostgreSQL; that is a different claim from "the
 * data can be moved there". This does the move and then checks it, because a
 * migration that reports success is worth nothing next to one that can show
 * row counts, primary keys and foreign keys matching on both sides.
 *
 * ── Safety ──
 *
 * The source is opened READ-ONLY, so this cannot damage the database it reads
 * however badly it goes wrong. The target must be empty of application tables
 * unless `--force` is given: refusing to write into a populated database is
 * what stops a second run from doubling every table, and re-running is exactly
 * what somebody does when the first attempt half-failed.
 *
 * ── Why foreign keys are disabled during the load and re-checked after ──
 *
 * Rows are copied table by table, so a child can arrive before its parent. The
 * alternative is a topological order over the FK graph, which this schema does
 * not admit cleanly — `users` and `organizations` reference each other through
 * nullable columns. `session_replication_role = replica` suspends the triggers
 * for the load, and every constraint is then VALIDATED afterwards, which is
 * strictly stronger than trusting an insertion order: it re-checks all of them
 * against all the data, rather than each row as it lands.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
/**
 * `--source` falls back to `WEV_DB_PATH`, like every other tool in `bin/`.
 *
 * The variable is what the rest of the system uses to name "the database this
 * deployment means", and a migration tool that ignored it would be the one
 * command able to read a different database from everything around it —
 * precisely the bug `docs/audits/04-PRIVILEGED-CLI-DATABASE-TARGET.md` records.
 * Defaulting to it is safe here in a way it would not be for a writer: the
 * source is opened READ-ONLY below, so the worst case is reading the wrong
 * database, never damaging one.
 *
 * `--target` has no default on purpose. There is no "the PostgreSQL database
 * this deployment means" yet, and guessing one is how a dry run lands somewhere
 * real.
 */
const SOURCE = arg('source') ?? process.env.WEV_DB_PATH;
const TARGET = arg('target');

if (!SOURCE || !TARGET) {
  console.error('usage: --source <sqlite.db|$WEV_DB_PATH> --target <postgres-url> [--apply] [--force]');
  process.exit(2);
}

const REPO = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(REPO, 'noop.js'));
const { default: pg } = await import(pathToFileURL(req.resolve('pg')).href);

const sqlite = new DatabaseSync(SOURCE, { readOnly: true });
const pool = new pg.Pool({ connectionString: TARGET, max: 1 });
const client = await pool.connect();

/* `bigint`/`numeric` as JavaScript numbers, matching the application adapter,
   so counts compare as numbers rather than strings on one side only. */
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const q = (sql, params = []) => client.query(sql, params);
const ident = (n) => `"${n.replace(/"/g, '""')}"`;

const sourceTables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(r => r.name);

const targetTables = (await q(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
)).rows.map(r => r.table_name);

function sortTablesByDependency(db, tableNames) {
  const set = new Set(tableNames);
  const deps = new Map();
  for (const t of tableNames) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${ident(t)})`).all();
    deps.set(t, new Set(fks.map(f => f.table).filter(target => set.has(target) && target !== t)));
  }
  const ordered = [];
  const placed = new Set();
  while (ordered.length < tableNames.length) {
    const ready = tableNames.filter(t => !placed.has(t) && [...deps.get(t)].every(d => placed.has(d)));
    if (ready.length === 0) {
      const remaining = tableNames.filter(t => !placed.has(t));
      ordered.push(...remaining);
      break;
    }
    for (const r of ready) {
      ordered.push(r);
      placed.add(r);
    }
  }
  return ordered;
}

const shared = sortTablesByDependency(sqlite, sourceTables.filter(t => targetTables.includes(t)));
const onlySource = sourceTables.filter(t => !targetTables.includes(t));
const onlyTarget = targetTables.filter(t => !sourceTables.includes(t));

console.log(`source tables ${sourceTables.length}   target tables ${targetTables.length}   shared ${shared.length}`);
if (onlySource.length) console.log(`  only in SQLite    : ${onlySource.join(', ')}`);
if (onlyTarget.length) console.log(`  only in PostgreSQL: ${onlyTarget.join(', ')}`);

/* ── Refuse to load into a populated target ───────────────────────────────── */
let populated = [];
for (const t of shared) {
  const { rows } = t === 'schema_migrations'
    ? await q("SELECT COUNT(*)::int AS c FROM schema_migrations WHERE name <> 'postgres_baseline'")
    : await q(`SELECT COUNT(*)::int AS c FROM ${ident(t)}`);
  if (rows[0].c > 0) populated.push(`${t}(${rows[0].c})`);
}
if (populated.length && !FORCE) {
  console.error(`\nREFUSING: the target already holds rows in ${populated.length} table(s): ${populated.slice(0, 6).join(', ')}`);
  console.error('Re-running into a populated database duplicates it. Drop and recreate, or pass --force.');
  client.release(); await pool.end(); process.exit(1);
}

/* ── Copy ─────────────────────────────────────────────────────────────────── */
let replicaRoleSet = false;
if (APPLY) {
  try {
    await q("SET session_replication_role = 'replica'");
    replicaRoleSet = true;
  } catch {
    /* Non-superuser connection (e.g. Supabase, Neon, AWS RDS, Render, etc.).
       Tables are sorted in dependency order so foreign keys are naturally satisfied. */
    console.log('Note: session_replication_role could not be set (non-superuser); relying on dependency-ordered load.');
  }
  await q('BEGIN');
}

try {
  if (APPLY && shared.includes('schema_migrations')) {
    const sourceHistory = sqlite
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    if (sourceHistory > 0) {
      await q("DELETE FROM schema_migrations WHERE name = 'postgres_baseline'");
    }
  }

  const report = [];
  let copied = 0, nullIds = [];

  for (const table of shared) {
    const cols = sqlite.prepare(`PRAGMA table_info(${ident(table)})`).all();
    const names = cols.map(c => c.name);
    const pk = cols.filter(c => c.pk > 0).map(c => c.name);

    const rows = sqlite.prepare(`SELECT ${names.map(ident).join(', ')} FROM ${ident(table)}`).all();

    for (const r of rows) {
      for (const c of pk) if (r[c] === null || r[c] === undefined) nullIds.push(`${table}.${c}`);
    }

    if (APPLY && rows.length) {
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const params = [];
        const tuples = slice.map((r) => {
          const ph = names.map((n) => { params.push(r[n] ?? null); return `$${params.length}`; });
          return `(${ph.join(', ')})`;
        });
        await q(
          `INSERT INTO ${ident(table)} (${names.map(ident).join(', ')}) VALUES ${tuples.join(', ')}`,
          params,
        );
      }
    }
    copied += rows.length;
    report.push({ table, rows: rows.length, pk });
  }

  console.log(`\n${APPLY ? 'COPIED' : 'WOULD COPY'} ${copied} rows across ${shared.length} tables`);
  if (nullIds.length) {
    const counts = nullIds.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
    console.log(`\nNULL PRIMARY KEYS (PostgreSQL rejects these):`);
    for (const [k, n] of counts) console.log(`  ${k}: ${n}`);
  } else {
    console.log('NULL primary keys: none');
  }

  /* ── Resynchronise identity sequences ─────────────────────────────────────── */
  if (APPLY) {
    const { rows: identities } = await q(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = current_schema() AND is_identity = 'YES'
       ORDER BY table_name, column_name
    `);

    const resynced = [];
    for (const { table_name: table, column_name: column } of identities) {
      const { rows } = await q(
        `SELECT setval(
                  pg_get_serial_sequence($1, $2),
                  COALESCE((SELECT MAX(${ident(column)}) FROM ${ident(table)}), 0) + 1,
                  false
                ) AS next_value`,
        [table, column]
      );
      resynced.push(`${table}.${column} → ${rows[0].next_value}`);
    }

    console.log(identities.length
      ? `\nidentity sequences resynchronised: ${resynced.join(', ')}`
      : '\nidentity sequences: none in this schema');
  }

  /* ── Verify ───────────────────────────────────────────────────────────────── */
  if (APPLY) {
    console.log('\n── verification ──');
    const mismatches = [];

    for (const { table_name: t, column_name: c } of (await q(`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND is_identity = 'YES'
    `)).rows) {
      const { rows: seqName } = await q('SELECT pg_get_serial_sequence($1, $2) AS s', [t, c]);
      const { rows: state } = await q(`
        SELECT COALESCE((SELECT MAX(${ident(c)}) FROM ${ident(t)}), 0) AS max_id,
               (SELECT last_value FROM ${seqName[0].s}) AS last_value,
               (SELECT is_called  FROM ${seqName[0].s}) AS is_called
      `);
      const maxId = Number(state[0].max_id);
      const nextId = Number(state[0].last_value) + (state[0].is_called ? 1 : 0);
      if (nextId <= maxId) {
        mismatches.push(
          `${t}.${c}: next id would be ${nextId} but MAX(${c}) is ${maxId} — `
          + 'the next insert would collide'
        );
      }
    }

    for (const { table, rows, pk } of report) {
      const { rows: got } = await q(`SELECT COUNT(*)::int AS c FROM ${ident(table)}`);
      if (got[0].c !== rows) mismatches.push(`${table}: source ${rows} -> target ${got[0].c}`);

      if (pk.length === 1 && rows > 0) {
        const src = new Set(sqlite.prepare(`SELECT ${ident(pk[0])} AS k FROM ${ident(table)}`).all().map(r => String(r.k)));
        const dst = new Set((await q(`SELECT ${ident(pk[0])} AS k FROM ${ident(table)}`)).rows.map(r => String(r.k)));
        const missing = [...src].filter(k => !dst.has(k));
        const extra = [...dst].filter(k => !src.has(k));
        if (missing.length || extra.length) {
          mismatches.push(`${table}: ${missing.length} ids missing, ${extra.length} unexpected`);
        }
      }
    }

    console.log(mismatches.length ? `ROW/ID MISMATCHES:\n  ${mismatches.join('\n  ')}` : 'row counts and primary keys: all match');

    const { rows: fks } = await q(`
      SELECT
        c.conname AS constraint_name,
        c.conrelid::regclass::text AS child_table,
        c.confrelid::regclass::text AS parent_table,
        (SELECT json_agg(attname ORDER BY array_position(c.conkey, attnum))
           FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = ANY(c.conkey)) AS child_columns,
        (SELECT json_agg(attname ORDER BY array_position(c.confkey, attnum))
           FROM pg_attribute WHERE attrelid = c.confrelid AND attnum = ANY(c.confkey)) AS parent_columns
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace
      ORDER BY c.conname
    `);
    const broken = [];
    for (const fk of fks) {
      const joinConds = fk.child_columns.map((cc, idx) => `c.${ident(cc)} = p.${ident(fk.parent_columns[idx])}`).join(' AND ');
      const notNullConds = fk.child_columns.map(cc => `c.${ident(cc)} IS NOT NULL`).join(' AND ');
      const nullParentConds = fk.parent_columns.map(pc => `p.${ident(pc)} IS NULL`).join(' AND ');
      const checkSql = `
        SELECT COUNT(*)::int AS count
        FROM ${fk.child_table} c
        LEFT JOIN ${fk.parent_table} p ON ${joinConds}
        WHERE ${notNullConds} AND ${nullParentConds}
      `;
      try {
        const { rows } = await q(checkSql);
        if (rows[0].count > 0) {
          broken.push(`${fk.child_table}.${fk.constraint_name}: ${rows[0].count} orphaned rows referencing missing ${fk.parent_table}`);
        }
      } catch (e) {
        broken.push(`${fk.child_table}.${fk.constraint_name}: verification failed: ${e.message}`);
      }
    }
    console.log(broken.length ? `FOREIGN KEYS FAILING:\n  ${broken.join('\n  ')}` : `foreign keys: all ${fks.length} validate`);

    process.exitCode = (mismatches.length || broken.length || nullIds.length) ? 1 : 0;
  }

  if (APPLY) {
    if (process.exitCode === 1) {
      await q('ROLLBACK');
      console.error('\nROLLBACK: migration failed verification');
    } else {
      await q('COMMIT');
    }
    if (replicaRoleSet) {
      try { await q("SET session_replication_role = 'origin'"); } catch {}
    }
  }
} catch (err) {
  if (APPLY) {
    try { await q('ROLLBACK'); } catch {}
    if (replicaRoleSet) {
      try { await q("SET session_replication_role = 'origin'"); } catch {}
    }
  }
  throw err;
} finally {
  client.release();
  await pool.end();
  sqlite.close();
}
