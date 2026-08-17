/**
 * Concurrent SQLite transactions must queue, not freeze the process.
 *
 * ── The defect this pins ──
 *
 * `runInTransaction` gives a SQLite transaction its own connection, which is
 * what makes an `await` inside one safe. The cost is that two concurrent
 * transactions contend for the file's single write lock, and the driver's answer
 * to contention — `PRAGMA busy_timeout` — is to block until the holder commits.
 *
 * That answer cannot work here. `node:sqlite` is synchronous, so the wait
 * happens inside a C call on Node's only thread, and the holder's `COMMIT` is a
 * JavaScript continuation queued behind it. The lock cannot be released while
 * anybody is waiting for it, so the waiter burns the whole timeout and then
 * fails with `SQLITE_BUSY`.
 *
 * Found by `twoFactor.singleUseRace`: eight concurrent second-factor
 * submissions produced one `BEGIN` at 0ms and seven failures at ~5,400ms each,
 * stalling the process for 37 seconds. The same shape applies to every
 * transactional endpoint, so in production it is two students clicking at once
 * and freezing the server for five seconds.
 *
 * The fix is an in-process queue: a contending writer `await`s, which yields the
 * event loop and lets the holder commit. This file asserts the queue works and,
 * more importantly, that the pathology cannot come back — a run that takes
 * multiples of `busy_timeout`, or loses transactions to `SQLITE_BUSY`, fails
 * here rather than in whichever feature test happens to drive enough
 * concurrency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setDefaultConnection, runInTransaction, createConnectionProxy } from './db/connectionContext.js';

/** The per-connection wait a contended `BEGIN IMMEDIATE` would burn. */
const BUSY_TIMEOUT_MS = 5000;
const WRITERS = 8;

let dir;
let connection;

beforeEach(() => {
  /* File-backed, not `:memory:` — the whole behaviour under test only exists
     when a transaction can open a SECOND connection, and an in-memory database
     cannot be reached from one. A `:memory:` version of this test would pass
     without exercising a single line of the gate. */
  dir = mkdtempSync(path.join(tmpdir(), 'wev-write-gate-'));
  const file = path.join(dir, 'gate.db');
  connection = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  connection.exec('PRAGMA journal_mode = WAL');
  connection.exec('CREATE TABLE marks (id INTEGER PRIMARY KEY, writer INTEGER NOT NULL)');
  setDefaultConnection(connection, file);
});

afterEach(() => {
  setDefaultConnection(null, null);
  try { connection.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('concurrent SQLite transactions', () => {
  /**
   * Every writer yields the event loop while holding its transaction, which is
   * the case that deadlocked: the holder needs the loop to reach `COMMIT`, and
   * a blocked contender never gives it back.
   */
  const writer = (n) => runInTransaction(connection, async (tx) => {
    tx.prepare('INSERT INTO marks (writer) VALUES (?)').run(n);
    await new Promise((resolve) => setTimeout(resolve, 1));
    return n;
  });

  it('lets all of them commit, rather than losing seven to SQLITE_BUSY', async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: WRITERS }, (_, n) => writer(n)),
    );

    const rejected = settled
      .filter(s => s.status === 'rejected')
      .map(s => s.reason?.message ?? String(s.reason));

    expect(
      rejected,
      'a concurrent transaction was refused — the write gate is not serialising them',
    ).toEqual([]);

    const rows = connection.prepare('SELECT writer FROM marks ORDER BY writer').all();
    expect(rows.map(r => r.writer)).toEqual(Array.from({ length: WRITERS }, (_, n) => n));
  });

  /**
   * The timing assertion, and why it is worth the fragility.
   *
   * The failure mode is not "wrong answer", it is "right answer, eventually" —
   * seven writers each burning a five-second timeout. A correctness-only test
   * passes while the process is unusable, so the wall clock is the measurement
   * that matters.
   *
   * The bound is deliberately loose: the work here is eight 1ms sleeps, so
   * anything under a single `busy_timeout` is unambiguous. The broken version
   * took seven of them.
   */
  it('finishes in well under one busy_timeout, not several', async () => {
    const started = Date.now();
    await Promise.all(Array.from({ length: WRITERS }, (_, n) => writer(n)));
    const elapsed = Date.now() - started;

    expect(
      elapsed,
      `${WRITERS} concurrent transactions took ${elapsed}ms. A contended BEGIN IMMEDIATE `
      + `blocks the event loop for busy_timeout (${BUSY_TIMEOUT_MS}ms) and the holder `
      + 'cannot commit while it does, so a run in multiples of that is the deadlock '
      + 'returning rather than the machine being slow.',
    ).toBeLessThan(BUSY_TIMEOUT_MS);
  });

  /**
   * The gate is a queue, so the transactions must not overlap. Asserted directly
   * rather than inferred from the timing above: a run could be fast because the
   * writes happened to serialise on their own, and this distinguishes the two.
   */
  it('admits exactly one writer at a time', async () => {
    let open = 0;
    let peak = 0;

    await Promise.all(Array.from({ length: WRITERS }, () =>
      runInTransaction(connection, async (tx) => {
        open += 1;
        peak = Math.max(peak, open);
        tx.prepare('INSERT INTO marks (writer) VALUES (0)').run();
        await new Promise((resolve) => setTimeout(resolve, 1));
        open -= 1;
      })));

    expect(peak, 'two transactions were open at once on a single-writer engine').toBe(1);
  });

  /**
   * A transaction that throws must open the gate on its way out.
   *
   * The rollback path releases, and so does a `BEGIN` that never succeeded. If
   * either forgot, one failure would strand every later writer in the process —
   * a hang with no error, which is worse than the deadlock this replaced.
   */
  it('releases the gate when a transaction rolls back', async () => {
    await expect(runInTransaction(connection, async () => {
      throw new Error('deliberate');
    })).rejects.toThrow(/deliberate/);

    /* If the gate leaked, this never settles and the test times out. */
    await expect(writer(99)).resolves.toBe(99);
    expect(connection.prepare('SELECT COUNT(*) AS n FROM marks').get().n).toBe(1);
  });
});

