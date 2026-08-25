/**
 * The wire to Better Stack. Batches, posts, and never lets any of that reach a
 * request.
 *
 * ── Why this is ~150 lines and not `@logtail/node` ──
 *
 * Better Stack documents two supported ways in for Node: the `@logtail/node`
 * client, and the Telemetry HTTP ingestion API it is built on
 * (`POST https://$INGESTING_HOST` with `Authorization: Bearer $SOURCE_TOKEN` and
 * a JSON array of records). Both are official; the second is what the first
 * does.
 *
 * The client was rejected on this repository's own terms:
 *
 *   · **Dependencies.** `@logtail/node` brings `@logtail/core`, `@logtail/types`,
 *     `@msgpack/msgpack`, `minimatch` and `stack-trace` — five packages plus a
 *     types package, to make one HTTPS POST. ENGINEERING_GUIDE §3.2 treats an
 *     unexplained lockfile diff as a supply-chain risk, and this codebase runs
 *     on a Node with `fetch` built in.
 *   · **The failure semantics are the feature.** Everything below exists to
 *     guarantee that a telemetry problem cannot become a user's problem —
 *     bounded queue, swallowed errors, a hard timeout, no unhandled rejection.
 *     Wrapping a third-party client to obtain those guarantees is more code than
 *     writing the POST, and leaves the guarantee resting on somebody else's
 *     retry loop.
 *   · **It would invite the wrong thing.** The client's `.error(err)` helper
 *     serialises an Error and its properties wholesale. On this application that
 *     is precisely the move §6.10 forbids, and a convenient wrong path in a
 *     shared module gets used.
 *
 * What is NOT reimplemented: the format, the endpoint, the auth scheme and the
 * `dt` timestamp semantics are Better Stack's, used as documented.
 *
 * ── Delivery model ──
 *
 * The deployment is a long-lived systemd service (`deploy/wevolunteer.service`),
 * not a serverless function, so an in-process queue drained on a timer is
 * appropriate and there is a real shutdown hook to flush it from. Nothing here
 * spawns a process, opens a socket it holds, or adds anything for the service
 * manager to supervise.
 *
 * ── Invariants ──
 *
 *   1. Never throws, never rejects, never produces an unhandled rejection.
 *   2. Never blocks a request. `enqueue` is synchronous and returns immediately.
 *   3. Bounded memory. A full queue drops the OLDEST record and counts it.
 *   4. Off unless configured. No token, no host, no network calls.
 *   5. Silent in tests unless a test asks for it by name.
 */

/**
 * Records held before the oldest are dropped.
 *
 * `telemetry.js` caps `stack` at 4 kB and every other string at 500 bytes, so a
 * record is a few kilobytes at worst and the queue is bounded at roughly 2 MB.
 * (Better Stack's own limit is 10 MiB per request and ~100 KiB per record;
 * nothing here can approach either.)
 */
const MAX_QUEUE = 500;

/** Records per POST. Better Stack accepts an array; 10 MiB is the request cap. */
const MAX_BATCH = 50;

/** How long a partly-full batch waits for company. */
const FLUSH_INTERVAL_MS = 2000;

/**
 * How long a POST may take before it is abandoned.
 *
 * Short on purpose. A hung telemetry request holds a socket and, at shutdown,
 * delays the drain — and there is nothing to be gained by waiting: the record is
 * already gone from the queue and the batch is already lost. Five seconds is
 * long enough for a slow link and short enough to stay well inside systemd's
 * `TimeoutStopSec`.
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * The whole shutdown drain's budget, not one request's.
 *
 * ── The bug this exists for ──
 *
 * `drainTelemetry` was bounded only by the number of passes — eleven, being the
 * queue cap over the batch size. Against an unreachable endpoint every pass
 * costs a full `REQUEST_TIMEOUT_MS`, so a drain could take **55 seconds**, on
 * top of the 15-second in-flight request drain above it. systemd's default
 * `TimeoutStopSec` is 90, and `SHUTDOWN_TIMEOUT_MS` is operator-configurable —
 * so a Better Stack outage during a deploy could push the process into SIGKILL,
 * which discards exactly the cleanup the shutdown sequence exists to perform.
 *
 * That is Better Stack taking WeVolunteer down, by the back door. Five seconds
 * is one request's worth: enough for a healthy endpoint to accept several
 * batches, and short enough that an unhealthy one costs a deploy almost
 * nothing.
 */
const DRAIN_DEADLINE_MS = 5000;

const queue = [];
let timer = null;
let config = null;
const stats = { queued: 0, sent: 0, dropped: 0, failed: 0, batches: 0 };

/**
 * Whether this process may talk to Better Stack, and where.
 *
 * ── The test gate is deliberate and is checked first ──
 *
 * A suite that ships real telemetry is a suite that leaks fixture data into a
 * production account and burns somebody's ingestion quota, and it would do it
 * silently. `VITEST` is set by the runner in every worker and by nothing that
 * deploys, so the refusal cannot be inherited by a real process. A test that
 * genuinely needs the transport sets `WEV_TELEMETRY_TEST_SINK=1` and points the
 * host at its own stub — which is how `telemetrySink.test.js` exercises the POST
 * without a network.
 *
 * Both values are required. A token with no host has nowhere to go, and a host
 * with no token is an unauthenticated POST to somebody's ingest endpoint.
 */
