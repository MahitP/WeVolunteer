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
   * The three shapes that defeat a naive string comparison, and the whole
   * reason the fingerprint covers host+port+database rather than the URL.
   */
  it('ignores credentials, so a rotated password cannot silently disable the guard', () => {
    expect(databaseFingerprint('postgres://user:DIFFERENT@db.abcdefgh.supabase.co:5432/postgres')).toBe(FP);
    expect(databaseFingerprint('postgres://other:pw@db.abcdefgh.supabase.co:5432/postgres')).toBe(FP);
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
