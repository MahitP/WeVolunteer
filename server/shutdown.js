/**
 * Graceful shutdown.
 *
 * ── What happened without this ──
 *
 * The process installed no signal handlers at all. `systemctl restart` sends
 * SIGTERM, Node's default action for which is to exit immediately, so every
 * ordinary deploy or restart:
 *
 *   • dropped in-flight HTTP requests mid-response;
 *   • abandoned the notification job the worker had already marked `processing`,
 *     which nothing reclaimed — those notifications were lost permanently (now
 *     also fixed at the source by reclaimStaleJobs);
 *   • abandoned an in-flight data export the same way, and because
 *     privacyRoutes.js refuses a new export while one is `pending` or
 *     `processing`, that locked the student out of their own data export with a
 *     409 that never expired;
 *   • never called `db.close()`, leaving the WAL un-checkpointed.
 *
 * The database survives all of that — SQLite's WAL is crash-safe, and a dirty
 * shutdown recovers on next open — so this is not about corruption. It is about
 * the queued work and the open requests, which are not crash-safe at all.
 *
 * ── Ordering ──
 *
 * The sequence below is deliberate and the comments say why at each step. The
 * short version: stop taking on new work, then stop generating new work, then let
 * existing work finish, then close the database last because everything above it
 * needs the database while it drains.
 */
import { db } from './db.js';
import { stopNotificationWorker } from './workers/notificationWorker.js';
import { stopExportWorker } from './workers/exportWorker.js';
import { releaseInstanceLock, stopInstanceLockHeartbeat } from './instanceLock.js';
import { stopAutoSelectScheduler } from './services/autoSelectScheduler.js';
import { stopRetentionWorker } from './workers/retentionWorker.js';
import { logLifecycle, drainTelemetry } from './telemetry.js';
import { stopIndexWorker } from './search/indexWorker.js';

/**
 * How long to wait for in-flight requests before giving up on them.
 *
 * Must stay comfortably below the service manager's own kill timeout — systemd's
 * default `TimeoutStopSec` is 90s — so that a slow drain still ends in a clean
 * exit of our choosing rather than a SIGKILL of systemd's.
 */
const DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 15_000;

let shuttingDown = false;

/**
 * Runs the shutdown sequence and resolves with the exit code to use.
 *
 * Exported separately from the signal wiring so a test can drive it directly
 * without sending real signals to the test runner's own process.
 */
