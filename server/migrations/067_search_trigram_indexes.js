/**
 * Trigram indexes for the browse search box, on PostgreSQL only.
 *
 * ── What was slow ──
 *
 * The search box matches a typed string against four pieces of text: an event's
 * title, description and location, and its organizer's name. Every one of those
 * comparisons is "contains", and "contains" is the one string predicate a
 * b-tree cannot answer — a b-tree orders by prefix, and a substring has no
 * prefix. So the search read every event that survived the status filter and
 * evaluated four function calls on it: 93 ms at 50,000 events, the last O(n)
 * left on this endpoint after migration 066 removed the sort's.
 *
 * `pg_trgm` indexes text by its three-character subsequences, which is exactly
 * the shape of a substring question. `docs/operations/search-measurements.md`
 * carries the before-and-after plans.
 *
 * ── Why the query had to change too, and this index alone would have done
 *    nothing ──
 *
 * A GIN trigram index answers `LIKE`, not `strpos(...) > 0`, and it cannot
 * answer a disjunction that spans two tables at all. Both are handled in
 * `eventQuery.textMatchClause`, which this migration exists to serve; neither
 * half is useful without the other, and the query is correct (merely slower)
 * without the index — which is what makes it safe for this migration to decline
 * to create one.
 *
 * ── Why this may decline, and what happens then ──
 *
 * `CREATE EXTENSION` needs a privilege the application's own role may not have.
 * A migration that fails there fails the BOOT, and refusing to start over an
 * index is the wrong trade for a query that still returns correct rows without
 * it. So the extension is probed rather than attempted: if it is absent and
 * cannot be installed, this logs what is missing and records itself as applied.
 *
 * Probed and not `try`/`catch`ed, because on PostgreSQL a failed statement
 * aborts the whole transaction — the trap migration 066 fell into, where the
 * caught error still poisoned the `INSERT INTO schema_migrations` that followed
 * it.
 *
 * `bin/verify-search-indexes.mjs` reports which of these exist on a live
 * database, so "the search is slow" has an answer that does not require reading
 * this file.
 *
 * ── Deploying against a large table ──
 *
 * `CREATE INDEX` takes a lock that blocks writes to the table for as long as it
 * runs, and it runs inside the migration's transaction, so `CONCURRENTLY` is
 * not available here. At pilot scale this is milliseconds. An operator with a
 * large `events` table can create the four indexes by hand with
 * `CREATE INDEX CONCURRENTLY` using the names below, and this migration will
 * find them already there and do nothing.
 */

/** A schema name, quoted only when it needs to be. */
function qualify(schema) {
  return /^[a-z_][a-z0-9_$]*$/.test(schema) ? schema : `"${String(schema).replace(/"/g, '""')}"`;
}

/**
 * The schema `pg_trgm` lives in, or null when it is not installed and cannot be.
 *
 * The opclass has to be schema-qualified because the extension does not always
 * land in `public`: Supabase installs extensions into a schema called
 * `extensions`, which is on the search path for some roles and not others. An
 * unqualified `gin_trgm_ops` therefore works on a developer's machine and fails
 * on the deployment, which is the worst possible place to discover it.
 */
