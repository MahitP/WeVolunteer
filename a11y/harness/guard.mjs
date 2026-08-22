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

  assertContainedInScratch(tool, dbPath);

  return dbPath;
}

/**
 * Refuses unless dbPath is contained in scratch/, checking every filesystem
 * component that actually exists rather than inspecting only the parent or
 * only the leaf.
 *
 * ── The invariant, stated exactly ──
 *
 * No component of the path is a symlink or a multiply-linked file anywhere it
 * exists; any component that cannot be INSPECTED is a refusal; and the deepest
 * component that does exist lies inside scratch/. Components below that point
 * cannot be links, because they do not exist.
 *
 * ── The threat this exists to stop ──
 *
 * An ACCIDENT: a developer or a CI job pointing WEV_DB_PATH at pilot.db, which
 * holds real minors' personal data. That is the failure this must make
 * impossible, and it is the standard to judge this function against.
 *
 * ── What it does NOT defend against, named rather than implied ──
 *
 * There is a window between this gate exiting and bin/reset-dev-db.mjs running
 * in a second process, and nothing re-validates containment there. A local
 * actor who can swap a component inside that window is not stopped. Closing it
 * would mean the shared reset-dev-db.mjs depending on a11y/, inverting the
 * dependency for a threat this gate was never scoped to cover. Recorded as a
 * known limitation, deliberately, rather than left for somebody to assume.
 *
 * Four escapes were found in this one check, each fix inviting the next. The
 * lesson worth keeping: a comment claiming completeness is how the first three
 * survived review.
 *
 * This replaced three separate special-case checks, each of which covered one
 * end of the path and was blind to the others — and each fix invited the
 * next, which was the signal that the property was being approximated rather
 * than actually checked:
 *
 *   - A leaf-only check (lstat dbPath itself) cannot see a symlinked PARENT.
 *     Worse, it cannot even see a DANGLING symlinked parent: lstatSync on the
 *     full leaf path throws ENOENT when an intermediate component doesn't
 *     resolve, indistinguishable from "does not exist yet".
 *   - A parent-only check (realpath dirname(dbPath)) cannot see a symlinked
 *     LEAF — the parent sits correctly inside scratch/ while the leaf itself
 *     points anywhere on disk.
 *   - Neither one can see scratch/ ITSELF being a symlink, which is worse
 *     than either: `ensureDir` succeeds on a symlinked directory, and
 *     realpathSync(SCRATCH) then resolves THROUGH it, so the baseline every
 *     comparison below is made against becomes the attacker's directory
 *     rather than the repository's scratch/.
 */
function assertContainedInScratch(tool, dbPath) {
  /* Refuse a symlinked SCRATCH before it becomes the baseline everything else
     is compared against. lstatSync tolerates SCRATCH not existing yet
     (ensureDir below creates it as a real directory in that case), but if it
     already exists it must be a real directory, not a link elsewhere. */
  try {
    if (fs.lstatSync(SCRATCH).isSymbolicLink()) {
      refuse(tool, `${SCRATCH} is a symlink.`,
        'scratch/ has to be a real directory. Every containment check below is\n'
        + '  a comparison against its real location, and a symlinked scratch/ would\n'
        + '  make that comparison meaningless — it would resolve through the link\n'
        + '  and use wherever that link points as the baseline instead.');
    }
  } catch {
    // Does not exist yet — ensureDir below creates it as a real directory.
  }
  const scratchReal = fs.realpathSync(ensureDir(SCRATCH));

  /* Walk from the target upward, deepest first. The FIRST component that has
     an entry on disk is the first thing the OS would actually traverse to
     resolve dbPath, so it is the one that decides: a symlink there is refused
     outright rather than followed, and a real entry there is realpath'd and
     must be scratchReal or a descendant of it. Every component BELOW that
     point does not exist, so it is a plain lexical name — it cannot itself be
     a symlink, because a symlink is a filesystem entry that would exist. */
  const resolved = path.resolve(dbPath);
  const ancestors = [];
  for (let cursor = resolved; ; ) {
    ancestors.push(cursor);
    const next = path.dirname(cursor);
    if (next === cursor) break; // reached the filesystem root
    cursor = next;
  }

  for (const candidate of ancestors) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (err) {
      /* ONLY "absent" means keep walking. A bare `catch` here treated every
         failure as absence, and that was an escape: `chmod 000` on an
         intermediate directory makes lstat throw EACCES, which was skipped as
         though nothing were there, so the walk approved containment from a
         shallower ancestor while the real leaf was a symlink pointing outside
         scratch/. refuseNonDisposableDatabase is blind to the same path for the
         same reason — its existsSync also returns false.

         A gate that cannot determine what a component IS must refuse. "I could
         not look" is not "it is fine". */
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
      refuse(tool, `${candidate} could not be inspected (${err?.code || 'unknown error'}).`,
        'This gate refuses whatever it cannot verify. A component it is not\n'
        + '  permitted to inspect could be a link to anywhere, so proceeding would\n'
        + `  mean guessing about a path that decides which database is opened.`);
    }

    if (stat.isSymbolicLink()) {
      refuse(tool, `${candidate} is a symlink.`,
        'A scratch database, and everything containing it, has to be a real\n'
        + `  directory or file — not a link that could point outside ${SCRATCH}.`);
    }

    /* A hardlink is lstat-indistinguishable from an ordinary file — same
       inode as a file elsewhere on the same device, no link to follow, so the
       symlink check above cannot see it. nlink > 1 is the observable part, and
       a scratch database has no legitimate reason to have a second name.

       Without this, containment was only ever "containment plus a content
       heuristic": refuseNonDisposableDatabase catches a hardlink to pilot.db by
       reading it and finding the owner accounts, but a real SQLite file
       carrying none of those markers would pass both checks. */
    if (stat.isFile() && stat.nlink > 1) {
      refuse(tool, `${candidate} has ${stat.nlink} hard links.`,
        'A scratch database should have exactly one name. More than one means\n'
        + `  these bytes are also reachable from outside ${SCRATCH}, where this\n`
        + '  gate cannot see them and where deleting "the scratch database" would\n'
        + '  not be deleting a scratch database.');
    }

    const real = fs.realpathSync(candidate);
    if (real !== scratchReal && !real.startsWith(scratchReal + path.sep)) {
      refuse(tool, `WEV_DB_PATH resolves to ${dbPath}, outside scratch/.`,
        `Artefacts are written beside the database, so it belongs under\n  ${SCRATCH}, which git already ignores.`);
    }
    return;
  }

  // The filesystem root always exists, so the loop above always returns
  // before falling out the bottom — this is a defensive backstop, not a
  // reachable branch, for the case where nothing along the path could be
  // inspected at all.
  refuse(tool, `WEV_DB_PATH resolves to ${dbPath}, and no part of that path could be found.`,
    `Point WEV_DB_PATH at a path under ${SCRATCH}.`);
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