export async function shutdown({ signal, httpServer, io, intervals = [] }) {
  // A second SIGTERM during a slow drain must not restart the sequence and run
  // db.close() twice. systemd escalates to SIGKILL on its own timeout, which is
  // the correct backstop for a shutdown that genuinely will not finish.
  if (shuttingDown) {
    console.warn(`[Shutdown] Already shutting down; ignoring ${signal}.`);
    return null;
  }
  shuttingDown = true;

  console.log(`[Shutdown] ${signal} received — draining.`);
  let exitCode = 0;

  /**
   * 1. Stop accepting new connections.
   *
   * First, so nothing new arrives while the rest is torn down. `close()` stops
   * the listener but lets requests already being served run to completion — the
   * whole point of a graceful stop. Keep-alive sockets are handled by
   * `closeAllConnections()` at the end of the drain.
   */
  const httpClosed = httpServer
    ? new Promise(resolve => httpServer.close(() => resolve()))
    : Promise.resolve();

  /**
   * 2. Stop the periodic work.
   *
   * Before draining rather than after: the sweep and the two workers each create
   * new database work, and letting them fire during the drain means the set of
   * things to finish keeps growing. Clearing the intervals also releases their
   * hold on the event loop, without which the process would not exit even once
   * every request had finished.
   */
  for (const handle of intervals) {
    if (handle) clearInterval(handle);
  }
  stopNotificationWorker();
  stopExportWorker();
  stopInstanceLockHeartbeat();
  stopAutoSelectScheduler();
  stopRetentionWorker();

  /**
   * 3. Disconnect realtime clients.
   *
   * Socket.IO connections are long-lived by design, so they will never close on
   * their own and `httpServer.close()` waits on them. Told explicitly, clients
   * see a clean disconnect and reconnect after the restart instead of hanging on
   * a dead socket until a timeout.
   */
  if (io) {
    /* The shared session-invalidation sweep (`socketServer.js`) replaced a timer
       per socket. One timer means one thing to stop, and stopping it here rather
       than relying on `io`'s 'close' event is deliberate: the event is not
       emitted on every Socket.IO version, and a surviving interval would hold a
       reference to a closed server. Clearing an already-cleared timer is a
       no-op, so doing both is safe. */
    if (io.sessionSweepTimer) clearInterval(io.sessionSweepTimer);
    try {
      await new Promise(resolve => io.close(() => resolve()));
    } catch (err) {
      console.error('[Shutdown] Socket.IO close failed:', err);
    }
  }

  /**
   * 4. Wait for in-flight requests, but not forever.
   *
   * A request wedged on something external must not hold the deploy open until
   * systemd loses patience and SIGKILLs us — that would discard exactly the
   * cleanup this function exists to perform. On timeout the remaining sockets are
   * closed and the sequence continues to the database, which is the part that
   * actually matters.
   */
  const timedOut = Symbol('timeout');
  const outcome = await Promise.race([
    httpClosed.then(() => 'drained'),
    new Promise(resolve => setTimeout(() => resolve(timedOut), DRAIN_TIMEOUT_MS))
  ]);

  if (outcome === timedOut) {
    console.warn(
      `[Shutdown] In-flight requests did not finish within ${DRAIN_TIMEOUT_MS}ms — `
      + 'closing remaining connections.'
    );
    // Node 18.2+. Guarded because the socket set is only present on a server that
    // was actually listening.
    httpServer?.closeAllConnections?.();
    exitCode = 1;
  } else {
    console.log('[Shutdown] In-flight requests finished.');
  }

  /**
   * 5. Release the single-instance lock, before closing the database.
   *
   * Ordering: this is a write, so it has to happen while the connection is still
   * open. Releasing explicitly means a restart takes the lock immediately instead of
   * waiting for the previous holder's heartbeat to go stale — which for a clean stop
   * would add a pointless delay to every deploy.
   *
   * `releaseInstanceLock` only deletes a row this process owns, so a shutdown that
   * happens after losing the lock to a takeover cannot hand it away.
   */
  try {
    await releaseInstanceLock(db);
  } catch (err) {
    console.error('[Shutdown] Instance lock release failed:', err);
  }

  /**
   * 6. Close the database last.
   *
   * Everything above may touch it while draining, so closing earlier would turn a
   * graceful shutdown into a burst of "database is not open" errors on the
   * requests being finished. `node:sqlite` checkpoints the WAL on close, which is
   * what keeps the `-wal` sidecar from growing across restarts.
   *
   * Awaited, because on PostgreSQL `close()` is `pool.end()` and returns a
   * promise. Unawaited it did three wrong things at once: the pool was still
   * draining when the process exited, the line below claimed the database was
   * closed before it was, and — the one that matters — a rejection escaped the
   * synchronous `catch` and surfaced as `unhandledRejection`, which this
   * process treats as fatal, so a failed close during shutdown re-entered
   * shutdown.
   *
   * `node:sqlite` closes synchronously and returns undefined; awaiting that is
   * a no-op, so one spelling is right on both engines and no call site needs to
   * know which one it is talking to.
   */
  try {
    await db.close();
    console.log('[Shutdown] Database closed.');
  } catch (err) {
    // Already closed, or mid-statement. Worth reporting, not worth failing over:
    // the WAL is crash-safe and recovers on next open.
    console.error('[Shutdown] Database close failed:', err);
  }

  /**
   * 6b. Stop the search index worker.
   *
   * Before the telemetry flush and after the database close attempt, because a
   * pass in flight is holding a database handle. Nothing is lost by stopping
   * mid-queue: the work it had not done is still `pending` in
   * `event_search_index`, which is exactly why that table exists rather than an
   * in-memory list.
   */
  try {
    await stopIndexWorker();
  } catch { /* a worker that will not stop must not stop the shutdown */ }

  /**
   * 7. Flush telemetry last of all.
   *
   * After the database, because the interesting thing to record is how the
   * shutdown went — including a database close that failed — and because
   * nothing above needs Better Stack to be reachable.
   *
   * `drainTelemetry`, not `flushTelemetry`: the latter posts one batch of 50,
   * and a busy server can be holding several hundred records — including the
   * ones describing why it is restarting. The drain is bounded by the queue cap
   * and each pass swallows its own failures, so an unreachable endpoint costs
   * one request timeout per pass and nothing else.
   *
   * When telemetry is unconfigured — the default — both calls are no-ops.
   */
  try {
    logLifecycle('shutdown', { outcome: exitCode === 0 ? 'clean' : 'forced', ok: exitCode === 0 });
    await drainTelemetry();
  } catch { /* a shutdown must not fail on its own epilogue */ }

  console.log(`[Shutdown] Complete (exit ${exitCode}).`);
  return exitCode;
}

/**
 * Wires SIGTERM and SIGINT to the sequence above.
 *
 * SIGTERM is what systemd sends on `stop` and `restart`; SIGINT is Ctrl-C in
 * development. Both get the same treatment so the path exercised locally is the
 * one that runs in production.
 *
 * `unhandledRejection` and `uncaughtException` are also handled here. Node's
 * default for both is to print and exit — losing the queued work and leaving the
 * database open. Routing them through the same drain means an unexpected error
 * still ends in a clean stop, and the non-zero exit lets systemd's `Restart=`
 * policy do its job.
 */
export function installShutdownHandlers({ httpServer, io, intervals = [] }) {
  const run = async (signal) => {
    const code = await shutdown({ signal, httpServer, io, intervals });
    if (code !== null) process.exit(code);
  };

  process.on('SIGTERM', () => { run('SIGTERM'); });
  process.on('SIGINT', () => { run('SIGINT'); });

  process.on('unhandledRejection', (reason) => {
    console.error('[Fatal] Unhandled promise rejection:', reason);
    run('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    console.error('[Fatal] Uncaught exception:', err);
    run('uncaughtException');
  });
}

/** Test seam: clears the one-shot latch so a suite can drive several sequences. */
export function resetShutdownStateForTests() {
  shuttingDown = false;
}
