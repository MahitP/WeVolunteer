/**
 * The thing that drains the search queue, and the reason event creation never
 * waits for a search vendor.
 *
 * ── Why a timer and not a job queue ──
 *
 * The deployment is a single long-lived systemd service
 * (`deploy/wevolunteer.service`), not a fleet and not a serverless function.
 * There is no work-stealing to arrange, no visibility timeout to honour and no
 * second process to coordinate with — so a queue system would add an operational
 * component to supervise in exchange for a guarantee this already has: the
 * durable part of the work is a committed row in the application's own database,
 * and the timer is only the thing that notices it.
 *
 * `telemetrySink.js` reached the same conclusion about batching for the same
 * reason, and this follows its shape deliberately — including `unref`, so a
 * pending pass can never be the reason a finished process stays alive.
 *
 * ── Why passes are serialised ──
 *
 * One drain at a time, enforced by a flag. Two overlapping passes would select
 * the same pending rows (nothing marks them in-flight) and upsert the same
 * records twice — correct, because the ids are deterministic, but paid for
 * twice in embedding tokens. Against a 5,000,000-token monthly allowance that is
 * exactly the kind of silent waste this integration is arranged to avoid.
 */
import { syncPending } from './eventIndexer.js';
import { pineconeEnabled, UPSERT_BATCH_SIZE } from './pineconeConfig.js';
import { logEvent } from './../telemetry.js';

/**
 * How often the queue is checked.
 *
 * Fifteen seconds is chosen against what a person notices. An organizer who
 * posts an opportunity and immediately searches for it should find it; a minute
 * would feel broken, and a second would mean a database query every second for
 * ever in exchange for nothing — Pinecone's own indexing is eventually
 * consistent by a few seconds regardless, so a shorter interval cannot make the
 * record appear sooner.
 */
const INTERVAL_MS = Number(process.env.PINECONE_SYNC_INTERVAL_MS ?? 15000);

let timer = null;
/** The handle `startIndexWorker` was given; see the note in eventIndexer.js. */
let handle = null;
let running = false;
let stopped = false;
const stats = { passes: 0, upserted: 0, deleted: 0, failed: 0, lastError: null };

async function pass() {
  if (running || stopped) return;
  running = true;
  try {
    const res = await syncPending(handle, { limit: UPSERT_BATCH_SIZE });
    if (!res.skipped) {
      stats.passes++;
      stats.upserted += res.upserted;
      stats.deleted += res.deleted;
      stats.failed += res.failed;
      if (res.reason) stats.lastError = res.reason;
    }
  } catch (err) {
    /* A worker that throws is a worker that stops. The name only — an error from
       a sync carries the rows it was working on. */
    stats.lastError = err?.name || 'error';
  } finally {
    running = false;
  }
}

/**
 * Starts the drain. Idempotent, and a no-op when Pinecone is not configured —
 * which is the default, and every test run.
 */
export function startIndexWorker(db) {
  if (timer || !pineconeEnabled()) return false;
  handle = db;
  stopped = false;
  timer = setInterval(() => { void pass(); }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  logEvent('info', 'lifecycle.search_worker', { operation: 'start', outcome: 'ok' });
  return true;
}

/**
 * Stops the drain and lets a pass in flight finish.
 *
 * Bounded, because shutdown is bounded. An unfinished pass loses nothing: its
 * rows are still `pending` in the database and the next process picks them up —
 * which is the whole point of putting the queue there.
 */
export async function stopIndexWorker({ graceMs = 2000 } = {}) {
  stopped = true;
  if (timer) { clearInterval(timer); timer = null; }

  const deadline = Date.now() + graceMs;
  while (running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { drained: !running };
}

export function indexWorkerStats() {
  return { ...stats, running, active: Boolean(timer) };
}

/** Test seam: one pass, awaited, without waiting for the interval. */
export async function __runIndexWorkerPass(db) {
  if (db) handle = db;
  await pass();
  return indexWorkerStats();
}

export function __resetIndexWorker() {
  if (timer) { clearInterval(timer); timer = null; }
  running = false;
  stopped = false;
  handle = null;
  for (const key of Object.keys(stats)) stats[key] = key === 'lastError' ? null : 0;
}
