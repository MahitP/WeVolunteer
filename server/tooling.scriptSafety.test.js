import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Regression cover: no development CLI may destroy a production database.
 *
 * `bin/seed-pilot.js` used to resolve `WEV_DB_PATH`, then set
 * `process.env.NODE_ENV = 'development'` itself, then `fs.unlinkSync()` the file
 * unconditionally — no confirmation, no production check, and the one signal that
 * would have identified a real deployment overwritten before anything read it.
 * `bin/simulate-pilot.js` did the same NODE_ENV override and then mutated whatever
 * database it found (approving organizers, crediting hours).
 *
 * `bin/` is present on the production host — the backup timer runs
 * `/srv/wevolunteer/bin/backup.sh` — so this was reachable in one command:
 *
 *     WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db node bin/seed-pilot.js
 *
 * and it would have replaced the live records with 26 accounts sharing a
 * published password, one of them an administrator.
 *
 * These tests assert the three properties the task requires, for every
 * destructive tool at once, so a tool added later cannot quietly skip them.
 */

const ROOT = process.cwd();

/** Tools that delete or mutate a database and therefore need the full gate. */
const DESTRUCTIVE_TOOLS = [
  'bin/seed-pilot.js',
  'bin/simulate-pilot.js',
  'bin/reset-dev-db.mjs'
];

/**
 * Runs a tool and captures the outcome without throwing.
 *
 * `execFileSync` throws on a non-zero exit, which is the expected result for most
 * of these cases, so the status and both streams are normalised here instead of
 * being wrapped in try/catch at every call site.
 */
function run(script, { env = {}, args = [], cwd = ROOT } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      // stdin is a pipe here, never a TTY — which is itself part of what is being
      // tested: a tool with no --yes and no terminal must refuse, not hang.
      env: { ...process.env, ...env }
    });
    return { code: 0, out: stdout, combined: stdout };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: String(err.stdout || ''),
      combined: String(err.stdout || '') + String(err.stderr || '')
    };
  }
}

/** A throwaway directory under the OS temp root, which the guard must permit. */
function scratchDir(label) {
  return mkdtempSync(path.join(tmpdir(), `wev-safety-${label}-`));
}

describe('destructive CLIs refuse a production environment', () => {
  for (const tool of DESTRUCTIVE_TOOLS) {
    it(`${tool} refuses NODE_ENV=production`, () => {
      const dir = scratchDir('prodenv');
      const dbFile = path.join(dir, 'scratch.db');
      // A real file, so the refusal cannot be mistaken for "nothing to do".
      writeFileSync(dbFile, 'sentinel');

      const res = run(tool, {
        env: { NODE_ENV: 'production', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
        args: ['--yes'] // even an explicit yes must not get past the production gate
      });

      const stillThere = existsSync(dbFile);
      const untouched = stillThere && readFileSync(dbFile, 'utf8') === 'sentinel';
      rmSync(dir, { recursive: true, force: true });

      expect(res.code, `expected a non-zero exit\n${res.combined}`).not.toBe(0);
      expect(res.combined).toMatch(/REFUS/i);
      expect(untouched, 'the database was modified despite the refusal').toBe(true);
    });
  }
});

describe('destructive CLIs refuse a production-looking database path', () => {
  // NODE_ENV is the primary gate, but an operator who exported only WEV_DB_PATH
  // never sets it. This is the second net under that case.
  for (const tool of DESTRUCTIVE_TOOLS) {
    it(`${tool} refuses a path under /var/lib`, () => {
      const res = run(tool, {
        env: {
          NODE_ENV: 'development',
          WEV_DB_PATH: '/var/lib/wevolunteer/wevolunteer.db',
          JWT_SECRET: 'x'.repeat(48)
        },
        args: ['--yes']
      });

      expect(res.code, `expected a non-zero exit\n${res.combined}`).not.toBe(0);
      expect(res.combined).toMatch(/REFUS/i);
      // It must name the reason, not just fail — an operator needs to know it was
      // the path that was rejected and not a missing file.
      expect(res.combined).toMatch(/production/i);
    });
  }

  it('refuses a path whose own name says production', () => {
    const dir = scratchDir('named');
    const dbFile = path.join(dir, 'wevolunteer-production.db');
    writeFileSync(dbFile, 'sentinel');

    const res = run('bin/seed-pilot.js', {
      env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
      args: ['--yes']
    });

    const untouched = existsSync(dbFile) && readFileSync(dbFile, 'utf8') === 'sentinel';
    rmSync(dir, { recursive: true, force: true });

    expect(res.code).not.toBe(0);
    expect(untouched).toBe(true);
  });
});

describe('destructive CLIs require explicit confirmation', () => {
  for (const tool of DESTRUCTIVE_TOOLS) {
    it(`${tool} refuses without --yes when stdin is not a terminal`, () => {
      const dir = scratchDir('confirm');
      const dbFile = path.join(dir, 'scratch.db');
      writeFileSync(dbFile, 'sentinel');

      // No --yes, and stdin is a pipe. The tool must refuse rather than either
      // proceeding or blocking on a prompt nobody can answer.
      const res = run(tool, {
        env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) }
      });

      const untouched = existsSync(dbFile) && readFileSync(dbFile, 'utf8') === 'sentinel';
      rmSync(dir, { recursive: true, force: true });

      expect(res.code, `expected a non-zero exit\n${res.combined}`).not.toBe(0);
      expect(res.combined).toMatch(/REFUS|confirm/i);
      expect(untouched, 'the database was modified without confirmation').toBe(true);
    });
  }
});

