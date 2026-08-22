import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * The accessibility harness must refuse to run against anything but a scratch
 * database.
 *
 * The shared gate in bin/lib/db-safety.mjs already refuses production, a
 * PostgreSQL target, a production-looking path, and a database holding real
 * accounts. It does not refuse an UNSET WEV_DB_PATH, because it is written for
 * an operator at a terminal who can read the announced path before confirming.
 * This harness runs unattended, and the default resolution is
 * server/wevolunteer.db — a real developer database with real local accounts in
 * it. Auditing that silently is the failure this adds.
 *
 * The other addition is the scratch/ containment rule. A path under the OS temp
 * root satisfies every existing check, which is correct for the hand-run tools
 * and too loose here: the harness writes artefacts next to its database, and
 * they belong somewhere git already ignores.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const TOOL = 'bin/a11y-audit.mjs';

function run(env) {
  const res = spawnSync(process.execPath, [TOOL, '--yes'], {
    cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development', ...env }
  });
  return { code: res.status ?? 1, combined: String(res.stdout || '') + String(res.stderr || '') };
}

describe('the accessibility harness refuses a database it must not audit', () => {
  it('refuses an unset WEV_DB_PATH rather than defaulting', () => {
    const res = run({ WEV_DB_PATH: undefined });
    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    expect(res.combined).toMatch(/WEV_DB_PATH/);
  });

  it('refuses a relative WEV_DB_PATH, which resolves differently per directory', () => {
    const res = run({ WEV_DB_PATH: './scratch/a11y.db' });
    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    expect(res.combined).toMatch(/absolute/i);
  });

  it('refuses an absolute path outside scratch/, even under the temp root', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-a11y-outside-'));
    /* Deliberately not created. The containment check runs LAST, after the
       four shared refusals, so a file here would reach
       refuseNonDisposableDatabase, which opens it as SQLite — an outcome this
       test should not depend on. An absent database is explicitly fine by the
       shared suite's own "an absent database is not mistaken for a real one"
       case, so the four shared refusals pass and containment is what refuses. */
    const dbFile = path.join(dir, 'scratch.db');
    const res = run({ WEV_DB_PATH: dbFile });
    rmSync(dir, { recursive: true, force: true });
    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    // Specifically the containment message, not any refusal that happens to
    // echo a path containing the literal word "scratch" (the fixture's own
    // filename is scratch.db, which refuseProductionLikePath's message would
    // also contain).
    expect(res.combined).toMatch(/outside scratch\//);
  });

  it('accepts an absolute path under scratch/', () => {
    /* --dry-run stops before starting browsers, so this asserts the GATE
       accepts, not that a whole audit runs. */
    const res = spawnSync(process.execPath, [TOOL, '--yes', '--dry-run'], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
      env: {
        ...process.env, NODE_ENV: 'development',
        WEV_DB_PATH: path.join(ROOT, 'scratch', 'a11y.db'),
        DATABASE_ENGINE: 'sqlite'
      }
    });
    const combined = String(res.stdout || '') + String(res.stderr || '');
    expect(res.status, combined).toBe(0);
    expect(combined).not.toMatch(/REFUS/i);
  });
});

/**
 * The symlink defence, exercised directly.
 *
 * The containment check resolves the database's PARENT with realpathSync so a
 * symlinked directory cannot smuggle the target out of scratch/ — but that
 * alone has two blind spots. A symlinked LEAF (the database path itself is a
 * link) has a parent that sits correctly inside scratch/ and would sail
 * through the parent check while pointing anywhere on disk. And a DANGLING
 * symlink — one whose target does not exist — defeats existsSync, which
 * follows links and reports "not found" for a dangling one, which then falls
 * to a lexical comparison that only sees the link's own path, never where it
 * points or fails to point. Both are closed by a single lstatSync check on
 * the resolved WEV_DB_PATH itself: lstatSync (never statSync, which follows
 * the link) succeeds whether or not the link's target exists, and reports the
 * link as a link either way.
 */
describe('the containment check refuses a symlinked WEV_DB_PATH', () => {
  it('refuses a symlinked parent directory that points outside scratch/, pinning the existing parent check', () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'wev-a11y-symlink-target-'));
    const linkDir = path.join(ROOT, 'scratch', `sym-parent-${process.pid}`);
    symlinkSync(outsideDir, linkDir);
    const dbFile = path.join(linkDir, 'a11y.db');

    const res = run({ WEV_DB_PATH: dbFile });

    unlinkSync(linkDir);
    rmSync(outsideDir, { recursive: true, force: true });

    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
  });

  it('refuses a symlinked leaf, even though its own path sits inside scratch/', () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'wev-a11y-symlink-target-'));
    const dbFile = path.join(ROOT, 'scratch', `sym-leaf-${process.pid}.db`);
    // The link's own path is squarely inside scratch/; only its target is not.
    symlinkSync(path.join(outsideDir, 'fake.db'), dbFile);

    const res = run({ WEV_DB_PATH: dbFile });

    unlinkSync(dbFile);
    rmSync(outsideDir, { recursive: true, force: true });

    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    expect(res.combined).toMatch(/symlink/i);
  });

  it('refuses a dangling symlink, which existsSync cannot see', () => {
    // Never created, so the link's target does not exist — existsSync(dbFile)
    // is false, which is exactly the condition that fell through to the
    // lexical branch of the OLD parent-only check.
    const missingTarget = path.join(tmpdir(), `wev-a11y-missing-${process.pid}-${Date.now()}`);
    const dbFile = path.join(ROOT, 'scratch', `sym-dangling-${process.pid}.db`);
    symlinkSync(missingTarget, dbFile);

    const res = run({ WEV_DB_PATH: dbFile });

    unlinkSync(dbFile);

    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    expect(res.combined).toMatch(/symlink/i);
  });
});
