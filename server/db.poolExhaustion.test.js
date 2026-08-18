import { describe, it, expect, afterAll } from 'vitest';
import { PostgresDatabase, runTransaction } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';

/**
 * What the pool does when it runs out, which is a 3am question.
 *
 * Nothing exercised this. The application's pool is ten connections wide with a
 * ten-second `connectionTimeoutMillis`, and the interesting properties are not
 * "does it have a limit" but:
 *
 *   1. does a request that cannot get a connection FAIL, or hang forever;
 *   2. does the failure say what happened;
 *   3. does the pool RECOVER once the holders let go, or stay wedged.
 *
 * (3) is the one that decides whether an incident is a blip or an outage. A pool
 * that never recovers turns one slow query into a restart.
 *
 * Builds its own two-connection pool rather than borrowing the application's:
 * exhausting the real one would make every other test in the file share the
 * outage, and two is enough to prove the behaviour.
 */
const URL_ = process.env.TEST_POSTGRES_URL;

describe.skipIf(!URL_)('PostgreSQL pool exhaustion', () => {
  const pools = [];
  const makePool = (over = {}) => {
    const db = new PostgresDatabase({
      connectionString: URL_,
      translate: translatePlaceholders,
      max: 2,
      connectionTimeoutMillis: 1_500,
      ...over,
    });
    pools.push(db);
    return db;
  };

  afterAll(async () => { for (const p of pools) await p.close().catch(() => {}); });

  it('fails rather than hanging when every connection is held', async () => {
    const db = makePool();

    /* Two transactions, which is the whole pool. They are held open until the
       third attempt has had its answer. */
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const holders = [0, 1].map(() => runTransaction(db, async () => { await held; }));

    /* Give the holders time to actually check their connections out. */
    await new Promise(r => setTimeout(r, 300));

    const started = Date.now();
    let error = null;
    try {
      await db.prepare('SELECT 1 AS ok').get();
    } catch (err) {
      error = err;
    }
    const waited = Date.now() - started;

    release();
    await Promise.allSettled(holders);

    expect(error, 'a query with no connection available resolved anyway').toBeTruthy();
    /* It must give up near the configured timeout, not sit forever and not
       fail instantly in a way that would break a merely-busy pool. */
    expect(waited).toBeGreaterThan(1_000);
    expect(waited).toBeLessThan(6_000);
    expect(String(error.message)).toMatch(/timeout|connection/i);
  }, 30_000);

  it('recovers once the holders release, rather than staying wedged', async () => {
    const db = makePool();

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const holders = [0, 1].map(() => runTransaction(db, async () => { await held; }));
    await new Promise(r => setTimeout(r, 300));

    /* Written as an explicit try/await rather than `expect(...).rejects` so the
       chain carries a literal `await`. The fixture-debt ratchet counts unawaited
       prepare() chains, and a promise handed to a matcher looks identical to the
       real defect it exists to catch. */
    let exhausted = null;
    try { await db.prepare('SELECT 1 AS ok').get(); } catch (err) { exhausted = err; }
    expect(exhausted, 'the pool answered while both connections were held').toBeTruthy();

    release();
    await Promise.allSettled(holders);

    /* The point of the test: the same pool, immediately afterwards, works. */
    const row = await db.prepare('SELECT 1 AS ok').get();
    expect(Number(row.ok)).toBe(1);

    /* And it is not limping — both connections are usable again. */
    /* Concurrent on purpose — sequential queries would pass with one working
       connection. The async wrappers keep the `await` literal for the ratchet. */
    const both = await Promise.all([
      (async () => await db.prepare('SELECT 2 AS ok').get())(),
      (async () => await db.prepare('SELECT 3 AS ok').get())(),
    ]);
    expect(both.map(r => Number(r.ok))).toEqual([2, 3]);
  }, 30_000);

  it('does not leak a connection when a transaction throws', async () => {
    /* A pool of two survives far more than two failures only if each rollback
       returns its client. Ten rounds against a two-connection pool: a leak of
       even one wedges it by the third. */
    const db = makePool();

    for (let i = 0; i < 10; i += 1) {
      await expect(
        runTransaction(db, async (tx) => {
          await tx.prepare('SELECT 1').get();
          throw new Error(`deliberate ${i}`);
        })
      ).rejects.toThrow(/deliberate/);
    }

    const row = await db.prepare('SELECT 42 AS ok').get();
    expect(Number(row.ok), 'the pool was wedged by rolled-back transactions').toBe(42);
  }, 30_000);
});
