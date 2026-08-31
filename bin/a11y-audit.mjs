#!/usr/bin/env node
/**
 * Entry point for the accessibility audit.
 *
 * ── Why this is a script and not just `npx playwright test` ──
 *
 * It resets a database, which makes it destructive, which means it belongs in
 * the same parameterised refusal suite as every other destructive tool here
 * (server/tooling.scriptSafety.test.js). A gate that lives only in Playwright's
 * globalSetup is a gate no existing suite covers.
 *
 * The gate ALSO runs in playwright.config.js's globalSetup, so `npx playwright
 * test` on its own cannot bypass it. Two call sites, one implementation.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertScratchDatabase } from '../a11y/harness/guard.mjs';
import { hasYesFlag, confirmDestructive } from './lib/db-safety.mjs';

const TOOL = 'The accessibility audit';
const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const assumeYes = hasYesFlag(args);

const dbPath = assertScratchDatabase({ tool: TOOL });

console.log('WeVolunteer — accessibility audit');
console.log('');
console.log(`  Database: ${dbPath}`);
console.log(`  NODE_ENV: ${process.env.NODE_ENV || '(unset)'}`);
console.log('');

if (dryRun) {
  console.log('  --dry-run: the gate passed. Stopping before the database reset.');
  process.exit(0);
}

/* An unattended harness must neither block on a prompt nobody can answer nor
   proceed unconfirmed just because nobody is watching. confirmDestructive()
   already draws exactly that line — --yes proceeds, no TTY and no --yes
   refuses — and it is the same function bin/reset-dev-db.mjs uses. Passing
   `--yes` to that script below on this tool's own authority, without ever
   checking whether THIS invocation was confirmed, was a hand-rolled
   substitute that did not actually check anything. */
if (!(await confirmDestructive({ dbPath, assumeYes }))) process.exit(1);

/* Reset through the existing tool rather than deleting the file here. It owns
   the "delete the file and let initDatabase rebuild the schema" decision, and
   its own header explains why enumerating tables drifts. Confirmation already
   happened above, so --yes here skips reset-dev-db.mjs's own prompt rather
   than asking twice. */
const reset = spawnSync(process.execPath, ['bin/reset-dev-db.mjs', '--yes'], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, WEV_DB_PATH: dbPath, DATABASE_ENGINE: 'sqlite' }
});
if (reset.status !== 0) process.exit(reset.status ?? 1);

/**
 * `WEV_A11Y_HARNESS=1` exempts the audit's server from the VOLUME limiter.
 *
 * One full run makes more than the 10,000 requests `apiLimiter` allows in
 * fifteen minutes — measured, and mostly the application loading its own pages
 * a hundred and ninety times rather than anything this harness does. Without
 * this the run exhausts the ceiling partway through and the remaining specs
 * fail with 429s that say nothing about accessibility, so the gate cannot state
 * a result in one invocation.
 *
 * It exempts nothing else. Every credential limiter — login, signup, mail,
 * reauth, 2FA — still counts these requests, and `config.js` refuses the
 * variable outright when NODE_ENV is production, where `server.js` also
 * declines to boot on it. See A11Y_HARNESS in server/config.js.
 *
 * Passed to Playwright rather than exported here because playwright.config.js
 * spawns the API server itself; this is the process that inherits it.
 */
const pw = spawnSync('npx', ['playwright', 'test', ...args.filter(a => a !== '--yes' && a !== '--dry-run')], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, WEV_DB_PATH: dbPath, DATABASE_ENGINE: 'sqlite', WEV_A11Y_HARNESS: '1' }
});
process.exit(pw.status ?? 1);
