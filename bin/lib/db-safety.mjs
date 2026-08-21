/**
 * Shared safety gate for the destructive development CLIs in bin/.
 *
 * ── Why this is one module and not three copies ──
 *
 * `bin/reset-dev-db.mjs` already had the right guards: refuse
 * `NODE_ENV=production`, print the target path before touching it, and demand a
 * typed confirmation. `bin/seed-pilot.js` and `bin/simulate-pilot.js` had none of
 * them — and seed-pilot went further and set `process.env.NODE_ENV =
 * 'development'` itself, so the one signal that says "this is a real deployment"
 * was overwritten before anything could check it. It then called
 * `fs.unlinkSync(dbPath)` on whatever `WEV_DB_PATH` named.
 *
 * That is one command away from deleting a production database:
 *
 *     WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db node bin/seed-pilot.js
 *
 * and `bin/` ships to `/srv/wevolunteer/bin/` because that is where the backup
 * timer invokes `backup.sh` from, so the script is present on the production host.
 *
 * The lesson from audit finding F-1 is the reason this is shared rather than
 * copied: the demo-reset endpoint destroyed the database because a hand-maintained
 * list drifted from reality every time someone added a table. A hand-copied safety
 * guard drifts the same way. Three scripts importing one gate cannot disagree
 * about what "production" means, and a fourth script added later gets the same
 * behaviour by importing the same function.
 */
import { existsSync } from 'fs';
import path from 'path';
import readline from 'readline';
import { DatabaseSync } from 'node:sqlite';

/**
 * Roots that indicate a real deployment rather than a workstation.
 *
 * Derived from the layout the deployment runbook actually specifies: code at
 * `/srv/wevolunteer`, database at `/var/lib/wevolunteer`, secrets at
 * `/etc/wevolunteer`.
 */
const PRODUCTION_ROOTS = ['/var/lib/', '/srv/', '/opt/', '/etc/', '/usr/local/share/', '/usr/share/'];

/**
 * Temp roots that must stay usable, checked BEFORE the production roots.
 *
 * This ordering is load-bearing on macOS, where `os.tmpdir()` returns
 * `/var/folders/…`. A naive `/var/` prefix check would refuse every temporary
 * database — including the ones this module's own tests create — and the failure
 * would look like a broken guard rather than an over-eager one.
 */
const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/tmp/', '/var/folders/', '/private/var/folders/'];

/**
 * Describes why a path looks like production, or null if it does not.
 *
 * Advisory by nature — a heuristic cannot know every deployment layout — so it is
 * deliberately paired with the NODE_ENV check rather than relied on alone. Between
 * them, the realistic mistakes are covered: an operator with the deployment's
 * environment loaded trips the NODE_ENV check, and an operator who exported only
 * `WEV_DB_PATH` trips this one.
 */
export function describeProductionLikePath(dbPath) {
  const resolved = path.resolve(dbPath);

  /**
   * The explicit-name check runs FIRST, ahead of the temp-directory allowance.
   *
   * Ordering matters and was wrong the first time: a file the operator has named
   * `wevolunteer-production.db` is a deliberate label, and it stays a refusal
   * wherever it happens to sit. Checking the temp roots first meant a path under
   * `/var/folders` (macOS's tmpdir) was waved through before anyone looked at the
   * name — caught by the "refuses a path whose own name says production" test.
   *
   * Scoped to the filename and its immediate parent, so a home directory that
   * contains "prod" in some unrelated ancestor segment does not trip it.
   */
  const base = path.basename(resolved).toLowerCase();
  const parent = path.basename(path.dirname(resolved)).toLowerCase();
  if (/prod|production|live/.test(base) || /prod|production|live/.test(parent)) {
    return `its name contains "prod"/"production"/"live" (${path.basename(resolved)})`;
  }

  // Temp roots are explicitly permitted. This has to come before the deployment
  // roots below because macOS `os.tmpdir()` returns `/var/folders/…`, and a naive
  // `/var/` prefix rule would refuse every throwaway database — including the
  // ones this module's own tests build.
  for (const root of TEMP_ROOTS) {
    if (resolved.startsWith(root)) return null;
  }

  for (const root of PRODUCTION_ROOTS) {
    if (resolved.startsWith(root)) {
      return `it is under ${root}, which is a deployment location, not a workstation one`;
    }
  }

  return null;
}

