/**
 * Leader leases for the periodic sweeps.
 *
 * ── What this is for ──
 *
 * Four things run on a timer in this application, and each one does a whole
 * scan rather than claiming a row:
 *
 *   notification-sweep   time-based notifications        every 15 min
 *   auto-select          the draw after a deadline       every 15 min
 *   retention            deletes data past its period    every 6 h
 *   search-index         reconciles the Pinecone index   every 60 s
 *
 * Run two of them at once and each does the whole scan. The consequences are
 * not symmetrical, which is why the guard is worth having rather than being
 * merely tidy:
 *
 *   • The notification sweep is idempotent by construction — a unique index on
 *     `dedupe_key` — so a double run is wasted work, not duplicate mail.
 *   • Auto Select is idempotent for the same kind of reason: a confirmed
 *     `auto_select_runs` row is the guard, and it is in the database.
 *   • **Retention is not.** It deletes. Two concurrent passes over the same
 *     expired set is the one place where "both processes did the whole scan"
 *     stops being wasteful and starts being a correctness question.
 *   • The search indexer spends a metered third-party allowance
 *     (`docs/operations/pinecone.md`), so a double run costs money rather than
 *     time.
 *
 * ── This does NOT make the application multi-instance ──
 *
 * `instanceLock.js` still refuses a second production instance, and that has not
 * changed. What has changed is that the list of reasons it must is shorter and
 * evidenced: the sweeps are no longer on it. The remaining blocker is
 * Socket.IO, which has no adapter — see docs/operations/horizontal-scaling.md.
 *
 * ── Why the shape is a conditional UPDATE and not a SELECT-then-write ──
 *
 * "Read the lease, decide it is free, write it" is a race on PostgreSQL, where
 * every statement is a promise and two processes can interleave between the read
 * and the write. The write itself has to be the claim: a single statement whose
 * WHERE clause says "…and it is still free", branching on `changes`. That is the
 * rule `synchronous-handler-invariant` records after three real defects were
 * found this way, and the idiom `notificationWorker.reclaimStaleJobs` and
 * `instanceLock` already use.
 *
 * ── Fail-open, deliberately ──
 *
 * If the lease table cannot be read or written, `withLease` runs the work
 * anyway. The alternative is that a database hiccup silently stops the
 * notification sweep, retention and Auto Select — and this is not a security
 * boundary: it is a "do not do this twice on one deployment that already refuses
 * to run twice" guard. Failing closed would convert a transient error into a
 * silent, indefinite outage of the very things that page people.
 */
import { randomUUID } from 'node:crypto';

/**
 * How long a lease is held before it may be taken from a holder that has gone
 * quiet.
 *
 * Must comfortably exceed the longest a sweep can legitimately take, or a slow
 * pass loses its own lease mid-run and a second process starts a concurrent one
 * — which is the exact situation this exists to prevent. Ten minutes against
 * sweeps that finish in seconds gives a very wide margin, and it is short enough
 * that a hard-killed process does not block its replacement for long.
 */
export const LEASE_TTL_MS = Number(process.env.SCHEDULER_LEASE_TTL_MS) || 10 * 60 * 1000;

/**
 * This process's identity for lease ownership.
 *
 * A random token per process, not a hostname or a pid. Two processes on one host
 * would share a hostname, and a pid is reused after a reboot — either would let
 * a stale holder's release delete its successor's lease.
 */
export const LEASE_OWNER = `${process.pid}:${randomUUID()}`;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Takes the lease for `name`, or reports that somebody else holds it.
 *
 * One statement. `ON CONFLICT DO UPDATE … WHERE` is the claim: the row is only
 * overwritten when the existing lease has expired or is already ours, so two
 * processes issuing this at the same moment produce exactly one `changes: 1`.
 *
 * Re-acquiring our own live lease succeeds and extends it, which is what makes a
 * sweep that runs more often than the TTL work without a separate renewal path.
 *
 * @returns {Promise<boolean>} true when this process now holds it.
 */
