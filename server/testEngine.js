/**
 * Which engine the suite is running against, for the few tests that legitimately
 * only apply to one of them.
 *
 * ── The bar for using this ──
 *
 * Skipping a test because it fails on PostgreSQL is how a migration comes to
 * look finished. Almost every failure this migration has produced was a fixture
 * or a real defect, not an engine difference, and each one that looked like an
 * exception turned out not to be. So `RUNNING_ON_POSTGRES` is not for "this is
 * awkward on PostgreSQL" — it is for a test whose SUBJECT does not exist there.
 *
 * There is exactly one such subject today: the SQLite migration mechanism.
 * `initDatabase()` returns before running a single migration when the engine is
 * PostgreSQL — the schema is applied whole from the generated
 * `db/postgresSchema.js` instead, because the 56 migrations include 14 SQLite
 * table-rebuild dances that exist to work around things PostgreSQL does not
 * have. A test asserting that migration 001 wrote a `schema_migrations` row,
 * recreated three indexes and left `PRAGMA foreign_keys` on is asking about
 * machinery that never ran.
 *
 * ── Why this loses no PostgreSQL coverage ──
 *
 * The migrations exist to produce a schema, and the schema is what the
 * application depends on. `db.postgresSchema.test.js` verifies that schema
 * against a live PostgreSQL directly: same tables, same columns in the same
 * order with the same nullability, same type families, same primary keys,
 * foreign keys, unique indexes and triggers — and then that the translated
 * GUARANTEES still hold there, including case-insensitive email uniqueness,
 * audit-log immutability, write-once appeal statements and the retention
 * window.
 *
 * So the outcome is tested on PostgreSQL and the mechanism is tested on SQLite,
 * which is where the mechanism is. Marking a file with this is a statement that
 * its subject is the mechanism; if it also covers behaviour, split the file
 * rather than skipping the behaviour with it.
 */
import { harnessOverride } from './db/engine.js';

/**
 * True when the application under test is on PostgreSQL.
 *
 * Derived from the same `harnessOverride()` the engine itself uses, rather than
 * from `TEST_POSTGRES_URL` — the URL being *set* only means a PostgreSQL server
 * is reachable, which is also true during a plain SQLite run that has the
 * adapter tests enabled. What matters here is which engine the APPLICATION
 * opened, and that is exactly what `harnessOverride()` decides.
 */
export const RUNNING_ON_POSTGRES = harnessOverride();

/**
 * The reason string to hand a reader who finds one of these skipped.
 *
 * Kept next to the flag so the explanation cannot drift away from the mechanism
 * that applies it.
 */
export const SQLITE_MIGRATION_ONLY =
  'PostgreSQL never replays the SQLite migrations — it applies the generated '
  + 'schema whole — so this file\'s subject does not exist there. The resulting '
  + 'schema and its guarantees are verified on PostgreSQL by db.postgresSchema.test.js.';
