import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabase } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';
import { runInTransaction } from './db/connectionContext.js';

/**
 * The application against a real TRANSACTION-MODE connection pooler.
 *
 * ── Why this suite exists ──
 *
 * `deploy/wevolunteer.env.example` tells operators to point `DATABASE_URL` at
 * Supabase's Supavisor in transaction mode (port 6543), and
 * `db/postgresConnection.js` leaves `pg`'s named prepared statements off
 * *because* such a pooler can put a different backend under a client between
 * checkouts. Supabase's own documentation, re-read 2026-09-01, states it
 * plainly: "Transaction mode does not support prepared statements."
 *
 * All of that was reasoning. Nothing in the suite had ever executed a statement
 * through a transaction pooler, so the most load-bearing compatibility decision
 * in the deployment was an argument rather than a measurement.
 *
 * pgbouncer in transaction mode is the same protocol behaviour and runs
 * locally. `TEST_POOLER_URL` points at it; without it these skip, exactly as
 * the PostgreSQL suites skip without `TEST_POSTGRES_URL`.
 *
 *   pool_mode = transaction
 *   listen_port = 6543
 *   TEST_POOLER_URL=postgres://you@127.0.0.1:6543/wv_pool
 *
 * ── What is still NOT verified ──
 *
 * Supabase's own network path and Supavisor's specific implementation. This
 * proves the application is correct against transaction pooling as a protocol
 * behaviour; it does not prove anything about one vendor's build of it.
 */
const POOLER_URL = process.env.TEST_POOLER_URL;

