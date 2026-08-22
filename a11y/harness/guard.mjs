import path from 'node:path';
import fs from 'node:fs';
import {
  resolveDbPath,
  refuseProduction,
  refuseNonSqliteEngine,
  refuseProductionLikePath,
  refuseNonDisposableDatabase
} from '../../bin/lib/db-safety.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRATCH = path.join(ROOT, 'scratch');

/** A sentinel no real path resolves to, so an unset variable cannot default. */
const UNSET = ' unset';

/**
 * Refuses any database this harness must not drive a browser through, and
 * returns the one it may.
 *
 * Order, and why it is this order:
 *
 *   1. refuseProduction        — first, because it is the check that must not
 *      be reachable past, and it needs no dbPath to run.
 *   2. refuseNonSqliteEngine   — also needs no dbPath; with
 *      DATABASE_ENGINE=postgres a file path is irrelevant and every check
 *      after it would be inspecting the wrong thing.
 *   3. the unset check         — must come before resolveDbPath() is called
 *      for real, because an unset WEV_DB_PATH is exactly the case whose
 *      "default" is server/wevolunteer.db, a real developer database.
 *   4. the absolute check      — a relative path means a different file from
 *      every working directory this harness runs processes in.
 *   5. refuseProductionLikePath / refuseNonDisposableDatabase — the same two
 *      checks bin/reset-dev-db.mjs composes, in its order, now that dbPath
 *      exists.
 *   6. the scratch-containment check — LAST. Checking it earlier meant a path
 *      outside scratch/ was refused for being outside scratch/ even when it
 *      was ALSO a production path or a database full of real accounts —
 *      hiding the more specific, more useful refusal behind a generic one.
 *      The cost of running it last is that a database outside scratch/ may be
 *      read before this check ever gets to refuse it — acceptable, because
 *      reading is precisely how refuseNonDisposableDatabase proves a database
 *      is disposable, it is what the other three tools already do, and
 *      refuseProductionLikePath has already rejected production-looking paths
 *      by that point.
 */
export function assertScratchDatabase({ tool }) {
  const effect = 'delete that database, reseed it, and drive a browser through it';

  refuseProduction({ tool, effect });
  refuseNonSqliteEngine({ tool, effect });

  /* Deliberately NOT resolveDbPath's default. The default is
     server/wevolunteer.db, a real developer database; silently auditing it is
     the failure this refusal exists for. */
  const raw = process.env.WEV_DB_PATH;
  if (raw === undefined || raw === '') {
    refuse(tool, 'WEV_DB_PATH is not set.',
      'This harness has no default database on purpose: the default would be\n'
      + '  server/wevolunteer.db, which holds real local accounts.\n'
      + `  Point WEV_DB_PATH at an absolute path under ${SCRATCH}.`);
  }

  if (!path.isAbsolute(raw)) {
    refuse(tool, `WEV_DB_PATH="${raw}" is not absolute.`,
      'A relative path means a different file from every working directory, and\n'
      + '  the harness starts processes in two of them (the root, and server/).');
  }

  const dbPath = resolveDbPath(UNSET);

  refuseProductionLikePath({ tool, dbPath });
  refuseNonDisposableDatabase({ tool, dbPath, effect });

  /* Containment is checked LAST, and it never creates the directory it is
     validating. The first version did — `mkdirSync` on the target's parent
     before deciding whether that parent was allowed — which crashed with
     EACCES on `/var/lib/...` and produced a stack trace where a refusal
     belonged. A gate that dies is not a gate. */
  const scratchReal = fs.realpathSync(ensureDir(SCRATCH));
  const parentPath = path.dirname(dbPath);
  /* realpath only an EXISTING parent: a symlink has to exist to be followed, so
     an absent parent cannot smuggle the target out of scratch/, and resolving
     it lexically is enough. This covers the PARENT only — a symlinked LEAF
     (scratch/leaf.db -> /elsewhere/fake.db) has a parent that sits correctly
     inside scratch/ and would sail through this check while pointing anywhere
     on disk. The lstat check below is what catches that case; this one alone
     is not the complete symlink defence. */
  const parent = fs.existsSync(parentPath) ? fs.realpathSync(parentPath) : path.resolve(parentPath);
  if (parent !== scratchReal && !parent.startsWith(scratchReal + path.sep)) {
    refuse(tool, `WEV_DB_PATH resolves to ${dbPath}, outside scratch/.`,
      `Artefacts are written beside the database, so it belongs under\n  ${SCRATCH}, which git already ignores.`);
  }

  /* The leaf itself, not just its parent. A scratch database has no reason to
     be a link, so any symlink here is refused outright rather than followed —
     which closes two escapes the parent check above cannot see: a symlinked
     LEAF whose own path sits inside scratch/ but whose target does not, and a
     DANGLING symlinked parent (existsSync follows the link, finds nothing, and
     reports "does not exist", which fell to the lexical branch above as if it
     were an ordinary absent file — even though something could appear at the
     link's target between this check and the reset that follows it).
     lstatSync, never statSync: statSync follows the link and would describe
     whatever it points to, not the link itself. */
  let leafStat = null;
  try {
    leafStat = fs.lstatSync(dbPath);
  } catch {
    // Genuinely does not exist yet — the ordinary first-run case.
  }
  if (leafStat && leafStat.isSymbolicLink()) {
    refuse(tool, `WEV_DB_PATH resolves to ${dbPath}, which is a symlink.`,
      'A scratch database has no reason to be a link, and a symlinked leaf can\n'
      + '  point outside scratch/ regardless of where its own path sits.');
  }

  return dbPath;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same shape as db-safety.mjs's refusals, so the output reads consistently. */
function refuse(tool, headline, detail) {
  console.error(`REFUSING: ${headline}`);
  console.error('');
  console.error(`  ${tool} will not run.`);
  console.error(`  ${detail}`);
  process.exit(1);
}
