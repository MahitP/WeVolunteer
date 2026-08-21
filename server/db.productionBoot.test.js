/**
 * The production boot path fails CLOSED.
 *
 * ── What this is guarding against ──
 *
 * The worst outcome of this migration is not PostgreSQL being down. It is a
 * deployment configured for PostgreSQL that quietly opens SQLite instead,
 * reports healthy, and serves traffic from an empty or stale database while
 * everyone believes the cutover succeeded. Nothing about that failure is
 * visible from the outside until somebody notices their data is missing.
 *
 * `db.engine.test.js` covers the SELECTION — which engine the variables name,
 * and that a typo or an unready gate stops the boot. This file covers what
 * happens AFTER a valid selection, when the database itself will not cooperate:
 * unreachable server, wrong database name, bad credentials, schema never
 * created. Each of those must raise, and none of them may produce a working
 * SQLite handle.
 */
import { describe, it, expect } from 'vitest';
import { PostgresDatabase } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';

const URL = process.env.TEST_POSTGRES_URL;
const live = Boolean(URL);

/** A URL pointing at the same server, with one part replaced. */
const variant = (overrides) => {
  const u = new URL_CTOR(URL);
  if (overrides.database !== undefined) u.pathname = `/${overrides.database}`;
  if (overrides.port !== undefined) u.port = String(overrides.port);
  if (overrides.user !== undefined) u.username = overrides.user;
  if (overrides.password !== undefined) u.password = overrides.password;
  return u.toString();
};
const URL_CTOR = globalThis.URL;

describe.skipIf(!live)('a PostgreSQL boot that cannot work fails loudly', () => {
  /**
   * A short timeout throughout: the point is that these REJECT, and waiting the
   * default ten seconds for each only makes the suite slow.
   */
  const connect = (connectionString) =>
    new PostgresDatabase({ connectionString, max: 1, connectionTimeoutMillis: 3_000, translate: translatePlaceholders });

  it('refuses a server that is not listening, rather than falling back', async () => {
    /* Port 1 is reserved and nothing serves PostgreSQL there. */
    const db = connect(variant({ port: 1 }));
    await expect(async () => db.prepare('SELECT 1 AS ok').get()).rejects.toThrow();
    /* And it did not quietly become something else on the way. */
    expect(db.dialect, 'a failed PostgreSQL handle must not report as another engine').toBe('postgres');
    await db.close().catch(() => { /* never opened */ });
  }, 30_000);

  it('refuses a database that does not exist', async () => {
    const db = connect(variant({ database: 'wv_does_not_exist_probe' }));
    await expect(async () => db.prepare('SELECT 1 AS ok').get()).rejects.toThrow(/does not exist|3D000/i);
    await db.close().catch(() => {});
  }, 30_000);

  it('refuses credentials the server will not accept', async () => {
    const db = connect(variant({ user: 'wv_no_such_role_probe', password: 'wrong' }));
    await expect(async () => db.prepare('SELECT 1 AS ok').get()).rejects.toThrow();
    await db.close().catch(() => {});
  }, 30_000);

  /**
   * The shape that matters most, because it is the one that could plausibly
   * look fine: a reachable database with none of the application's tables.
   *
   * A boot that got this far and answered queries would be serving an empty
   * platform. It must raise on the first real read instead.
   */
  it('refuses to read from a reachable database with no schema', async () => {
    const db = connect(URL);
    await db.exec('DROP SCHEMA IF EXISTS wv_empty_probe CASCADE');
    await db.exec('CREATE SCHEMA wv_empty_probe');
    try {
      await expect(
        async () => db.prepare('SELECT id FROM wv_empty_probe.users LIMIT 1').get(),
        'an empty database must not answer as though it held the application',
      ).rejects.toThrow(/does not exist|42P01/i);
    } finally {
      await db.exec('DROP SCHEMA IF EXISTS wv_empty_probe CASCADE');
      await db.close();
    }
  }, 30_000);

  /**
   * A failure must not poison the pool for everyone after it.
   *
   * A rejected statement returns its client; if it did not, a handful of bad
   * queries would exhaust the pool and the symptom would be the whole
   * application hanging rather than one request failing.
   */
  it('returns the connection after a failed statement, so the pool survives', async () => {
    const db = connect(URL);
    try {
      for (let i = 0; i < 5; i += 1) {
        await expect(async () => db.prepare('SELECT * FROM no_such_table_probe').all())
          .rejects.toThrow();
      }
      /* With max: 1, this can only succeed if every failure above released. */
      expect((await db.prepare('SELECT 1 AS ok').get()).ok).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);
});