describe.skipIf(!POOLER_URL)('through a transaction-mode pooler', () => {
  let db;

  beforeAll(async () => {
    /* The application's OWN translator, not a stand-in — identical SQL through
       an identical adapter is the only way this proves anything about what the
       server would do. */
    db = new PostgresDatabase({
      connectionString: POOLER_URL, max: 6, ssl: false, translate: translatePlaceholders,
    });
    await db.prepare('DROP TABLE IF EXISTS pooler_probe').run();
    await db.prepare('CREATE TABLE pooler_probe (id int PRIMARY KEY, n int NOT NULL)').run();
  }, 60_000);

  afterAll(async () => {
    if (db) {
      /* Spelled without optional chaining on purpose: `db?.prepare(...)` reads
         as an unawaited chain to `asyncShapes.test.js`, which cannot see
         through the `?.` — and a guard that has to be argued with is one that
         stops being run. */
      try { await db.prepare('DROP TABLE IF EXISTS pooler_probe').run(); } catch { /* closing */ }
      await db.close();
    }
  });

  it('runs ordinary statements', async () => {
    const row = await db.prepare('SELECT 1 AS one').get();
    expect(row.one).toBe(1);
  });

  it('reuses connections across many statements without pinning', async () => {
    /**
     * The property transaction pooling exists for, and the one that breaks if
     * anything holds session state. 200 statements through a pool of 6 means
     * the backend under a client changes repeatedly.
     */
    /* Prepared once and executed 200 times, rather than prepared 200 times.
       That is closer to what the application does, and it keeps the statement
       out of the `Promise.all` where `asyncShapes.test.js` cannot see that the
       chain is awaited. */
    const stmt = await db.prepare('SELECT CAST(? AS int) AS n');
    const results = await Promise.all(
      Array.from({ length: 200 }, async (_, i) => await stmt.get(i)),
    );
    expect(results.map(r => r.n)).toEqual([...Array(200).keys()]);
  });

  it('does not leave named prepared statements behind', async () => {
    /**
     * THE compatibility decision, tested rather than argued.
     *
     * A named statement is a per-connection server-side object. Under
     * transaction pooling the connection beneath a client changes, so a named
     * statement prepared on one backend does not exist on another — the classic
     * symptom is `prepared statement "S_1" does not exist` after some traffic.
     *
     * Running the same SQL many times through a shifting set of backends is
     * exactly the shape that triggers it. If `postgresConnection.js` ever turned
     * statement caching on, this is where it would surface.
     */
    for (let i = 0; i < 120; i++) {
      const r = await db.prepare('SELECT CAST(? AS text) AS v').get(`v${i}`);
      expect(r.v).toBe(`v${i}`);
    }

    const [{ n }] = await db.prepare(
      'SELECT COUNT(*)::int AS n FROM pg_prepared_statements'
    ).all();
    expect(n, 'a named prepared statement survived the call').toBe(0);
  });

  it('keeps a transaction on ONE backend from start to finish', async () => {
    /**
     * Transaction mode pins a connection for the length of a transaction and
     * releases it after — so a transaction is safe, and only work spanning
     * transactions is not. `runInTransaction` depends on this entirely: its
     * `FOR UPDATE` row locks mean nothing if the UPDATE lands on a different
     * backend than the SELECT.
     */
    await db.prepare('DELETE FROM pooler_probe').run();
    await db.prepare('INSERT INTO pooler_probe (id, n) VALUES (1, 0)').run();

    await runInTransaction(db, async (tx) => {
      const before = await tx.prepare('SELECT n FROM pooler_probe WHERE id = 1 FOR UPDATE').get();
      await tx.prepare('UPDATE pooler_probe SET n = ? WHERE id = 1').run(before.n + 41);
      const after = await tx.prepare('SELECT n FROM pooler_probe WHERE id = 1').get();
      expect(after.n, 'the UPDATE landed on a different backend than the SELECT').toBe(41);
    });

    expect((await db.prepare('SELECT n FROM pooler_probe WHERE id = 1').get()).n).toBe(41);
  });

  it('serialises concurrent transactions on the same row', async () => {
    /**
     * The capacity guard's actual mechanism, through the pooler. Twenty
     * transactions each read-modify-write one row under `FOR UPDATE`; the total
     * must be exactly twenty, and any lost update shows up as less.
     */
    await db.prepare('DELETE FROM pooler_probe').run();
    await db.prepare('INSERT INTO pooler_probe (id, n) VALUES (2, 0)').run();

    await Promise.all(Array.from({ length: 20 }, async () => await runInTransaction(db, async (tx) => {
      const row = await tx.prepare('SELECT n FROM pooler_probe WHERE id = 2 FOR UPDATE').get();
      await tx.prepare('UPDATE pooler_probe SET n = ? WHERE id = 2').run(row.n + 1);
    })));

    const { n } = await db.prepare('SELECT n FROM pooler_probe WHERE id = 2').get();
    expect(n, 'a concurrent update was lost through the pooler').toBe(20);
  });

  it('a rolled-back transaction leaves nothing behind', async () => {
    await db.prepare('DELETE FROM pooler_probe').run();
    await expect(runInTransaction(db, async (tx) => {
      await tx.prepare('INSERT INTO pooler_probe (id, n) VALUES (9, 9)').run();
      throw new Error('deliberate');
    })).rejects.toThrow('deliberate');

    const [{ n }] = await db.prepare('SELECT COUNT(*)::int AS n FROM pooler_probe').all();
    expect(n, 'a rolled-back INSERT survived').toBe(0);
  });

  it('recovers the pool after a failed statement', async () => {
    /**
     * On PostgreSQL a failed statement aborts its transaction, and a client
     * returned to the pool in that state poisons whoever picks it up next. This
     * is the same failure that broke migration 063's first guard, so it is
     * worth asserting the POOL recovers rather than only the statement.
     */
    /* try/catch rather than `expect(...).rejects`, so the `await` sits directly
       on the execution where `asyncShapes.test.js` can see it. An execution
       hidden inside `expect()` reads as unawaited, and that guard is right far
       more often than it is wrong. */
    const doomed = await db.prepare('SELECT * FROM no_such_relation_here');
    let threw = false;
    try { await doomed.all(); } catch { threw = true; }
    expect(threw, 'a query against a missing relation did not throw').toBe(true);
    const row = await db.prepare('SELECT 2 AS two').get();
    expect(row.two, 'the pool did not recover from a failed statement').toBe(2);
  });

  it('survives more concurrent work than the pool has clients', async () => {
    /* Requests queue for a client rather than erroring — the behaviour
       `HEALTH_POOL_STATS` exists to make visible under load. */
    const stmt = await db.prepare('SELECT CAST(? AS int) AS n');
    const out = await Promise.all(
      Array.from({ length: 60 }, async (_, i) => await stmt.get(i)),
    );
    expect(out).toHaveLength(60);
    expect(db.stats.waiting).toBe(0);
  });
});