async function trigramSchema(db) {
  const [installed] = await db.prepare(`
    SELECT n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pg_trgm'
  `).all();
  if (installed?.schema) return installed.schema;

  const [can] = await db.prepare(`
    SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') AS available,
           current_setting('server_version_num')::int AS version_num,
           /* Supabase installs extensions into a schema called \`extensions\`,
              which is on the search path for the roles that matter and is the
              convention its own documentation asks for. Preferred when it is
              there and writable; \`public\` otherwise, which is what a plain
              PostgreSQL has. NOT the first schema on the search path, which is
              where an unqualified CREATE EXTENSION would land it — that put the
              opclass inside a test's private schema and it vanished with it. */
           (SELECT n.nspname FROM pg_namespace n
             WHERE n.nspname = 'extensions'
               AND has_schema_privilege(current_user, n.nspname, 'CREATE')) AS extensions_schema,
           has_schema_privilege(current_user, 'public', 'CREATE') AS public_writable
  `).all();

  const target = can?.extensions_schema ?? (can?.public_writable ? 'public' : null);

  /* pg_trgm is a TRUSTED extension from PostgreSQL 13, which is what lets a
     role that merely holds CREATE on the schema install it. Below 13 it needs
     superuser, and asking for it would be the failed statement this function
     exists to avoid. */
  if (!can?.available || !target || Number(can?.version_num) < 130000) {
    console.warn(
      '[migration 067] pg_trgm is not installed and cannot be installed by this role '
      + `(available=${Boolean(can?.available)}, writable_schema=${target ?? 'none'}, `
      + `server_version_num=${can?.version_num}). The search box stays correct and stays `
      + 'linear in event count. To fix: CREATE EXTENSION pg_trgm; then re-run this migration '
      + 'or create the indexes named in server/migrations/067_search_trigram_indexes.js.'
    );
    return null;
  }

  await db.prepare(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA ${qualify(target)}`).run();

  const [created] = await db.prepare(`
    SELECT n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pg_trgm'
  `).all();
  return created?.schema ?? null;
}


/** `[index name, table, column]`. Every index is `gin (lower(<column>) …)`. */
export const TRIGRAM_INDEXES = [
  ['idx_events_title_trgm', 'events', 'title'],
  ['idx_events_description_trgm', 'events', 'description'],
  ['idx_events_location_trgm', 'events', 'location'],
  ['idx_users_name_trgm', 'users', 'name'],
];

/**
 * Does this column exist, asked without risking the transaction?
 *
 * The table guard above is not enough. `migrations.postgres.test.js` provisions
 * a database from a PARTIAL baseline to prove that post-baseline migrations
 * apply in isolation, and the `events` it builds there is a stripped-down copy
 * — the table is present and the column is not. A `CREATE INDEX` on a missing
 * column raises 42703, and on PostgreSQL a raised statement aborts the whole
 * transaction, taking the `INSERT INTO schema_migrations` with it. Migration
 * 063 has the same shape of guard for the same reason.
 *
 * Named `columnExistsPg` and not `hasColumn`, which is what 063 calls its
 * SYNCHRONOUS version of this. `asyncShapes.test.js` builds a regex from every
 * async function name in the tree to catch `!f(x)` on a promise — a branch that
 * never runs — so an async function sharing a name with a synchronous one turns
 * that guard into a false positive on somebody else's correct code. It found
 * this immediately, which is the guard working.
 */
async function columnExistsPg(db, table, column) {
  const [row] = await db.prepare(`
    SELECT COUNT(*)::int AS n
      FROM pg_attribute
     WHERE attrelid = to_regclass(?) AND attname = ? AND NOT attisdropped AND attnum > 0
  `).all(table, column);
  return Number(row?.n ?? 0) > 0;
}

export default {
  version: 67,
  name: 'search_trigram_indexes',
  fileUrl: import.meta.url,

  /**
   * Nothing in this migration reaches the generated PostgreSQL schema, so a
   * FRESH PostgreSQL database has to run it rather than record it.
   *
   * `postgresSchema.js` is derived from a booted SQLite database, and the
   * SQLite half below is deliberately empty — so without this flag a new
   * deployment would mark 064 applied, create no indexes, and search linearly
   * for ever while every test passed. See `seedPostgresBaseline`.
   */
  postgresOnly: true,

  /**
   * SQLite gets nothing, and that is the whole SQLite half.
   *
   * There is no trigram index in `node:sqlite`, and FTS5 — the thing SQLite
   * does have — answers a different question: it matches words, not substrings,
   * so adopting it would change what the search box finds. The predicate stays
   * `instr(...)`, which on the pilot's few hundred events is the right plan
   * regardless. The two engines are not obliged to be fast in the same way,
   * only to agree on the answer, and `search.eventQuery.test.js` is where that
   * agreement is asserted.
   */
  up() {},

  postgres: {
    async up(db) {
      const [present] = await db.prepare(`
        SELECT to_regclass('events') IS NOT NULL AS events,
               to_regclass('users')  IS NOT NULL AS users
      `).all();
      if (!present?.events || !present?.users) return;

      const schema = await trigramSchema(db);
      if (!schema) return;

      const ops = `${qualify(schema)}.gin_trgm_ops`;
      for (const [name, table, column] of TRIGRAM_INDEXES) {
        if (!await columnExistsPg(db, table, column)) continue;
        await db.prepare(
          `CREATE INDEX IF NOT EXISTS ${name} ON ${table} USING gin (lower(${column}) ${ops})`
        ).run();
      }
    },
  },
};
