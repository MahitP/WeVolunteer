#!/usr/bin/env node
/**
 * Restore a DEVELOPMENT database to its seeded state.
 *
 * ⚠️  THIS IS DESTRUCTIVE. It deletes the database file and everything in it:
 *     every account, event, application, attendance record, credited hour,
 *     certificate, conversation and notification. There is no undo.
 *
 * Usage:
 *   npm run db:reset:dev            # prompts for confirmation
 *   npm run db:reset:dev -- --yes   # no prompt (for scripts and tests)
 *
 * ── Why this is a CLI and not an HTTP endpoint ──
 *
 * It used to be `POST /api/auth/reset`, registered whenever DEMO_MODE was on.
 * Two things were wrong with that, and only one of them was the endpoint.
 *
 * The endpoint itself was the smaller problem: a reachable HTTP route whose
 * whole purpose is to destroy the database is a liability that no amount of
 * gating makes comfortable, because the gate is one environment-variable
 * mistake away from being open. `npm run dev` on a server is exactly that
 * mistake, and it is a plausible one.
 *
 * The larger problem was HOW it reset. It issued `DROP TABLE` for a
 * hand-maintained list of 16 tables, and that list drifted every single time a
 * feature added one — messaging, certificates and moderation each added tables
 * and each left the list behind. By the time the audit ran, 13 tables were
 * missing from it, and the omission was not merely untidy: `conversations`
 * declares foreign keys to BOTH `events` and `users`, so once `events` had been
 * dropped SQLite could no longer resolve the cascade and `DROP TABLE users`
 * threw `no such table: main.events`. The handler died there, before
 * `initDatabase()`, leaving a database with users but no events, applications,
 * attendance, notifications or hours ledger — and no way back, because a
 * restart recreates empty tables but will not re-seed a non-empty `users`.
 * Pressing "Reset data" destroyed the demo it claimed to restore.
 *
 * So this script does not enumerate tables at all. It deletes the database
 * FILE and lets `initDatabase()` rebuild the schema from the single definition
 * that the application itself uses. There is no list to drift, which means this
 * class of bug cannot come back the next time someone adds a table.
 *
 * The WAL sidecars go with it. `journal_mode=WAL` keeps committed pages in
 * `-wal` until a checkpoint, so deleting only the `.db` would leave SQLite able
 * to recover rows from a file that is supposed to be gone.
 */
import { existsSync, rmSync } from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { resolveDbPath, refuseProduction, refuseProductionLikePath } from './lib/db-safety.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolved exactly as server/db.js resolves it, so this can never operate on a
// different file from the one the application opens.
const dbPath = resolveDbPath(path.join(__dirname, '..', 'server', 'wevolunteer.db'));

const args = process.argv.slice(2);
const assumeYes = args.includes('--yes') || args.includes('-y');

/**
 * Refusing production is the first thing that happens, before any check that
 * could fail for a duller reason. Nothing below this point runs in production.
 *
 * Both checks now come from bin/lib/db-safety.mjs, shared with seed-pilot.js and
 * simulate-pilot.js. The NODE_ENV refusal was already here and is unchanged in
 * behaviour; the path check is new to this script — NODE_ENV alone misses the
 * operator who exported only WEV_DB_PATH, which is the likelier of the two
 * mistakes when running a one-off command by hand.
 */
refuseProduction({
  tool: 'the development database reset',
  effect: 'delete that database and reseed demo accounts'
});
refuseProductionLikePath({ tool: 'The development database reset', dbPath });

console.log('WeVolunteer — development database reset');
console.log('');
console.log(`  Database: ${dbPath}`);
console.log(`  Exists:   ${existsSync(dbPath) ? 'yes' : 'no (nothing to delete)'}`);
console.log(`  NODE_ENV: ${process.env.NODE_ENV || '(unset)'}`);
console.log('');
console.log('  This DELETES that file and every record in it — accounts, events,');
console.log('  applications, attendance, credited hours, certificates, messages and');
console.log('  notifications — then recreates it with the demo seed data.');
console.log('');

async function confirm() {
  if (assumeYes) return true;

  // No TTY (CI, a pipe, a test) and no --yes: refuse rather than hang waiting
  // on a prompt nobody can answer.
  if (!process.stdin.isTTY) {
    console.error('REFUSING: no confirmation given and stdin is not a terminal.');
    console.error('Re-run with --yes if you really mean to erase this database.');
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const expected = path.basename(dbPath);
  const answer = await new Promise(resolve =>
    // Typing the filename, rather than "y", so the answer cannot be given by
    // reflex — and so it is impossible to confirm the wrong database.
    rl.question(`Type "${expected}" to confirm deletion: `, a => { rl.close(); resolve(a); })
  );
  if (answer.trim() !== expected) {
    console.error('Cancelled — that did not match. Nothing was changed.');
    return false;
  }
  return true;
}

if (!(await confirm())) process.exit(1);

// Delete the file and its WAL sidecars BEFORE importing db.js, because that
// import opens a connection and would recreate the file underneath us.
for (const suffix of ['', '-wal', '-shm']) {
  const f = dbPath + suffix;
  if (existsSync(f)) {
    rmSync(f, { force: true });
    console.log(`  removed ${path.basename(f)}`);
  }
}

// Seeding is what makes a development reset useful, so default it on. An
// explicit DEMO_MODE=false still wins, which leaves a schema-only database.
if (process.env.DEMO_MODE === undefined) process.env.DEMO_MODE = 'true';
process.env.WEV_DB_PATH = dbPath;

const { initDatabase, db } = await import('../server/db.js');
initDatabase();

const counts = ['users', 'events', 'slots', 'applications']
  .map(t => `${t}=${db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c}`)
  .join('  ');

console.log('');
console.log(`Done. ${counts}`);
if (process.env.DEMO_MODE === 'true') {
  console.log('Demo accounts restored — password: password123');
}
