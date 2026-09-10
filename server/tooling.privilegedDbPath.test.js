import { describe, it, expect, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, symlinkSync, cpSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { databaseFingerprint } from './db/productionDatabaseGuard.js';

/** Same reasoning as `tooling.dbPath.test.js`: these spawn real `node` processes. */
vi.setConfig({ testTimeout: 20000 });

/**
 * Which database the four privileged command-line scripts change.
 *
 * ── The incident ──
 *
 * `tooling.dbPath.test.js` records the first version of this bug: `verifyHours.js`
 * ignored `WEV_DB_PATH`, opened a stale `server/wevolunteer.db`, and printed PASS
 * about a file nobody cared about. The fix made it read the variable.
 *
 * The privileged scripts had the same disease in two forms that fix did not reach,
 * and they are worse here because `bin/grant-ownership.mjs` is the *only*
 * sanctioned way to create an owner. A silent wrong-database write means an
 * operator reads "Successfully granted ownership", signs in, and is not an owner.
 *
 *   1. **`.env` was never loaded.** Every entry point that honours `.env` does it
 *      with `node --env-file-if-exists`, which is an npm-script flag. These four
 *      were invoked as plain `node bin/x.mjs`, so `WEV_DB_PATH` was simply absent
 *      and the fallback `server/wevolunteer.db` won.
 *
 *   2. **A relative value resolved against `process.cwd()`.** `.env` here says
 *      `WEV_DB_PATH=../pilot.db`. From the server's cwd (`server/`) that is the
 *      repository root's `pilot.db` — the live database. From a `bin/` script's cwd
 *      (the repository root) it is one level higher, outside the repository.
 *
 * The second one had already happened: a `pilot.db` sat outside the repository with
 * 15 migrations and 14 users against the live file's 23 and 18. Nothing copied it
 * there — `new DatabaseSync` creates an absent file, so a privileged script wrote a
 * fresh empty database and then reported success about it.
 *
 * Hence the three properties below: the same file from any cwd, a refusal rather
 * than a new file, and the path printed on every run.
 */

const ROOT = path.resolve(__dirname, '..');

/**
 * The `node_modules` Node would actually resolve from, found rather than assumed.
 *
 * ── Why `path.join(ROOT, 'node_modules')` is not it ──
 *
 * The copy below lives in the system temp directory, outside the repository, so
 * Node's upward search for a package starts and ends there — it cannot reach the
 * real tree by walking up. The symlink is what supplies it, and it pointed at
 * `ROOT/node_modules` unconditionally.
 *
 * That is only the dependency tree in a plain checkout. It is NOT one when the
 * tree is hoisted above `ROOT`, which happens for an ordinary reason: a **git
 * worktree**. `<repo>/.claude/worktrees/<name>` has its own `ROOT` and no
 * packages under it — Node finds them by walking up to the main checkout — so
 * `ROOT/node_modules` is either absent or, as here, a directory holding nothing
 * but Vite's cache. The symlink then resolved to an empty tree and the spawned
 * script died on `Cannot find package 'pg'` before reaching any behaviour this
 * file is about.
 *
 * The failure was indistinguishable from the defect under test: both produce a
 * run with no sentinel in its output. So the suite reported a database-safety
 * regression that did not exist, on any machine using a worktree.
 *
 * Walking up from `ROOT` and probing for a package the copied scripts genuinely
 * need is the same search Node performs, and it gives the right answer for a
 * checkout, a worktree, and a hoisted workspace alike.
 */
function dependencyTree() {
  /* `pg` and `bcryptjs` are both real dependencies of `bin/grant-ownership.mjs`'s
     import graph, so a tree containing them is a tree that can run it. Probing on
     a named package rather than on the directory existing is the whole point —
     the broken case had a `node_modules` directory that was simply empty. */
  const PROBES = ['pg', 'bcryptjs'];
  let dir = ROOT;
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (PROBES.every(pkg => existsSync(path.join(candidate, pkg)))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `No node_modules containing [${PROBES.join(', ')}] above ${ROOT}. `
    + 'Run `npm ci` — these cases spawn a copy of bin/ and server/ in a temp '
    + 'directory, which needs a real dependency tree symlinked into it.'
  );
}
const SCRIPTS = [
  'bin/grant-ownership.mjs',
  'bin/revoke-ownership.mjs',
  'bin/make-admin.mjs',
  'bin/bootstrap-owners.mjs',
  'bin/suspend-account.mjs',
];

/**
 * Run a script and return its combined output, whatever the exit code.
 *
 * Every case here expects a refusal, so a non-zero exit is the normal path and
 * `execFileSync` throwing on it is noise rather than signal.
 */
function run(script, args, env = {}) {
  try {
    return execFileSync(process.execPath, ['--no-warnings', path.join(ROOT, script), ...args], {
      cwd: env.__cwd || ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, __cwd: undefined },
    });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
}

describe('privileged CLI database resolution', () => {
  /**
   * The property that actually prevents the incident: one config value, one file,
   * regardless of where the operator happened to be standing.
   *
   * Asserted with a RELATIVE `WEV_DB_PATH`, because an absolute one cannot express
   * the bug — `path.resolve` is only ambiguous for relative input, so a test that
   * passed an absolute path would pass against the broken code too.
   */
  it.each(SCRIPTS)('%s resolves a relative WEV_DB_PATH the same way from any cwd', (script) => {
    /* `../pilot.db` is the real `.env` value. Anchored at `server/`, it names the
       repository root — so both runs must print the repository root's path. */
    const fromRoot = run(script, ['nobody@example.invalid', 'probe'],
      { WEV_DB_PATH: '../pilot.db', __cwd: ROOT });
    const fromElsewhere = run(script, ['nobody@example.invalid', 'probe'],
      { WEV_DB_PATH: '../pilot.db', __cwd: tmpdir() });

    const line = (out) => out.split('\n').find((l) => l.startsWith('Database: '));

    expect(line(fromRoot), `${script} printed no Database: line`).toBeTruthy();
    expect(line(fromElsewhere)).toBe(line(fromRoot));

    /* And it is the repository's own file, not the one a level above it. */
    expect(line(fromRoot)).toContain(path.join(ROOT, 'pilot.db'));
    expect(line(fromRoot)).not.toContain(path.join(path.dirname(ROOT), 'pilot.db'));
  });

  /**
   * The refusal that stops the fossil file from ever being created again.
   *
   * `new DatabaseSync(absent)` creates the file. That is the mechanism by which a
   * mistyped path became a real database that answered every query "not found",
   * which reads to an operator as a data problem rather than a wrong-file problem.
   */
  it.each(SCRIPTS)('%s refuses a path that does not exist, and does not create it', (script) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-nodb-'));
    const missing = path.join(dir, 'not-here.db');
    try {
      const out = run(script, ['nobody@example.invalid', 'probe'], { WEV_DB_PATH: missing });

      expect(out).toContain('Refused: no database at');
      expect(out).toContain(missing);
      expect(existsSync(missing), 'the script created a database').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A file that is not a WeVolunteer database must be named as such.
   *
   * Without this, opening a backup or an unrelated SQLite file produces "User with
   * email x not found" — a sentence about the user, for a problem that has nothing
   * to do with them.
   */
  it.each(SCRIPTS)('%s refuses a SQLite file with no users table', (script) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-notwev-'));
    const bogus = path.join(dir, 'something-else.db');
    try {
      /* A real SQLite file, so the failure is about content rather than format. */
      execFileSync(process.execPath, ['--no-warnings', '-e', `
        const { DatabaseSync } = require('node:sqlite');
        const d = new DatabaseSync(${JSON.stringify(bogus)});
        d.exec('CREATE TABLE unrelated (x INTEGER)');
        d.close();
      `]);

      const out = run(script, ['nobody@example.invalid', 'probe'], { WEV_DB_PATH: bogus });
      expect(out).toContain('is not an initialised WeVolunteer database');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * `.env` is read without an `--env-file` flag.
   *
   * This is the half that made the whole thing invisible: the scripts had no way to
   * see the variable that says which database is live, so they could not have been
   * right even in principle.
   *
   * Run in a temporary directory containing its own `.env`? No — `.env` is read
   * from the repository root, which is the point (a fixed anchor, not cwd). So the
   * assertion is that the repository's own `.env` value is what appears, which is
   * only true if the file was parsed.
   */
  /**
   * `.env` is parsed with no `--env-file` flag.
   *
   * ── Why this no longer reads the developer's own `.env` ──
   *
   * It used to run against the real repository file and assert the resolved path
   * was not the built-in fallback — the reasoning being that reaching anything
   * else proved the file had been read. That made the case depend on the
   * contents of an untracked file, and it broke the moment `WEV_DB_PATH` was
   * deliberately removed from it: the hazardous default this suite exists to
   * document was the very thing the case was using as its fixture.
   *
   * A temp copy with a `.env` this test writes proves the same property and
   * cannot be invalidated by a local configuration change. It also states the
   * expected path positively instead of by exclusion, which is a stronger claim.
   */
  it('reads WEV_DB_PATH from the repository .env with no --env-file flag', () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wev-envparse-')));
    try {
      const skip = (src) => /\.test\.[cm]?js$|\.db(-wal|-shm)?$/.test(src);
      cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true, filter: (s) => !skip(s) });
      cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true, filter: (s) => !skip(s) });
      symlinkSync(dependencyTree(), path.join(dir, 'node_modules'));
      cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));

      /* A disposable database, so the real-data guard has nothing to say and
         this case stays about `.env` parsing alone. */
      const named = path.join(dir, 'from-dotenv.db');
      const db = new DatabaseSync(named);
      db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, account_status TEXT);"
        + "INSERT INTO users VALUES ('u-1','student','active');");
      db.close();
      writeFileSync(path.join(dir, '.env'), `WEV_DB_PATH=${named}\n`);

      /* No WEV_DB_PATH in the environment and cwd elsewhere, so reading `.env`
         is the only way to arrive at that file. */
      const r = spawnSync(process.execPath, [path.join(dir, 'bin', 'grant-ownership.mjs'),
        'nobody@example.invalid', 'probe'], {
        cwd: tmpdir(),
        env: { ...process.env, WEV_DB_PATH: undefined, DATABASE_ENGINE: undefined,
               DATABASE_URL: undefined },
        encoding: 'utf8',
        input: 'y\n',
      });
      const out = (r.stdout || '') + (r.stderr || '');

      const line = out.split('\n').find((l) => l.startsWith('Database: '));
      expect(line, 'the .env file was not parsed').toContain(named);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * An explicit environment variable outranks `.env`.
   *
   * `bin/reset-dev-db.mjs` and the suites that exercise these scripts all set
   * `WEV_DB_PATH` deliberately and point it at throwaway files. If a stray `.env`
   * could override that, a test run would operate on the developer's real
   * database — which is the same class of accident in the other direction.
   */
  it('lets an explicit WEV_DB_PATH win over .env', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wev-explicit-'));
    const target = path.join(dir, 'explicit.db');
    try {
      execFileSync(process.execPath, ['--no-warnings', '-e', `
        const { DatabaseSync } = require('node:sqlite');
        const d = new DatabaseSync(${JSON.stringify(target)});
        d.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
        d.close();
      `]);

      const out = run('bin/grant-ownership.mjs', ['nobody@example.invalid', 'probe'],
        { WEV_DB_PATH: target });

      expect(out).toContain(target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The engine and the URL get the same precedence as the path.
   *
   * `WEV_DB_PATH` was preserved across `process.loadEnvFile`; `DATABASE_ENGINE`
   * and `DATABASE_URL` were not. Once a deployment put a real `DATABASE_URL`
   * into `.env`, that file silently outranked the operator:
   *
   *     DATABASE_ENGINE=sqlite node bin/reset-2fa.mjs someone@example.org
   *
   * ran against PRODUCTION. Same defect this whole file exists for — a
   * privileged command acting on a database nobody named.
   *
   * Asserted against the source rather than by running a script, because the
   * behavioural version has to write `DATABASE_ENGINE` into the repository's
   * own `.env` while other suites are reading it in parallel. That trade is
   * worth naming: this catches the preservation being narrowed or dropped, and
   * does NOT prove the resolved precedence end-to-end. The end-to-end proof is
   * the six privileged-CLI suites, which fail outright whenever `.env` carries
   * a production engine and URL — that is how the bug was found.
   */
  it('preserves an explicit engine and URL across .env, not just the path', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(path.join(ROOT, 'bin', 'resolveDb.mjs'), 'utf8');

    const block = src.match(/const explicit = \{([\s\S]*?)\};/);
    expect(block, 'resolveDb.mjs no longer snapshots caller-supplied variables').toBeTruthy();
    for (const key of ['WEV_DB_PATH', 'DATABASE_ENGINE', 'DATABASE_URL']) {
      expect(block[1], `${key} must outrank .env`).toContain(key);
    }

    /* An explicitly EMPTY value means "unset this" and must survive as empty.
       A truthiness check here would let `.env` hand a URL back to a caller that
       deliberately cleared it — which is exactly what the failing suites did. */
    expect(src, 'explicit empty values must be preserved, not treated as absent')
      .toMatch(/value !== undefined/);
  });

  /**
   * A caller that names a FILE must not be sent to a SERVER by `.env`.
   *
   * This is the production incident of 2026-08-19, reproduced. Two `super_admin`
   * accounts were written into the live Supabase database because
   * `ownerBootstrap.test.js` spawns `bin/bootstrap-owners.mjs` with
   * `WEV_DB_PATH` pointed at a throwaway file while `.env` carried a production
   * `DATABASE_ENGINE` and `DATABASE_URL`. The tool announced the Supabase host
   * and created the accounts there.
   *
   * The first fix preserved variables the caller had SET, and did not close
   * this: a caller that names a path has said everything it thinks it needs to
   * and never mentions `DATABASE_ENGINE`, so `.env` still supplied one. Verified
   * still broken after that fix before this rule was added.
   *
   * Run against a COPY of the repository rather than the real one, because the
   * behaviour depends on the contents of `.env` at the repository root and other
   * suites read that file concurrently. The copy is bin/ plus server/ with
   * node_modules symlinked — about a fifth of a second.
   */
  /**
   * A file nobody named, holding real people.
   *
   * ── The hazard this closes ──
   *
   * `.env` carried `WEV_DB_PATH=../pilot.db`. Every script in `bin/` resolves
   * through `loadDotEnv()`, so the DEFAULT target of every privileged command
   * was the real pilot database — minors' service records — and each command was
   * protected only by whatever guard it had thought to add for itself. Two had a
   * typed confirmation, one had a blocklist of file NAMES, and three had nothing
   * at all.
   *
   * ── Why the test is about provenance and not about the filename ──
   *
   * A name blocklist answers "is this called pilot.db", which the operator can
   * defeat by copying the file. The question worth asking is "did anybody choose
   * this file". So all three cases below use the SAME database and vary only how
   * the path arrived: inherited from `.env` (refused), named on the command line
   * (allowed), and inherited but explicitly authorised (allowed).
   *
   * The database is built here rather than copied from `pilot.db`, for the
   * reason the fixture above already gives about stray `.db` files — and because
   * a test that needs real minors' records in a temp directory to prove a
   * privacy guard has defeated its own purpose. Three synthetic rows reproduce
   * the markers `describeNonDisposableContent` actually looks for.
   */
  describe('a privileged command refuses real data it was not pointed at', () => {
    /** A repository copy whose `.env` names a SQLite file holding real-looking data. */
    function repoWithRealDataDotEnv() {
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wev-realdata-')));
      const skip = (src) => /\.test\.[cm]?js$|\.db(-wal|-shm)?$/.test(src);
      cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true, filter: (s) => !skip(s) });
      cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true, filter: (s) => !skip(s) });
      symlinkSync(dependencyTree(), path.join(dir, 'node_modules'));
      cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));

      /* The markers, and enough schema for the tool to get past its own
         "is this a WeVolunteer database" check: a super_admin account, a
         tombstone and an audit row. */
      /**
       * Two markers, not three, and deliberately NOT the audit table.
       *
       * `describeNonDisposableContent` returns non-null on ANY marker, so an
       * owner account and a tombstone are sufficient. Seeding
       * `admin_audit_logs` would have been more lifelike and is not worth it:
       * `auditLog.test.js` asserts that `recordAudit()` is the only thing in
       * `server/` or `bin/` containing that INSERT, it scans test files too, and
       * it has no allowlist. Writing the statement here — even in a fixture
       * fabricating a marker rather than recording a real action — trips it, and
       * the ways around that are all worse: an allowlist entry weakens a guard
       * protecting the most consequential table in the schema, and assembling
       * the string dynamically evades it while leaving the comment claiming
       * otherwise.
       */
      const target = path.join(dir, 'inherited.db');
      const db = new DatabaseSync(target);
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY, name TEXT, email TEXT, password_hash TEXT,
          grade TEXT, role TEXT, created_at TEXT, account_status TEXT
        );
        INSERT INTO users (id,name,email,password_hash,grade,role,created_at,account_status)
          VALUES ('u-own','Owner','owner@example.invalid','x','12','super_admin','now','active');
        INSERT INTO users (id,name,email,password_hash,grade,role,created_at,account_status)
          VALUES ('u-gone','Gone','gone@example.invalid','x','11','student','now','deleted');
      `);
      db.close();

      writeFileSync(path.join(dir, '.env'), `WEV_DB_PATH=${target}\n`);
      return { dir, target };
    }

    /* A local copy: the sibling block's `runIn` is scoped to it, and the
       environment this one needs to clear differs — WEV_ALLOW_REAL_DATA has to
       start unset or the override case proves nothing. */
    function runIn(dir, env) {
      const r = spawnSync(process.execPath, [path.join(dir, 'bin', 'grant-ownership.mjs'),
        'nobody@example.invalid', 'probe'], {
        cwd: dir,
        env: { ...process.env, WEV_DB_PATH: undefined, DATABASE_ENGINE: undefined,
               DATABASE_URL: undefined, WEV_ALLOW_REAL_DATA: undefined, ...env },
        encoding: 'utf8',
        input: 'y\n',
      });
      return (r.stdout || '') + (r.stderr || '');
    }

    it('refuses when the path came from .env, and says what it found', () => {
      const { dir, target } = repoWithRealDataDotEnv();
      try {
        const out = runIn(dir, {});
        expect(out, 'a privileged command operated on real data nobody named')
          .toContain('holds real data');
        /* The refusal has to name the evidence, or the operator cannot tell it
           from a path typo. */
        expect(out).toContain('owner (super_admin) account');
        expect(out).toContain('deleted-account tombstone');
        /* And it must not have gone on to do the thing. */
        expect(out).not.toContain('Successfully granted');
        expect(out).toContain(target);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('allows the same database when the caller names it', () => {
      /* The emergency path. `bin/reset-2fa.mjs` is the only way to clear a
         locked-out administrator's second factor, and an operator who typed the
         path has chosen it. A guard that refused this would be the outage. */
      const { dir, target } = repoWithRealDataDotEnv();
      try {
        const out = runIn(dir, { WEV_DB_PATH: target });
        expect(out, 'naming the file on the command line was still refused')
          .not.toContain('holds real data');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('allows an inherited path when WEV_ALLOW_REAL_DATA=1 is set', () => {
      /* For a runbook step that cannot pass the path. Distinct from
         WEV_ALLOW_DESTROYING_REAL_DATA: operating on live data and destroying it
         are different permissions, and the first must not confer the second. */
      const { dir } = repoWithRealDataDotEnv();
      try {
        const out = runIn(dir, { WEV_ALLOW_REAL_DATA: '1' });
        expect(out).not.toContain('holds real data');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('says nothing about a disposable database that arrived the same way', () => {
      /* The guard must be about CONTENT, not about inheritance alone — otherwise
         every ordinary `.env`-configured development command starts refusing. */
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wev-disposable-')));
      try {
        const skip = (src) => /\.test\.[cm]?js$|\.db(-wal|-shm)?$/.test(src);
        cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true, filter: (s) => !skip(s) });
        cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true, filter: (s) => !skip(s) });
        symlinkSync(dependencyTree(), path.join(dir, 'node_modules'));
        cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
        const target = path.join(dir, 'scratch.db');
        const db = new DatabaseSync(target);
        db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, account_status TEXT);
                 INSERT INTO users VALUES ('u-1','student','active');`);
        db.close();
        writeFileSync(path.join(dir, '.env'), `WEV_DB_PATH=${target}\n`);

        expect(runIn(dir, {})).not.toContain('holds real data');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('an explicit database path outranks a .env engine', () => {
    const SENTINEL = 'db.SENTINEL-MUST-NOT-BE-REACHED.supabase.co';
    /* The exact string the harness writes into `.env`, so the fingerprint
       cases can be derived from it rather than reconstructing it. */
    const DOTENV_URL = `postgres://postgres:x@${SENTINEL}:5432/postgres`;

    /** A repository copy whose `.env` points at PostgreSQL. */
    function repoWithPostgresDotEnv() {
      /* realpath, because on macOS `mkdtemp` hands back /var/folders/… while
         Node resolves a module's own `__filename` to /private/var/folders/… for
         the same file. Every `bin/` script guards its `main()` with
         `path.resolve(process.argv[1]) === path.resolve(__filename)`, so the two
         spellings make that comparison false: the script exits 0 having done
         nothing, and the test reads as "the tool produced no output" rather than
         as a path problem. The same symlink is why `startTestServer` realpaths
         both sides before comparing. */
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wev-dotenv-')));
      /* Tests and databases are excluded: they are irrelevant here, and copying
         a `.db` file into a temp directory is exactly the kind of stray database
         this whole file exists to prevent. */
      const skip = (src) => /\.test\.[cm]?js$|\.db(-wal|-shm)?$/.test(src);
      cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true, filter: (s) => !skip(s) });
      cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true, filter: (s) => !skip(s) });
      symlinkSync(dependencyTree(), path.join(dir, 'node_modules'));
      /* Without it every server/*.js is parsed as CommonJS, because "type":
         "module" lives in package.json — and the copy then fails on its first
         import rather than on the behaviour under test. */
      cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
      writeFileSync(path.join(dir, '.env'),
        `DATABASE_ENGINE=postgres\nDATABASE_URL=${DOTENV_URL}\n`);
      return dir;
    }

    function runIn(dir, env) {
      const r = spawnSync(process.execPath, [path.join(dir, 'bin', 'grant-ownership.mjs'),
        'nobody@example.invalid', 'probe'], {
        cwd: dir,
        env: { ...process.env, WEV_DB_PATH: undefined, DATABASE_ENGINE: undefined,
               DATABASE_URL: undefined, ...env },
        encoding: 'utf8',
        input: 'y\n',
      });
      return (r.stdout || '') + (r.stderr || '');
    }

    it('stays on the named file when .env says postgres', () => {
      const dir = repoWithPostgresDotEnv();
      try {
        const target = path.join(dir, 'named.db');
        const out = runIn(dir, { WEV_DB_PATH: target });

        /* The whole finding in one assertion: the tool must never announce, nor
           reach for, the host `.env` named. */
        expect(out, 'the .env engine overrode an explicitly named database file')
          .not.toContain(SENTINEL);
        expect(out).toContain(target);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still honours an engine the caller asked for explicitly', () => {
      /* The rule must not become "WEV_DB_PATH always means SQLite". An operator
         who sets both has said what they want, and production sets
         DATABASE_ENGINE in its own environment — that path must keep working. */
      const dir = repoWithPostgresDotEnv();
      try {
        const out = runIn(dir, { WEV_DB_PATH: path.join(dir, 'named.db'), DATABASE_ENGINE: 'postgres' });
        expect(out).toContain(SENTINEL);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('leaves a deployment that names no path alone', () => {
      /* With no WEV_DB_PATH there is no contradiction to resolve, and `.env` is
         how a deployment is configured. */
      const dir = repoWithPostgresDotEnv();
      try {
        expect(runIn(dir, {})).toContain(SENTINEL);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * ── And the production-database guard covers this path too ──
     *
     * The test directly above is the reason this one has to exist. `.env` IS how
     * some deployments are configured, and the emergency tooling must keep
     * working for them — `bin/reset-2fa.mjs` is the only way to clear a locked
     * out administrator's second factor, so a rule that refused a `.env`
     * connection string outright would make a lost authenticator unrecoverable.
     * Precedence therefore cannot be the mechanism.
     *
     * `assertNotProductionDatabase` is. It asks a different question — not
     * "where did this value come from" but "is this deployment allowed to touch
     * THAT database" — and it answers from a fingerprint of `host:port/database`
     * that carries no credentials and is safe to commit. So an operator on the
     * production host proceeds, and `vitest` (NODE_ENV=test, hence
     * `deploymentEnvironment() === 'development'`) is refused.
     *
     * This is asserted against the CLI rather than only against
     * `postgresConfig`, because `bin/resolveDb.mjs` deliberately does not import
     * `server/db/engine.js` and therefore did not inherit the guard the server
     * got. These six scripts hold the most privilege in the repository.
     */
    it('refuses the production database from a non-production process', () => {
      const dir = repoWithPostgresDotEnv();
      try {
        /* Derived by calling the guard's OWN fingerprint function on the same
           URL `.env` carries, rather than re-hashing here. A restated hash is a
           second copy of the rule: this test was written with one and broke the
           moment the fingerprint started covering the username, reporting "the
           guard did not fire" when the guard was fine. */
        const fingerprint = databaseFingerprint(DOTENV_URL);

        const out = runIn(dir, { WEV_PRODUCTION_DB_FINGERPRINT: fingerprint });

        expect(out, 'the guard did not fire').toMatch(/PRODUCTION database/);
        /* The point of the whole exercise: no connection was attempted. The
           guard runs before PostgresDatabase is constructed, so the host is
           never dialled — and the message must not print the URL either. */
        expect(out).not.toContain('postgres://');
        expect(out).not.toContain('Database: ');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * The guard must not become a reason the tooling stops working in an
     * emergency. A process that says it IS production proceeds, and gets as far
     * as trying to reach the host — which is a connection failure here, because
     * the sentinel does not resolve, and that is the correct outcome.
     */
    it('still lets a production process through to its own database', () => {
      const dir = repoWithPostgresDotEnv();
      try {
        const out = runIn(dir, {
          WEV_PRODUCTION_DB_FINGERPRINT: databaseFingerprint(DOTENV_URL),
          NODE_ENV: 'production',
        });

        expect(out, 'the guard refused a production process').not.toMatch(/PRODUCTION database/);
        /* It reached the connection attempt: the host is announced, then the
           lookup fails because the sentinel is unresolvable. */
        expect(out).toContain(SENTINEL);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  /**
   * Nothing may reintroduce a private path resolution.
   *
   * The four scripts each had their own copy of the same expression, which is why
   * fixing `verifyHours.js` did not fix them. A fifth script written next month
   * would copy the nearest neighbour, so the thing to guard is that there is no
   * neighbour left to copy.
   */
  it('has no privileged script resolving its own database path', async () => {
    const { readFileSync } = await import('fs');
    const offenders = SCRIPTS.filter((s) => {
      const src = readFileSync(path.join(ROOT, s), 'utf8');
      return /process\.env\.WEV_DB_PATH/.test(src) || /new DatabaseSync\(/.test(src);
    });

    expect(
      offenders,
      'These scripts resolve or open a database themselves instead of calling '
      + 'openPrivilegedDb() from bin/resolveDb.mjs, which is what makes the path '
      + 'independent of the working directory.',
    ).toEqual([]);
  });
});

/**
 * The privileged scripts on PostgreSQL.
 *
 * ── What changed, and why the old assertion is gone ──
 *
 * These six scripts used to speak SQLite only. `openPrivilegedDb` had no
 * PostgreSQL branch, so on a PostgreSQL deployment they fell through to the
 * file-existence check and reported "no database at …/pilot.db". An earlier
 * revision of this file pinned that refusal, because an accurate refusal beat a
 * misleading one. They now actually work, so pinning the refusal would pin the
 * bug.
 *
 * ── Why it mattered enough to port rather than document ──
 *
 * `bin/reset-2fa.mjs` is the ONLY way to clear a locked-out account's two-factor
 * enrolment. Every `/api/2fa/*` route is self-service behind `requireAAL2` — you
 * must already hold a second factor to remove one — and REQUIRE_ADMIN_2FA
 * defaults on. On PostgreSQL without this tooling, an administrator who loses
 * their authenticator and recovery codes is locked out permanently.
 *
 * These tests cover what can be asserted without a live server: the engine is
 * honoured, a missing URL fails closed, and SQLite is untouched. Actually
 * mutating a PostgreSQL database is covered by the cutover rehearsal in
 * `docs/operations/postgres-cutover-and-rollback.md`, which was executed against
 * a scratch database on 2026-08-18 — reset-2fa cleared the secret, zeroed both
 * flags, bumped token_version and wrote the audit row.
 */
describe('privileged scripts and the PostgreSQL engine', () => {
  const SCRIPTS = [
    'bin/reset-2fa.mjs',
    'bin/grant-ownership.mjs',
    'bin/revoke-ownership.mjs',
    'bin/make-admin.mjs',
    'bin/bootstrap-owners.mjs',
    'bin/clear-stale-tfa-secret.mjs',
    'bin/suspend-account.mjs',
  ];

  for (const script of SCRIPTS) {
    it(`${script} fails closed on DATABASE_ENGINE=postgres with no DATABASE_URL`, () => {
      const out = run(script, ['someone@example.org', 'a reason'], {
        DATABASE_ENGINE: 'postgres',
        DATABASE_URL: undefined,
      });

      expect(out).toMatch(/DATABASE_URL is not set/);
      /* It must not silently fall back to a SQLite file when the deployment has
         said it is on PostgreSQL. That fallback is how a privileged command ends
         up reporting success against a database nobody reads. */
      expect(out).not.toMatch(/no database at/);
    });
  }

  it('does not reach for PostgreSQL when the engine is SQLite, explicitly or by default', () => {
    const missing = path.join(ROOT, 'definitely-not-a-database.db');

    for (const env of [{ DATABASE_ENGINE: 'sqlite' }, { DATABASE_ENGINE: undefined }]) {
      const out = run('bin/reset-2fa.mjs', ['someone@example.org', 'a reason'], {
        ...env,
        WEV_DB_PATH: missing,
        DATABASE_URL: 'postgres://should-never-be-used@localhost:5432/nope',
      });
      /* DATABASE_URL is set and must be ignored: the engine, not the presence of
         a connection string, decides. */
      expect(out).toMatch(/no database at/);
      expect(out).not.toMatch(/should-never-be-used/);
    }
  });

  it('never prints the connection string, which carries the password', () => {
    const out = run('bin/reset-2fa.mjs', ['someone@example.org', 'a reason'], {
      DATABASE_ENGINE: 'postgres',
      DATABASE_URL: 'postgres://wev:sup3rs3cr3t@db.internal:5432/wevolunteer',
    });
    expect(out).not.toMatch(/sup3rs3cr3t/);
    /* Host and database name are what the operator needs to answer "is that the
       right server", and are safe to show. */
    expect(out).toMatch(/db\.internal:5432\/wevolunteer/);
  });
});
