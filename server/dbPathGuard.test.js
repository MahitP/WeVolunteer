import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which database did we actually open?
 *
 * ── The trap this exists for ──
 *
 * `WEV_DB_PATH` is resolved against `process.cwd()`, and SQLite creates a file
 * that is not there rather than complaining. Together those two behaviours turn
 * a wrong path into a *working server attached to the wrong database* — the
 * failure mode that produces no error at all.
 *
 * This repository contains a live instance of it. `.env` carries
 * `WEV_DB_PATH=../pilot.db`, which is right because `npm run dev:server` runs
 * with `server/` as its working directory. Start the same server from the
 * repository root and the identical string resolves one directory higher, onto a
 * stale database that still holds fourteen accounts and fifteen migrations. It
 * boots, it serves, and every write goes somewhere nobody is looking.
 *
 * The guard therefore does three things, and each is asserted below: resolve the
 * path explicitly, say out loud which file was opened, and refuse the forms that
 * cannot be recovered from — a relative path or a missing file in production.
 *
 * Development is deliberately exempt from both refusals. Creating the file on
 * first run is how you get a dev database, and a guard that blocks that is a
 * guard people delete.
 */

/** Boots just `db.js` in a child, so each case gets its own module scope. */
function boot({ dbPath, nodeEnv, cwd = ROOT }) {
  // db.js is required by ABSOLUTE path: several cases deliberately run from a
  // different working directory, which is the whole point of the test, and a
  // relative require would fail for that reason instead of the one under test.
  const res = spawnSync(process.execPath, ['-e', `
    process.env.WEV_DB_PATH = ${JSON.stringify(dbPath)};
    process.env.DEMO_MODE = '';
    require(${JSON.stringify(path.join(ROOT, 'server', 'db.js'))});
    console.log('BOOT_OK');
  `], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      // config.js runs its own guards at import and would otherwise refuse a
      // production process for an unrelated reason, masking what is under test.
      // The secret needs >=32 characters AND >=8 distinct ones — a repeated
      // character is rejected for having no entropy, which is correct of it and
      // was the first thing this harness got wrong.
      JWT_SECRET: 'Xk7fQ2mZp9RtLw4vBn6yHs3JdCa8EgUo1TiVr5MzOxNbKlPq',
      TFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')
    }
  });

  return { code: res.status, combined: String(res.stdout || '') + String(res.stderr || '') };
}

const scratch = label => mkdtempSync(path.join(tmpdir(), `wev-dbpath-${label}-`));