/**
 * The ambient handle stays pinned to the transaction across an `await`.
 *
 * ── Why this is asserted end to end, on a real second connection ──
 *
 * Most of the codebase does not hold a transaction handle. Roughly 650 call
 * sites reach the database through the module-global `db`, and helpers called
 * from inside a converted transaction — `promoteFromWaitlist` and
 * `assignWaitlistOrder` are the capacity-critical examples — reach it that way
 * too. Converting that entire transitive closure is the rest of the migration,
 * so every transaction wave rests on one property instead: the proxy resolves
 * to the TRANSACTION's connection, and keeps doing so after the body yields.
 *
 * `db.connectionContext.test.js` proves the binding survives an await, but it
 * does so against `withConnection` and a single in-memory handle, where there is
 * no second connection to resolve to and nothing to get wrong. The case that
 * matters is the file-backed one this file already sets up, where
 * `runInTransaction` genuinely opens a second connection: if the proxy resolved
 * to the default handle instead, the write would land OUTSIDE the transaction,
 * survive a rollback, and no test elsewhere would notice.
 *
 * If these two fail, the boundary drawn in waves 9–16 — pin direct statements to
 * `tx`, let transitive helpers resolve through the proxy — is unsound, and those
 * helpers have to take an explicit handle after all.
 */
describe('the ambient proxy inside an async transaction', () => {
  const proxy = createConnectionProxy();
  const committed = () => connection.prepare('SELECT writer FROM marks ORDER BY writer').all().map(r => r.writer);

  it('sends a post-await ambient write to the transaction, not the default connection', async () => {
    await runInTransaction(connection, async (tx) => {
      tx.prepare('INSERT INTO marks (writer) VALUES (1)').run();
      await new Promise((resolve) => setTimeout(resolve, 1));
      /* The ambient handle, used AFTER the yield — the shape every unconverted
         helper takes when called from inside a converted transaction. */
      proxy.prepare('INSERT INTO marks (writer) VALUES (2)').run();

      /* Proof it went to the transaction's own connection: the primary cannot
         see either row while the transaction is still open. */
      expect(committed(), 'an uncommitted row was visible on the default connection')
        .toEqual([]);
    });

    expect(committed(), 'both rows must commit together').toEqual([1, 2]);
  });

  it('discards a post-await ambient write when the transaction rolls back', async () => {
    await expect(runInTransaction(connection, async (tx) => {
      tx.prepare('INSERT INTO marks (writer) VALUES (3)').run();
      await new Promise((resolve) => setTimeout(resolve, 1));
      proxy.prepare('INSERT INTO marks (writer) VALUES (4)').run();
      throw new Error('undo');
    })).rejects.toThrow('undo');

    expect(
      committed(),
      'a rollback left the ambient write behind — it was never in the transaction',
    ).toEqual([]);
  });

  it('resolves back to the default connection once the transaction ends', async () => {
    await runInTransaction(connection, async (tx) => {
      tx.prepare('INSERT INTO marks (writer) VALUES (5)').run();
    });
    proxy.prepare('INSERT INTO marks (writer) VALUES (6)').run();
    expect(committed()).toEqual([5, 6]);
  });
});
