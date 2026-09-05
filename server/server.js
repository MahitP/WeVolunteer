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

/**
 * MUST stay above `app.js`, for the same reason `preflight.js` must stay above
 * everything.
 *
 * OpenTelemetry's automatic instrumentation works by patching modules as they
 * are loaded, so a module already loaded can no longer be instrumented. ES
 * imports are evaluated in source order, so this line is what guarantees the
 * `http`, `express` and `pg` patches are installed before `app.js` pulls those
 * packages in.
 *
 * It is a side-effect import on purpose: `startOtel()` is called from inside the
 * module rather than from a statement below, because a statement below would run
 * after every import in this file had already been evaluated — which is exactly
 * too late. See server/observability/otel.js.
 */
import './observability/bootstrap.js';

import { app } from './app.js';
import { PORT, IS_PRODUCTION, DEMO_MODE } from './config.js';
import { createServer } from 'http';
import { initSocketServer } from './realtime/socketServer.js';
import { initDatabase, completeDatabaseInit, assertSchemaReady, db, ENGINE } from './db.js';
import { describeRemoteDatabase, POSTGRES } from './db/engine.js';
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

/**
 * Demo mode over a database that is somewhere else.
 *
 * The refusal above keys on `NODE_ENV`, which is the wrong question and was
 * always the wrong question. What makes demo seeding dangerous is not the mode
 * this process believes it is in — it is whose database is on the other end.
 *
 * `npm run dev` sets `DEMO_MODE=true` and reads the same `.env` the server
 * does. While that named a local SQLite file, the worst case was a file the
 * developer could delete. With a real `DATABASE_URL` in it, the command a
 * developer types from muscle memory provisions a remote database and seeds
 * accounts whose shared password is published in the README — including an
 * administrator that demo mode exempts from the two-factor policy — and the
 * refusal above stays quiet, because a laptop does not set `NODE_ENV`.
 *
 * `db.js` already prints a loud warning for this. A warning is the wrong
 * instrument: it appears in a scrolling log at the moment the rows are being
 * written, and the rows persist after the service is later started correctly.
 *
 * Local PostgreSQL is untouched, so the everyday development loop is unchanged.
 */
const remoteDatabase = describeRemoteDatabase();
if (DEMO_MODE && remoteDatabase) {
  console.error('FATAL: DEMO_MODE is set and the database is not on this machine.');
  console.error(`       Target: ${remoteDatabase}`);
  console.error('');
  console.error('       Demo seeding inserts accounts that share a password published in');
  console.error('       the README, one of them an administrator exempt from the 2FA');
  console.error('       policy. Those rows would be written to that database and would');
  console.error('       outlive this process.');
  console.error('');
  console.error('       If you meant to run against it, start without demo mode:');
  console.error('         npm start --prefix server');
  console.error('       If you meant to develop locally, unset DATABASE_URL and');
  console.error('       DATABASE_ENGINE, or point them at a local database.');
  process.exit(1);
}

/**
 * A `DATABASE_URL` that nothing is going to use.
 *
 * `DATABASE_ENGINE` defaults to SQLite, so a deployment that sets the URL and
 * forgets the engine runs happily on a local file while its operator believes
 * it is on PostgreSQL — the same class of mistake `resolveEngine` refuses a
 * typo for, arriving by omission instead.
 *
 * A warning rather than a refusal, because the combination is legitimate: the
 * privileged `bin/` tools read `DATABASE_URL` and take their engine from their
 * own flags, so a developer can reasonably keep both in `.env` while serving
 * from SQLite. Stating it is enough; refusing would break that.
 */
if (!remoteDatabase && process.env.DATABASE_URL && ENGINE !== POSTGRES) {
  console.warn(
    '[db] DATABASE_URL is set but DATABASE_ENGINE is not "postgres", so this '
    + 'process is serving from SQLite and the URL is unused.'
  );
}

/**
 * The accessibility harness's volume-limiter exemption, refused in production.
 *
 * `config.js` already declines to honour the variable when `NODE_ENV` is
 * production, so this cannot change behaviour — it exists so a deployment that
 * has the variable set says so and stops, rather than running with an operator
 * believing an exemption is active. Exactly the treatment above, for exactly the
 * same reason.
 */
if (IS_PRODUCTION && process.env.WEV_A11Y_HARNESS === '1') {
  console.error('FATAL: WEV_A11Y_HARNESS cannot be enabled in production.');
  process.exit(1);
}

