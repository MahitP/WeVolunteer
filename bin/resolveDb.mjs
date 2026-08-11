import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const explicit = process.env.WEV_DB_PATH;
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

  if (explicit) process.env.WEV_DB_PATH = explicit;
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
export function openPrivilegedDb(command) {
  const dbPath = anchorRelative(loadDotEnv());

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

  return { db, dbPath };
}

/** Exported for the test that pins the fallback, so it cannot drift silently. */
export const DEFAULT_DB_PATH = DEFAULT_DB;
