import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
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
  'bin/reset-dev-db.mjs',
  /* The accessibility harness resets a scratch database before every run, which
     makes it destructive in exactly the way this suite exists for. Listed here
     rather than given its own guard so a refusal added to the shared gate
     reaches it automatically — the drift this file's header describes. */
  'bin/a11y-audit.mjs'
];

/**
 * Runs a tool and captures the outcome without throwing.
 *
 * `spawnSync` rather than `execFileSync` because `combined` has to include
 * stderr on a *successful* exit too. `execFileSync` only surfaces stderr by
 * throwing, so on exit 0 it returns stdout alone — which silently made
 * `combined` mean "both streams on failure, one stream on success". A warning
 * printed before a tool proceeds anyway (the real-data override) lands on stderr
 * with exit 0, so under the old helper any assertion about it could never match:
 * a vacuous test of exactly the kind this suite exists to prevent.
 */
function run(script, { env = {}, args = [], cwd = ROOT } = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd,
    // stdin is a pipe here, never a TTY — which is itself part of what is being
    // tested: a tool with no --yes and no terminal must refuse, not hang.
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });

  const out = String(res.stdout || '');
  return { code: res.status ?? 1, out, combined: out + String(res.stderr || '') };
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

/**
 * The PostgreSQL case, which every other gate in this file is blind to.
 *
 * The three existing gates all reason about a FILE — a path is resolved, the
 * path is inspected, the path is opened as SQLite and its rows counted. On
 * PostgreSQL the target is a URL and the path names a file that does not exist,
 * and a missing file reads as "nothing to protect". So all three passed.
 *
 * Measured on 2026-08-19, not reasoned about: with DATABASE_ENGINE=postgres and
 * a DATABASE_URL exported — the shell state the PostgreSQL runbook tells an
 * operator to create — `reset-dev-db.mjs --yes` created 65 tables and seeded 15
 * demo accounts, including an administrator, all sharing the password published
 * in docs/operations/pilot-credentials.md. NODE_ENV was unset, which is the
 * ordinary state of an operator's shell, so the production gate never fired.
 *
 * Asserted per tool rather than once, because reset-dev-db.mjs composes the gate
 * out of individual calls instead of using guardDestructive — which is exactly
 * how the previous content check came to miss it.
 */
