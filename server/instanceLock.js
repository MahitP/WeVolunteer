/**
 * Single-instance lock.
 *
 * ── Why this exists ──
 *
 * Three documents state that exactly one instance may run — the deployment runbook
 * twice and the release checklist once — and nothing enforced it. Verified by
 * booting two servers against one `WEV_DB_PATH`: both reported healthy and served
 * traffic, with no warning in either log.
 *
 * The certain consequence is that every throttle is in-process memory: the
 * `express-rate-limit` default store plus the `loginFailures` map in authRoutes.
 * With N instances the login brute-force limit, the mail limit and the
 * certificate-verify limit are all N× looser than configured, and nothing says so.
 *
 * The narrower consequence is an ordering hazard: capacity checks read outside their
 * transaction (`PATCH /api/applications/bulk` counts accepted rows per slot, then
 * opens a transaction to write). One process is safe because `node:sqlite` is
 * synchronous and the handler never awaits, so the read and the write cannot
 * interleave. Two processes can interleave them and accept past a slot's capacity.
 * Stated honestly: 25 concurrent trials across two live instances did not reproduce
 * an oversell, because SQLite's write serialization narrows the window to
 * microseconds. It is a real hazard, not a demonstrated defect.
 *
 * ── Why a lock rather than shared state ──
 *
 * Moving the rate limiters to shared storage means adding Redis — a new service, a
 * new failure mode, and a genuine architectural change for a deployment that does
 * not need more than one instance. Enforcing the constraint that is already
 * documented is the small, low-risk move, and it converts a silent misconfiguration
 * into a loud one.
 *
 * ── Why it must not block recovery ──
 *
 * A lock that survives a crash would turn `systemctl restart` after a SIGKILL into
 * an outage lasting the staleness window, which is worse than the hazard it guards.
 * So a holder is only believed if it is plausibly alive: a pid on THIS host that no
 * longer exists is reclaimed immediately, and any holder whose heartbeat has gone
 * stale is reclaimed after the window.
 */
import os from 'os';

/**
 * Every function takes the database handle as its first argument, matching
 * hoursLedger.js and certificates.js.
 *
 * Not a style choice: db.js has to create this table during initDatabase, so a
 * top-level `import { db } from './db.js'` here would make the two modules import
 * each other. That resolves in ESM only because nothing dereferences the binding at
 * module scope — a property no future edit is obliged to preserve. Passing the handle
 * removes the cycle instead of relying on it.
 */

/**
 * How long a holder's heartbeat may lag before it is presumed dead.
 *
 * Must comfortably exceed the heartbeat interval so ordinary scheduling jitter never
 * looks like a death, and must be short enough that a powered-off host does not
 * block a replacement for long. 45s against a 15s heartbeat gives three missed beats.
 */
const STALE_MS = Number(process.env.INSTANCE_LOCK_STALE_MS) || 45_000;

/** How often the holder refreshes its claim. */
const HEARTBEAT_MS = Number(process.env.INSTANCE_LOCK_HEARTBEAT_MS) || 15_000;

let heartbeatTimer = null;

