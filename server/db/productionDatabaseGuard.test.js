import { describe, it, expect } from 'vitest';
import {
  databaseFingerprint, deploymentEnvironment, assertNotProductionDatabase, describeFingerprint
} from './productionDatabaseGuard.js';
import { postgresConfig } from './engine.js';

const PROD = 'postgres://user:pw@db.abcdefgh.supabase.co:5432/postgres';
const FP = databaseFingerprint(PROD);

describe('databaseFingerprint', () => {
  it('is stable for the same host, port and database', () => {
    expect(databaseFingerprint(PROD)).toBe(FP);
  });

  /**
   * The shapes that defeat a naive string comparison, and the whole reason the
   * fingerprint covers `user@host:port/database` rather than the URL.
   */
  it('ignores the password, so a rotated password cannot silently disable the guard', () => {
    expect(databaseFingerprint('postgres://user:DIFFERENT@db.abcdefgh.supabase.co:5432/postgres')).toBe(FP);
  });

  /**
   * ── The username IS significant, and that is a deliberate reversal ──
   *
   * This case used to assert the opposite — that `other:pw@…` fingerprints the
   * same as `user:pw@…` — on the grounds that credentials are excluded. That
   * conflated two different things. A password is a secret that rotates; a
   * username is the only part of a managed provider's connection string that
   * says WHICH database you are reaching.
   *
   * On Supabase every project in a region shares one pooler hostname and the
   * default database name `postgres`, and the project lives in the pooler
   * username as `postgres.<project-ref>`. Hashing host and database alone gave
   * one fingerprint for every project in the region — so a staging database
   * matched production's fingerprint and the guard would have refused to boot
   * against it. A guard that blocks legitimate staging is a guard somebody
   * turns off.
   *
   * The rotation property is unaffected: rotating a password does not change a
   * username, which the case above pins.
   */
  it('distinguishes two databases that differ only by username', () => {
    expect(databaseFingerprint('postgres://other:pw@db.abcdefgh.supabase.co:5432/postgres')).not.toBe(FP);
    /* The real shape: two Supabase projects behind one regional pooler. */
    const pooler = (ref) =>
      databaseFingerprint(`postgres://postgres.${ref}:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres`);
    expect(pooler('projectone')).not.toBe(pooler('projecttwo'));
  });

  /**
   * ── A path-less URL is the default database, not "no database" ──
   *
   * `pg` resolves a connection string with no path to a database named after
   * the user, and on Supabase the direct-connection user is `postgres` — whose
   * default database is `postgres`. So this URL reaches production, and
   * returning null for it made the guard inert on the shortest URL anybody
   * could type: a fail-open, found by review of this commit.
   */
  it('fingerprints a URL with no database path as the user default', () => {
    expect(databaseFingerprint('postgres://user:pw@db.abcdefgh.supabase.co:5432'))
      .toBe(databaseFingerprint('postgres://user:pw@db.abcdefgh.supabase.co:5432/user'));
    expect(databaseFingerprint('postgres://user:pw@db.abcdefgh.supabase.co:5432')).not.toBeNull();
  });

  /**
   * ── One database, several endpoints ──
   *
   * Host and port are both hashed, so every route to one database fingerprints
   * differently — the session pooler, the transaction pooler on 6543, and the
   * direct connection. An earlier version of the module's header claimed the
   * guard saw through that; it did not, and the direct endpoint is the one the
   * credential-rotation runbook tells an operator to use. A single value cannot
   * express "this database, however reached", so the variable is a list.
   */
  it('accepts a comma-separated list, and matches any entry', () => {
    const direct = databaseFingerprint('postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres');
    const pooler = databaseFingerprint('postgres://postgres.abcdefgh:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres');
    expect(direct).not.toBe(pooler);

    const env = {
      NODE_ENV: 'development',
      WEV_PRODUCTION_DB_FINGERPRINT: `${direct}, ${pooler}`,
    };
    /* Either endpoint is refused, which is the point of the list. */
    expect(() => assertNotProductionDatabase(env,
      'postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres')).toThrow(/PRODUCTION database/);
    expect(() => assertNotProductionDatabase(env,
      'postgres://postgres.abcdefgh:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres')).toThrow(/PRODUCTION database/);
  });

  /* Whitespace, because a systemd EnvironmentFile does not always strip it and
     a fingerprint that silently never matches is a guard that is not there. */
  it('tolerates surrounding whitespace and case in the configured value', () => {
    expect(() => assertNotProductionDatabase(
      { NODE_ENV: 'development', WEV_PRODUCTION_DB_FINGERPRINT: `  ${FP.toUpperCase()}  ` },
      PROD
    )).toThrow(/PRODUCTION database/);
  });

  it('ignores query parameters like sslmode', () => {
    expect(databaseFingerprint(PROD + '?sslmode=require')).toBe(FP);
  });

  it('treats an omitted port as 5432, so both spellings match', () => {
    expect(databaseFingerprint('postgres://user:pw@db.abcdefgh.supabase.co/postgres')).toBe(FP);
  });

  it('distinguishes a different database on the same host', () => {
    expect(databaseFingerprint('postgres://user:pw@db.abcdefgh.supabase.co:5432/staging')).not.toBe(FP);
  });

  it('distinguishes a different host', () => {
    expect(databaseFingerprint('postgres://user:pw@db.zzzzzzzz.supabase.co:5432/postgres')).not.toBe(FP);
  });

  it('distinguishes the pooler port from the direct port', () => {
    expect(databaseFingerprint('postgres://user:pw@db.abcdefgh.supabase.co:6543/postgres')).not.toBe(FP);
  });

  it('returns null rather than throwing on junk', () => {
    expect(databaseFingerprint('not a url')).toBeNull();
    expect(databaseFingerprint('')).toBeNull();
    expect(databaseFingerprint(undefined)).toBeNull();
  });

  it('never contains the password', () => {
    expect(databaseFingerprint(PROD)).not.toMatch(/pw/);
    expect(describeFingerprint(PROD)).not.toMatch(/pw|user/);
  });
});

