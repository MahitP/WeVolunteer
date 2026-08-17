/**
 * Global setup: reclaims the throwaway directories the server suites leave in the
 * system temp directory.
 *
 * Runs BEFORE the suites, not after, and that is deliberate. Vitest calls a
 * `globalSetup` module's default export on the way in, and cleaning on the way in
 * is what makes the age threshold below work: this run's own directories are
 * minutes old when it finishes, so they are reclaimed by the NEXT run rather than
 * by this one. Growth stays bounded, and nothing is ever deleted while a suite
 * might still hold it open.
 *
 * ── The leak ──
 *
 * 55 server suites call `mkdtempSync(path.join(tmpdir(), '<prefix>'))` to get a
 * disposable SQLite file, and roughly a dozen of them never remove it — including
 * the heaviest: `email.reliability`, `routes.exportDownload` (which writes real
 * export ZIPs), `dbPathGuard`, `impact`, `ownershipBootstrap` and
 * `migrations.administratorRoster`. Every `npm test` run therefore left a few
 * dozen directories behind, and they accumulate for as long as the machine's temp
 * directory survives. Measured at 9,121 directories before this existed.
 *
 * Production is unaffected — systemd runs the service with `PrivateTmp=true`, so
 * its temp directory is destroyed on restart, and exports were deliberately moved
 * out of `os.tmpdir()` for exactly that reason. This is a developer- and
 * CI-machine problem: unbounded disk growth, and a CI runner with a small volume
 * eventually fails for a reason that has nothing to do with the change under test.
 *
 * ── Why one hook rather than 55 `afterAll` blocks ──
 *
 * Adding cleanup to each suite is 55 edits, each with its own chance of removing a
 * directory while a connection still holds the database open — which fails on some
 * platforms and would turn a hygiene fix into flakiness. This runs once, before
 * any suite starts, touches only directories old enough that no live run could own
 * one, and swallows every error — so it cannot affect the outcome of a test.
 *
 * ── Why an age threshold ──
 *
 * This checkout is shared by more than one concurrently running session, and they
 * share `os.tmpdir()`. Deleting everything matching the prefixes would delete a
 * sibling run's live databases mid-test. Only directories older than
 * `MIN_AGE_MS` are removed: a concurrent run's are seconds old and therefore
 * untouched, while the backlog — and this run's own, on the next invocation — is
 * reclaimed. Growth becomes bounded instead of monotonic, which is the actual
 * requirement.
 */
import { readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Prefixes the suites actually use, enumerated rather than matched loosely.
 *
 * A bare `wev-` glob would be both too broad (it would catch a sibling session's
 * stress-test databases) and too narrow (four suites use prefixes that do not
 * start with `wev-`). Anything not listed here is left alone: this teardown
 * deletes only what this test suite is known to create.
 */
const PREFIXES = [
  'wev-', 'clear-stale-tfa-', 'make-admin-test-',
];

/** Old enough that no live run could own it. */
const MIN_AGE_MS = 30 * 60 * 1000;

/**
 * Drops PostgreSQL schema namespaces left behind by earlier runs.
 *
 * The harness gives each test FILE its own `wev_t_…` schema and drops it in
 * `srv.close()`. A file that dies in `beforeAll` never reaches that, so the
 * namespace survives — and they accumulate: 89 of them had built up in
 * `wv_app_test`.
 *
 * That is not merely untidy. `db.postgresSchema.test.js` compares foreign keys
 * across the catalogue, and with 89 stale namespaces to walk it went from
 * passing to timing out at fifteen seconds — a failure that looked like a
 * schema disagreement and was actually accumulated litter. The same run passed
 * against `wv_adapter`, which had none.
 *
 * Safe to run here and nowhere else: `globalSetup` executes once, before any
 * worker starts, so nothing can be holding a namespace when this runs. Doing it
 * per-file would let one worker drop a schema another is using.
 *
 * Opportunistic throughout — a cleanup that fails a test run is worse than
 * litter.
 */
async function dropStaleSchemas() {
  const url = process.env.TEST_POSTGRES_URL;
  if (!url) return;

  let pg;
  try { pg = (await import('pg')).default; } catch { return; }

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const { rows } = await client.query(
      "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'wev\\_t\\_%'"
    );
    for (const { nspname } of rows) {
      /* Identifier interpolated, not bound: PostgreSQL takes no parameter in
         DDL. The value comes from its own catalogue and matched the prefix
         pattern above, so it cannot carry anything else. */
      await client.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
    }
    if (rows.length) {
      console.log(`[test cleanup] dropped ${rows.length} stale PostgreSQL schema namespace(s)`);
    }
  } catch {
    /* No server, no permission, or a race with another run. Opportunistic. */
  } finally {
    try { await client.end(); } catch { /* already gone */ }
  }
}

export default async function reclaimStaleTempDirs() {
  await dropStaleSchemas();
  const dir = tmpdir();
  let removed = 0;
  let reclaimed = 0;
  const cutoff = Date.now() - MIN_AGE_MS;

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // No temp directory to read is not a test failure.
  }

  for (const name of entries) {
    if (!PREFIXES.some(p => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs > cutoff) continue; // A live run may own it.
      let size = 0;
      try { size = st.size; } catch { /* size is a nicety, not a requirement */ }
      rmSync(full, { recursive: true, force: true });
      removed++;
      reclaimed += size;
    } catch {
      /* Vanished under us, or not ours to delete. Either way this is opportunistic
         cleanup and must never fail a test run. */
    }
  }

  if (removed > 0) {
    console.log(`[test cleanup] removed ${removed} stale temp director${removed === 1 ? 'y' : 'ies'} from ${dir}`);
  }
}
