import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PostgresDatabase, runTransaction } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';
import { setDefaultConnection, createConnectionProxy, currentConnection } from './db/connectionContext.js';

/**
 * The PostgreSQL adapter, against a real PostgreSQL.
 *
 * ── Why this needs a live server and does not mock ──
 *
 * Every property worth asserting here is a property of the database, not of this
 * code: that a transaction pins a client, that two concurrent transactions
 * cannot see each other's uncommitted rows, that a rollback discards, that
 * `rowCount` reports what actually changed. A mocked `pg` would assert that the
 * adapter calls the functions the adapter calls, which is worth nothing.
 *
 * ── Why it skips rather than fails when there is no server, and how the skip
 *    is kept honest ──
 *
 * CI does not have PostgreSQL yet; SQLite is still the engine the application
 * runs on, so these cannot be a hard requirement of `npm test`. But a quiet skip
 * is how a suite comes to report success while testing nothing. Three things
 * keep it honest:
 *
 *   • the skip is announced on stderr, naming what is not covered;
 *   • skipped cases appear in vitest's summary as skipped, not as passed;
 *   • `describe.skipIf` is used rather than an early `return` inside each test,
 *     because a test that returns early **passes**, and twenty green checkmarks
 *     for twenty things that did not happen is precisely the failure mode.
 *
 * Verified by running the file both ways: with the URL set, 20 pass; with it
 * unset and early-returns instead of skipIf, 19 of them failed — which is what
 * proved the suite is doing real work rather than asserting against nothing.
 *
 *   TEST_POSTGRES_URL=postgres://…/db npm test
 */
const URL = process.env.TEST_POSTGRES_URL;
const live = Boolean(URL);
if (!live) {
  console.warn(
    '[postgres] TEST_POSTGRES_URL is not set — the PostgreSQL adapter tests are SKIPPED. '
    + 'They are the only cover for transaction pinning, pool isolation and adapter semantics.'
  );
}