describe('deploymentEnvironment', () => {
  /**
   * The case the guard is built around: copying production environment
   * variables into a Preview deployment copies NODE_ENV=production with them.
   * VERCEL_ENV is stamped by the platform per deployment and does not travel.
   */
  it('trusts VERCEL_ENV over an inherited NODE_ENV', () => {
    expect(deploymentEnvironment({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe('preview');
  });

  it('falls back to NODE_ENV off Vercel', () => {
    expect(deploymentEnvironment({ NODE_ENV: 'production' })).toBe('production');
    expect(deploymentEnvironment({ NODE_ENV: 'development' })).toBe('development');
    expect(deploymentEnvironment({})).toBe('development');
  });
});

describe('assertNotProductionDatabase', () => {
  it('refuses a preview deployment pointed at production', () => {
    expect(() => assertNotProductionDatabase(
      { VERCEL_ENV: 'preview', NODE_ENV: 'production', WEV_PRODUCTION_DB_FINGERPRINT: FP }, PROD
    )).toThrow(/PRODUCTION database/);
  });

  it('refuses local development pointed at production', () => {
    expect(() => assertNotProductionDatabase(
      { NODE_ENV: 'development', WEV_PRODUCTION_DB_FINGERPRINT: FP }, PROD
    )).toThrow(/PRODUCTION database/);
  });

  it('still refuses when the password has been rotated', () => {
    expect(() => assertNotProductionDatabase(
      { VERCEL_ENV: 'preview', WEV_PRODUCTION_DB_FINGERPRINT: FP },
      'postgres://user:ROTATED@db.abcdefgh.supabase.co:5432/postgres'
    )).toThrow(/PRODUCTION database/);
  });

  it('allows production to use production', () => {
    expect(() => assertNotProductionDatabase(
      { VERCEL_ENV: 'production', WEV_PRODUCTION_DB_FINGERPRINT: FP }, PROD
    )).not.toThrow();
  });

  it('allows a preview pointed at its own database', () => {
    expect(() => assertNotProductionDatabase(
      { VERCEL_ENV: 'preview', WEV_PRODUCTION_DB_FINGERPRINT: FP },
      'postgres://user:pw@db.abcdefgh.supabase.co:5432/staging'
    )).not.toThrow();
  });

  it('is inert when no fingerprint is configured', () => {
    const r = assertNotProductionDatabase({ VERCEL_ENV: 'preview' }, PROD);
    expect(r.checked).toBe(false);
  });

  it('warns, but does not throw, when production is pointed elsewhere', () => {
    const r = assertNotProductionDatabase(
      { VERCEL_ENV: 'production', WEV_PRODUCTION_DB_FINGERPRINT: FP },
      'postgres://user:pw@db.zzzzzzzz.supabase.co:5432/postgres'
    );
    expect(r.warning).toMatch(/does not match/);
  });

  it('does not leak the password into the error message', () => {
    let msg = '';
    try {
      assertNotProductionDatabase(
        { VERCEL_ENV: 'preview', WEV_PRODUCTION_DB_FINGERPRINT: FP }, PROD
      );
    } catch (e) { msg = e.message; }
    expect(msg).not.toMatch(/pw/);
    expect(msg).not.toMatch(/supabase\.co/);
  });
});

/**
 * The guard is only worth anything if it is actually on the path the
 * application takes to reach a database. This asserts the wiring, not the
 * logic — the logic is covered above, and a passing unit test for a module
 * nothing calls is the exact false green this suite is meant to avoid.
 */
describe('postgresConfig integration', () => {
  const base = {
    DATABASE_URL: PROD,
    DATABASE_SSL: 'false',
    WEV_PRODUCTION_DB_FINGERPRINT: FP,
  };

  it('refuses to build a config for a preview pointed at production', () => {
    expect(() => postgresConfig({ ...base, VERCEL_ENV: 'preview' })).toThrow(/PRODUCTION database/);
  });

  it('builds a config for production', () => {
    expect(postgresConfig({ ...base, VERCEL_ENV: 'production' }).connectionString).toBe(PROD);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The environment × database matrix, as one table
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The cases above test the mechanism. This tests the POLICY — every combination
 * of "what does this process think it is" against "which database is it holding",
 * in one place, so the answer to "what happens if staging points at production"
 * is a row rather than an inference from three separate tests.
 *
 * Written as a table because the interesting property is the shape of the whole
 * grid: exactly one quadrant is fatal, exactly one is a warning, and the rest
 * are silence. A change that made a second quadrant fatal, or the fatal one
 * quiet, would be invisible in any single case.
 */
describe('the environment x database matrix', () => {
  const PRODUCTION_DB = 'postgres://postgres.abc:pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres';
  const OTHER_DB = 'postgres://postgres:pw@localhost:5432/wv_dev';
  const FINGERPRINT = databaseFingerprint(PRODUCTION_DB);

  /** `fatal` throws, `warns` returns a warning, `quiet` does neither. */
  const CASES = [
    ['development', OTHER_DB, 'quiet', 'the everyday development loop'],
    ['development', PRODUCTION_DB, 'fatal', 'a laptop holding real students records'],
    ['test', OTHER_DB, 'quiet', 'the test suite against its own database'],
    ['test', PRODUCTION_DB, 'fatal', 'a test run that would seed and truncate production'],
    ['staging', OTHER_DB, 'quiet', 'staging against its own database'],
    ['staging', PRODUCTION_DB, 'fatal', 'staging pointed at production'],
    ['production', PRODUCTION_DB, 'quiet', 'the deployment as intended'],
    ['production', OTHER_DB, 'warns', 'production pointed elsewhere — a failed cutover, or a stale fingerprint'],
  ];

  it.each(CASES)('NODE_ENV=%s against %#: %s', (nodeEnv, url, expected) => {
    const env = { NODE_ENV: nodeEnv, WEV_PRODUCTION_DB_FINGERPRINT: FINGERPRINT };
    if (expected === 'fatal') {
      expect(() => assertNotProductionDatabase(env, url)).toThrow(/PRODUCTION database/);
      return;
    }
    const result = assertNotProductionDatabase(env, url);
    if (expected === 'warns') {
      expect(result.warning, 'production on the wrong database must not be silent').toBeTruthy();
    } else {
      expect(result.warning, 'this combination must not warn').toBeFalsy();
    }
  });

  /**
   * `NODE_ENV=test` deserves its own line because it is the one that would do
   * the most damage fastest: the suites truncate tables between files.
   */
  it('names the environment it refused, so the message is not generic', () => {
    let message = '';
    try {
      assertNotProductionDatabase(
        { NODE_ENV: 'test', WEV_PRODUCTION_DB_FINGERPRINT: FINGERPRINT }, PRODUCTION_DB,
      );
    } catch (err) { message = err.message; }
    expect(message).toMatch(/this is a development deployment/);
    expect(message, 'the fingerprint is not a secret and is what the operator must compare')
      .toContain(FINGERPRINT);
  });

  it('never puts the password in the refusal', () => {
    let message = '';
    try {
      assertNotProductionDatabase(
        { NODE_ENV: 'development', WEV_PRODUCTION_DB_FINGERPRINT: FINGERPRINT },
        'postgres://postgres.abc:sup3r-s3cret-value@aws-0-us-east-2.pooler.supabase.com:5432/postgres',
      );
    } catch (err) { message = err.message; }
    expect(message).toBeTruthy();
    expect(message).not.toContain('sup3r-s3cret-value');
  });

  /**
   * Fail-OPEN when unconfigured, and that is deliberate rather than an
   * oversight: a deployment that has never set the fingerprint has told the
   * guard nothing about which database is production, and inventing an answer
   * would refuse every boot on every developer machine in the repository.
   * The mechanism is opt-in; what it must never do is claim to have checked.
   */
  it('reports that it did not check, rather than passing silently, when unconfigured', () => {
    const result = assertNotProductionDatabase({ NODE_ENV: 'development' }, PRODUCTION_DB);
    expect(result.checked).toBe(false);
    expect(result.reason).toMatch(/no fingerprint configured/);
  });
});
