#!/usr/bin/env node
/**
 * Operating the Pinecone search index: provision it, fill it, check it, repair
 * it, and find out what it is costing.
 *
 * ── Why the application does not do any of this ──
 *
 * Provisioning at boot is how a developer's laptop creates a production index,
 * and how a misconfigured `PINECONE_INDEX` silently becomes a second index that
 * nobody notices until the 5-index Starter allowance runs out. Every command
 * here is an act somebody performs on purpose, from a shell, having read what it
 * is about to do.
 *
 * ── Usage ──
 *
 *   node bin/pinecone-index.mjs setup            create the index (idempotent)
 *   node bin/pinecone-index.mjs backfill         index everything not yet indexed
 *   node bin/pinecone-index.mjs backfill --dry-run
 *   node bin/pinecone-index.mjs reindex          re-send the whole corpus
 *   node bin/pinecone-index.mjs reconcile        report drift
 *   node bin/pinecone-index.mjs reconcile --remove-orphans
 *   node bin/pinecone-index.mjs stats            counts, and free-tier usage
 *
 * `--dry-run` is supported where it means something: it computes hashes and
 * reports what WOULD be sent, without sending or recording anything. That is
 * the safe way to answer "how much of my monthly embedding allowance does the
 * first backfill cost".
 *
 * Reads `.env` through `--env-file-if-exists`, like every other privileged
 * script here; see `bin/resolveDb.mjs` for why that matters.
 */
import process from 'node:process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');

/**
 * Resolve a relative WEV_DB_PATH against `server/`, not against the cwd.
 *
 * ── The incident, for the second time ──
 *
 * `.env` here says `WEV_DB_PATH=../pilot.db`, and its comment explains why:
 * relative to `server/`, which is the cwd the dev and start scripts run from.
 * These npm scripts run from the REPOSITORY ROOT, where the same string means
 * one level above the repository — and from a git worktree it means
 * `.claude/worktrees/pilot.db`.
 *
 * `node:sqlite` creates a database that is not there, so the first live run of
 * `pinecone:setup` silently created an empty one and would have reported a
 * perfectly successful backfill of zero events into a real Pinecone index.
 * That is precisely the failure `bin/resolveDb.mjs` records from 2026-08:
 * "an operator would run it, read Successfully granted ownership, sign in, and
 * still not be an owner".
 *
 * `resolveDb.mjs` already had the right rule (`path.resolve(SERVER_DIR, value)`)
 * and these commands did not go through it, because the indexer needs the
 * dual-engine handle from `server/db.js` rather than a raw SQLite one. So the
 * rule is applied here instead, BEFORE `server/db.js` is imported — that module
 * reads the variable at import time.
 */
function normaliseDbPath() {
  const raw = process.env.WEV_DB_PATH;
  if (!raw) return null;
  if ((process.env.DATABASE_ENGINE || 'sqlite').toLowerCase() === 'postgres') return null;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(SERVER_DIR, raw);
  process.env.WEV_DB_PATH = resolved;
  return resolved;
}

/**
 * Refuse a database that is not there, rather than creating one.
 *
 * `node:sqlite` creates an absent file, so every wrong path is a silent success:
 * an empty database, a backfill of zero events, and an exit code of 0. That is
 * the failure `bin/resolveDb.mjs` answers with "a refusal rather than a new
 * file", and it happened twice during the first live run of these commands —
 * once from the repository root and once from a git worktree, each time leaving
 * a stray empty database behind.
 *
 * Resolving the path correctly was necessary and not sufficient: a correct rule
 * still points at nothing when the file genuinely is not there. So the tool
 * stops and says which path it tried.
 */
function assertDatabaseExists(resolved) {
  if (!resolved || existsSync(resolved)) return true;
  line('That database does not exist:');
  line('');
  line(`    ${resolved}`);
  line('');
  line('  WEV_DB_PATH is resolved against server/, matching bin/resolveDb.mjs.');
  line('  Nothing was created — node:sqlite would happily have made an empty');
  line('  database here and reported a successful backfill of zero events.');
  line('');
  line('  Point WEV_DB_PATH at the database you mean, as an absolute path if');
  line('  you are running from a git worktree.');
  process.exitCode = 1;
  return false;
}

const RESOLVED_DB = normaliseDbPath();

const [, , rawCommand, ...args] = process.argv;
const command = String(rawCommand ?? '').toLowerCase();
const has = (flag) => args.includes(flag);

const line = (s = '') => process.stdout.write(`${s}\n`);
const num = (n) => Number(n ?? 0).toLocaleString('en-US');

/**
 * The modules are imported lazily, inside the command.
 *
 * `server/db.js` opens a database connection at module scope, so importing it is
 * a side effect — and `--help` should not open the production database to print
 * a usage message.
 */