export function resolveTelemetryConfig(env = process.env) {
  if (env.VITEST && env.WEV_TELEMETRY_TEST_SINK !== '1') {
    return { enabled: false, reason: 'test_environment' };
  }

  const token = String(env.BETTERSTACK_SOURCE_TOKEN || '').trim();
  const rawHost = String(env.BETTERSTACK_INGESTING_HOST || '').trim();
  if (!token || !rawHost) return { enabled: false, reason: 'not_configured' };

  /* Accepts `s123.eu-nbg-2.betterstackdata.com` or a full URL, because the
     dashboard shows the bare host and an operator pasting either should work.
     Anything that is not http(s) is refused rather than coerced — a typo that
     produced `ftp://` would otherwise fail once per batch, for ever. */
  let url;
  try {
    url = new URL(rawHost.includes('://') ? rawHost : `https://${rawHost}`);
  } catch {
    return { enabled: false, reason: 'bad_host' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { enabled: false, reason: 'bad_host' };
  }
  /**
   * Plain HTTP is refused outside development. The payload carries a Bearer
   * token and redacted-but-real diagnostics; sending it in clear over the public
   * internet would undo the point of redacting it. `http://` stays available for
   * a loopback stub, which is what the tests use.
   */
  if (url.protocol === 'http:' && env.NODE_ENV === 'production') {
    return { enabled: false, reason: 'insecure_host' };
  }

  return { enabled: true, endpoint: url.toString(), token };
}

/** Reads configuration once per process, unless a test resets it. */
function currentConfig() {
  if (config === null) config = resolveTelemetryConfig();
  return config;
}

export function telemetryEnabled() {
  return currentConfig().enabled === true;
}

/** Why telemetry is off, for the boot line an operator reads. */
export function telemetryStatus() {
  const c = currentConfig();
  return c.enabled ? { enabled: true } : { enabled: false, reason: c.reason };
}

/**
 * Hands one record to the wire. Synchronous, and returns nothing worth checking.
 *
 * The oldest record is dropped when the queue is full rather than the newest:
 * during an incident the newest records describe the incident, and the ones
 * already queued are the ones that have had their chance.
 */
export function enqueue(record) {
  try {
    if (!telemetryEnabled()) return;
    if (queue.length >= MAX_QUEUE) {
      queue.shift();
      stats.dropped++;
    }
    queue.push(record);
    stats.queued++;
    if (queue.length >= MAX_BATCH) {
      fireAndForgetFlush();
      return;
    }
    scheduleFlush();
  } catch {
    /* A failure to QUEUE a log line is not worth a second failure. */
  }
}

/**
 * Starts a flush that nobody is waiting on, and swallows the result.
 *
 * `void flushTelemetry()` was wrong here, and the reason is specific to this
 * process: `shutdown.js` installs an `unhandledRejection` handler that DRAINS
 * THE SERVER. `flushTelemetry` resolves on every path it has today, so the bug
 * was latent rather than live — but "the telemetry sink cannot take the process
 * down" is the guarantee this whole module exists to provide, and resting it on
 * a promise that merely happens not to reject is not providing it. The `.catch`
 * makes it structural.
 */
function fireAndForgetFlush() {
  try {
    flushTelemetry().catch(() => { /* delivery failures are counted, not thrown */ });
  } catch { /* a synchronous throw from the call itself */ }
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    fireAndForgetFlush();
  }, FLUSH_INTERVAL_MS);
  /* `unref` so a pending flush cannot hold the event loop open and keep a
     finished process alive — `shutdown.js` flushes explicitly. */
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * The POST currently in flight, or `null`.
 *
 * ── Why delivery is serialised ──
 *
 * `enqueue` starts a flush as soon as fifty records are waiting, and
 * `flushTelemetry` takes its batch out of the queue synchronously, before its
 * first `await`. With no interlock, a burst therefore produced one CONCURRENT
 * request per fifty records — five thousand records meant a hundred simultaneous
 * POSTs, each holding a socket and its own batch. The queue stayed near empty
 * throughout, so `MAX_QUEUE` never engaged and `stats.dropped` never moved: the
 * bounded-memory invariant was being measured in the one place the memory was
 * not.
 *
 * One request at a time turns that around. A slow or dead endpoint now shows up
 * as the queue filling, which is what the cap and the drop counter are for, and
 * the process holds one batch and one socket no matter how hard it is logging.
 * The cost is throughput — fifty records per round trip — and the sources feeding
 * this sink (sampled access log, errors, lifecycle, audit pulse) do not come
 * close to it.
 *
 * It also gives the shutdown drain something to await. A batch already in flight
 * is not in the queue, so without this the drain saw an empty queue and returned
 * while the records were still on the wire.
 */
let inFlight = null;