import { startNotificationWorker } from './workers/notificationWorker.js';
import { startExportWorker } from './workers/exportWorker.js';
import { installShutdownHandlers } from './shutdown.js';
import { logLifecycle, telemetryStatus } from './telemetry.js';
import { otelStatus, otelSnapshot } from './observability/otel.js';
import { startIndexWorker } from './search/indexWorker.js';
import { pineconeStatus } from './search/pineconeConfig.js';
import { startAutoSelectScheduler } from './services/autoSelectScheduler.js';
import { startRetentionWorker } from './workers/retentionWorker.js';
import {
  acquireInstanceLock, startInstanceLockHeartbeat, shouldRefuseBoot, describeConflict
} from './instanceLock.js';
import { verifyPolicyFiles } from './legalContent.js';
import { withLease, LEASES } from './schedulerLease.js';

initDatabase();
/* Async because it writes through a transaction; see db.js. No-op outside DEMO_MODE. */
await completeDatabaseInit();
/* On PostgreSQL `initDatabase()` cannot build the schema and defers it to the
   call above. This is the check that the deferral was honoured — a no-op on
   SQLite, and the difference between a named boot error and a server answering
   "relation does not exist" from inside a route. */
assertSchemaReady();

try {
  const { count } = await db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'").get();
  if (count === 0) {
    console.warn('[ownership] WARNING: Platform has ZERO owners. Super admin access is completely lost.');
    console.warn('[ownership] Use `node bin/grant-ownership.mjs` to bootstrap an owner.');
  } else if (count > 2) {
    console.warn(`[ownership] WARNING: Platform has ${count} owners. Expected 1 or 2.`);
  }
} catch (err) {
  console.error('[ownership] Failed to verify owner count at startup:', err.message);
}

/**
 * Refuse to serve policy text this build cannot vouch for.
 *
 * The Legal Center reads the published Markdown out of `docs/legal/policies`,
 * which is the first thing in this server that needs `docs/` to be deployed
 * alongside it. A deployment that ships the code without the documents, or with
 * documents edited after their version was pinned, would otherwise fail one
 * request at a time — and the failing request is somebody trying to read the
 * terms they are being held to.
 *
 * So it fails here instead, on the same principle as the production guards in
 * `config.js`: a missing `JWT_SECRET` refuses to boot rather than issuing
 * unsigned tokens. Fatal in production only. In development a missing document
 * is usually a half-finished branch, and killing the dev server over it would
 * make the drift harder to fix rather than easier — the warning names the
 * problem and `npm test` fails on it regardless.
 */
/* Logged in production as well, deliberately.
 *
 * The success line used to be development-only, on the reasonable-sounding
 * ground that a production boot should be quiet about things that went right.
 * That was wrong here for one specific reason: PRE-RELEASE §6 instructs the
 * operator to "boot once and confirm `[legal] 11 published documents verified
 * against their pinned hashes`" — a line that, in production, was never printed.
 * The one person who most needs the confirmation was the only one who could not
 * get it, and its absence reads as enforcement being broken rather than as
 * enforcement being silent.
 *
 * The count is the part worth having. A boot that verifies 11 and a boot that
 * verifies 3 because `docs/` was partially deployed both raise no error — the
 * failure this guards against is a document that is missing rather than
 * drifted, and only the number distinguishes them. */
try {
  const verified = verifyPolicyFiles();
  console.log(`[legal] ${verified} published documents verified against their pinned hashes.`);
} catch (err) {
  if (IS_PRODUCTION) {
    console.error('FATAL: published legal documents failed verification.');
    console.error('');
    console.error(err.message);
    process.exit(1);
  }
  console.warn(`[legal] WARNING: ${err.message}`);
}

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
const lockResult = await acquireInstanceLock(db);
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
const lockHeartbeat = await startInstanceLockHeartbeat(db);

/**
 * The notification sweep, behind a leader lease.
 *
 * The lease is what keeps a second instance from running the same whole-table
 * scan concurrently. On the single instance this deployment actually runs, the
 * sole holder always acquires it, so nothing observable changes — see
 * `schedulerLease.js` for why it fails OPEN rather than closed.
 *
 * Direct callers — an operator, a test — deliberately go to
 * `runNotificationSweep` unleased. The lease governs the SCHEDULE, not the
 * operation: somebody asking for a sweep by hand should get one.
 */
