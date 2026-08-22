import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, renameSync } from 'fs';
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
 * The containment check walks every filesystem component of the resolved
 * WEV_DB_PATH, deepest first, and stops at the first one that actually exists:
 * if that component is a symlink it is refused outright, otherwise it is
 * realpath'd and must resolve inside scratch/. This replaced three earlier
 * special-case checks that each covered one end of the path:
 *
 *   - a leaf-only check (lstat dbPath itself) cannot see a symlinked PARENT,
 *     and is blind even to a DANGLING one, because lstatSync on the full leaf
 *     path throws ENOENT when an intermediate component does not resolve —
 *     indistinguishable from "does not exist yet";
 *   - a parent-only check (realpath dirname(dbPath)) cannot see a symlinked
 *     LEAF, whose parent sits correctly inside scratch/ while the leaf itself
 *     points anywhere;
 *   - neither one can see scratch/ ITSELF being a symlink, which corrupts the
 *     baseline every comparison is made against rather than just one path
 *     being compared against it.
 *
 * The tests below exercise all four shapes, plus the ordinary case where none
 * of this fires.
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

  it('refuses when an intermediate component is a dangling symlink', () => {
    /* The exact escape the leaf-only and parent-only checks each missed: the
       intermediate directory is a symlink to somewhere that does not exist,
       so lstatSync on the full leaf path throws ENOENT (an intermediate
       component that will not resolve), and existsSync on the parent alone
       also returns false and falls to a lexical comparison that never
       notices the parent is a link at all. The walk instead finds THIS
       component — the first one that actually exists on disk — and refuses
       it directly. */
    const missingTarget = path.join(tmpdir(), `wev-a11y-missing-mid-${process.pid}-${Date.now()}`);
    const linkPath = path.join(ROOT, 'scratch', `sym-dangle-mid-${process.pid}`);
    symlinkSync(missingTarget, linkPath);
    const dbFile = path.join(linkPath, 'file.db');

    const res = run({ WEV_DB_PATH: dbFile });

    unlinkSync(linkPath);

    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    // Names the link component itself, not just a generic "outside scratch/"
    // — proof the walk found the symlink rather than stopping at the first
    // thing that merely doesn't exist.
    expect(res.combined).toContain(linkPath);
  });

  it('refuses when scratch/ itself is a symlink', () => {
    /* The target file is pre-created so the walk's FIRST existing component
       is the leaf itself — a real file, not a symlink — and containment
       succeeds or fails purely on which directory realpathSync(SCRATCH)
       resolved to. If the up-front "is SCRATCH itself a symlink" guard were
       missing, scratchReal would silently become the attacker's directory
       and this exact case would pass. Without pre-creating the file, the walk
       would instead hit the scratch/ symlink itself as the first EXISTING
       component and refuse there — which would pass even with the guard
       removed, and prove nothing about it. */
    const fakeScratch = mkdtempSync(path.join(tmpdir(), 'wev-a11y-fake-scratch-'));
    const dbFile = path.join(fakeScratch, 'a11y.db');
    writeFileSync(dbFile, '');

    const realScratch = path.join(ROOT, 'scratch');
    const backupScratch = path.join(ROOT, `scratch.guard-test-backup-${process.pid}`);
    const hadRealScratch = existsSync(realScratch);
    if (hadRealScratch) renameSync(realScratch, backupScratch);

    let res;
    try {
      symlinkSync(fakeScratch, realScratch);
      res = run({ WEV_DB_PATH: path.join(realScratch, 'a11y.db') });
    } finally {
      unlinkSync(realScratch);
      if (hadRealScratch) renameSync(backupScratch, realScratch);
      rmSync(fakeScratch, { recursive: true, force: true });
    }

    expect(res.code, res.combined).not.toBe(0);
    expect(res.combined).toMatch(/REFUS/i);
    expect(res.combined).toMatch(/symlink/i);
  });

  it('accepts the ordinary happy path: a real scratch/, database absent', () => {
    /* Without this, a walk that refuses everything indiscriminately would
       look identical to a walk that refuses only what it should. */
    const dbFile = path.join(ROOT, 'scratch', 'a11y.db');
    rmSync(dbFile, { force: true });

    const res = spawnSync(process.execPath, [TOOL, '--yes', '--dry-run'], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
      env: {
        ...process.env, NODE_ENV: 'development',
        WEV_DB_PATH: dbFile,
        DATABASE_ENGINE: 'sqlite'
      }
    });
    const combined = String(res.stdout || '') + String(res.stderr || '');
    expect(res.status, combined).toBe(0);
    expect(combined).not.toMatch(/REFUS/i);
  });
});