describe('destructive CLIs announce the target before mutating it', () => {
  for (const tool of DESTRUCTIVE_TOOLS) {
    it(`${tool} prints the resolved database path`, () => {
      const dir = scratchDir('announce');
      const dbFile = path.join(dir, 'scratch.db');

      const res = run(tool, {
        env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
        args: ['--yes']
      });

      rmSync(dir, { recursive: true, force: true });

      // The full resolved path, so an operator can see WHICH file before the
      // prompt — the check that makes a typed confirmation meaningful.
      expect(res.combined, `path not announced\n${res.combined}`).toContain(dbFile);
    });
  }
});

describe('development usage still works', () => {
  it('seed-pilot.js seeds a scratch database when confirmed', () => {
    const dir = scratchDir('seed-ok');
    const dbFile = path.join(dir, 'pilot-scratch.db');

    const res = run('bin/seed-pilot.js', {
      env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
      args: ['--yes']
    });

    let counts = null;
    if (existsSync(dbFile)) {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(${JSON.stringify(dbFile)});
        const n = t => db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
        console.log(JSON.stringify({ users: n('users'), events: n('events') }));
      `], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
      counts = JSON.parse(out);
    }

    rmSync(dir, { recursive: true, force: true });

    expect(res.code, `seeding failed\n${res.combined}`).toBe(0);
    expect(counts, 'no database was produced').not.toBeNull();
    expect(counts.users).toBeGreaterThan(0);
    expect(counts.events).toBeGreaterThan(0);
  });

  /**
   * Comments are stripped before matching.
   *
   * Both scripts now document the defect in their headers, quoting the offending
   * line verbatim — which a naive grep over the raw source counts as a hit. The
   * assertion is about executable code, so the prose has to come out first.
   */
  function codeOnly(relPath) {
    return readFileSync(path.join(ROOT, relPath), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '');      // whole-line comments
  }

  it('seed-pilot.js does not force NODE_ENV, so the production gate stays reachable', () => {
    // The specific defect: `process.env.NODE_ENV = 'development'` in the script
    // body meant no downstream check could ever observe a production process.
    expect(codeOnly('bin/seed-pilot.js')).not.toMatch(/process\.env\.NODE_ENV\s*=\s*['"]development['"]/);
  });

  it('simulate-pilot.js does not force NODE_ENV either', () => {
    expect(codeOnly('bin/simulate-pilot.js')).not.toMatch(/process\.env\.NODE_ENV\s*=\s*['"]development['"]/);
  });

  it('no destructive tool assigns NODE_ENV at all', () => {
    // Broader than the two cases above: assigning NODE_ENV to *anything* in one of
    // these scripts defeats the gate, so the whole pattern is barred rather than
    // just the literal 'development'.
    for (const tool of DESTRUCTIVE_TOOLS) {
      expect(codeOnly(tool), `${tool} assigns NODE_ENV`).not.toMatch(/process\.env\.NODE_ENV\s*=/);
    }
  });

  it('simulate-pilot.js runs against a seeded scratch database', () => {
    const dir = scratchDir('sim-ok');
    const dbFile = path.join(dir, 'pilot-scratch.db');

    const seeded = run('bin/seed-pilot.js', {
      env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
      args: ['--yes']
    });
    const sim = run('bin/simulate-pilot.js', {
      env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
      args: ['--yes']
    });

    rmSync(dir, { recursive: true, force: true });

    expect(seeded.code, seeded.combined).toBe(0);
    expect(sim.code, `simulation failed\n${sim.combined}`).toBe(0);
  });
});

describe('the safety gate cannot be skipped by a new tool', () => {
  // A static guard. The F-1 lesson is that hand-maintained parallel lists drift;
  // this makes the drift a test failure instead of a production incident.
  it('every bin/ script that deletes a file imports the shared gate', () => {
    const offenders = [];
    for (const name of readdirSync(path.join(ROOT, 'bin'))) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      const src = readFileSync(path.join(ROOT, 'bin', name), 'utf8');
      const deletes = /unlinkSync|rmSync|rimraf|DROP TABLE/i.test(src);
      if (deletes && !/db-safety\.mjs/.test(src)) offenders.push(name);
    }
    expect(offenders, 'these delete data without the shared safety gate').toEqual([]);
  });
});
