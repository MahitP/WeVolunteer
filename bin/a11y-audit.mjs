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

const TOOL = 'The accessibility audit';
const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

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

/* Reset through the existing tool rather than deleting the file here. It owns
   the "delete the file and let initDatabase rebuild the schema" decision, and
   its own header explains why enumerating tables drifts. */
const reset = spawnSync(process.execPath, ['bin/reset-dev-db.mjs', '--yes'], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, WEV_DB_PATH: dbPath, DATABASE_ENGINE: 'sqlite' }
});
if (reset.status !== 0) process.exit(reset.status ?? 1);

const pw = spawnSync('npx', ['playwright', 'test', ...args.filter(a => a !== '--yes')], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, WEV_DB_PATH: dbPath, DATABASE_ENGINE: 'sqlite' }
});
process.exit(pw.status ?? 1);
