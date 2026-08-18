import { describe, it, expect } from 'vitest';
import { resolveEngine, harnessOverride, postgresConfig, SQLITE, POSTGRES, POSTGRES_READY } from './db/engine.js';

/**
 * The engine switch.
 *
 * Small, but it is the thing standing between a half-ported application and a
 * real database — so the refusals matter more than the happy path.
 */
describe('resolving the database engine', () => {
  it('defaults to SQLite when nothing is set', () => {
    expect(resolveEngine({})).toBe(SQLITE);
  });

  it('accepts an explicit sqlite, case-insensitively and with whitespace', () => {
    expect(resolveEngine({ DATABASE_ENGINE: 'SQLite' })).toBe(SQLITE);
    expect(resolveEngine({ DATABASE_ENGINE: ' sqlite ' })).toBe(SQLITE);
  });

  /**
   * A typo must stop the boot, not fall back.
   *
   * `DATABASE_ENGINE=postgre` quietly running on SQLite is indistinguishable
   * from a successful migration until somebody looks for their data in the wrong
   * database. This is the same reasoning `config.js` applies to every setting
   * whose absence cannot be noticed at runtime.
   */
  it('refuses an unrecognised engine rather than defaulting', () => {
    expect(() => resolveEngine({ DATABASE_ENGINE: 'postgre' })).toThrow(/not a known engine/);
    expect(() => resolveEngine({ DATABASE_ENGINE: 'mysql' })).toThrow(/not a known engine/);
  });

  /**
   * Pinned to the current state of the port, and meant to be changed by the
   * commit that makes PostgreSQL runnable — together with `POSTGRES_READY`.
   *
   * ── Why the wording assertions keep moving ──
   *
   * They have now moved twice, and both times for the same good reason: the
   * refusal describes what is actually missing, and what is missing keeps
   * shrinking. It first required the phrase "pending promise", when the blocker
   * was ~1,021 synchronous call sites. Then it required `resolveEngine`,
   * `initDatabase` and `SQLite-only SQL`, when those were the three gaps.
   *
   * All of those are closed. The one remaining precondition is that the
   * application has never run against PostgreSQL, so that is what the refusal
   * must now say — and a refusal describing solved problems is one the next
   * reader deletes. `server/sqliteDialect.test.js` holds the same facts against
   * the codebase, so this cannot drift into being merely a well-worded string.
   */
  /**
   * The gate is open, so `postgres` resolves rather than refusing.
   *
   * This test used to assert the refusal and the reason given for it. Both are
   * gone, and pinning either would pin a lie. What is worth keeping is that the
   * flag and the behaviour cannot drift apart: whichever way POSTGRES_READY
   * points, `resolveEngine` must agree with it, or a deployment reads one answer
   * from the constant and gets the other from the engine.
   */
  it('resolves postgres, in step with POSTGRES_READY', () => {
    expect(POSTGRES_READY, 'flip this together with the behaviour below').toBe(true);
    expect(resolveEngine({ DATABASE_ENGINE: POSTGRES })).toBe(POSTGRES);
  });

  it('still refuses an engine it does not know, rather than falling back', () => {
    /* The failure mode this protects is a typo: `DATABASE_ENGINE=postgre`
       quietly opening SQLite would look exactly like a successful migration. */
    expect(() => resolveEngine({ DATABASE_ENGINE: 'postgre' })).toThrow(/not a known engine/);
  });

  /**
   * The harness override, tested condition by condition.
   *
   * It was the only way past the gate while the gate was shut. Now that
   * POSTGRES_READY is true, `resolveEngine` returns postgres with or without it,
   * so the assertions about it THROWING are gone — they would pass only by
   * accident of a behaviour that no longer exists.
   *
   * `harnessOverride()` itself is still pinned condition by condition, because
   * it is still a deliberate escape hatch and "all three are required" is still
   * the property that keeps it from becoming an environment-variable bypass. If
   * the gate is ever closed again it becomes load-bearing immediately, and it
   * must not have rotted in the meantime.
   */
  describe('the PostgreSQL application-test override', () => {
    const harness = { DATABASE_ENGINE: POSTGRES, VITEST: 'true', WEV_POSTGRES_APP_TEST: '1' };

    it('lets the test harness through', () => {
      expect(harnessOverride(harness)).toBe(true);
      expect(resolveEngine(harness)).toBe(POSTGRES);
    });

    it('refuses without VITEST, which nothing outside the runner sets', () => {
      expect(harnessOverride({ ...harness, VITEST: undefined })).toBe(false);
    });

    it('refuses without the explicitly named flag', () => {
      expect(harnessOverride({ ...harness, WEV_POSTGRES_APP_TEST: undefined })).toBe(false);
    });

    it('refuses a value that merely looks enabled', () => {
      for (const value of ['true', 'yes', '0', '']) {
        expect(harnessOverride({ ...harness, WEV_POSTGRES_APP_TEST: value }), value).toBe(false);
      }
    });

    /**
     * The condition that makes this safe rather than merely narrow: even a
     * production process holding both other variables cannot use it.
     */
    it('refuses in production even with both set', () => {
      expect(harnessOverride({ ...harness, NODE_ENV: 'production' })).toBe(false);
    });

    it('does not affect the SQLite selection at all', () => {
      expect(resolveEngine({ ...harness, DATABASE_ENGINE: 'sqlite' })).toBe(SQLITE);
    });
  });
});

describe('the PostgreSQL connection settings', () => {
  const URL = 'postgres://u:p@db.example.com:5432/wv';

  it('requires DATABASE_URL', () => {
    expect(() => postgresConfig({})).toThrow(/requires DATABASE_URL/);
  });

  it('warns against putting the password in a VITE_ variable', () => {
    /* The message is the control here: a browser-visible database password is
       the single worst mistake available in this migration, and the error is
       where somebody configuring it will actually read about it. */
    expect(() => postgresConfig({})).toThrow(/VITE_/);
  });

  it('defaults the pool to 10', () => {
    expect(postgresConfig({ DATABASE_URL: URL }).max).toBe(10);
  });

  it('refuses an out-of-range or non-numeric pool size', () => {
    for (const bad of ['0', '-1', '1000', 'ten', '10.5']) {
      expect(() => postgresConfig({ DATABASE_URL: URL, DATABASE_POOL_MAX: bad }),
        `DATABASE_POOL_MAX=${bad} should be refused`).toThrow(/must be an integer between 1 and 100/);
    }
  });

  /**
   * TLS defaults to ON for a remote host and OFF for a local one.
   *
   * Getting this backwards would send every student record and the database
   * password over the internet in clear text, and it would work perfectly, so
   * nothing would ever surface it.
   */
  it('enables TLS for a remote host by default', () => {
    const cfg = postgresConfig({ DATABASE_URL: URL });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('disables TLS for localhost by default', () => {
    expect(postgresConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/wv' }).ssl).toBeUndefined();
    expect(postgresConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/wv' }).ssl).toBeUndefined();
  });

  it('lets a local connection opt INTO TLS', () => {
    const cfg = postgresConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/wv', DATABASE_SSL: 'true' });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('lets a remote connection opt OUT explicitly', () => {
    expect(postgresConfig({ DATABASE_URL: URL, DATABASE_SSL: 'false' }).ssl).toBeUndefined();
  });

  it('only skips certificate verification when asked in so many words', () => {
    expect(postgresConfig({ DATABASE_URL: URL, DATABASE_SSL_INSECURE: 'true' }).ssl)
      .toEqual({ rejectUnauthorized: false });
  });
});
