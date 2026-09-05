#!/usr/bin/env node
/**
 * Checks — and optionally repairs — `events.first_slot_start`.
 *
 * ── Why a stored derived value needs a tool like this ──
 *
 * `first_slot_start` is the only aggregate this schema stores, and it exists so
 * the browse list's default ORDER BY has something indexable. That makes drift
 * a quiet failure rather than a loud one: the figures a page reports are still
 * computed live, so a stale column produces a page whose rows are all correct
 * and whose ORDER is wrong — and `OFFSET` is only sound over a total order, so
 * pagination begins repeating and skipping events with nothing to say so.
 *
 * `server/eventSummary.js` argues that storing it is safe BECAUSE it is always
 * recomputable and therefore always checkable. This is the check.
 *
 * ── Usage ──
 *
 *   node bin/verify-event-summaries.mjs            # report only
 *   node bin/verify-event-summaries.mjs --repair   # recompute the drifted rows
 *   node bin/verify-event-summaries.mjs --rebuild  # recompute EVERY row
 *
 * Read-only by default. `--repair` touches only rows that already disagree, so
 * it cannot make a consistent database worse. `--rebuild` is for a database
 * restored from a backup taken mid-write, or one whose migration was
 * interrupted.
 */
import { openPrivilegedDb } from './resolveDb.mjs';
import {
  verifyEventSummaries, refreshEventSummaries, refreshAllEventSummaries,
} from '../server/eventSummary.js';

const args = process.argv.slice(2);
const REPAIR = args.includes('--repair');
const REBUILD = args.includes('--rebuild');

/**
 * The database the OPERATOR named, through the shared resolver.
 *
 * Not `import { db } from '../server/db.js'`, which was the first version and
 * was wrong twice over: it would have run migrations and the demo seeder as a
 * side effect of asking a read-only question, and it ignores `WEV_DB_PATH`
 * unless the resolver has already normalised the environment.
 * `docs/audits/04-PRIVILEGED-CLI-DATABASE-TARGET.md` records what that class of
 * mistake cost before, and `server/tooling.dbPath.test.js` refuses a new tool
 * in `bin/` that opens a database without consulting it — which is how this one
 * was caught.
 */
const { db, dbPath } = await openPrivilegedDb('bin/verify-event-summaries.mjs');
console.log(`database: ${dbPath}`);

const { n: total } = await db.prepare('SELECT COUNT(*) AS n FROM events').get();
console.log(`events: ${total}`);

if (REBUILD) {
  /* One statement, so it is atomic without an explicit transaction — and the
     resolver hands back a plain handle rather than the application's
     transaction-aware proxy. */
  await refreshAllEventSummaries(db);
  console.log('rebuilt every row from its slots.');
}

/* A generous cap: this is a report, and an operator running it wants to see the
   shape of the problem rather than the first hundred instances of it. */
const drift = await verifyEventSummaries(db, { limit: 10_000 });

if (drift.length === 0) {
  console.log('OK — every event\'s first_slot_start agrees with its slots.');
  await db.close();
  process.exit(0);
}

console.log(`\nDRIFT: ${drift.length} event(s) disagree with their slots.\n`);
for (const row of drift.slice(0, 20)) {
  console.log(`  ${row.id}`);
  console.log(`    stored:   ${row.stored ?? 'NULL'}`);
  console.log(`    computed: ${row.computed ?? 'NULL'}`);
}
if (drift.length > 20) console.log(`  … and ${drift.length - 20} more`);

if (!REPAIR) {
  console.log('\nRun again with --repair to recompute these rows.');
  console.log('Nothing has been changed.');
  await db.close();
  process.exit(1);
}

await refreshEventSummaries(db, drift.map(r => r.id));

const after = await verifyEventSummaries(db, { limit: 10 });
if (after.length) {
  console.error(`\nREPAIR INCOMPLETE: ${after.length} row(s) still disagree.`);
  console.error('That should not happen — the recompute reads the same slots the check does.');
  await db.close();
  process.exit(1);
}

console.log(`\nRepaired ${drift.length} event(s). Every row now agrees with its slots.`);
await db.close();
