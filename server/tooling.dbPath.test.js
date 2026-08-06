import { describe, it, expect, vi } from 'vitest';
/**
 * A file-wide budget, measured rather than guessed.
 *
 * The two tests in `verifyHours.js operates on the database WEV_DB_PATH names` each
 * build a throwaway database and then `execFileSync` a fresh `node` process against
 * it. Spawning a Node process and booting its data layer is the cost being measured,
 * and it is not something the test can avoid — the whole point is that the REAL CLI
 * honours the environment variable.
 *
 * Isolated they run ~0.3s against vitest's 5000ms default. Under the parallel load of
 * the full suite one was measured at 5085ms and timed out: process startup is exactly
 * what gets slow when every core is already busy. Nothing was hung, so this is a
 * flake rather than a defect in the code under test — and flakiness is a defect in
 * its own right on the gate every other gate depends on.
 *
 * The global default stays 5000ms so a genuinely hung test elsewhere still fails fast.
 */
vi.setConfig({ testTimeout: 20000 });

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Regression cover for the audit finding that `verifyHours.js` verified the
 * wrong database.
 *
 * It resolved its path as:
 *
 *     const dbPath = process.argv[2] || path.join(__dirname, 'wevolunteer.db');
 *
 * with no reference to WEV_DB_PATH — the variable every other part of the system
 * uses to say which database is live. `npm run verify:hours` is
 * `node --env-file-if-exists=../.env verifyHours.js`, and the pilot's `.env`
 * sets `WEV_DB_PATH=../pilot.db`. So the command loaded the env file that names
 * the real database, ignored it, opened a stale `server/wevolunteer.db` that
 * happened to exist, and printed:
 *
 *     PASS — ledger matches attendance for all N volunteer(s).
 *
 * The one tool whose entire purpose is proving that credited hours have not been
 * tampered with gave a confident answer about a file nobody cared about. A
 * silent wrong answer from a verification tool is worse than no tool.
 */

const ROOT = process.cwd();
const CLI_TOOLS = [
  'server/verifyHours.js',
  'server/migrate_usernames.js',
  'bin/make-admin.mjs',
  'bin/reset-dev-db.mjs'
];

/** Builds a seeded database at `file`. */
function seedDb(file) {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.WEV_DB_PATH = ${JSON.stringify(file)};
    process.env.JWT_SECRET = ${JSON.stringify('x'.repeat(48))};
    process.env.DEMO_MODE = 'true';
    const { initDatabase } = await import('${ROOT.replace(/\\/g, '/')}/server/db.js');
    initDatabase();
  `], { cwd: ROOT, stdio: 'pipe' });
}

describe('every CLI tool honours WEV_DB_PATH', () => {
  // A static guard, so a NEW tool that forgets the variable fails here rather
  // than silently operating on the wrong file in production.
  for (const tool of CLI_TOOLS) {
    it(`${tool} references WEV_DB_PATH`, () => {
      const src = readFileSync(path.join(ROOT, tool), 'utf8');
      expect(src).toMatch(/WEV_DB_PATH/);
    });
  }

  it('no tool in bin/ opens a database without consulting WEV_DB_PATH', () => {
    const offenders = [];
    for (const name of readdirSync(path.join(ROOT, 'bin'))) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      const src = readFileSync(path.join(ROOT, 'bin', name), 'utf8');
      const opensDb = /new DatabaseSync\(|from '.*db\.js'|import\(.*db\.js/.test(src);
      if (opensDb && !src.includes('WEV_DB_PATH')) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

describe('verifyHours.js operates on the database WEV_DB_PATH names', () => {
  it('reports the WEV_DB_PATH database, not the built-in default', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-verify-env-'));
    const dbFile = path.join(dir, 'target.db');
    seedDb(dbFile);

    const out = execFileSync(process.execPath, ['verifyHours.js'], {
      cwd: path.join(ROOT, 'server'),
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) }
    });

    rmSync(dir, { recursive: true, force: true });

    expect(out).toContain(dbFile);
    // The precise failure mode: silently falling back to server/wevolunteer.db.
    expect(out).not.toMatch(/server[/\\]wevolunteer\.db/);
  });

  it('still lets an explicit CLI argument win over the environment', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-verify-argv-'));
    const envDb = path.join(dir, 'from-env.db');
    const argDb = path.join(dir, 'from-argv.db');
    seedDb(envDb);
    seedDb(argDb);

    const out = execFileSync(process.execPath, ['verifyHours.js', argDb], {
      cwd: path.join(ROOT, 'server'),
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, WEV_DB_PATH: envDb, JWT_SECRET: 'x'.repeat(48) }
    });

    rmSync(dir, { recursive: true, force: true });

    expect(out).toContain(argDb);
    expect(out).not.toContain(envDb);
  });

  it('actually verifies that database rather than reporting a path it did not open', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-verify-real-'));
    const dbFile = path.join(dir, 'tampered.db');
    seedDb(dbFile);

    // Break ledger/attendance parity, which is the one thing this tool exists to
    // detect. If it is reading the file it names, it must fail.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbFile)});
      db.exec("UPDATE attendance SET hours_awarded = hours_awarded + 99 WHERE present = 1");
      db.close();
    `], { cwd: ROOT, stdio: 'pipe' });

    let failed = false;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['verifyHours.js'], {
        cwd: path.join(ROOT, 'server'),
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) }
      });
    } catch (err) {
      failed = true;
      out = String(err.stdout || '') + String(err.stderr || '');
    }

    rmSync(dir, { recursive: true, force: true });

    expect(failed || /MISMATCH|FAIL/i.test(out), `tampering went undetected:\n${out}`).toBe(true);
  });
});
