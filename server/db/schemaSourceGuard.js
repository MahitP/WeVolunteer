/**
 * Refuse a database whose tables were created by a DIFFERENT schema source.
 *
 * ── The two sources, and why they are not interchangeable ──
 *
 * `supabase/migrations/*_baseline_schema.sql` was generated from `pilot.db`
 * during the SQLite-to-PostgreSQL migration and translated into idiomatic
 * PostgreSQL types. This file keeps the types the APPLICATION uses, which are
 * deliberately SQLite-compatible so one codebase serves both engines:
 * timestamps as TEXT (ISO-8601 strings written by JS, never `datetime('now')`
 * — see reauth.js), and booleans as INTEGER 0/1.
 *
 * Measured, not estimated: the two disagree on **150 columns**, in two
 * systematic classes —
 *
 *     ~130 timestamps   this file TEXT          baseline TIMESTAMPTZ
 *      ~20 booleans     this file INTEGER       baseline BOOLEAN
 *
 * and the baseline is additionally missing `events.hours_closed_out_at/by`.
 *
 * ── Why this cannot be left to `CREATE TABLE IF NOT EXISTS` ──
 *
 * It cannot repair a table that already exists with the wrong types — it is a
 * no-op, by definition. So a database provisioned from the baseline keeps
 * BOOLEAN columns, and the application then runs `WHERE present = 1` against
 * them. PostgreSQL answers:
 *
 *     operator does not exist: boolean = integer
 *
 * The first failure actually observed was worse than that, because it surfaced
 * on an unrelated column during seeding:
 *
 *     column "verified" is of type boolean but expression is of type integer
 *
 * — which names neither the cause nor the fix, and sends an operator looking at
 * `users.verified` instead of at how the database was created.
 *
 * The silent variant is worse still. `pg` returns BOOLEAN as JavaScript `true`,
 * and `hoursLedger.js` credits with `present === 1`. `true === 1` is false, so
 * a database that got far enough to serve traffic would credit every attending
 * volunteer **zero hours** — the derived-hours invariant, broken quietly.
 *
 * ── What this checks ──
 *
 * Two sentinel columns, one from each divergence class, on tables that have
 * existed since the baseline. Cheap, and sufficient: the two classes are
 * systematic, so a database is either entirely one source or entirely the
 * other. An empty database has neither and passes straight through.
 */
export async function assertSchemaSourceCompatible(db) {
  const SENTINELS = [
    { table: 'attendance', column: 'present',    expected: 'integer', wrong: 'boolean' },
    { table: 'users',      column: 'created_at', expected: 'text',    wrong: 'timestamp with time zone' },
  ];

  for (const s of SENTINELS) {
    const row = await db.prepare(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`
    ).get(s.table, s.column);

    /* No table yet: a fresh database, which is the normal path. */
    if (!row) continue;
    if (row.data_type === s.expected) continue;

    throw new Error(
      'FATAL: this database was created by a different schema source.\n\n'
      + `  ${s.table}.${s.column} is ${row.data_type}; this application requires ${s.expected}.\n\n`
      + '  That is the signature of a database provisioned from\n'
      + '  supabase/migrations/*_baseline_schema.sql, which is a HISTORICAL\n'
      + '  artefact of the SQLite migration and is NOT how production is built.\n'
      + '  It differs from the application schema on ~150 columns: timestamps as\n'
      + '  TIMESTAMPTZ rather than TEXT, and booleans as BOOLEAN rather than\n'
      + '  INTEGER 0/1.\n\n'
      + '  CREATE TABLE IF NOT EXISTS cannot repair those types, so continuing\n'
      + '  would fail on "operator does not exist: boolean = integer" — or, worse,\n'
      + '  credit every attending volunteer zero hours, because pg returns BOOLEAN\n'
      + '  as true and the ledger credits on `present === 1`.\n\n'
      + '  Point DATABASE_URL at an EMPTY database and start the application: it\n'
      + '  creates its own schema. Do not run the baseline migration by hand.'
    );
  }
}

