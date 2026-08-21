/**
 * Transactions, exercised rather than read.
 *
 * ── What this is for ──
 *
 * `runInTransaction` looks correct: begin, run, commit, and roll back in the
 * catch. Reading it proves nothing about a POOL, where the interesting failures
 * are not "did it roll back" but "what happened to the client afterwards". A
 * transaction that rolls back its work and then hands a still-aborted client
 * back to the pool poisons the next request, and the symptom appears somewhere
 * else entirely — which is the shape of every expensive bug this migration has
 * found.
 *
 * So every case here drives the real helper against the real pool and then asks
 * the pool to do more work.
 *
 * ── Why a scratch table ──
 *
 * The application's own tables carry append-only triggers, which is the audit
 * guarantee working and makes them useless for testing rollback. This creates
 * its own table inside the test's schema namespace.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RUNNING_ON_POSTGRES } from './testEngine.js';
import { runInTransaction } from './db/connectionContext.js';

describe.skipIf(!RUNNING_ON_POSTGRES)('transactions against a real pool', () => {
  let srv, db;

  beforeAll(async () => {
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    await db.exec('CREATE TABLE IF NOT EXISTS tx_probe (id text PRIMARY KEY, note text)');
  }, 60_000);

  afterAll(async () => {
    try { await db.exec('DROP TABLE IF EXISTS tx_probe'); } catch { /* schema already gone */ }
    await srv?.close();
  });

  const rows = async () => Number((await db.prepare('SELECT COUNT(*) AS c FROM tx_probe').get()).c);
  const insert = (tx, id) =>
    tx.prepare('INSERT INTO tx_probe (id, note) VALUES (?, ?)').run(id, 'x');

  it('commits work that succeeds', async () => {
    const before = await rows();
    await runInTransaction(db, async (tx) => { await insert(tx, `commit-${Date.now()}`); });
    expect(await rows(), 'a successful transaction did not commit').toBe(before + 1);
  });

  it('rolls back every write when the callback throws', async () => {
    const before = await rows();
    const id = `throw-${Date.now()}`;
    await expect(async () => runInTransaction(db, async (tx) => {
      await insert(tx, id);
      /* The row exists INSIDE the transaction — proving the rollback undoes real
         work rather than the insert never having happened. */
      expect(Number((await tx.prepare('SELECT COUNT(*) AS c FROM tx_probe WHERE id = ?').get(id)).c)).toBe(1);
      throw new Error('deliberate failure');
    })).rejects.toThrow(/deliberate failure/);

    expect(await rows(), 'a thrown callback left its writes behind').toBe(before);
    expect(Number((await db.prepare('SELECT COUNT(*) AS c FROM tx_probe WHERE id = ?').get(id)).c)).toBe(0);
  });

  it('rolls back when a statement inside fails, not just when the callback throws', async () => {
    const before = await rows();
    const id = `dup-${Date.now()}`;
    await runInTransaction(db, async (tx) => { await insert(tx, id); });

    /* Same primary key again, inside a transaction that also writes something
       else. Both must disappear. */
    await expect(async () => runInTransaction(db, async (tx) => {
      await insert(tx, `${id}-sibling`);
      await insert(tx, id);            // duplicate key
    })).rejects.toThrow();

    expect(await rows(), 'the sibling write survived a failed transaction').toBe(before + 1);
  });

  /**
   * The one that matters most on a pool.
   *
   * PostgreSQL puts a client into an aborted state after a failed statement, and
   * every subsequent command on it answers "current transaction is aborted".
   * If the rollback did not happen, or the client were returned without one, the
   * NEXT request to borrow it would fail for a reason that has nothing to do
   * with itself.
   */
  it('leaves the pool usable after a failure — repeatedly', async () => {
    for (let i = 0; i < 12; i += 1) {
      await expect(async () => runInTransaction(db, async (tx) => {
        await tx.prepare('SELECT * FROM no_such_table_in_tx_probe').all();
      })).rejects.toThrow();

      /* Every iteration must find a clean client. With a bounded pool, a single
         leaked or aborted connection makes this fail within a few rounds. */
      expect(Number((await db.prepare('SELECT 1 AS ok').get()).ok)).toBe(1);
    }
  }, 60_000);

  it('commits and rolls back correctly when transactions run concurrently', async () => {
    const before = await rows();
    const tag = Date.now();

    const outcomes = await Promise.all([
      runInTransaction(db, async (tx) => { await insert(tx, `conc-a-${tag}`); }).then(() => 'ok', () => 'failed'),
      runInTransaction(db, async (tx) => {
        await insert(tx, `conc-b-${tag}`);
        throw new Error('this one fails');
      }).then(() => 'ok', () => 'failed'),
      runInTransaction(db, async (tx) => { await insert(tx, `conc-c-${tag}`); }).then(() => 'ok', () => 'failed'),
    ]);

    expect(outcomes.filter(o => o === 'ok').length, 'the two good transactions must both commit').toBe(2);
    expect(await rows(), "one transaction's rollback took another's work with it").toBe(before + 2);
  });

  /**
   * Nesting is refused rather than flattened. PostgreSQL folds an inner BEGIN
   * into the outer transaction, so an inner rollback would discard the outer
   * one's committed-looking work.
   */
  it('refuses a nested transaction instead of silently joining it', async () => {
    await expect(async () => runInTransaction(db, async () => {
      await runInTransaction(db, async (inner) => { await insert(inner, 'never'); });
    })).rejects.toThrow(/nested/i);
  });

  /**
   * A transaction that has committed must not still be writable. Statements
   * issued on a finished handle would land outside any transaction — the
   * silent shape this whole phase exists to prevent.
   */
  it('refuses statements on a transaction that has already finished', async () => {
    let escaped;
    await runInTransaction(db, async (tx) => { escaped = tx; });
    await expect(
      async () => escaped.prepare('INSERT INTO tx_probe (id, note) VALUES (?, ?)').run('after-commit', 'x'),
      'a committed transaction handle still accepted writes',
    ).rejects.toThrow();
    expect(Number((await db.prepare("SELECT COUNT(*) AS c FROM tx_probe WHERE id = 'after-commit'").get()).c)).toBe(0);
  });
});