describe('the database path is resolved, announced, and checked', () => {
  it('announces the absolute path it opened', () => {
    const dbFile = path.join(scratch('announce'), 'dev.db');
    const res = boot({ dbPath: dbFile, nodeEnv: 'development' });

    expect(res.combined).toContain('BOOT_OK');
    expect(res.combined).toContain(`[db] using ${dbFile}`);
  });

  it('warns in development that a relative path depends on the working directory', () => {
    const dir = scratch('rel-dev');
    const res = boot({ dbPath: 'relative-dev.db', nodeEnv: 'development', cwd: dir });

    expect(res.combined, 'a relative path must still work in development').toContain('BOOT_OK');
    expect(res.combined).toMatch(/relative/i);
    // The warning has to name the directory it resolved against, because that is
    // the piece of information the reader is missing when they are in the wrong one.
    expect(res.combined).toContain(dir);
    expect(existsSync(path.join(dir, 'relative-dev.db'))).toBe(true);
  });

  it('refuses a relative path in production', () => {
    const dir = scratch('rel-prod');
    const res = boot({ dbPath: 'relative-prod.db', nodeEnv: 'production', cwd: dir });

    expect(res.code, `expected a refusal\n${res.combined}`).not.toBe(0);
    expect(res.combined).toMatch(/FATAL/);
    expect(res.combined).toMatch(/absolute/i);
    // And it must refuse BEFORE creating anything.
    expect(existsSync(path.join(dir, 'relative-prod.db'))).toBe(false);
  });

  /**
   * Creating a database in production is announced, not refused.
   *
   * This was a refusal first, and it was wrong: a genuinely new deployment has
   * no database, so refusing breaks the first boot of every install — the one
   * case where creating the file is exactly right. Three existing suites that
   * boot a production-mode server against a fresh temp file caught it. The
   * warning keeps the signal without standing in front of a legitimate first
   * run, and the relative-path refusal still covers the ambiguity that has no
   * correct production use.
   */
  it('warns, but proceeds, when it has to create a database in production', () => {
    const missing = path.join(scratch('missing'), 'not-there.db');
    const res = boot({ dbPath: missing, nodeEnv: 'production' });

    expect(res.combined, `a first production boot must still work\n${res.combined}`).toContain('BOOT_OK');
    expect(res.combined).toMatch(/WARNING/);
    expect(res.combined).toMatch(/creating an empty one/i);
    // The warning is only useful if it says which file, since the whole failure
    // mode is not knowing that.
    expect(res.combined).toContain(missing);
    expect(existsSync(missing)).toBe(true);
  });

  /**
   * The positive control, and the one that stops the two refusals above from
   * being satisfied by a `db.js` that simply throws in production.
   */
  /**
   * ── SQLite LOCATORS are not filesystem paths ──
   *
   * `:memory:` and `file:` URIs are instructions to SQLite, not paths, and the
   * resolution above is actively destructive applied to them: `path.resolve(':memory:')`
   * yields `<cwd>/:memory:`, so an in-memory database silently becomes a real
   * file on disk. Dozens of test files pass `:memory:` through `WEV_DB_PATH`, and
   * the first version of this guard did exactly that — leaving `:memory:`,
   * `:memory:-shm` and `:memory:-wal` sitting in the repository root.
   *
   * Worse than the litter: a suite that believes it is running against a fresh
   * in-memory database is instead sharing a persistent file with every other
   * suite, so state leaks between runs and failures appear in whichever test
   * happens to run second.
   *
   * Asserted by running from a scratch directory and checking that nothing was
   * created there, which is the property that actually matters — a test that only
   * checked the announced string would pass while the file appeared anyway.
   */
  it('treats :memory: as a locator and never creates a file for it', () => {
    const dir = scratch('memory');
    const res = boot({ dbPath: ':memory:', nodeEnv: 'development', cwd: dir });

    expect(res.combined).toContain('BOOT_OK');
    expect(res.code).toBe(0);
    expect(
      existsSync(path.join(dir, ':memory:')),
      'an in-memory database was materialised as a file on disk'
    ).toBe(false);
    /* The sidecars WAL mode would produce beside it, for the same reason. */
    expect(existsSync(path.join(dir, ':memory:-wal'))).toBe(false);
    expect(existsSync(path.join(dir, ':memory:-shm'))).toBe(false);
    /* And it must not have been resolved to an absolute path in the announcement,
       which is what "treated as a locator" means. */
    expect(res.combined).not.toMatch(/\[db\] using .*\/:memory:/);
  });

  /**
   * The same rule for `file:` URIs, which carry query parameters (`?mode=ro`,
   * `?cache=shared`) that resolution would mangle into a filename.
   */
  it('treats a file: URI as a locator rather than resolving it', () => {
    const dir = scratch('fileuri');
    const target = path.join(dir, 'via-uri.db');
    const res = boot({ dbPath: `file:${target}`, nodeEnv: 'development', cwd: dir });

    expect(res.combined).toContain('BOOT_OK');
    /* No literal `file:...` directory appeared next to the working directory. */
    expect(existsSync(path.join(dir, `file:${target}`))).toBe(false);
  });

  /**
   * A locator is not a relative path, so the development warning must not fire
   * for it — a warning that cries wolf on every `:memory:` test run is a warning
   * nobody reads on the day it means something.
   */
  it('does not warn about working directories for a locator', () => {
    const dir = scratch('memory-warn');
    const res = boot({ dbPath: ':memory:', nodeEnv: 'development', cwd: dir });
    expect(res.combined).not.toMatch(/resolves against the current/i);
  });

  it('opens an existing absolute database in production', () => {
    const dbFile = path.join(scratch('prod-ok'), 'wevolunteer.db');

    const seeded = boot({ dbPath: dbFile, nodeEnv: 'development' });
    expect(seeded.combined, 'fixture setup failed').toContain('BOOT_OK');

    const res = boot({ dbPath: dbFile, nodeEnv: 'production' });
    expect(res.combined, `production refused a valid database\n${res.combined}`).toContain('BOOT_OK');
  });
});