async function load() {
  const [config, client, indexer, doc, database] = await Promise.all([
    import('../server/search/pineconeConfig.js'),
    import('../server/search/pineconeClient.js'),
    import('../server/search/eventIndexer.js'),
    import('../server/search/eventDocument.js'),
    import('../server/db.js'),
  ]);
  /* The indexer takes a handle rather than importing one — see the note in
     server/search/eventIndexer.js. A command-line tool is the one caller with
     no ambient transaction, so it supplies the module-global handle itself,
     which is also the handle whose path `server/db.js` printed on the way in. */
  return { config, client, indexer, doc, db: database.db };
}

function requireEnabled(config) {
  const status = config.pineconeStatus();
  if (!status.enabled) {
    line(`Pinecone is not configured (${status.reason}).`);
    line('');
    line('  Set PINECONE_API_KEY, and optionally PINECONE_INDEX and');
    line('  PINECONE_NAMESPACE. See docs/operations/pinecone.md.');
    process.exitCode = 1;
    return null;
  }
  return status;
}

/**
 * Which database this run will index, stated before it does anything.
 *
 * ── Why this is here and not left to `server/db.js` ──
 *
 * `server/db.js` resolves and prints the path already, so this is not the only
 * place it appears. It is here because `server/tooling.dbPath.test.js` requires
 * every tool in `bin/` to consult `WEV_DB_PATH` in its own source — and that
 * guard is not bureaucracy. `bin/resolveDb.mjs` records the incident it exists
 * for: privileged scripts invoked as bare `node` silently operated on
 * `server/wevolunteer.db` while the server used the path in `.env`, and reported
 * success about a file nobody looked at.
 *
 * The failure is worse for this tool than for most. Indexing the wrong database
 * does not throw — it produces a Pinecone index full of the wrong corpus, spends
 * the month's embedding allowance building it, and leaves Discover confidently
 * returning events that are not there.
 */
function databaseTarget() {
  const engine = (process.env.DATABASE_ENGINE || 'sqlite').toLowerCase();
  if (engine === 'postgres') {
    /* Never the URL: it carries a password. The engine name is the useful part,
       and `server/db.js` prints the host it actually connected to. */
    return 'postgres (DATABASE_URL)';
  }
  const configured = process.env.WEV_DB_PATH;
  return configured
    ? `sqlite ${configured}`
    : `sqlite ${path.join(SERVER_DIR, 'wevolunteer.db')}  ← WEV_DB_PATH is unset; is that the database you meant?`;
}