/**
 * Content markers that identify a database as real rather than disposable.
 *
 * ── Why a path heuristic was not enough ──
 *
 * `describeProductionLikePath` asks where a file sits and what it is called. The
 * pilot database sits at the repository root and is called `pilot.db`, so it
 * answers "workstation, innocuous name" to both questions and every check above
 * waves it through. `docs/operations/demo-reset.md` then described that exact
 * file as disposable and told the operator to run `bin/seed-pilot.js` against it.
 * Following the documentation as written would have deleted both owner accounts,
 * the demo-administrator tombstone, and the append-only administrative audit
 * trail — and the typed confirmation would not have helped, because the operator
 * types the filename believing the file is disposable. A prompt cannot correct a
 * false belief about what the file *is*.
 *
 * So this check asks the only question that actually distinguishes them: what is
 * *in* it. The three markers below were chosen by seeding a scratch database with
 * `bin/seed-pilot.js` and diffing it against the live pilot database, because
 * guessing produces a guard that blocks ordinary development:
 *
 *   marker                      fresh demo seed   live pilot
 *   super_admin accounts              0               2
 *   non-system tombstones             0               2
 *   admin_audit_logs rows             0               5
 *
 * `hours_ledger` deliberately is NOT a marker. A fresh seed writes five rows to
 * it, so using it would refuse every legitimate demo reset — which is how a
 * safety guard gets disabled by the people it protects.
 */
const NON_DISPOSABLE_MARKERS = [
  {
    sql: "SELECT COUNT(*) AS c FROM users WHERE role = 'super_admin'",
    describe: c => `${c} owner (super_admin) account${c === 1 ? '' : 's'}`
  },
  {
    // `system-cli` is a reserved actor row seeded by migration 022 and is
    // deliberately `account_status = 'deleted'`, so it must be excluded or every
    // freshly seeded database looks like it has deletion history.
    sql: "SELECT COUNT(*) AS c FROM users WHERE account_status = 'deleted' AND id <> 'system-cli'",
    describe: c => `${c} deleted-account tombstone${c === 1 ? '' : 's'}`
  },
  {
    sql: 'SELECT COUNT(*) AS c FROM admin_audit_logs',
    describe: c => `${c} administrative audit record${c === 1 ? '' : 's'}`
  }
];

/**
 * Describes why a database holds real data, or null if it looks disposable.
 *
 * Read-only and forgiving by design: a missing file, an empty file, or a schema
 * without these tables all mean "nothing here to protect", which is the correct
 * answer for a database that is about to be created for the first time.
 */
