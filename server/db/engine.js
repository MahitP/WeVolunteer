/**
 * Which database engine this process uses.
 *
 * `DATABASE_ENGINE=sqlite` (the default) or `postgres`. The variable exists now,
 * ahead of the engine being usable, so that the contract is fixed before the
 * ~653 call sites start being converted against it — a switch introduced
 * afterwards would mean converting twice.
 *
 * ── Why selecting `postgres` currently refuses to boot ──
 *
 * The adapter in `postgresConnection.js` is finished and tested: statements,
 * transactions, pooling and isolation all behave. The async port is finished
 * too — every application query site awaits, and `asyncShapes.test.js` keeps
 * them that way. Neither of those is what is missing, and this comment used to
 * say otherwise: it named the synchronous call sites as the blocker, which
 * would now read as "the blocker is gone, flip the constant".
 *
 * What IS missing is one thing, and it is no longer in the application:
 *
 *   The application has never been executed against PostgreSQL. `db.js` now
 *   selects its engine, `postgresSchema.js` creates the schema, the dialect is
 *   translated down to six constructs in files that hold raw SQLite handles by
 *   design — and none of that is the same as a request having been served. The
 *   remaining precondition is the PostgreSQL application suite passing, which
 *   is what `WEV_POSTGRES_APP_TEST` below exists to make possible.
 *
 * The original reason for refusing still holds and is worth restating: the
 * failure mode being avoided is not a crash but a server that starts, serves,
 * and is wrong.
 *
 * ── The one exception, and why it is not a hole ──
 *
 * There is now a legitimate reason to run the application against PostgreSQL
 * before the gate opens: proving that it works. That proof is the gate's own
 * remaining precondition, and it cannot be produced without running.
 *
 * So `harnessOverride` exists. It requires BOTH `VITEST` (set by the test runner
 * in every worker, and by nothing else) AND an explicitly named
 * `WEV_POSTGRES_APP_TEST=1`, and it is refused outright when `NODE_ENV` is
 * `production`. A deployment cannot satisfy the first condition at all, so this
 * is not the "override to be found by someone debugging at the wrong moment"
 * the previous version of this comment refused to add — it is unreachable
 * outside a test runner, and `db.engine.test.js` asserts each condition
 * independently.
 */

export const SQLITE = 'sqlite';
export const POSTGRES = 'postgres';

const VALID = new Set([SQLITE, POSTGRES]);

/**
 * Whether this process is the PostgreSQL application test harness.
 *
 * Three conditions, all required. `VITEST` is set by the runner in each worker
 * and by nothing that ships; `WEV_POSTGRES_APP_TEST` has to be asked for by
 * name; and production is refused regardless of the other two, so even a
 * process that somehow had both could not use this to serve traffic.
 */
export function harnessOverride(env = process.env) {
  if (env.NODE_ENV === 'production') return false;
  return Boolean(env.VITEST) && env.WEV_POSTGRES_APP_TEST === '1';
}

/**
 * Reads and validates the selection.
 *
 * An unrecognised value is refused rather than defaulted. `DATABASE_ENGINE=postgre`
 * silently falling back to SQLite is how a deployment comes to believe it
 * migrated; a typo should stop the boot, the same way `config.js` treats every
 * other setting whose absence is undetectable at runtime.
 */
export function resolveEngine(env = process.env) {
  const raw = (env.DATABASE_ENGINE ?? SQLITE).trim().toLowerCase();

  if (!VALID.has(raw)) {
    throw new Error(
      `FATAL: DATABASE_ENGINE="${env.DATABASE_ENGINE}" is not a known engine.\n`
      + `       Valid values are "${SQLITE}" (default) and "${POSTGRES}".\n`
      + '       Refusing to fall back silently: a typo here would look exactly\n'
      + '       like a successful migration.'
    );
  }

  if (raw === POSTGRES && !POSTGRES_READY && !harnessOverride(env)) {
    throw new Error(
      'FATAL: DATABASE_ENGINE=postgres is not runnable yet.\n'
      + '\n'
      + '  This message used to say the application had never served a request\n'
      + '  against PostgreSQL. That stopped being true: the full application suite\n'
      + '  runs against a real PostgreSQL server through the real Express app --\n'
      + '  4,800+ tests including transactions, pool concurrency, capacity under\n'
      + '  parallel load, and a cross-engine parity diff on migrated data.\n'
      + '\n'
      + '  What has NOT happened is a production BOOT. `server.js` does more than\n'
      + '  the harness does: initDatabase() -> completeDatabaseInit() ->\n'
      + '  assertSchemaReady(), the single-instance lock, the notification sweep\n'
      + '  and the workers. The harness applies the schema directly and starts\n'
      + '  none of that, so the boot sequence itself is the part with no evidence.\n'
      + '\n'
      + '  That is one experiment, not a programme of work: run the production boot\n'
      + '  against a migrated scratch database, confirm it reaches listening and\n'
      + '  that /health reports connected and writable, then this line is an\n'
      + '  owner decision rather than an engineering one.\n'
      + '\n'
      + '  Progress and remaining work: POSTGRES_MIGRATION_STATUS.md (phase 10).\n'
      + '  To run the application suite against PostgreSQL:\n'
      + '    TEST_POSTGRES_URL=postgres://…/db npm run test:postgres\n'
      + '  To exercise the adapter itself, run its tests with TEST_POSTGRES_URL set.'
    );
  }

  return raw;
}

/**
 * Flipped to `true` by the change that makes PostgreSQL actually runnable —
 * engine wiring, a schema path, and the dialect translated. Not by the change
 * that finishes the async port: that one has landed, and this is still false.
 *
 * A single constant rather than a scattered set of checks, so "is PostgreSQL
 * supported" has exactly one answer and turning it on is one reviewable line.
 */
export const POSTGRES_READY = false;

/**
 * Connection settings for the PostgreSQL engine.
 *
 * Read lazily rather than at module load: `config.js` fails closed on missing
 * values at import time, which is right for settings the process always needs,
 * and wrong for one engine's settings when the other engine is selected.
 */
export function postgresConfig(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'FATAL: DATABASE_ENGINE=postgres requires DATABASE_URL.\n'
      + '       It must never be a VITE_-prefixed variable: those are compiled into\n'
      + '       the browser bundle, and this string contains the database password.'
    );
  }

  /**
   * Pool size. Ten, deliberately, and not larger.
   *
   * This is one Node process — `instanceLock.js` enforces that — with three
   * background workers and a scheduler. PostgreSQL does not go faster when given
   * more concurrent connections than it has cores to serve them with, and a
   * managed provider meters direct connections besides. If a pooler sits in
   * front, the client-side pool competes with it rather than adding throughput.
   */
  const max = Number(env.DATABASE_POOL_MAX ?? 10);
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error(`FATAL: DATABASE_POOL_MAX="${env.DATABASE_POOL_MAX}" must be an integer between 1 and 100.`);
  }

  /* TLS on by default for anything that is not plainly local. A managed
     PostgreSQL reached over the internet without TLS sends the password and
     every student record in clear text, and defaulting to off would make that
     the accidental configuration rather than a chosen one. */
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  const sslDisabled = env.DATABASE_SSL === 'false' || (isLocal && env.DATABASE_SSL !== 'true');

  return {
    connectionString,
    max,
    ssl: sslDisabled ? undefined : { rejectUnauthorized: env.DATABASE_SSL_INSECURE !== 'true' },
  };
}