export async function acquireLease(db, name, ttlMs = LEASE_TTL_MS) {
  const now = Date.now();
  const nowIso = iso(now);
  const expiresIso = iso(now + ttlMs);

  const result = await db.prepare(`
    INSERT INTO scheduler_leases (name, owner, acquired_at, renewed_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET
      owner       = excluded.owner,
      acquired_at = CASE WHEN scheduler_leases.owner = excluded.owner
                         THEN scheduler_leases.acquired_at
                         ELSE excluded.acquired_at END,
      renewed_at  = excluded.renewed_at,
      expires_at  = excluded.expires_at
    WHERE scheduler_leases.expires_at <= excluded.renewed_at
       OR scheduler_leases.owner = excluded.owner
  `).run(name, LEASE_OWNER, nowIso, nowIso, expiresIso);

  return result.changes > 0;
}

/**
 * Releases the lease, but only if this process still holds it.
 *
 * The owner predicate is not decoration: a process whose lease expired and was
 * taken over would otherwise delete the CURRENT holder's row on its way out,
 * handing a third process a free pass at exactly the wrong moment. Same
 * predicate, same reason, as `releaseInstanceLock`.
 */
export async function releaseLease(db, name) {
  const result = await db.prepare(
    'DELETE FROM scheduler_leases WHERE name = ? AND owner = ?'
  ).run(name, LEASE_OWNER);
  return result.changes > 0;
}

/** Who holds `name` right now, or null. For the health endpoint and for tests. */
export async function readLease(db, name) {
  return (await db.prepare('SELECT * FROM scheduler_leases WHERE name = ?').get(name)) ?? null;
}

/**
 * Runs `fn` if this process can take the lease for `name`, and skips it if
 * another process holds it.
 *
 * Returns `{ ran, result, leased }` rather than just the result, so a caller can
 * tell "skipped because somebody else is doing it" from "ran and produced
 * nothing" — a distinction that matters in the logs at 3am.
 *
 * The four scheduler call sites unwrap it back to `.result` on purpose. Each of
 * them already had a published return value that tests and callers depend on —
 * `startAutoSelectScheduler`'s `timer.startupSweep` resolves to the sweep's
 * `{ executed, failed }`, and `startRetentionWorker` resolves to `undefined` —
 * and quietly widening those to an envelope would be a breaking change made as a
 * side effect of adding a lease.
 *
 * The lease is RELEASED on the way out, including when `fn` throws. Holding it
 * for the full TTL after a completed sweep would mean the next tick fifteen
 * minutes later found its own lease still live — harmless, since re-acquiring
 * our own lease succeeds — but a crash-restarted process would wait out the TTL
 * for no reason. Releasing makes the normal case immediate.
 */
export async function withLease(db, name, fn, { ttlMs = LEASE_TTL_MS } = {}) {
  let held = false;
  try {
    held = await acquireLease(db, name, ttlMs);
  } catch (err) {
    /* Fail open — see the header. A lease we cannot take is not a reason to stop
       sweeping on a deployment that runs one instance, which is every deployment
       today. */
    console.error(`[lease] Could not acquire "${name}" (${err.message}); running anyway.`);
    const result = await fn();
    return { ran: true, result, leased: false };
  }

  if (!held) {
    console.log(`[lease] Skipping "${name}" — another instance holds it.`);
    return { ran: false, result: undefined, leased: false };
  }

  try {
    const result = await fn();
    return { ran: true, result, leased: true };
  } finally {
    try {
      await releaseLease(db, name);
    } catch (err) {
      /* A lease we failed to release expires on its own. Saying so is useful;
         throwing here would replace the sweep's own outcome with a bookkeeping
         error. */
      console.error(`[lease] Could not release "${name}" (${err.message}); it expires in ${Math.round(ttlMs / 1000)}s.`);
    }
  }
}

/** The four sweeps' lease names, in one place so they cannot be spelled two ways. */
export const LEASES = Object.freeze({
  NOTIFICATION_SWEEP: 'notification-sweep',
  AUTO_SELECT: 'auto-select',
  RETENTION: 'retention',
  SEARCH_INDEX: 'search-index',
});
