import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Kept as literals rather than imported from server/db/engine.js: that module
    throws on an unrunnable engine at import time, which is a rule about serving
    traffic and must not stop an operator repairing a database. */
const SQLITE_ENGINE = 'sqlite';
const POSTGRES_ENGINE = 'postgres';

/**
 * Which database a privileged command-line script is about to change.
 *
 * ── The incident ──
 *
 * The four privileged scripts — `grant-ownership`, `revoke-ownership`,
 * `make-admin`, `bootstrap-owners` — each resolved their own path with
 *
 *     process.env.WEV_DB_PATH || path.join(__dirname, '..', 'server', 'wevolunteer.db')
 *
 * and were invoked as plain `node bin/grant-ownership.mjs`. Plain `node` does not
 * read `.env`; only `--env-file-if-exists` does, and every entry point that has
 * it — `server` start, `server` dev, `verify:hours`, `db:reset:dev` — is an npm
 * script. These four were the only entry points in the repository without it.
 *
 * So on a machine whose `.env` sets `WEV_DB_PATH=./pilot.db`, the server ran
 * against `pilot.db` and `bin/grant-ownership.mjs` wrote to
 * `server/wevolunteer.db`. Two different files, no warning, exit code 0.
 *
 * That is worse than it sounds for one specific reason: `bin/grant-ownership.mjs`
 * is the *only* sanctioned way to create an owner. An operator would run it, read
 * "Successfully granted ownership", sign in, and still not be an owner — with the
 * grant sitting in a stale database nobody looks at, and the audit row proving it
 * happened sitting there too.
 *
 * It was found because `assertSystemActor` refused: the stale file predated
 * migration 022, so it had no `system-cli` row. That is luck, not design. On a
 * stale file that *had* run 022, the write would have succeeded silently.
 *
 * ── What this module does about it ──
 *
 * Three things, in order of how much they matter:
 *
 *   1. **Reads `.env`**, so the scripts resolve the same path the server does.
 *   2. **Refuses to create a database.** `new DatabaseSync(p)` creates the file
 *      when it is absent — which is how a typo in a path becomes a brand-new
 *      empty database that every subsequent query answers "not found" from. A
 *      privileged script must never be the thing that invents a database.
 *   3. **Says which file it opened**, on every run, before doing anything. The
 *      whole failure above is invisibility; the cheapest durable fix is for the
 *      operator to be told.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const DEFAULT_DB = path.join(SERVER_DIR, 'wevolunteer.db');

/**
 * The second half of the same incident, and the half that had already done damage.
 *
 * `.env` in this repository says:
 *
 *     WEV_DB_PATH=../pilot.db
 *
 * A relative path means nothing on its own — it resolves against the current
 * working directory, and the two callers do not share one. `npm run dev` runs the
 * server from `server/`, so `../pilot.db` is the repository root's `pilot.db`: 23
 * migrations, 18 users, the live database. A `bin/` script runs from the
 * repository root, so the same six characters mean `../pilot.db` one level HIGHER
 * — outside the repository entirely.
 *
 * That file exists on this machine. It has 15 migrations and 14 users. It is not a
 * copy anybody made; it is the fossil of earlier privileged commands writing to a
 * database that `new DatabaseSync` created for them because it was absent, at a
 * time when the repository had 15 migrations. The bug had already run.
 *
 * So a relative value is resolved against `server/` — deliberately not against
 * the repository root, and not against `process.cwd()`:
 *
 *   - `server/` is how the value is *already* interpreted by the process that
 *     owns the data. Choosing any other anchor would silently repoint whichever
 *     side currently agrees with the operator's intent, and the server is the
 *     side that must not move.
 *   - `process.cwd()` is the property that caused this. Two correct programs
 *     reading one config value must not disagree because of where they were
 *     launched from.
 *
 * An absolute value is used as given, which is what the tests pass and what a
 * deployment should set.
 */
function anchorRelative(value) {
  return path.isAbsolute(value) ? value : path.resolve(SERVER_DIR, value);
}

/**
 * Load the repository-root `.env` into `process.env`, if there is one.
 *
 * An explicit `WEV_DB_PATH` in the environment wins over the file. That is the
 * same precedence `node --env-file` applies, and it is the precedence the tests
 * and `reset-dev-db.mjs` depend on — both set the variable deliberately and must
 * not have a stray `.env` override them.
 */
