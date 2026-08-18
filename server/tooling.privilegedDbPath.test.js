import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

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
const SCRIPTS = [
  'bin/grant-ownership.mjs',
  'bin/revoke-ownership.mjs',
  'bin/make-admin.mjs',
  'bin/bootstrap-owners.mjs',
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
  it('reads WEV_DB_PATH from the repository .env with no --env-file flag', () => {
    const envFile = path.join(ROOT, '.env');
    if (!existsSync(envFile)) {
      /* Nothing to prove on a checkout without one; the cwd test above covers the
         resolution rule itself. Skipping loudly rather than passing quietly. */
      console.warn('[skipped] no .env in this checkout');
      return;
    }

    /* Deliberately no WEV_DB_PATH in the environment, and cwd elsewhere, so the
       only way to reach the repository's pilot.db is to have read `.env`. */
    const out = run('bin/grant-ownership.mjs', ['nobody@example.invalid', 'probe'],
      { WEV_DB_PATH: undefined, __cwd: tmpdir() });

    expect(out).toContain('Database: ');
    /* The fallback is `server/wevolunteer.db`. Reaching anything else proves the
       file was parsed. Asserted as "not the fallback" rather than a hardcoded
       pilot.db so this still holds on a checkout whose `.env` names another file. */
    const line = out.split('\n').find((l) => l.startsWith('Database: '));
    expect(line).not.toContain(path.join(ROOT, 'server', 'wevolunteer.db'));
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
