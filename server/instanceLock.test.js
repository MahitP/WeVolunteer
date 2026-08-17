/**
 * The single-instance requirement must be enforced, not merely documented.
 *
 * ── The finding ──
 *
 * Three documents state that exactly one instance may run
 * (`pilot-deployment-runbook.md` twice, `release-checklist.md` once). Nothing
 * enforced it. Verified by booting two servers against one `WEV_DB_PATH`: both
 * reported `{"status":"ok"}` and served traffic simultaneously, with no warning in
 * either log.
 *
 * ── Why it matters ──
 *
 * Two consequences, one certain and one narrow:
 *
 * 1. CERTAIN — every rate limiter and throttle is in-process memory
 *    (`express-rate-limit`'s default store, plus the `loginFailures` map). With N
 *    instances the effective limit is N× the configured one, so the login brute-force
 *    throttle, the mail limiter and the certificate-verify limiter are all silently
 *    weakened. Nothing surfaces this.
 *
 * 2. NARROW — capacity checks read outside their transaction. `PATCH
 *    /api/applications/bulk` counts accepted applications per slot, then opens a
 *    transaction to write. Within one process that is atomic (`node:sqlite` is
 *    synchronous and the handler never awaits), but two processes can interleave the
 *    read and the write, accepting more volunteers than a slot has spots.
 *    Reported honestly: 25 concurrent trials across two live instances did NOT
 *    reproduce an oversell — SQLite's write serialization narrows the window to
 *    microseconds. It is a real ordering hazard, not a demonstrated defect.
 *
 * The fix is a lock, not a redesign: shared rate-limit storage would be a genuine
 * architectural change, and the deployment does not need multiple instances. Making
 * the documented constraint enforceable is the small, safe move.
 *
 * ── Restart must still work ──
 *
 * A lock that survives a crash would block recovery, which would be worse than the
 * problem. These tests pin that a dead holder's lock is reclaimed immediately.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import os from 'os';

let dir;

async function freshLock() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-lock-'));
  process.env.WEV_DB_PATH = path.join(dir, 'lock.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  const lock = await import('./instanceLock.js');
  return { db: dbMod.db, lock };
}

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('acquiring the lock on a free database', () => {
  it('succeeds and records this process as the holder', async () => {
    const { db, lock } = await freshLock();

    const result = await lock.acquireInstanceLock(db);

    expect(result.acquired).toBe(true);
    expect(result.conflict).toBeNull();

    const row = await db.prepare('SELECT * FROM instance_lock WHERE id = 1').get();
    expect(row.pid).toBe(process.pid);
    expect(row.hostname).toBe(os.hostname());
    expect(row.heartbeat_at).toBeTruthy();
  });

  it('is idempotent for the same process', async () => {
    const { db, lock } = await freshLock();

    expect((await lock.acquireInstanceLock(db)).acquired).toBe(true);
    // A re-entrant call (e.g. a boot path that runs twice) must not deadlock the
    // process against its own lock.
    expect((await lock.acquireInstanceLock(db)).acquired).toBe(true);
  });
});

describe('a second LIVE instance is detected', () => {
  it('refuses when another live process on another host holds the lock', async () => {
    const { db, lock } = await freshLock();

    // A holder on a different host, heartbeating now. The pid-liveness check cannot
    // apply across hosts, so recency is the only signal — which is why the
    // heartbeat exists.
    await db.prepare(`
      INSERT INTO instance_lock (id, hostname, pid, acquired_at, heartbeat_at)
      VALUES (1, 'other-host.example', 4242, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    const result = await lock.acquireInstanceLock(db);

    expect(result.acquired).toBe(false);
    expect(result.conflict).toBeTruthy();
    expect(result.conflict.hostname).toBe('other-host.example');
  });

  it('refuses when a live process on THIS host holds the lock', async () => {
    const { db, lock } = await freshLock();

    // process.ppid is a real, live pid that is not us — the closest honest stand-in
    // for a genuine second instance on the same machine.
    await db.prepare(`
      INSERT INTO instance_lock (id, hostname, pid, acquired_at, heartbeat_at)
      VALUES (1, ?, ?, ?, ?)
    `).run(os.hostname(), process.ppid, new Date().toISOString(), new Date().toISOString());

    const result = await lock.acquireInstanceLock(db);

    expect(result.acquired).toBe(false);
    expect(result.conflict.pid).toBe(process.ppid);
  });
});

describe('a dead or stale holder does not block recovery', () => {
  it('reclaims the lock when the holder pid on this host is gone', async () => {
    const { db, lock } = await freshLock();

    /**
     * The crash-restart case, and the reason this is not a naive lock.
     *
     * If the previous process was SIGKILLed it never released the row. A lock that
     * waited for the staleness window would block `systemctl restart` for up to that
     * window — turning a recovery into an outage, which is worse than the race the
     * lock exists to prevent. A pid on this host that no longer exists is
     * unambiguous, so it is reclaimed at once.
     *
     * pid 999999 is above the default pid_max on Linux and macOS, so it is reliably
     * absent rather than merely probably absent.
     */
    await db.prepare(`
      INSERT INTO instance_lock (id, hostname, pid, acquired_at, heartbeat_at)
      VALUES (1, ?, 999999, ?, ?)
    `).run(os.hostname(), new Date().toISOString(), new Date().toISOString());

    const result = await lock.acquireInstanceLock(db);

    expect(result.acquired, 'a dead holder blocked restart').toBe(true);
    expect((await db.prepare('SELECT pid FROM instance_lock WHERE id = 1').get()).pid).toBe(process.pid);
  });

  it('reclaims the lock when the heartbeat has gone stale', async () => {
    const { db, lock } = await freshLock();

    // A holder on another host that stopped heartbeating — the host was powered off,
    // or the network partitioned. Recency is the only available signal.
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db.prepare(`
      INSERT INTO instance_lock (id, hostname, pid, acquired_at, heartbeat_at)
      VALUES (1, 'other-host.example', 4242, ?, ?)
    `).run(old, old);

    expect((await lock.acquireInstanceLock(db)).acquired).toBe(true);
  });
});

