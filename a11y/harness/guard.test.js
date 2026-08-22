import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
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
    expect(res.combined).toMatch(/scratch/);
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