function banner(status) {
  line('WeVolunteer — Pinecone search index');
  line('='.repeat(58));
  line(`index:      ${status.index}`);
  line(`namespace:  ${status.namespace}`);
  line(`model:      ${status.model}`);
  line(`database:   ${databaseTarget()}`);
  line('');
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h' || has('--help')) {
    line('Usage: node bin/pinecone-index.mjs <setup|backfill|reindex|reconcile|stats> [--dry-run] [--remove-orphans]');
    return;
  }

  if (!assertDatabaseExists(RESOLVED_DB)) return;

  const { config, client, indexer, doc, db } = await load();

  if (command === 'stats') {
    const status = config.pineconeStatus();
    line('WeVolunteer — Pinecone search index');
    line('='.repeat(58));
    line(status.enabled
      ? `index ${status.index} / namespace ${status.namespace} / model ${status.model}`
      : `Pinecone is DISABLED (${status.reason}) — the counts below are local only.`);
    line('');

    line(`database:   ${databaseTarget()}`);
    line('');

    const local = await indexer.indexingStats(db);
    if (!local.available) {
      line('This database has no event_search_index table.');
      line('');
      line('  Migration 059 creates it, and it runs when the server boots.');
      line('  Start the server once against this database, or check that the');
      line('  path above is the database you meant.');
      process.exitCode = 1;
      return;
    }
    line('Local bookkeeping (event_search_index):');
    line(`  events in database   ${num(local.events)}`);
    line(`  indexed              ${num(local.indexed)}`);
    line(`  pending              ${num(local.pending)}`);
    line(`  failed               ${num(local.failed)}`);
    line(`  removed (cancelled)  ${num(local.removed)}`);
    line(`  document version     ${local.documentVersion}`);

    if (status.enabled) {
      const stats = await client.indexStats();
      line('');
      if (stats.ok) {
        const namespaces = stats.body?.namespaces ?? {};
        const mine = namespaces[status.namespace] ?? {};
        line('Pinecone:');
        line(`  records in namespace ${num(mine.vectorCount ?? mine.record_count ?? 0)}`);
        line(`  namespaces in index  ${num(Object.keys(namespaces).length)} of 100 (Starter)`);
      } else {
        line(`Pinecone: unreachable (${stats.reason}).`);
      }

      /**
       * What this process has spent, as Pinecone itself reported it.
       *
       * Counted from the `usage` block on each response rather than estimated
       * from request counts — a read unit measures data scanned, not calls made,
       * so counting calls would be a guess dressed as a number. It resets when
       * the process does; the authoritative monthly figure is in the Pinecone
       * console, and this is for spotting a runaway before the console does.
       */
      const used = client.pineconeUsage();
      line('');
      line('This process has used (Starter allowances, per month, per org):');
      line(`  read units       ${num(used.readUnits)}          of 1,000,000`);
      line(`  embed tokens     ${num(used.embedTokens)}        of 5,000,000`);
      line(`  rerank units     ${num(used.rerankUnits)}        of 500`);
      line(`  searches ${num(used.searches)} · upserts ${num(used.upserts)} (${num(used.records)} records) · deletes ${num(used.deletes)}`);
      line(`  failures ${num(used.failures)} (${num(used.timeouts)} timeouts)`);
    }
    return;
  }

  const status = requireEnabled(config);
  if (!status) return;
  banner(status);

  if (command === 'setup') {
    line('Creating the index if it does not exist…');
    const res = await client.createIndexForModel({ fieldMapText: doc.TEXT_FIELD });
    if (!res.ok) {
      /* An index that already exists is the success case for an idempotent
         setup, and Pinecone says so with a 409. */
      if (res.status === 409) {
        line('Already exists. Nothing to do.');
      } else {
        line(`FAILED (${res.reason}${res.message ? `: ${res.message}` : ''})`);
        process.exitCode = 1;
        return;
      }
    } else {
      line('Created.');
    }

    const described = await client.describeIndex();
    if (described.ok) {
      line(`  host       ${described.body?.host ?? 'unknown'}`);
      line(`  dimension  ${described.body?.dimension ?? 'model default'}`);
      line(`  ready      ${described.body?.status?.ready === true}`);
    }
    line('');
    line('Next: node bin/pinecone-index.mjs backfill --dry-run');
    return;
  }

  if (command === 'backfill' || command === 'reindex') {
    const dryRun = has('--dry-run');

    if (command === 'reindex') {
      if (dryRun) {
        line('reindex --dry-run would mark every event pending; run backfill --dry-run instead.');
        process.exitCode = 1;
        return;
      }
      line('Marking every event for re-indexing…');
      await indexer.markAllDirty(db);
    }

    line(dryRun ? 'Dry run — computing what would be sent.' : 'Indexing…');
    const totals = await indexer.backfill(db, {
      dryRun,
      onProgress: (p) => {
        /* One line, rewritten. A backfill over 50,000 events would otherwise
           produce 550 lines of progress in somebody's terminal. */
        process.stdout.write(
          `\r  batch ${p.batches} · ${num(p.upserted)} sent · ${num(p.unchanged)} unchanged`
          + ` · ${num(p.deleted)} removed · ${num(p.failed)} failed   `,
        );
      },
    });
    line('');
    line('');
    line(dryRun ? 'Would send:' : 'Done:');
    line(`  upserted   ${num(totals.upserted)}`);
    line(`  unchanged  ${num(totals.unchanged)}   (already indexed, not re-embedded)`);
    line(`  removed    ${num(totals.deleted)}`);
    line(`  failed     ${num(totals.failed)}`);

    if (dryRun) {
      line('');
      line('Nothing was sent and nothing was recorded.');
    }
    if (totals.failed) process.exitCode = 1;
    return;
  }

  if (command === 'reconcile') {
    const removeOrphans = has('--remove-orphans');
    line(removeOrphans ? 'Reconciling, and removing what should not be there…' : 'Reconciling…');
    const report = await indexer.reconcile(db, { removeOrphans });
    line('');
    line(`  events in database        ${num(report.dbEvents)}   (excluding cancelled)`);
    line(`  records in Pinecone       ${report.indexedRecords == null ? 'unknown' : num(report.indexedRecords)}`);
    line(`  not indexed (missing)     ${num(report.missing)}`);
    line(`  unaccounted for (orphans) ${num(report.orphaned)}`);
    if (removeOrphans) line(`  removed                   ${num(report.removed)}`);
    line('');
    if (report.missing > 0) {
      line(`${num(report.missing)} event(s) are not searchable. Fix with:`);
      line('  node bin/pinecone-index.mjs backfill');
    } else {
      line('Nothing missing.');
    }
    if (report.orphaned > 0 && !removeOrphans) {
      line('');
      line(`${num(report.orphaned)} record(s) in Pinecone are unaccounted for.`);
      line('Before deleting anything, check PINECONE_NAMESPACE is the one you mean —');
      line('a namespace mismatch looks exactly like a namespace full of orphans.');
      line('  node bin/pinecone-index.mjs reconcile --remove-orphans');
    }
    return;
  }

  line(`Unknown command: ${command}`);
  line('Try: setup | backfill | reindex | reconcile | stats');
  process.exitCode = 1;
}

main().catch((err) => {
  /**
   * The name, plus a short message when there is one.
   *
   * The client itself never throws — it returns `{ ok: false }` — so anything
   * arriving here came from the database or from this script, neither of which
   * holds the API key. A bare name ("Error") is not an answer anybody can act
   * on, and this is a tool people run when something is already wrong.
   */
  const detail = typeof err?.message === 'string' ? `: ${err.message.slice(0, 200)}` : '';
  line(`pinecone-index failed (${err?.name || 'error'})${detail}`);
  process.exitCode = 1;
});