/** Creates the table. Safe to call repeatedly. */
export function createInstanceLockTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_lock (
      -- Single row by construction: the CHECK plus the PRIMARY KEY make a second
      -- row impossible, so there is no "which lock is authoritative" question.
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      hostname     TEXT NOT NULL,
      pid          INTEGER NOT NULL,
      acquired_at  TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    )
  `);
}

/**
 * Whether a pid is running on this machine.
 *
 * `process.kill(pid, 0)` sends no signal; it only performs the permission and
 * existence check. EPERM means the process exists but belongs to another user —
 * still alive, so still a conflict.
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Attempts to take the lock.
 *
 * Returns `{ acquired, conflict }` rather than exiting, so the boot path decides what
 * to do with the answer and the decision stays testable without spawning a process.
 */
export async function acquireInstanceLock(db) {
  createInstanceLockTable(db);

  const me = { hostname: os.hostname(), pid: process.pid };
  const now = new Date();

  const existing = await db.prepare('SELECT * FROM instance_lock WHERE id = 1').get();

  if (existing) {
    const sameProcess = existing.hostname === me.hostname && existing.pid === me.pid;

    if (!sameProcess) {
      const heartbeatAge = now.getTime() - new Date(existing.heartbeat_at).getTime();
      const stale = heartbeatAge > STALE_MS;

      // A pid on this host that is gone is unambiguous — reclaim at once so a
      // crash-restart is never delayed. Across hosts the pid means nothing, so
      // staleness is the only signal available.
      const holderDeadLocally = existing.hostname === me.hostname && !pidAlive(existing.pid);

      if (!stale && !holderDeadLocally) {
        return {
          acquired: false,
          conflict: {
            hostname: existing.hostname,
            pid: existing.pid,
            heartbeatAgeMs: heartbeatAge,
            acquiredAt: existing.acquired_at
          }
        };
      }
    }
  }

  // Take it. `INSERT OR REPLACE` on a fixed primary key is an upsert here, and the
  // whole statement is a single write so two racing acquisitions serialize.
  await db.prepare(`
    INSERT INTO instance_lock (id, hostname, pid, acquired_at, heartbeat_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      hostname = excluded.hostname, pid = excluded.pid,
      acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at
  `).run(me.hostname, me.pid, now.toISOString(), now.toISOString());

  return { acquired: true, conflict: null };
}

/** Refreshes this process's claim. Never throws — it is bookkeeping, not a check. */
export async function heartbeatInstanceLock(db) {
  try {
    await db.prepare(`
      UPDATE instance_lock SET heartbeat_at = ?
      WHERE id = 1 AND hostname = ? AND pid = ?
    `).run(new Date().toISOString(), os.hostname(), process.pid);
  } catch (err) {
    // A failed heartbeat costs at most a spurious takeover after STALE_MS. Taking
    // the process down over it would be a far worse trade.
    console.error('[InstanceLock] Heartbeat failed:', err.message);
  }
}

/** Starts the heartbeat. Returns the timer so shutdown can clear it. */
export async function startInstanceLockHeartbeat(db) {
  if (heartbeatTimer) return heartbeatTimer;
  heartbeatTimer = setInterval(() => heartbeatInstanceLock(db), HEARTBEAT_MS);
  // Never the reason the process stays alive.
  heartbeatTimer.unref?.();
  return heartbeatTimer;
}

/** Stops the heartbeat. */
export function stopInstanceLockHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * Releases the lock, but only if this process holds it.
 *
 * The hostname/pid predicate matters: without it, a process that lost the lock to a
 * takeover would delete the CURRENT holder's row on its way out, handing a third
 * instance a free pass.
 */
export async function releaseInstanceLock(db) {
  try {
    await db.prepare('DELETE FROM instance_lock WHERE id = 1 AND hostname = ? AND pid = ?')
      .run(os.hostname(), process.pid);
  } catch (err) {
    console.error('[InstanceLock] Release failed:', err.message);
  }
}

/**
 * Whether a failed acquisition should stop the boot.
 *
 * Fatal in production: two instances silently multiply every rate limit and open the
 * capacity race, and neither symptom is visible in a log.
 *
 * Advisory outside production: two dev servers against one database is an ordinary
 * local situation, and refusing to start would push people into deleting their
 * development database to get moving.
 */
export function shouldRefuseBoot(result, isProduction) {
  return !result.acquired && Boolean(isProduction);
}

/** The operator-facing explanation for a conflict. */
export function describeConflict(conflict) {
  return (
    'Another WeVolunteer instance appears to be running against this database.\n'
    + `  Holder:        ${conflict.hostname} (pid ${conflict.pid})\n`
    + `  Last heartbeat: ${Math.round(conflict.heartbeatAgeMs / 1000)}s ago\n`
    + `  Held since:    ${conflict.acquiredAt}\n`
    + '\n'
    + 'Running two instances against one SQLite database is not supported:\n'
    + '  • every rate limiter and the login throttle are in-process memory, so each\n'
    + '    instance enforces its own copy and the effective limit is multiplied;\n'
    + '  • slot-capacity checks read outside their write transaction, which is atomic\n'
    + '    in one process but can interleave across two.\n'
    + '\n'
    + 'If the named process is genuinely gone, the lock clears itself once its\n'
    + 'heartbeat is stale (see INSTANCE_LOCK_STALE_MS), or immediately if the pid is\n'
    + 'absent on this host.'
  );
}
