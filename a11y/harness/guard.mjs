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
 * The unset and absolute checks run first because they are pure validation —
 * no I/O, nothing to get wrong by ordering them ahead of everything else.
 *
 * The four shared refusals run next, in the same order bin/reset-dev-db.mjs
 * composes them and for the same reasons — production first, because it is the
 * check that must not be reachable past; then the engine, because with
 * DATABASE_ENGINE=postgres a file path is irrelevant and every check after it
 * would be inspecting the wrong thing; then the path; then the contents.
 *
 * The scratch-containment check runs LAST, after the shared refusals rather
 * than before them. Checking it earlier meant a path outside scratch/ was
 * refused for being outside scratch/ even when it was ALSO a production path or
 * a database full of real accounts — hiding the more specific, more useful
 * refusal behind a generic one, and (see below) doing so by way of a crash. The
 * cost of running it last is that a database outside scratch/ may be read
 * before this check ever gets to refuse it — acceptable, because reading is
 * precisely how refuseNonDisposableDatabase proves a database is disposable, it
 * is what the other three tools already do, and refuseProductionLikePath has
 * already rejected production-looking paths by that point.
 */
export function assertScratchDatabase({ tool }) {
  const effect = 'delete that database, reseed it, and drive a browser through it';

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

  refuseProduction({ tool, effect });
  refuseNonSqliteEngine({ tool, effect });
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
     it lexically is enough. */
  const parent = fs.existsSync(parentPath) ? fs.realpathSync(parentPath) : path.resolve(parentPath);
  if (parent !== scratchReal && !parent.startsWith(scratchReal + path.sep)) {
    refuse(tool, `WEV_DB_PATH resolves to ${dbPath}, outside scratch/.`,
      `Artefacts are written beside the database, so it belongs under\n  ${SCRATCH}, which git already ignores.`);
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