function loadDotEnv() {
  /**
   * A value the CALLER set wins over `.env`, for the engine and the URL as well
   * as the path.
   *
   * Only `WEV_DB_PATH` used to be preserved. Once a deployment put
   * `DATABASE_ENGINE=postgres` and a production `DATABASE_URL` into `.env`,
   * `process.loadEnvFile` overwrote whatever the caller had set — so
   *
   *     DATABASE_ENGINE=sqlite node bin/reset-2fa.mjs someone@example.org
   *
   * silently operated on PRODUCTION instead of the local database the operator
   * named. That is the same defect this module was written for: a privileged
   * command quietly acting on a database nobody meant.
   *
   * Caught by six privileged-CLI suites the moment a real `DATABASE_URL`
   * appeared in `.env`, which is exactly when it would have started to matter.
   */
  const explicit = {
    WEV_DB_PATH: process.env.WEV_DB_PATH,
    DATABASE_ENGINE: process.env.DATABASE_ENGINE,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  const envFile = path.join(REPO_ROOT, '.env');

  if (fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      /* A malformed `.env` must not stop an ownership revocation. Fall through to
         the explicit value or the default, both of which are still safe because
         the existence check below is what actually prevents damage. */
    }
  }

  for (const [key, value] of Object.entries(explicit)) {
    /* An explicitly EMPTY value is a deliberate "unset this" and is honoured as
       such — a test proving a command fails closed without a URL cannot have
       `.env` hand one back. */
    if (value !== undefined) process.env[key] = value;
  }

  /**
   * Naming a FILE and being sent to a SERVER are contradictory instructions, and
   * the caller's is the specific one.
   *
   * The loop above only protects variables the caller actually set. A caller
   * that says `WEV_DB_PATH=/tmp/scratch.db` has said everything it thinks it
   * needs to — it named the database — and never mentions `DATABASE_ENGINE`, so
   * `.env` still supplied one. That is not a hypothetical: it is exactly how two
   * `super_admin` accounts were written into the production database on
   * 2026-08-19. `ownerBootstrap.test.js` spawns `bin/bootstrap-owners.mjs` with
   * `WEV_DB_PATH` pointed at a throwaway file, `.env` carried a production
   * `DATABASE_ENGINE`/`DATABASE_URL`, and the tool announced the Supabase host
   * and created the accounts there.
   *
   * Reproduced after the first fix and still broken, which is why this second
   * rule exists: preserving what the caller SET was not enough, because the
   * dangerous case is the variable the caller never mentions.
   *
   * So an explicit `WEV_DB_PATH` with no explicit `DATABASE_ENGINE` pins the
   * engine to SQLite. A caller that genuinely wants PostgreSQL says so —
   * production sets `DATABASE_ENGINE` in its own environment, and that path is
   * untouched because the value is then caller-explicit.
   */
  if (explicit.WEV_DB_PATH !== undefined && explicit.DATABASE_ENGINE === undefined) {
    process.env.DATABASE_ENGINE = 'sqlite';
  }
  return process.env.WEV_DB_PATH || DEFAULT_DB;
}

/**
 * Open the active database for a privileged script, or exit non-zero explaining
 * why not.
 *
 * Exits rather than throwing: every caller is a top-level script whose only
 * response to "I cannot tell which database this is" is to stop, and a stack
 * trace is not what the operator needs to read at that moment.
 *
 * @param {string} command  e.g. `bin/grant-ownership.mjs`, used in the messages.
 * @returns {{ db: DatabaseSync, dbPath: string }}
 */
