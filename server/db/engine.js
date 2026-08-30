import { readFileSync } from 'node:fs';

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
 * Opened 2026-08-18, after the production boot rehearsal it was waiting for.
 *
 * A single constant rather than a scattered set of checks, so "is PostgreSQL
 * supported" has exactly one answer and turning it on is one reviewable line.
 *
 * ── What was required, and what was done ──
 *
 * The three original conditions — an engine-selecting `db.js`, a PostgreSQL
 * schema path, and the dialect translated — are each pinned by a test below.
 * The fourth, added when the first three were met, was the one thing the suite
 * could not provide: an actual production boot. `startTestServer` applies the
 * schema directly and starts none of `initDatabase()` ->
 * `completeDatabaseInit()` -> `assertSchemaReady()`, the instance lock, the
 * notification sweep or the workers.
 *
 * That boot was run: `NODE_ENV=production`, no harness override, against a
 * scratch database holding 7,024 migrated rows. It applied the schema, verified
 * hours-ledger parity for 400 volunteers, issued 400 certificates, checked 12
 * legal documents against their pinned hashes, started the worker and the
 * scheduler, reached listening, and answered `/health` with connected and
 * writable. Authentication, authorization refusals, hours read AND write,
 * organizations, moderation, notifications, 2FA status and directory search
 * were all exercised against the running server.
 *
 * ── It was not a formality: it found two defects the suite could not ──
 *
 *   1. `db.js` ran its SQLite path checks before resolving the engine, so a
 *      relative `WEV_DB_PATH` — which the pilot's own .env carries — made a
 *      PostgreSQL boot exit with `FATAL: WEV_DB_PATH must be an absolute path`.
 *      The first cutover attempt would have failed on a setting it never reads.
 *   2. Express 4 does not catch rejected async handlers, so one failing request
 *      became `unhandledRejection` and drained the whole process. 51 of 206
 *      async handlers had no try/catch. `GET /api/organizations` ended the
 *      server three requests into the session.
 *
 * Both are fixed and covered. Opening this flag records that the engineering
 * evidence exists; it does not claim the deployment has served real traffic.
 */
export const POSTGRES_READY = true;

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
   * Pool size, PER PROCESS.
   *
 * ── Measured, not reasoned ──
 *
 * This was 10, and the argument for it was that "PostgreSQL does not go faster
 * when handed more concurrent connections than it has cores to serve them
 * with". That is true of CPU-bound queries and it is the wrong model here: over
 * a network a pooled client spends most of its life waiting on a round trip, not
 * on database CPU, so the pool has to be sized for requests in flight rather
 * than for cores.
 *
 * `bin/load-test.mjs --latency-profile same-region --soak 45 --pool-max N`, at
 * 20 concurrent HTTP connections and a 3ms round trip:
 *
 *      pool    req/s     p50      p95      p99   peak waiting
 *         5     67.7   203ms   1027ms   1164ms       19
 *        10    127.2   120ms    481ms    526ms       17
 *        15    269.2    56ms    161ms    194ms       13
 *        20    403.4    37ms     97ms    106ms        9
 *        25    486.8    29ms     73ms     80ms        5
 *        40    501.8    24ms     58ms     64ms        0
 *
 * 25 takes ~97% of the achievable throughput and drops p95 by 6.6x against the
 * old default; past it the curve is flat. With NO injected latency the same
 * sweep is noise (863 / 1011 / 706 / 871 req/s at 10 / 20 / 30 / 50), because
 * loopback makes the application's own event loop the bottleneck instead — which
 * is exactly why the old number looked defensible for as long as it did.
 *
 * ── It still has a ceiling, and the ceiling is per process ──
 *
 * Supabase's Nano and Micro sizes allow 60 direct connections and 200 Supavisor
 * pooler clients. 25 leaves room for eight instances against the pooler, or two
 * against a direct connection — which is another reason to use the pooler.
   */
  const max = Number(env.DATABASE_POOL_MAX ?? 25);
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error(`FATAL: DATABASE_POOL_MAX="${env.DATABASE_POOL_MAX}" must be an integer between 1 and 100.`);
  }

  /* TLS on by default for anything that is not plainly local. A managed
     PostgreSQL reached over the internet without TLS sends the password and
     every student record in clear text, and defaulting to off would make that
     the accidental configuration rather than a chosen one. */
  let isLocal = false;
  try {
    const u = new URL(connectionString);
    isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
      || u.hostname === '::1' || u.hostname === '[::1]';
  } catch {
    isLocal = /(?:@|:\/\/)(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  }
  const sslDisabled = env.DATABASE_SSL === 'false' || (isLocal && env.DATABASE_SSL !== 'true');

  /**
   * Certificate verification, and why a CA has to be supplied for Supabase.
   *
   * Supabase does not use a public CA. It presents
   *
   *     db.<ref>.supabase.co  ->  Supabase Intermediate 2021 CA  ->  Supabase Root 2021 CA
   *
   * and that root is self-signed and absent from Node's trust store, so a
   * verifying connection fails with SELF_SIGNED_CERT_IN_CHAIN. The root is a
   * public certificate, not a secret; `deploy/certs/supabase-root-2021.crt`
   * carries it, and `DATABASE_SSL_CA` points at it (a path, or the PEM inline
   * for platforms that only offer environment variables).
   *
   * With it supplied, `rejectUnauthorized` stays TRUE and the server's identity
   * is actually checked — which is the whole point. Without it the only way to
   * connect is to stop verifying, and a database holding minors' records must
   * not be reachable over a connection that cannot tell Supabase from anyone
   * holding the wire.
   */
  let ca;
  const caSource = env.DATABASE_SSL_CA;
  if (!sslDisabled && caSource) {
    ca = caSource.includes('BEGIN CERTIFICATE') ? caSource : readFileSync(caSource, 'utf8');
  }

  /**
   * The insecure hatch is refused in production rather than merely discouraged.
   *
   * It exists for a developer pointing at a local server with a throwaway
   * certificate. Reaching production with it set means every connection is
   * encrypted to an unverified peer, which reads as secure in a log and is not.
   * It was used once, deliberately, to establish the first Supabase connection
   * before the CA was in place; failing closed here is what stops that
   * temporary measure from quietly becoming the deployed configuration.
   */
  if (!sslDisabled && env.DATABASE_SSL_INSECURE === 'true' && env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: DATABASE_SSL_INSECURE=true in production disables TLS certificate\n'
      + '  verification, so the connection cannot tell the real database from an\n'
      + '  attacker holding the wire.\n'
      + '  Supply the provider CA instead:\n'
      + '    DATABASE_SSL_CA=deploy/certs/supabase-root-2021.crt\n'
      + '  and unset DATABASE_SSL_INSECURE.'
    );
  }

  return {
    connectionString,
    max,
    ssl: sslDisabled ? undefined : { rejectUnauthorized: env.DATABASE_SSL_INSECURE !== 'true', ...(ca ? { ca } : {}) },
  };
}