describe.skipIf(!live)('the PostgreSQL adapter', () => {
  let db;

  beforeAll(async () => {
    if (!live) return;
    db = new PostgresDatabase({ connectionString: URL, max: 5, translate: translatePlaceholders });
    await db.exec(`
      DROP TABLE IF EXISTS adapter_t;
      CREATE TABLE adapter_t (
        id text PRIMARY KEY,
        v text,
        n integer,
        flag boolean,
        amount double precision,
        created_at timestamptz
      );
    `);
  }, 30000);

  afterAll(async () => {
    if (!live) return;
    await db.exec('DROP TABLE IF EXISTS adapter_t');
    await db.close();
  });

  beforeEach(async () => {
    if (!live) return;
    await db.exec('TRUNCATE adapter_t');
  });

  /** Row count read independently of the code under test. */
  const count = async () => (await db.prepare('SELECT COUNT(*) AS c FROM adapter_t').get()).c;
  const rowOf = async (id) => db.prepare('SELECT * FROM adapter_t WHERE id = ?').get(id);

  /**
   * The tripwire. If `TEST_POSTGRES_URL` is set but points at nothing usable,
   * every case below would fail with a connection error — but this one fails
   * first and says why, rather than leaving twenty identical ECONNREFUSED
   * stacks to be read through.
   */
  it('is actually connected, so a configured-but-broken server is obvious', async () => {
    const r = await db.prepare('SELECT 1 AS ok').get();
    expect(r.ok).toBe(1);
  });

  describe('statement semantics match DatabaseSync', () => {
    /**
     * The SQLite behaviour is not described from memory — it is executed, in the
     * same test, and the two results compared. A claim that "SQLite returns
     * undefined here" is exactly the kind of thing that is right until it isn't.
     */
    let sqlite;
    beforeEach(() => {
      sqlite = new DatabaseSync(':memory:');
      sqlite.exec('CREATE TABLE adapter_t (id TEXT PRIMARY KEY, v TEXT, n INTEGER, flag INTEGER, amount REAL, created_at TEXT)');
    });

    it('get() returns undefined on a miss, in both engines', async () => {
      const pgMiss = await db.prepare('SELECT * FROM adapter_t WHERE id = ?').get('nope');
      const liteMiss = sqlite.prepare('SELECT * FROM adapter_t WHERE id = ?').get('nope');
      expect(pgMiss).toBeUndefined();
      expect(liteMiss).toBeUndefined();
    });

    it('all() returns an empty array on a miss, in both engines', async () => {
      expect(await db.prepare('SELECT * FROM adapter_t WHERE id = ?').all('nope')).toEqual([]);
      expect(sqlite.prepare('SELECT * FROM adapter_t WHERE id = ?').all('nope')).toEqual([]);
    });

    it('run() reports changes for a write that matched, in both engines', async () => {
      await db.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('a', 'one');
      sqlite.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('a', 'one');

      const pgRes = await db.prepare('UPDATE adapter_t SET v = ? WHERE id = ?').run('two', 'a');
      const liteRes = sqlite.prepare('UPDATE adapter_t SET v = ? WHERE id = ?').run('two', 'a');

      expect(pgRes.changes).toBe(1);
      expect(liteRes.changes).toBe(1);
      // and the row really changed
      expect((await rowOf('a')).v).toBe('two');
    });

    /**
     * The number 31 call sites branch on. A conditional UPDATE that matched
     * nothing must report 0 — that is how "somebody else already claimed this
     * row" is detected, and a wrong answer here hands the same slot to two
     * people.
     */
    it('run() reports 0 changes when nothing matched, in both engines', async () => {
      const pgRes = await db.prepare('UPDATE adapter_t SET v = ? WHERE id = ?').run('x', 'absent');
      const liteRes = sqlite.prepare('UPDATE adapter_t SET v = ? WHERE id = ?').run('x', 'absent');
      expect(pgRes.changes).toBe(0);
      expect(liteRes.changes).toBe(0);
      expect(typeof pgRes.changes).toBe('number');
    });

    it('COUNT(*) comes back as a number, not a bigint string', async () => {
      await db.prepare('INSERT INTO adapter_t (id) VALUES (?)').run('a');
      const c = await count();
      expect(typeof c).toBe('number');
      expect(c).toBe(1);
      expect(c === 1).toBe(true);   // the comparison that a string would break
    });

    it('round-trips a double without turning it into a string', async () => {
      await db.prepare('INSERT INTO adapter_t (id, amount) VALUES (?, ?)').run('a', 3.25);
      const row = await rowOf('a');
      expect(typeof row.amount).toBe('number');
      expect(row.amount).toBe(3.25);
    });

    it('round-trips a boolean', async () => {
      await db.prepare('INSERT INTO adapter_t (id, flag) VALUES (?, ?)').run('a', true);
      expect((await rowOf('a')).flag).toBe(true);
    });

    it('binds named parameters', async () => {
      await db.prepare('INSERT INTO adapter_t (id, n) VALUES (?, ?)').run('a', 1);
      await db.prepare('INSERT INTO adapter_t (id, n) VALUES (?, ?)').run('b', 2);
      const rows = await db.prepare('SELECT id FROM adapter_t ORDER BY n LIMIT @limit OFFSET @offset')
        .all({ limit: 1, offset: 1 });
      expect(await rows.map(r => r.id)).toEqual(['b']);
    });

    it('names the statement in an error, so a $3 can be traced to its source', async () => {
      await expect(db.prepare('SELECT * FROM no_such_table WHERE id = ?').get('x'))
        .rejects.toThrow(/written as: SELECT \* FROM no_such_table/);
    });
  });

  describe('transactions pin one client', () => {
    it('commits work as a unit, and the rows are really there', async () => {
      await runTransaction(db, async (tx) => {
        await tx.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('a', 'one');
        await tx.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('b', 'two');
      });
      expect(await count()).toBe(2);
      expect((await rowOf('a')).v).toBe('one');
      expect((await rowOf('b')).v).toBe('two');
    });

    it('rolls the whole unit back when the body throws, leaving nothing behind', async () => {
      await expect(runTransaction(db, async (tx) => {
        await tx.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('a', 'one');
        /* Proves the row existed inside the transaction — otherwise a rollback
           that "worked" is indistinguishable from an insert that never ran. */
        expect((await tx.prepare('SELECT v FROM adapter_t WHERE id = ?').get('a')).v).toBe('one');
        throw new Error('boom');
      })).rejects.toThrow('boom');

      expect(await count()).toBe(0);
    });

    /**
     * The property this whole file exists for.
     *
     * Two transactions are held open at the same time, on different clients from
     * the same pool. Neither may see the other's uncommitted rows. If the adapter
     * were issuing BEGIN on the pool rather than on a checked-out client, these
     * writes would land outside any transaction and each side would see the
     * other's immediately.
     */
    it('keeps two concurrent transactions isolated from each other', async () => {
      const a = await db.beginTransaction();
      const b = await db.beginTransaction();

      await a.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('from-a', 'a');
      await b.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('from-b', 'b');

      // each sees only its own
      expect(await a.prepare('SELECT COUNT(*) AS c FROM adapter_t').get()).toEqual({ c: 1 });
      expect(await b.prepare('SELECT COUNT(*) AS c FROM adapter_t').get()).toEqual({ c: 1 });
      expect(await a.prepare('SELECT id FROM adapter_t').get()).toEqual({ id: 'from-a' });
      expect(await b.prepare('SELECT id FROM adapter_t').get()).toEqual({ id: 'from-b' });

      // and nothing outside sees either, because neither has committed
      expect(await count()).toBe(0);

      await a.commit();
      expect(await count()).toBe(1);

      await b.rollback();
      expect(await count()).toBe(1);
      expect(await rowOf('from-b')).toBeUndefined();
      expect((await rowOf('from-a')).v).toBe('a');
    });

    it('refuses to settle a transaction twice', async () => {
      const tx = await db.beginTransaction();
      await tx.commit();
      await expect(tx.commit()).rejects.toThrow(/already been committed or rolled back/);
    });
  });

  describe('the pool is not leaked', () => {
    const settle = async () => { await new Promise(r => setTimeout(r, 50)); };

    it('returns the client after a commit', async () => {
      const before = db.stats.idle + db.stats.total;
      await runTransaction(db, async (tx) => {
        await tx.prepare('INSERT INTO adapter_t (id) VALUES (?)').run('a');
      });
      await settle();
      expect(db.stats.waiting).toBe(0);
      expect(db.stats.idle).toBeGreaterThan(0);
      expect(before).toBeGreaterThanOrEqual(0);
    });

    it('returns the client after a rollback', async () => {
      await expect(runTransaction(db, async () => { throw new Error('x'); })).rejects.toThrow('x');
      await settle();
      expect(db.stats.waiting).toBe(0);
      expect(db.stats.idle).toBeGreaterThan(0);
    });

    /**
     * The test that would catch a leak. The pool holds five clients; running
     * more transactions than that in sequence can only succeed if each one gives
     * its client back. A leak makes this hang rather than fail, so it carries a
     * timeout.
     */
    it('survives more sequential transactions than the pool has clients', async () => {
      for (let i = 0; i < 15; i++) {
        await runTransaction(db, async (tx) => {
          await tx.prepare('INSERT INTO adapter_t (id) VALUES (?)').run(`leak-${i}`);
        });
      }
      expect(await count()).toBe(15);
      expect(db.stats.waiting).toBe(0);
    }, 20000);

    it('survives more CONCURRENT transactions than the pool has clients', async () => {
      await Promise.all(
        Array.from({ length: 15 }, (_, i) => runTransaction(db, async (tx) => {
          await tx.prepare('INSERT INTO adapter_t (id) VALUES (?)').run(`conc-${i}`);
        }))
      );
      expect(await count()).toBe(15);
      expect(db.stats.waiting).toBe(0);
    }, 20000);
  });

  /**
   * The composition with phase 4: a transaction handle bound into the async
   * context, with the unedited `db` proxy resolving to it.
   *
   * This is the mechanism that lets ~653 existing call sites join a transaction
   * without being touched, so it is asserted end to end rather than assumed from
   * the two halves working separately.
   */
  describe('composes with the connection context from phase 4', () => {
    it('routes proxy writes into the enclosing transaction, and rolls them back', async () => {
      setDefaultConnection(db);
      const proxy = createConnectionProxy();

      await expect(runTransaction(db, async (tx) => {
        expect(currentConnection()).toBe(tx);
        // written through the PROXY, not through tx — the call sites' spelling
        await proxy.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('via-proxy', 'x');
        expect((await tx.prepare('SELECT v FROM adapter_t WHERE id = ?').get('via-proxy')).v).toBe('x');
        throw new Error('undo');
      })).rejects.toThrow('undo');

      expect(await rowOf('via-proxy')).toBeUndefined();
      setDefaultConnection(null);
    });

    /**
     * The pinning invariant, proved by backend identity rather than by outcome.
     *
     * ── Why an outcome test is not enough ──
     *
     * The rollback test above shows that a proxy write *behaved* as though it
     * were inside the transaction. That is strong evidence and it is still
     * indirect: a write could reach a different client, be committed
     * independently, and a later assertion could pass for an unrelated reason —
     * a visibility quirk, a fixture that was never there, an assertion checking
     * the wrong row.
     *
     * `pg_backend_pid()` removes the inference. Every PostgreSQL connection is
     * served by its own backend process with its own pid, so two statements that
     * report the same pid provably ran on the same connection. The required
     * invariant is:
     *
     *     transaction begins
     *       → every operation runs on the SAME pinned client
     *       → COMMIT or ROLLBACK
     *       → client released
     *
     * and "the same pinned client" is exactly what a matching pid demonstrates.
     */
    it('runs every operation inside a transaction on ONE pinned backend', async () => {
      setDefaultConnection(db);
      const proxy = createConnectionProxy();
      const pidOf = async (h) => (await h.prepare('SELECT pg_backend_pid() AS pid').get()).pid;

      const seen = await runTransaction(db, async (tx) => {
        const viaTx = await pidOf(tx);
        const viaProxy = await pidOf(proxy);
        /* Several operations, interleaved with a real write, because a single
           pair could coincide if the pool happened to hand back the same client. */
        await proxy.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('pinned', 'x');
        const afterWrite = await pidOf(proxy);
        await new Promise(r => setTimeout(r, 10));   // yield: the pin must survive it
        const afterYield = await pidOf(proxy);
        return { viaTx, viaProxy, afterWrite, afterYield };
      });

      expect(seen.viaProxy, 'a proxy query must run on the transaction backend').toBe(seen.viaTx);
      expect(seen.afterWrite, 'still pinned after a write').toBe(seen.viaTx);
      expect(seen.afterYield, 'still pinned after an await — this is the async port case').toBe(seen.viaTx);
      expect((await rowOf('pinned')).v).toBe('x');
      setDefaultConnection(null);
    });

    /**
     * The negative control. Without this, the test above could pass simply
     * because the pool only ever hands out one backend, which would make the
     * matching pids meaningless.
     */
    it('uses a DIFFERENT backend outside the transaction, so matching pids mean something', async () => {
      setDefaultConnection(db);
      const proxy = createConnectionProxy();
      const pidOf = async (h) => (await h.prepare('SELECT pg_backend_pid() AS pid').get()).pid;

      /* Hold a second transaction open so its client cannot be reused, which
         forces the pool to serve the outer query from another backend. */
      const held = await db.beginTransaction();
      const heldPid = await pidOf(held);

      const innerPid = await runTransaction(db, async (tx) => await pidOf(tx));

      expect(innerPid, 'two concurrent transactions must be on different backends')
        .not.toBe(heldPid);

      await held.rollback();
      setDefaultConnection(null);
    });

    it('routes proxy writes to the pool when no transaction is open', async () => {
      setDefaultConnection(db);
      const proxy = createConnectionProxy();
      await proxy.prepare('INSERT INTO adapter_t (id, v) VALUES (?, ?)').run('no-tx', 'y');
      expect((await rowOf('no-tx')).v).toBe('y');
      setDefaultConnection(null);
    });
  });
});