/**
 * Sends one batch, or joins the send already happening. Never rejects.
 *
 * A rejected POST is counted and the batch is discarded — it is NOT requeued,
 * because a retry loop against an endpoint that is down is how a telemetry
 * outage becomes a memory leak, and the records it would preserve are the least
 * valuable thing the process is holding.
 */
export function flushTelemetry() {
  /* Already sending: the caller gets that one. Returning it rather than
     starting a second is the interlock. */
  if (inFlight) return inFlight;

  if (timer) { clearTimeout(timer); timer = null; }

  let cfg;
  /* Its own guard: a throw here would reject, and a rejection from
     `fireAndForgetFlush` is a drained process. */
  try {
    cfg = currentConfig();
  } catch { return Promise.resolve(); }
  if (!cfg.enabled || queue.length === 0) return Promise.resolve();

  const batch = queue.splice(0, MAX_BATCH);
  stats.batches++;

  inFlight = deliver(cfg, batch).then(() => {
    inFlight = null;
    /* Anything that arrived while the POST was in flight. Bounded by the queue
       cap, so this cannot spin. */
    if (queue.length > 0) scheduleFlush();
  });
  return inFlight;
}

/** The request itself. Resolves on every path, including failure. */
async function deliver(cfg, batch) {
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      stats.failed += batch.length;
      /* Status only. A body from an ingest endpoint is not something to copy
         into this process's logs unread. */
      warnOnce(`Better Stack rejected a batch (HTTP ${res.status}).`);
    } else {
      stats.sent += batch.length;
    }
  } catch (err) {
    stats.failed += batch.length;
    warnOnce(`Better Stack delivery failed (${err?.name || 'error'}).`);
  }
}

/**
 * Sends everything queued before the process exits, not just one batch.
 *
 * `flushTelemetry` posts at most `MAX_BATCH` (50) records, which is right for a
 * timer tick and wrong for a shutdown: a busy server can be holding several
 * hundred, and the records describing WHY it is restarting are exactly the ones
 * worth keeping. A batch already on the wire counts too — it is no longer in the
 * queue, and exiting without waiting for it loses it just as completely.
 *
 * ── Three independent bounds, because a shutdown must end ──
 *
 *   passes     the queue cap over the batch size, plus room for a pass spent
 *              waiting on a request that was already in flight
 *   deadline   `DRAIN_DEADLINE_MS` over the whole loop — see the note there for
 *              the SIGKILL this prevents
 *   failure    the FIRST failed pass stops it
 *
 * The last one carries most of the weight. A failed batch is discarded rather
 * than retried, so once delivery is failing the remaining passes cannot deliver
 * anything either — they would only spend a request timeout each to discard
 * records that were already lost. Stopping is strictly better for both the
 * deploy and the data.
 *
 * Always resolves. Never throws.
 *
 * @param {object} [opts]
 * @param {number} [opts.deadlineMs]  overridden only by tests
 */
export async function drainTelemetry({ deadlineMs = DRAIN_DEADLINE_MS } = {}) {
  const startedAt = Date.now();
  const MAX_PASSES = Math.ceil(MAX_QUEUE / MAX_BATCH) + 2;

  for (let pass = 0; pass < MAX_PASSES && (queue.length > 0 || inFlight); pass++) {
    const failedBefore = stats.failed;
    await flushTelemetry();
    if (stats.failed > failedBefore) break;          // delivery is down
    if (Date.now() - startedAt >= deadlineMs) break; // the deploy comes first
  }

  /* Nothing should be scheduled after a drain: the process is leaving. */
  if (timer) { clearTimeout(timer); timer = null; }

  /**
   * Records the queue never had room for, said once, locally.
   *
   * Dropping is by design — a bounded queue is what stops a telemetry outage
   * becoming a memory leak — but silently lossy telemetry is worse than
   * obviously lossy telemetry, and this is the one moment the total is known.
   */
  if (stats.dropped > 0) {
    try {
      console.warn(
        `[telemetry] ${stats.dropped} record(s) were dropped by the queue cap this run. `
        + 'Telemetry is sampled, not guaranteed.'
      );
    } catch { /* nothing left to try */ }
  }
}

/**
 * One warning per process, not one per batch.
 *
 * An unreachable endpoint fails every two seconds for as long as it is down. At
 * one line each that is the outage filling the journal it is meant to be
 * diagnosed from — and the second line says nothing the first did not.
 */
let warned = false;
function warnOnce(message) {
  if (warned) return;
  warned = true;
  try { console.warn(`[telemetry] ${message} Logging continues locally.`); } catch { /* nothing left */ }
}

/** Counters, for the tests and for a future health line. */
export function telemetrySinkStats() {
  return { ...stats, pending: queue.length };
}

/** Test seam. Module state must not leak between cases. */
export function __resetTelemetrySink() {
  if (timer) { clearTimeout(timer); timer = null; }
  inFlight = null;
  queue.length = 0;
  config = null;
  warned = false;
  for (const key of Object.keys(stats)) stats[key] = 0;
}