const leasedNotificationSweep = async () =>
  (await withLease(db, LEASES.NOTIFICATION_SWEEP, () => runNotificationSweep())).result;

await leasedNotificationSweep();

// The handle is kept so shutdown can clear it. Previously discarded, which meant
// the interval held the event loop open forever — a graceful stop could close the
// listener and still never exit, so systemd would wait out its timeout and
// SIGKILL the process, discarding the cleanup entirely.
const sweepInterval = setInterval(() => {
  /* `setInterval` does not await, so a rejection here would be an unhandled
     rejection — which on Node ends the process. The same guard the notification
     worker and the Auto Select scheduler carry, for the same reason. */
  leasedNotificationSweep().catch((err) => {
    console.error('[Sweep] Notification sweep failed:', err);
  });
}, 15 * 60 * 1000);

/* Awaited: `startExportWorker` recovers exports its predecessor abandoned
   before it begins polling, and starting to serve traffic while that is still
   running is how a student's stuck export stays stuck. Both are cheap, and an
   unawaited rejection here would be silent. */
await startNotificationWorker();
await startExportWorker();

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
 * The realtime adapter, awaited before this process serves anything.
 *
 * Awaited HERE rather than left as a floating promise, for two reasons. A
 * rejected promise nobody handles is an unhandled rejection, which on Node ends
 * the process with no useful message. And a misconfigured adapter must stop the
 * boot: the failure it would otherwise produce is a cluster that looks healthy
 * while delivering realtime events to a fraction of its users, which is not
 * visible from inside the application.
 *
 * With no adapter configured — the default, and what this deployment runs — this
 * resolves immediately and reports why it did nothing.
 */
const adapterState = await io.adapterReady;
console.log(`[realtime] ${adapterState.enabled ? `adapter: ${adapterState.adapter}` : 'no adapter'} — ${adapterState.detail}`);

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

  /**
   * One line saying whether telemetry is on, and the matching record if it is.
   *
   * The console line is unconditional and deliberately so: "Better Stack is not
   * configured" is the single most useful thing an operator can read when they
   * are wondering why a dashboard is empty, and a silent no-op tells them
   * nothing. It names the reason — unset, malformed host, refused as insecure —
   * rather than just the state.
   *
   * The `lifecycle.boot` record is what makes a restart visible IN Better Stack,
   * which is the context for every gap in the other logs.
   */
  const telemetry = telemetryStatus();
  console.log(
    telemetry.enabled
      ? '[telemetry] Better Stack enabled.'
      : `[telemetry] Better Stack disabled (${telemetry.reason}). Logs stay local.`
  );
  if (telemetry.enabled) {
    logLifecycle('boot', { outcome: 'listening', ok: true });
  }

  /**
   * And one line for the traces and metrics half.
   *
   * Reported separately from the log line above because the two halves can
   * genuinely differ: they share a token and a host, but tracing has its own off
   * switch (`WEV_OTEL_ENABLED=false`), and an operator who turned it off during
   * an incident should be able to see that rather than infer it. When it is on,
   * the sample rate and the daily span budget are printed because they are the
   * two numbers that explain a trace somebody expected to find and did not.
   */
  const otel = otelStatus();
  if (otel.enabled) {
    const snap = otelSnapshot();
    console.log(
      `[otel] Traces and metrics enabled (sampling ${snap.config.sampleRatio}, `
      + `budget ${snap.config.dailySpanBudget} spans/day).`
    );
  } else {
    console.log(`[otel] Traces and metrics disabled (${otel.reason}).`);
  }

  /**
   * The Pinecone search index, if one is configured.
   *
   * Printed either way, for the same reason the telemetry line above is: an
   * operator reading the boot output should be able to tell whether semantic
   * Discover is on without going and looking. Off is the default and is not a
   * warning — Discover works without it.
   *
   * `startIndexWorker` returns false when Pinecone is unconfigured, so nothing
   * is scheduled and nothing has to be stopped later.
   */
  const search = pineconeStatus();
  console.log(
    search.enabled
      ? `[search] Pinecone enabled (index ${search.index}, namespace ${search.namespace}).`
      : `[search] Pinecone disabled (${search.reason}). Discover uses database search only.`
  );
  startIndexWorker(db);
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
