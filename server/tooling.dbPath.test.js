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
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs';
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
    const { initDatabase, completeDatabaseInit } = await import('${ROOT.replace(/\\/g, '/')}/server/db.js');
    initDatabase();
    await completeDatabaseInit();
  `], { cwd: ROOT, stdio: 'pipe' });
}

describe('every CLI tool honours WEV_DB_PATH', () => {
  /**
   * A tool satisfies this either by naming the variable itself, or by delegating
   * to `openPrivilegedDb` — which names it, anchors a relative value, and refuses
   * to create a database that is not there.
   *
   * The delegation clause was added when the four privileged scripts moved to the
   * shared resolver. Each had kept its own copy of
   *
   *     process.env.WEV_DB_PATH || path.join(__dirname, '..', 'server', 'wevolunteer.db')
   *
   * and four private copies of one expression is exactly why fixing
   * `verifyHours.js` for this same bug did not fix them — see
   * `docs/audits/04-PRIVILEGED-CLI-DATABASE-TARGET.md`. Requiring the literal
   * string would now push a tool AWAY from the shared resolver to satisfy a guard,
   * which inverts what the guard is for.
   *
   * It is not a weakening: a new tool that consults neither still fails, which is
   * the case this exists to catch.
   */
  const honoursDbPath = (src) => /WEV_DB_PATH/.test(src) || /openPrivilegedDb/.test(src);

  for (const tool of CLI_TOOLS) {
    it(`${tool} honours WEV_DB_PATH, directly or via openPrivilegedDb`, () => {
      const src = readFileSync(path.join(ROOT, tool), 'utf8');
      expect(honoursDbPath(src)).toBe(true);
    });
  }

  it('no tool in bin/ opens a database without consulting WEV_DB_PATH', () => {
    const offenders = [];
    for (const name of readdirSync(path.join(ROOT, 'bin'))) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      const src = readFileSync(path.join(ROOT, 'bin', name), 'utf8');
      const opensDb = /new DatabaseSync\(|from '.*db\.js'|import\(.*db\.js|openPrivilegedDb/.test(src);
      if (opensDb && !honoursDbPath(src)) offenders.push(name);
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

/**
 * `bin/pinecone-index.mjs` and the database it opens.
 *
 * ── Two live incidents, both the same shape ──
 *
 * `.env` carries `WEV_DB_PATH=../pilot.db`, which is relative to `server/` — the
 * cwd the dev and start scripts use. The `pinecone:*` npm scripts run from the
 * REPOSITORY ROOT, where that string means one level above the repository, and
 * from a git worktree it means `.claude/worktrees/pilot.db`.
 *
 * `node:sqlite` creates a database that is not there. So the first live run of
 * `pinecone:setup` silently created an empty one, and a backfill against it
 * would have embedded nothing, reported "0 failed", and exited 0 — the same
 * silent-wrong-database failure `bin/resolveDb.mjs` records.
 *
 * Resolving correctly was necessary and not sufficient: a correct rule still
 * points at nothing when the file genuinely is absent. Both halves are asserted
 * here.
 */
describe('the Pinecone CLI opens the database an operator meant', () => {
  const CLI = path.join(ROOT, 'bin', 'pinecone-index.mjs');

  const run = (env) => {
    try {
      return execFileSync(process.execPath, [CLI, 'stats'], {
        cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
        env: { ...process.env, JWT_SECRET: 'x'.repeat(48), ...env },
      });
    } catch (err) {
      return String(err.stdout || '') + String(err.stderr || '');
    }
  };

  /** The refusal. Nothing is created, and the path tried is named. */
  it('refuses a database that does not exist instead of creating one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-pinecone-missing-'));
    const missing = path.join(dir, 'not-there.db');

    const out = run({ WEV_DB_PATH: missing });

    expect(out).toMatch(/does not exist/i);
    expect(out).toContain(missing);
    expect(existsSync(missing), 'the CLI created the database it was pointed at').toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * And a relative value resolves against `server/`, the same rule
   * `bin/resolveDb.mjs` applies — NOT against the cwd, which for these scripts
   * is the repository root.
   */
  it('resolves a relative WEV_DB_PATH against server/, not the cwd', () => {
    /* A unique name per run. A leftover from an earlier run — this test creates
       nothing, but a broken build might — would otherwise make the assertion
       fail for a reason that has nothing to do with the code under test. */
    const probe = `wev-relative-probe-${Date.now()}.db`;
    const out = run({ WEV_DB_PATH: `../${probe}` });

    /* server/../ is the repository root, so that is where it must have looked —
       and it must have refused, since nothing is there. */
    expect(out).toContain(path.join(ROOT, probe));
    expect(existsSync(path.join(ROOT, probe)),
      'the CLI created the database it was pointed at').toBe(false);
    expect(existsSync(path.join(path.dirname(ROOT), probe)),
      'it resolved against the cwd and created a file outside the repository').toBe(false);
  });
});
