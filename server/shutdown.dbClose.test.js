import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The shutdown sequence must WAIT for the database to close.
 *
 * On SQLite `close()` is synchronous and returns undefined, so calling it
 * without `await` looked correct for as long as SQLite was the only engine. On
 * PostgreSQL `close()` is `pool.end()` and returns a promise, and the unawaited
 * version failed three ways at once:
 *
 *   - the process exited while the pool was still draining;
 *   - "[Shutdown] Database closed." was printed before it was;
 *   - a rejection escaped the synchronous `try/catch` entirely and surfaced as
 *     `unhandledRejection`, which this process treats as fatal — so a failed
 *     close during shutdown re-entered shutdown.
 *
 * The last one is why this is asserted rather than left to review: the symptom
 * appears only on the engine the tests did not run, during the one code path
 * that runs when something is already going wrong.
 */

const stop = () => {};
vi.mock('./workers/notificationWorker.js', () => ({ stopNotificationWorker: stop }));
vi.mock('./workers/exportWorker.js', () => ({ stopExportWorker: stop }));
vi.mock('./workers/retentionWorker.js', () => ({ stopRetentionWorker: stop }));
vi.mock('./services/autoSelectScheduler.js', () => ({ stopAutoSelectScheduler: stop }));
vi.mock('./instanceLock.js', () => ({
  releaseInstanceLock: stop,
  stopInstanceLockHeartbeat: stop,
}));

const close = vi.fn();
vi.mock('./db.js', () => ({ db: { close: () => close() } }));

const { shutdown, resetShutdownStateForTests } = await import('./shutdown.js');

describe('shutdown waits for the database to close', () => {
  beforeEach(() => {
    close.mockReset();
    resetShutdownStateForTests();
  });

  it('does not resolve until an async close() has settled', async () => {
    let release;
    let closed = false;
    close.mockImplementation(() => new Promise((resolve) => {
      release = () => { closed = true; resolve(); };
    }));

    let done = false;
    const run = shutdown({ signal: 'SIGTERM', httpServer: null, io: null })
      .then(() => { done = true; });

    /* Let every earlier step of the drain run to completion. If close() were
       unawaited, shutdown would already have finished here — that is exactly
       the bug. */
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(done, 'shutdown finished without waiting for the pool to drain').toBe(false);
    expect(closed).toBe(false);

    release();
    await run;
    expect(done).toBe(true);
  });

  it('completes the drain when close() rejects', () => {
    close.mockImplementation(() => Promise.reject(new Error('pool already ended')));

    /* Resolves rather than throws: a database that will not close is reported
       and the drain finishes, because the alternative is a process that cannot
       shut down at all. Awaiting the rejection without catching it would also
       skip the exit-code return below.

       Scope note: this guards the `catch`, verified by removing it. It does NOT
       detect an unawaited `close()` — the drain test above is what does that.
       An earlier version of this test also asserted that no
       `unhandledRejection` escaped; that assertion held whether or not the
       `await` was present, so it was removed rather than left standing as
       coverage it did not provide. */
    return expect(shutdown({ signal: 'SIGTERM', httpServer: null, io: null }))
      .resolves.toBeTypeOf('number');
  });
});
