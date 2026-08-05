/**
 * MUST stay the first import.
 *
 * ES imports are hoisted and evaluated in source order, so this is the only way to
 * run a check before `app.js` pulls in `config.js` and `db.js` — the latter opens the
 * database and sets WAL at import time. `node:sqlite` is experimental, so on an
 * unsupported Node major that work would happen against an API allowed to have
 * changed, before anything could refuse. See server/preflight.js.
 */
import './preflight.js';

import { app } from './app.js';
import { PORT, IS_PRODUCTION, DEMO_MODE } from './config.js';
import { createServer } from 'http';
import { initSocketServer } from './realtime/socketServer.js';
import { initDatabase, db } from './db.js';
import { runNotificationSweep } from './utils.js';

// The JWT_SECRET guard that used to sit here has been removed as dead code.
// config.js now throws unconditionally when the secret is missing, and it is
// evaluated during the import above — so this check could never be reached,
// and its message ("...must be set in production") contradicted the actual
// behaviour, which requires the secret in every environment.
if (IS_PRODUCTION && DEMO_MODE) {
  console.error('FATAL: DEMO_MODE cannot be enabled in production.');
  process.exit(1);
}

import { startNotificationWorker } from './workers/notificationWorker.js';
import { startExportWorker } from './workers/exportWorker.js';
import { installShutdownHandlers } from './shutdown.js';
import { startAutoSelectScheduler } from './services/autoSelectScheduler.js';
import { startRetentionWorker } from './workers/retentionWorker.js';
import {
  acquireInstanceLock, startInstanceLockHeartbeat, shouldRefuseBoot, describeConflict
} from './instanceLock.js';

initDatabase();

/**
 * Refuse to run a second instance against the same database.
 *
 * Three documents already said "run exactly one instance" and nothing enforced it:
 * two servers booted against one WEV_DB_PATH both reported healthy and served
 * traffic, with no warning in either log. The consequences are that every rate
 * limiter and the login throttle are per-process memory (so N instances enforce N×
 * the configured limit) and that slot-capacity checks read outside their write
 * transaction — atomic within one process, interleavable across two.
 *
 * Fatal in production, advisory in development, because two dev servers on one
 * database is an ordinary local situation. A crashed predecessor never blocks a
 * restart: see instanceLock.js for how a dead pid and a stale heartbeat are handled.
 */
const lockResult = acquireInstanceLock(db);
if (shouldRefuseBoot(lockResult, IS_PRODUCTION)) {
  console.error('FATAL: refusing to start a second instance.');
  console.error('');
  console.error(describeConflict(lockResult.conflict));
  process.exit(1);
}
if (!lockResult.acquired) {
  console.warn('[InstanceLock] WARNING: another instance appears to hold this database.');
  console.warn(describeConflict(lockResult.conflict));
  console.warn('[InstanceLock] Continuing because this is not a production process.');
}
const lockHeartbeat = startInstanceLockHeartbeat(db);

runNotificationSweep();

// The handle is kept so shutdown can clear it. Previously discarded, which meant
// the interval held the event loop open forever — a graceful stop could close the
// listener and still never exit, so systemd would wait out its timeout and
// SIGKILL the process, discarding the cleanup entirely.
const sweepInterval = setInterval(runNotificationSweep, 15 * 60 * 1000);

startNotificationWorker();
startExportWorker();

/**
 * Auto Select safety net.
 *
 * Runs one catch-up sweep immediately, then every 15 minutes. The immediate pass is
 * the startup-recovery behaviour: a draw that came due while the process was down
 * should not wait another interval. Safe at boot because the operation is idempotent —
 * the guard is a confirmed `auto_select_runs` row, which lives in the database rather
 * than in this process.
 */
const autoSelectTimer = startAutoSelectScheduler(db);

// Retention enforcement. The Privacy Policy publishes periods; this is what
// makes them true rather than a representation nothing implements.
startRetentionWorker(db);

const httpServer = createServer(app);
const io = initSocketServer(httpServer);

/**
 * Bind address.
 *
 * `0.0.0.0` by default, which is what this has always done — but the deployment
 * runbook claimed the bind address was "hardcoded to 127.0.0.1", so an operator
 * had no reason to firewall the port. On a host with a public IP that leaves the
 * Node process directly reachable, bypassing the reverse proxy and therefore TLS
 * and HSTS.
 *
 * The default is unchanged because changing it would break the container and
 * port-forward topologies that rely on it. Instead it is now configurable, and the
 * runbook documents both the real default and the firewall requirement. For the
 * single-host deployment the runbook describes, set:
 *
 *     BIND_ADDRESS=127.0.0.1
 *
 * and nothing off-box can reach the app except through nginx.
 */
const BIND_ADDRESS = process.env.BIND_ADDRESS || '0.0.0.0';

httpServer.listen(PORT, BIND_ADDRESS, () => {
  console.log(`WeVolunteer API Server listening on ${BIND_ADDRESS}:${PORT}`);
  if (IS_PRODUCTION && BIND_ADDRESS === '0.0.0.0') {
    // Not fatal: this is a legitimate configuration behind a firewall or inside a
    // container. But it is only safe deliberately, so it says so out loud rather
    // than being a silent default nobody revisits.
    console.warn(
      '[Security] Listening on 0.0.0.0 in production. The app is reachable on '
      + `port ${PORT} from anywhere the host is, bypassing the reverse proxy and TLS.\n`
      + '           Set BIND_ADDRESS=127.0.0.1, or confirm a firewall blocks this port.'
    );
  }
});

// Registered after listen() so the handler closes a server that is actually open.
installShutdownHandlers({
  httpServer,
  io,
  intervals: [sweepInterval, lockHeartbeat, autoSelectTimer]
});