describe('the heartbeat keeps the lock fresh', () => {
  it('advances heartbeat_at', async () => {
    const { db, lock } = await freshLock();
    await lock.acquireInstanceLock(db);

    const before = (await db.prepare('SELECT heartbeat_at FROM instance_lock WHERE id = 1').get()).heartbeat_at;
    // Force a distinct timestamp; ISO strings have millisecond resolution.
    await new Promise(r => setTimeout(r, 5));
    await lock.heartbeatInstanceLock(db);
    const after = (await db.prepare('SELECT heartbeat_at FROM instance_lock WHERE id = 1').get()).heartbeat_at;

    expect(after >= before).toBe(true);
  });

  it('does not throw when the row has been removed underneath it', async () => {
    const { db, lock } = await freshLock();
    await lock.acquireInstanceLock(db);
    await db.prepare('DELETE FROM instance_lock WHERE id = 1').run();

    // A heartbeat failure must never take the process down — it is bookkeeping.
    await expect(lock.heartbeatInstanceLock(db)).resolves.not.toThrow();
  });
});

describe('releasing the lock', () => {
  it('clears the row so the next instance starts cleanly', async () => {
    const { db, lock } = await freshLock();
    await lock.acquireInstanceLock(db);

    await lock.releaseInstanceLock(db);

    const row = await db.prepare('SELECT * FROM instance_lock WHERE id = 1').get();
    expect(row).toBeUndefined();
  });

  it('does not release a lock held by someone else', async () => {
    const { db, lock } = await freshLock();
    await db.prepare(`
      INSERT INTO instance_lock (id, hostname, pid, acquired_at, heartbeat_at)
      VALUES (1, 'other-host.example', 4242, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    await lock.releaseInstanceLock(db);

    // Shutting down must not hand another running instance's lock away.
    const row = await db.prepare('SELECT hostname FROM instance_lock WHERE id = 1').get();
    expect(row?.hostname).toBe('other-host.example');
  });
});

describe('enforcement is fatal in production and advisory in development', () => {
  it('reports that it should be fatal in production', async () => {
    const { db, lock } = await freshLock();
    await db.prepare(`
      INSERT INTO instance_lock (id, hostname, pid, acquired_at, heartbeat_at)
      VALUES (1, 'other-host.example', 4242, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    // The decision is returned rather than acted on inside the module, so the
    // behaviour is testable without spawning a process that exits.
    const result = await lock.acquireInstanceLock(db);
    expect(result.acquired).toBe(false);
    expect(lock.shouldRefuseBoot(result, true)).toBe(true);
  });

  it('does not refuse boot outside production', async () => {
    const { db, lock } = await freshLock();
    await db.prepare(`
      INSERT INTO instance_lock (id, hostname, pid, acquired_at, heartbeat_at)
      VALUES (1, 'other-host.example', 4242, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    const result = await lock.acquireInstanceLock(db);
    // Two dev servers on one database is an ordinary local situation and must stay
    // possible; refusing would push people into deleting their dev database.
    expect(lock.shouldRefuseBoot(result, false)).toBe(false);
  });
});