export function describeNonDisposableContent(dbPath) {
  if (!existsSync(dbPath)) return null;

  let db;
  try {
    db = new DatabaseSync(`file:${path.resolve(dbPath)}?mode=ro`, {});
  } catch {
    // Not a readable SQLite database — nothing to protect.
    return null;
  }

  const found = [];
  try {
    for (const marker of NON_DISPOSABLE_MARKERS) {
      try {
        const { c } = db.prepare(marker.sql).get();
        if (c > 0) found.push(marker.describe(c));
      } catch {
        // Table absent on this schema version. Absence is not evidence of real
        // data, so it is skipped rather than treated as either answer.
      }
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }

  return found.length ? found.join(', ') : null;
}

/**
 * Refuses a database whose contents say it is not disposable.
 *
 * The override is an environment variable rather than a flag because it must be
 * impossible to reach by pasting a documented command line. `--yes` appears in
 * the documentation for legitimate reasons; this must not.
 */
export function refuseNonDisposableDatabase({ tool, dbPath, effect }) {
  const reason = describeNonDisposableContent(dbPath);
  if (!reason) return;

  if (process.env.WEV_ALLOW_DESTROYING_REAL_DATA === '1') {
    console.warn(`WARNING: ${dbPath} contains real data (${reason}).`);
    console.warn('Proceeding only because WEV_ALLOW_DESTROYING_REAL_DATA=1 is set.');
    return;
  }

  console.error(`REFUSING: ${dbPath}`);
  console.error('');
  console.error(`  That database contains real data — ${reason}.`);
  console.error(`  ${tool} only ever runs against a disposable demo database.`);
  console.error('');
  console.error(`  What it would have done: ${effect}`);
  console.error('');
  console.error('  A demo database seeded by this tool has none of those records, so');
  console.error('  this file is a pilot or production database, not a scratch one.');
  console.error('');
  console.error('  To reset a demo environment, point WEV_DB_PATH at a throwaway file:');
  console.error(`    WEV_DB_PATH=/tmp/wevolunteer-demo.db node ${tool === 'pilot data seed' ? 'bin/seed-pilot.js' : '<tool>'}`);
  console.error('');
  console.error('  To restore a real deployment, restore from a backup instead:');
  console.error('  docs/operations/pilot-deployment-runbook.md § Backup strategy.');
  process.exit(1);
}

/**
 * Refuses to continue in a production process.
 *
 * Called first in every destructive script, before any check that could fail for
 * a duller reason — an operator who has made this mistake needs to be told which
 * mistake it was, not that a file was missing.
 */
export function refuseProduction({ tool, effect }) {
  if (process.env.NODE_ENV !== 'production') return;

  console.error(`REFUSING: NODE_ENV=production. ${tool} is a development tool.`);
  console.error('');
  console.error(`  What it would have done: ${effect}`);
  console.error('');
  console.error('  It seeds accounts that share a single password documented in');
  console.error('  docs/operations/pilot-credentials.md, including an administrator.');
  console.error('  Running it against a real deployment would both destroy the live');
  console.error('  records and install a known-password admin login.');
  console.error('');
  console.error('  To restore a real deployment, restore from a backup instead:');
  console.error('  docs/operations/pilot-deployment-runbook.md § Backup strategy.');
  process.exit(1);
}

/**
 * Refuses to run when the environment points at anything but a local SQLite file.
 *
 * ── The hole this closes ──
 *
 * Every other gate in this file reasons about a FILE: `resolveDbPath` returns a
 * path, `describeProductionLikePath` inspects that path, and
 * `describeNonDisposableContent` opens it as a SQLite database and counts rows.
 * All three are correct and all three are blind on PostgreSQL, where the target
 * is a URL and the path is a file that does not exist. A missing file reads as
 * "nothing to protect", so the content check returned `null` and the gate
 * opened.
 *
 * What that meant in practice, measured on 2026-08-19 rather than reasoned
 * about: with `DATABASE_ENGINE=postgres` and a `DATABASE_URL` exported —
 * the exact shell state the PostgreSQL runbook tells an operator to create —
 * `bin/reset-dev-db.mjs --yes` passed all three gates, created 65 tables and
 * seeded 15 demo accounts, including an administrator, all sharing the password
 * published in `docs/operations/pilot-credentials.md`. `NODE_ENV` was unset,
 * which is the normal state of an operator's shell, so the production gate
 * never fired either.
 *
 * These tools delete and reseed. There is no version of them that should reach
 * a PostgreSQL deployment, so the refusal is unconditional on engine rather than
 * another heuristic about which database it is — heuristics are what the other
 * three gates already are, and this is the case they cannot see.
 */
export function refuseNonSqliteEngine({ tool, effect }) {
  const engine = (process.env.DATABASE_ENGINE ?? 'sqlite').trim().toLowerCase();
  const hasUrl = typeof process.env.DATABASE_URL === 'string'
    && process.env.DATABASE_URL.trim() !== '';

  if (engine === 'sqlite' && !hasUrl) return;

  console.error('REFUSING: this environment points at a PostgreSQL database.');
  console.error('');
  if (engine !== 'sqlite') console.error(`  DATABASE_ENGINE=${engine}`);
  /* The URL is NOT printed. It carries the password. */
  if (hasUrl) console.error('  DATABASE_URL is set.');
  console.error('');
  console.error(`  ${tool} only ever runs against a disposable local SQLite file.`);
  console.error(`  What it would have done: ${effect}`);
  console.error('');
  console.error('  It seeds accounts that share a single published password, including');
  console.error('  an administrator, so against a deployment it installs known logins.');
  console.error('');
  console.error('  To reset a local development database, clear the PostgreSQL settings');
  console.error('  for this command:');
  console.error(`    env -u DATABASE_ENGINE -u DATABASE_URL node ${tool.startsWith('bin/') ? tool : 'bin/<tool>'}`);
  process.exit(1);
}

/** Refuses a path that looks like a deployment database, whatever NODE_ENV says. */
export function refuseProductionLikePath({ tool, dbPath }) {
  const reason = describeProductionLikePath(dbPath);
  if (!reason) return;

  console.error(`REFUSING: ${dbPath}`);
  console.error('');
  console.error(`  That looks like a production database — ${reason}.`);
  console.error(`  ${tool} is a development tool and will not touch it.`);
  console.error('');
  console.error('  If this really is a scratch database, move it somewhere under your');
  console.error('  home directory or /tmp and point WEV_DB_PATH at it there.');
  process.exit(1);
}

/**
 * Resolves the database path the same way `server/db.js` does.
 *
 * Shared so a tool can never operate on a different file from the one the
 * application opens — the failure mode audit finding F-5 hit, where
 * `verifyHours.js` confidently reported PASS about a stale file nobody was using.
 */
export function resolveDbPath(defaultAbsolute) {
  return process.env.WEV_DB_PATH
    ? path.resolve(process.cwd(), process.env.WEV_DB_PATH)
    : defaultAbsolute;
}

/** Prints what is about to happen, before it happens. */
export function announce({ tool, dbPath, effect }) {
  console.log(`WeVolunteer — ${tool}`);
  console.log('');
  console.log(`  Database: ${dbPath}`);
  console.log(`  Exists:   ${existsSync(dbPath) ? 'yes' : 'no'}`);
  console.log(`  NODE_ENV: ${process.env.NODE_ENV || '(unset)'}`);
  console.log('');
  console.log(`  ${effect}`);
  console.log('');
}

/**
 * Demands a typed confirmation naming the database.
 *
 * The answer is the filename rather than "y" for two reasons: it cannot be given
 * by reflex, and it cannot be given for the wrong database. `--yes` exists so
 * tests and scripted setup do not hang; without it, a non-TTY stdin refuses
 * rather than blocking forever on a prompt nobody can see.
 */
export async function confirmDestructive({ dbPath, assumeYes }) {
  if (assumeYes) return true;

  if (!process.stdin.isTTY) {
    console.error('REFUSING: no confirmation given and stdin is not a terminal.');
    console.error('Re-run with --yes if you really mean to do this.');
    return false;
  }

  const expected = path.basename(dbPath);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve =>
    rl.question(`Type "${expected}" to confirm: `, a => { rl.close(); resolve(a); })
  );

  if (answer.trim() !== expected) {
    console.error('Cancelled — that did not match. Nothing was changed.');
    return false;
  }
  return true;
}

/** True when the invocation carries an explicit non-interactive confirmation. */
export function hasYesFlag(argv = process.argv.slice(2)) {
  return argv.includes('--yes') || argv.includes('-y');
}

/**
 * The whole gate, in the order it must run.
 *
 * Exits the process on refusal so a caller cannot accidentally continue past a
 * failed check by ignoring a return value.
 */
export async function guardDestructive({ tool, dbPath, effect, assumeYes = hasYesFlag() }) {
  refuseProduction({ tool, effect });
  /* Before every path-shaped check, because those all reason about a file and
     this is the case where the target is not a file at all. */
  refuseNonSqliteEngine({ tool, effect });
  refuseProductionLikePath({ tool, dbPath });
  // Content check runs before the prompt, not after: the prompt asks the operator
  // to confirm a belief, and this is the check that tests whether the belief is
  // true. It must also sit ahead of `--yes`, which skips the prompt entirely.
  refuseNonDisposableDatabase({ tool, dbPath, effect });
  announce({ tool, dbPath, effect });
  if (!(await confirmDestructive({ dbPath, assumeYes }))) process.exit(1);
}