describe('destructive CLIs refuse a PostgreSQL target', () => {
  for (const tool of DESTRUCTIVE_TOOLS) {
    it(`${tool} refuses DATABASE_ENGINE=postgres`, () => {
      const dir = scratchDir('pgengine');
      const dbFile = path.join(dir, 'scratch.db');
      writeFileSync(dbFile, 'sentinel');

      const res = run(tool, {
        env: {
          DATABASE_ENGINE: 'postgres',
          /* Unreachable on purpose. The refusal must happen before anything
             tries to connect, so a wrong URL must not be what stops it. */
          DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nonexistent',
          WEV_DB_PATH: dbFile,
          JWT_SECRET: 'x'.repeat(48),
        },
        args: ['--yes'],
      });

      const untouched = existsSync(dbFile) && readFileSync(dbFile, 'utf8') === 'sentinel';
      rmSync(dir, { recursive: true, force: true });

      expect(res.code, `expected a non-zero exit\n${res.combined}`).not.toBe(0);
      expect(res.combined).toMatch(/REFUS/i);
      expect(untouched, 'the database was modified despite the refusal').toBe(true);
      /* The URL carries the password; a refusal must not print it. */
      expect(res.combined).not.toMatch(/nobody@127\.0\.0\.1/);
    });

    it(`${tool} refuses a bare DATABASE_URL with no engine set`, () => {
      /* DATABASE_ENGINE defaults to sqlite, so an operator who exported only the
         URL still has a shell pointed at a deployment. */
      const dir = scratchDir('pgurl');
      const dbFile = path.join(dir, 'scratch.db');
      writeFileSync(dbFile, 'sentinel');

      const res = run(tool, {
        env: {
          DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nonexistent',
          WEV_DB_PATH: dbFile,
          JWT_SECRET: 'x'.repeat(48),
        },
        args: ['--yes'],
      });

      const untouched = existsSync(dbFile) && readFileSync(dbFile, 'utf8') === 'sentinel';
      rmSync(dir, { recursive: true, force: true });

      expect(res.code, `expected a non-zero exit\n${res.combined}`).not.toBe(0);
      expect(res.combined).toMatch(/REFUS/i);
      expect(untouched).toBe(true);
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

/**
 * Regression cover for the demo-reset landmine.
 *
 * The path checks above ask where a database sits and what it is called. The
 * pilot database sits at the repository root and is called `pilot.db`, so it
 * passes both — and `docs/operations/demo-reset.md` described that exact file as
 * disposable and told the operator to run `bin/seed-pilot.js` against it. The
 * typed confirmation was no help either: the operator types the filename because
 * they believe the file is scratch. A prompt cannot correct a false belief about
 * what a file is, so the guard has to look at what is inside it.
 */
describe('destructive CLIs refuse a database that holds real data', () => {
  /**
   * Builds a database that looks real: a seeded demo database plus the one
   * marker a seed never produces, an owner account.
   *
   * Seeding first matters — the guard must be shown rejecting a database that is
   * otherwise byte-for-byte what the demo tooling itself creates, so the test
   * proves the marker is doing the work rather than some incidental difference.
   */
  function seedThenPromoteAnOwner(dir) {
    const dbFile = path.join(dir, 'pilot.db');
    const seeded = run('bin/seed-pilot.js', {
      env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
      args: ['--yes']
    });
    if (seeded.code !== 0) throw new Error(`fixture seed failed\n${seeded.combined}`);

    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbFile)});
      db.prepare("UPDATE users SET role = 'super_admin' WHERE id = (SELECT id FROM users LIMIT 1)").run();
    `], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });

    return dbFile;
  }

  for (const tool of DESTRUCTIVE_TOOLS) {
    it(`${tool} refuses a database containing owner accounts, and leaves it untouched`, () => {
      const dir = scratchDir('realdata');
      const dbFile = seedThenPromoteAnOwner(dir);
      const before = readFileSync(dbFile);

      const res = run(tool, {
        env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
        args: ['--yes']
      });

      const after = existsSync(dbFile) ? readFileSync(dbFile) : null;
      rmSync(dir, { recursive: true, force: true });

      expect(res.code, `expected a refusal\n${res.combined}`).not.toBe(0);
      expect(res.combined).toMatch(/REFUS/i);
      // It must name what it found, so the operator learns the file is not what
      // they thought rather than that some check failed.
      expect(res.combined).toMatch(/super_admin|owner/i);
      expect(after, 'the database was deleted').not.toBeNull();
      expect(Buffer.compare(before, after), 'the database was modified').toBe(0);
    });
  }

  /**
   * The guard must not break the thing it protects.
   *
   * A demo database has to stay resettable indefinitely, so seeding twice over
   * the same file must work. This is the assertion that would have caught using
   * `hours_ledger` as a marker: a fresh seed writes five rows to it, so that
   * choice would have refused every legitimate reset from the second one onward.
   */
  it('a freshly seeded demo database can still be reset again', () => {
    const dir = scratchDir('reseed');
    const dbFile = path.join(dir, 'demo.db');
    const env = { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) };

    const first = run('bin/seed-pilot.js', { env, args: ['--yes'] });
    const second = run('bin/seed-pilot.js', { env, args: ['--yes'] });

    rmSync(dir, { recursive: true, force: true });

    expect(first.code, `first seed failed\n${first.combined}`).toBe(0);
    expect(second.code, `re-seeding a demo database was refused\n${second.combined}`).toBe(0);
  });

  it('an absent database is not mistaken for a real one', () => {
    const dir = scratchDir('absent');
    const dbFile = path.join(dir, 'does-not-exist-yet.db');

    const res = run('bin/seed-pilot.js', {
      env: { NODE_ENV: 'development', WEV_DB_PATH: dbFile, JWT_SECRET: 'x'.repeat(48) },
      args: ['--yes']
    });

    rmSync(dir, { recursive: true, force: true });
    expect(res.code, `creating a new database was refused\n${res.combined}`).toBe(0);
  });

  it('the override proceeds, but only when set explicitly', () => {
    const dir = scratchDir('override');
    const dbFile = seedThenPromoteAnOwner(dir);

    const res = run('bin/seed-pilot.js', {
      env: {
        NODE_ENV: 'development',
        WEV_DB_PATH: dbFile,
        JWT_SECRET: 'x'.repeat(48),
        WEV_ALLOW_DESTROYING_REAL_DATA: '1'
      },
      args: ['--yes']
    });

    rmSync(dir, { recursive: true, force: true });

    expect(res.code, `the documented override did not work\n${res.combined}`).toBe(0);
    // It still has to say what it is doing — an override is not a silent mode.
    expect(res.combined).toMatch(/WARNING/i);
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
  /**
   * A script's code, with comments removed.
   *
   * Both checks below decide "does this file delete something" by looking for
   * `unlinkSync` and friends, and both used to look at the raw source. The
   * second check already stripped comments before deciding whether the gate was
   * *called*, for a reason its own note gives: "these files document the gate at
   * length, and the prose names the very functions being searched for."
   *
   * The detection half had the same flaw and it bit. `bin/migration-baseline.mjs`
   * contains no deletion at all — it restores a dump into `:memory:` precisely so
   * that nothing has to be deleted — but it *explains* that choice in a comment,
   * and naming `unlinkSync` there was enough to be reported as an ungated
   * destructive tool.
   *
   * That false positive is not harmless. The obvious way to silence it is to add
   * a `guardDestructive()` call to a script that destroys nothing, which is a
   * meaningless gate on a no-op and teaches the next author that the gate is a
   * formality to be satisfied rather than a check that means something. (It was
   * also the first fix attempted, and it was wrong.)
   *
   * Stripping comments cannot hide a real deletion: a call inside a comment is
   * not a call.
   */
  const codeOf = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const DELETES = /unlinkSync|rmSync|rimraf|DROP TABLE/i;

  // A static guard. The F-1 lesson is that hand-maintained parallel lists drift;
  // this makes the drift a test failure instead of a production incident.
  it('every bin/ script that deletes a file imports the shared gate', () => {
    const offenders = [];
    for (const name of readdirSync(path.join(ROOT, 'bin'))) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      const code = codeOf(readFileSync(path.join(ROOT, 'bin', name), 'utf8'));
      if (DELETES.test(code) && !/db-safety\.mjs/.test(code)) offenders.push(name);
    }
    expect(offenders, 'these delete data without the shared safety gate').toEqual([]);
  });

  /**
   * The detection itself still works — asserted, not assumed.
   *
   * Loosening what a security guard looks at is the kind of change that can
   * quietly turn it into a test that passes because it inspects nothing. This
   * checks both directions on synthetic sources: a real call is still caught
   * after comment-stripping, and a mention in prose is not.
   */
  it('still detects a real deletion, and still ignores one described in a comment', () => {
    const realCall = "import fs from 'fs';\nfs.unlinkSync(target);\n";
    const inBlockComment = '/**\n * We deliberately avoid unlinkSync here.\n */\nconst x = 1;\n';
    const inLineComment = '// no unlinkSync in this file\nconst x = 1;\n';

    expect(DELETES.test(codeOf(realCall)), 'a real unlinkSync call must still be detected').toBe(true);
    expect(DELETES.test(codeOf(inBlockComment)), 'a block comment must not count').toBe(false);
    expect(DELETES.test(codeOf(inLineComment)), 'a line comment must not count').toBe(false);
  });

  /**
   * Importing the gate is not running the gate.
   *
   * `bin/reset-dev-db.mjs` imported `db-safety.mjs` and satisfied the check
   * above while composing the gate out of its individual pieces rather than
   * calling `guardDestructive`. So when the real-data content check was added to
   * that function, it did not reach this script — and it went on deleting a
   * database the other two tools refused. The import-only assertion could not
   * see the difference, because the import was there the whole time.
   *
   * This asserts the property that actually matters: whatever else a destructive
   * tool does, the content check runs. A script may reach it either through
   * `guardDestructive` or by calling `refuseNonDisposableDatabase` directly, so
   * both spellings count — the requirement is that the check happens, not which
   * function name gets it there.
   */
  it('every bin/ script that deletes a file actually RUNS the content check', () => {
    const offenders = [];
    let scanned = 0;

    for (const name of readdirSync(path.join(ROOT, 'bin'))) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      /* Comments are stripped before BOTH questions — "does this delete
         anything" and "does it run the check" — because these files document the
         gate at length and the prose names the very functions being searched
         for. Detecting on the raw source reported a script that deletes nothing
         and merely explains why. */
      const code = codeOf(readFileSync(path.join(ROOT, 'bin', name), 'utf8'));
      if (!DELETES.test(code)) continue;

      scanned++;
      const runsCheck = /guardDestructive\s*\(/.test(code)
        || /refuseNonDisposableDatabase\s*\(/.test(code);
      if (!runsCheck) offenders.push(name);
    }

    expect(scanned, 'the scan found no destructive scripts — it is testing nothing')
      .toBeGreaterThan(0);
    expect(
      offenders,
      'these delete a database file without ever running the real-data content check. '
      + 'Call guardDestructive(), or refuseNonDisposableDatabase() if the script '
      + 'composes the gate itself.'
    ).toEqual([]);
  });
});

/**
 * Guards the guard.
 *
 * Every assertion above is "exit non-zero and print REFUS". A tool whose file
 * does not exist exits non-zero, and node's own error contains no "REFUS" — so
 * a missing file fails loudly today. `existsSync` proves only that: the file is
 * there. It cannot tell a working gate from a broken one — a syntax error or a
 * bad import still leaves the file sitting on disk, `existsSync` still returns
 * true, and none of that is what the assertion below actually checks.
 *
 * The second assertion per tool is what closes the hole `existsSync` cannot: a
 * tool with a syntax error exits non-zero and prints no "REFUS", which would
 * satisfy the exit-code half of every assertion above while the refusal it is
 * supposed to prove never ran. `node --check` parses the file without running
 * it and without resolving its imports, so it proves the file parses — nothing
 * about whether it runs, or what a bad import inside it would do.
 */
describe('the destructive-tool list points at real tools', () => {
  for (const tool of DESTRUCTIVE_TOOLS) {
    it(`${tool} exists`, () => {
      expect(existsSync(path.join(ROOT, tool)), `${tool} is listed but absent`).toBe(true);
    });

    it(`${tool} parses without a syntax error`, () => {
      const res = spawnSync(process.execPath, ['--check', tool], {
        cwd: ROOT, stdio: 'pipe', encoding: 'utf8'
      });
      const combined = String(res.stdout || '') + String(res.stderr || '');
      expect(res.status, `${tool} failed to parse\n${combined}`).toBe(0);
    });
  }
});