export async function openPrivilegedDb(command) {
  /**
   * Whether the CALLER named the file, read BEFORE `loadDotEnv()` mutates
   * `process.env`.
   *
   * This is the whole basis of the guard below, and it has to be sampled here:
   * a moment later `.env`'s value is indistinguishable from one the operator
   * typed, which is exactly the confusion that made the hazard possible.
   */
  const callerNamedPath = process.env.WEV_DB_PATH !== undefined;
  const dbPath = anchorRelative(loadDotEnv());
  const engine = (process.env.DATABASE_ENGINE ?? SQLITE_ENGINE).trim().toLowerCase();

  /**
   * PostgreSQL, when the deployment is on PostgreSQL.
   *
   * These scripts are the emergency path, not a convenience. `bin/reset-2fa.mjs`
   * is the ONLY way to clear a locked-out account's two-factor enrolment — every
   * `/api/2fa/*` route is self-service behind `requireAAL2`, so you must already
   * hold a second factor to remove one — and REQUIRE_ADMIN_2FA defaults on. A
   * PostgreSQL deployment without working tooling is a deployment where a lost
   * authenticator is unrecoverable, including for an administrator.
   *
   * Deliberately NOT gated on `POSTGRES_READY`. That flag governs whether the
   * server may SERVE TRAFFIC on PostgreSQL; it has nothing to say about whether
   * an operator may repair a database. Gating here would make the cutover
   * rehearsal impossible and would keep the tooling broken for exactly as long
   * as the flag is false, which is the window in which it is most needed.
   *
   * The application's own connection class and placeholder translator are reused
   * rather than reimplemented: identical SQL through an identical adapter is the
   * only way these commands are guaranteed to mean the same thing the server
   * would mean by them.
   */
  if (engine === POSTGRES_ENGINE) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.error('Refused: DATABASE_ENGINE=postgres but DATABASE_URL is not set.');
      console.error('');
      console.error('  There is nothing to connect to, and this script will not guess.');
      process.exit(1);
    }

    /**
     * The production-database guard, applied to the privileged path too.
     *
     * `server/db/engine.js` calls this before it builds a pool, and this module
     * deliberately does NOT import engine.js — see the note at the top: that
     * module throws on an unrunnable engine at import time, which is a rule
     * about serving traffic and must not stop an operator repairing a database.
     *
     * The consequence was that the guard covered the server and skipped the six
     * scripts that can grant ownership, promote an administrator, suspend an
     * account and clear a second factor. That is the wrong way round: these run
     * with the most privilege and the least supervision, and the incident this
     * file records twice over is a privileged script writing to a database
     * nobody meant.
     *
     * Safe to import here because `productionDatabaseGuard.js` imports nothing
     * but `node:crypto` — no `db`, no config, nothing that can throw on load.
     * `assertNotProductionDatabase` is inert until
     * `WEV_PRODUCTION_DB_FINGERPRINT` is set, so this changes nothing for a
     * deployment that has not opted in.
     */
    const { assertNotProductionDatabase } = await import('../server/db/productionDatabaseGuard.js');
    try {
      const guard = assertNotProductionDatabase(process.env, connectionString);
      if (guard.warning) console.warn(guard.warning);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const { PostgresDatabase } = await import('../server/db/postgresConnection.js');
    const { translatePlaceholders } = await import('../server/db/sqlPlaceholders.js');

    /* Two connections is more than a single-threaded script can use. A CLI that
       opens the server's ten would sit on a meaningful slice of a small
       deployment's pool while it waits at a confirmation prompt. */
    const db = new PostgresDatabase({
      connectionString,
      translate: translatePlaceholders,
      max: 2,
    });
    const close = () => db.close();

    /**
     * Never the whole URL: it carries the password, and these transcripts get
     * pasted into incident notes. Host and database name are what the operator
     * needs in order to answer "is that the right server".
     */
    let target = 'the configured PostgreSQL server';
    try {
      const u = new URL(connectionString);
      target = `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
    } catch { /* an unparseable URL still connects or fails loudly below */ }

    let reachable;
    try {
      reachable = await db.prepare(
        "SELECT to_regclass('users') IS NOT NULL AS has_users"
      ).get();
    } catch (err) {
      console.error(`Database: ${target}`);
      console.error(`Refused: could not query ${target}.`);
      console.error(`  ${err.message}`);
      await close();
      process.exit(1);
    }

    /* Same check the SQLite path makes, and for the same reason: a database
       without a `users` table makes every script below report "user not found"
       for a user who exists, which reads as a data problem rather than a
       wrong-database problem. */
    if (!reachable?.has_users) {
      console.error(`Database: ${target}`);
      console.error(`Refused: ${target} is not an initialised WeVolunteer database.`);
      console.error('It has no `users` table. Run the migration or start the server');
      console.error('against it once, or point DATABASE_URL at the right database.');
      await close();
      process.exit(1);
    }

    const migrations = await db.prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE to_regclass('schema_migrations') IS NOT NULL"
    ).get().catch(() => ({ n: 0 }));

    console.log(`Database: ${target} (postgres, ${Number(migrations?.n ?? 0)} migrations applied)`);
    return { db, dbPath: target, engine, close };
  }

  /**
   * Which file the configuration resolved to, said the same way on every exit
   * path rather than only the successful one.
   *
   * A refusal is where the operator most needs the answer — "no database at X"
   * names the path in prose, but the question being asked is whether X is the
   * file they meant, and that is a question about resolution, not about the
   * refusal. The successful path announces after opening instead, so the
   * migration count can be part of the same line.
   */
  const announcePath = () => console.log(`Database: ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    announcePath();
    console.error(`Refused: no database at ${dbPath}`);
    console.error('');
    console.error('This script will not create one. A privileged command that');
    console.error('invents an empty database looks like it worked and changes');
    console.error('nothing that matters.');
    console.error('');
    console.error('Check WEV_DB_PATH in .env, or set it for this command:');
    console.error(`  WEV_DB_PATH=./pilot.db node ${command} ...`);
    process.exit(1);
  }

  /**
   * Fail closed when a file nobody named turns out to hold real people.
   *
   * ── The hazard ──
   *
   * `.env` carried `WEV_DB_PATH=../pilot.db`. Every script in this directory
   * resolves through `loadDotEnv()`, so from `server/` that string is the
   * repository root's `pilot.db` — the real pilot database, holding minors'
   * service records. The default target of every privileged command was
   * therefore live data, and each command was protected only by whatever guard
   * it had thought to add for itself. Some had a typed confirmation, some a
   * blocklist of file NAMES, and three had nothing.
   *
   * ── Why provenance is the right test, and not the path ──
   *
   * A name blocklist answers "is this file called pilot.db". The question worth
   * asking is "did anybody actually choose this file". An operator who types
   *
   *     WEV_DB_PATH=./pilot.db node bin/reset-2fa.mjs someone@example.org
   *
   * has chosen it, and that is the emergency path this module exists to keep
   * working — `bin/reset-2fa.mjs` is the only way to clear a locked-out
   * administrator's second factor. Refusing them would be the guard causing the
   * outage. Whereas a command that inherited the path from a file, and finds
   * two owner accounts and eighteen audit records behind it, has found live data
   * by accident.
   *
   * So: caller-explicit is allowed, inherited-and-non-disposable is refused.
   *
   * ── Why content and not size or mtime ──
   *
   * `describeNonDisposableContent` looks for markers a fresh demo seed cannot
   * produce: `super_admin` accounts, deleted-account tombstones, administrative
   * audit rows. A size or age heuristic would refuse a large demo database and
   * admit a small real one, which is the wrong failure in both directions. It
   * reads counts only — no record is read out of the file, which matters
   * because the thing being protected is exactly that content.
   *
   * ── The override ──
   *
   * `WEV_ALLOW_REAL_DATA=1`, distinct from
   * `WEV_ALLOW_DESTROYING_REAL_DATA=1` in `bin/lib/db-safety.mjs`. They are
   * different permissions: one says "operate on live data", the other says
   * "destroy it", and a runbook step that needs the first must not silently
   * confer the second.
   */
  if (!callerNamedPath && process.env.WEV_ALLOW_REAL_DATA !== '1') {
    const { describeNonDisposableContent } = await import('./lib/db-safety.mjs');
    const realData = describeNonDisposableContent(dbPath);
    if (realData) {
      announcePath();
      console.error(`Refused: ${dbPath} holds real data and nothing on this`);
      console.error('command line asked for it.');
      console.error('');
      console.error(`  found: ${realData}`);
      console.error('');
      console.error('The path came from `.env` or the built-in default, not from');
      console.error('this invocation. A privileged command acting on live records');
      console.error('by inheritance is the incident this module already records');
      console.error('twice over.');
      console.error('');
      console.error('If you meant a scratch database, name it:');
      console.error(`  WEV_DB_PATH=/tmp/scratch.db node ${command} ...`);
      console.error('');
      console.error('If you genuinely meant this one, say so explicitly — either');
      console.error('by naming it on the command line, which is preferred because');
      console.error('it is visible in the transcript:');
      console.error(`  WEV_DB_PATH=${dbPath} node ${command} ...`);
      console.error('or, for a runbook step that cannot pass the path:');
      console.error(`  WEV_ALLOW_REAL_DATA=1 node ${command} ...`);
      process.exit(1);
    }
  }

  const db = new DatabaseSync(dbPath);

  /**
   * A WeVolunteer database has a `users` table. A backup opened by mistake, a
   * half-initialised file, or an unrelated SQLite file does not — and every
   * script here would otherwise report "user not found" for a user who exists,
   * which reads as a data problem rather than a wrong-file problem.
   */
  const hasUsers = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).get().n;

  if (!hasUsers) {
    announcePath();
    console.error(`Refused: ${dbPath} is not an initialised WeVolunteer database.`);
    console.error('It has no `users` table. Start the server against it once so');
    console.error('the migrations run, or point WEV_DB_PATH at the right file.');
    process.exit(1);
  }

  /* Announced on every run, including the successful ones. The operator has to be
     able to see, in the transcript, which file they changed. */
  const migrations = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get().n
    ? db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n
    : 0;

  console.log(`Database: ${dbPath} (${migrations} migrations applied)`);

  /* `close` exists on both engines so a caller never has to ask which it got.
     On SQLite it is nearly a formality; on PostgreSQL an unclosed pool keeps
     the event loop alive and the script hangs after printing success. */
  return { db, dbPath, engine, close: () => db.close() };
}

/** Exported for the test that pins the fallback, so it cannot drift silently. */
export const DEFAULT_DB_PATH = DEFAULT_DB;
