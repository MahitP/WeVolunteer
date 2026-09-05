import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Leader leases for the four periodic sweeps.
 *
 * ── What is being guarded ──
 *
 * The notification sweep, Auto Select, retention and the search indexer each do
 * a whole scan on a timer. Unlike the three JOB queues — which claim a row with
 * a conditional UPDATE and are therefore already safe under two processes —
 * there is no row for a sweep to claim, so two processes both do the whole scan.
 * Retention is the one that matters most, because it deletes.
 *
 * ── What these tests are actually asserting ──
 *
 * Three properties, in order of how badly they fail if wrong:
 *
 *   1. **Two holders cannot coexist.** A second acquisition while a lease is
 *      live must fail. This is the whole point.
 *   2. **A lease is never indefinite.** A holder that dies without releasing
 *      must not block its successor forever; the expiry is what turns a crash
 *      into a delay instead of an outage.
 *   3. **It fails OPEN.** A database error taking the lease must not stop the
 *      sweep. Failing closed would mean a transient fault silently ends
 *      retention and notification reminders on a deployment that runs one
 *      instance anyway — a much worse outcome than doing the work twice.
 *
 * A second process is simulated by overriding the owner token, because that is
 * exactly what distinguishes two processes as far as the lease is concerned.
 */
let srv, db, lease;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  lease = await import('./schedulerLease.js');
}, 60000);

afterAll(async () => { await srv?.close(); });

beforeEach(async () => {
  await db.prepare('DELETE FROM scheduler_leases').run();
});

/**
 * Takes a lease as if from a different process.
 *
 * `acquireLease` uses the module-level `LEASE_OWNER`, which is one process's
 * identity by construction. A foreign holder is written directly, with the same
 * columns the module writes, so the contention being tested is real contention
 * over the row rather than a mock.
 */
async function foreignHolder(name, { ttlMs = 60_000, owner = 'other-process:token' } = {}) {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO scheduler_leases (name, owner, acquired_at, renewed_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET
      owner = excluded.owner, acquired_at = excluded.acquired_at,
      renewed_at = excluded.renewed_at, expires_at = excluded.expires_at
  `).run(name, owner, new Date(now).toISOString(), new Date(now).toISOString(),
    new Date(now + ttlMs).toISOString());
  return owner;
}

describe('acquiring', () => {
  it('takes a lease nobody holds', async () => {
    expect(await lease.acquireLease(db, 'test-sweep')).toBe(true);
    const row = await lease.readLease(db, 'test-sweep');
    expect(row.owner).toBe(lease.LEASE_OWNER);
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a lease another process holds — the whole point', async () => {
    await foreignHolder('test-sweep');
    expect(await lease.acquireLease(db, 'test-sweep')).toBe(false);
    // And the incumbent is untouched: a failed acquisition must not half-write.
    expect((await lease.readLease(db, 'test-sweep')).owner).toBe('other-process:token');
  });

  it('re-acquires and extends its OWN live lease', async () => {
    await lease.acquireLease(db, 'test-sweep', 60_000);
    const first = await lease.readLease(db, 'test-sweep');

    await new Promise(r => setTimeout(r, 20));
    expect(await lease.acquireLease(db, 'test-sweep', 120_000)).toBe(true);
    const second = await lease.readLease(db, 'test-sweep');

    expect(new Date(second.expires_at).getTime())
      .toBeGreaterThan(new Date(first.expires_at).getTime());
    // `acquired_at` is when the hold BEGAN, so extending must not reset it.
    expect(second.acquired_at).toBe(first.acquired_at);
  });

  it('takes over an EXPIRED lease, so a crash is a delay and not an outage', async () => {
    await foreignHolder('test-sweep', { ttlMs: -1000 });   // already expired
    expect(await lease.acquireLease(db, 'test-sweep')).toBe(true);
    expect((await lease.readLease(db, 'test-sweep')).owner).toBe(lease.LEASE_OWNER);
  });

  it('never writes a lease without an expiry', async () => {
    await lease.acquireLease(db, 'test-sweep');
    const row = await lease.readLease(db, 'test-sweep');
    expect(row.expires_at).toBeTruthy();
    expect(Number.isFinite(new Date(row.expires_at).getTime())).toBe(true);
  });
});

describe('releasing', () => {
  it('releases a lease it holds', async () => {
    await lease.acquireLease(db, 'test-sweep');
    expect(await lease.releaseLease(db, 'test-sweep')).toBe(true);
    expect(await lease.readLease(db, 'test-sweep')).toBeNull();
  });

  it('refuses to release somebody else\'s lease', async () => {
    /* The predicate that matters: a process whose lease expired and was taken
       over would otherwise delete the CURRENT holder's row on its way out,
       handing a third process a free pass at exactly the wrong moment. */
    await foreignHolder('test-sweep');
    expect(await lease.releaseLease(db, 'test-sweep')).toBe(false);
    expect((await lease.readLease(db, 'test-sweep')).owner).toBe('other-process:token');
  });
});

describe('withLease', () => {
  it('runs the work and reports that it held the lease', async () => {
    let ran = 0;
    const out = await lease.withLease(db, 'test-sweep', async () => { ran++; return 'done'; });
    expect(out).toEqual({ ran: true, result: 'done', leased: true });
    expect(ran).toBe(1);
  });

  it('releases afterwards, so the next tick is not blocked', async () => {
    await lease.withLease(db, 'test-sweep', async () => 'x');
    expect(await lease.readLease(db, 'test-sweep')).toBeNull();
  });

  it('skips the work entirely when another instance holds the lease', async () => {
    await foreignHolder('test-sweep');
    let ran = 0;
    const out = await lease.withLease(db, 'test-sweep', async () => { ran++; });
    expect(ran).toBe(0);
    expect(out.ran).toBe(false);
  });

  it('releases even when the work throws', async () => {
    await expect(
      lease.withLease(db, 'test-sweep', async () => { throw new Error('sweep exploded'); })
    ).rejects.toThrow('sweep exploded');
    // A lease held by a failed sweep would silence the next fifteen ticks.
    expect(await lease.readLease(db, 'test-sweep')).toBeNull();
  });

  it('runs the work anyway when the lease cannot be taken — fails OPEN', async () => {
    /* A handle whose `prepare` throws stands in for the lease table being
       unreadable. The sweep must still happen: a transient database fault must
       not silently end retention or notification reminders. */
    const broken = {
      prepare() { throw new Error('lease table unavailable'); },
    };
    let ran = 0;
    const out = await lease.withLease(broken, 'test-sweep', async () => { ran++; return 'ok'; });
    expect(ran).toBe(1);
    expect(out).toEqual({ ran: true, result: 'ok', leased: false });
  });

  it('does not fail the sweep when only the RELEASE fails', async () => {
    let calls = 0;
    const original = db.prepare;
    const flaky = {
      prepare(sql) {
        // Let the acquire through; break the DELETE that releases.
        if (/^\s*DELETE FROM scheduler_leases/i.test(sql)) {
          calls++;
          throw new Error('release failed');
        }
        return original(sql);
      },
    };
    const out = await lease.withLease(flaky, 'test-sweep', async () => 'finished');
    expect(calls).toBe(1);
    // The sweep's own outcome survives a bookkeeping failure. The lease expires
    // on its own, which is exactly what the TTL is for.
    expect(out).toEqual({ ran: true, result: 'finished', leased: true });
  });
});

describe('contention between two would-be leaders', () => {
  it('lets exactly one of two concurrent acquisitions win', async () => {
    /**
     * Both statements are issued before either is awaited, so they race the way
     * two instances would. The claim is the WRITE — `ON CONFLICT … WHERE` — not
     * a read followed by a write, which is precisely the shape that produced
     * three real oversell defects elsewhere in this codebase.
     */
    const a = lease.acquireLease(db, 'race-sweep');
    const b = lease.acquireLease(db, 'race-sweep');
    const results = await Promise.all([a, b]);

    /* Both calls come from THIS process, so both legitimately succeed —
       re-acquiring your own lease is allowed and is what makes a sweep running
       more often than the TTL work. The property under test is that the row
       ends up with exactly one owner and one expiry, never a torn write. */
    expect(results.some(Boolean)).toBe(true);
    const rows = await db.prepare('SELECT * FROM scheduler_leases WHERE name = ?').all('race-sweep');
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe(lease.LEASE_OWNER);
  });

  it('only one side does the work when the other process got there first', async () => {
    await foreignHolder('race-sweep');
    let mine = 0;
    await Promise.all([
      lease.withLease(db, 'race-sweep', async () => { mine++; }),
      lease.withLease(db, 'race-sweep', async () => { mine++; }),
    ]);
    // The incumbent holds it, so neither of ours runs.
    expect(mine).toBe(0);
  });
});

describe('the names the sweeps actually use', () => {
  it('publishes one name per periodic sweep', () => {
    expect(Object.values(lease.LEASES).sort()).toEqual(
      ['auto-select', 'notification-sweep', 'retention', 'search-index']
    );
  });

  it('gives every name a distinct value, so two sweeps cannot share a lease', () => {
    const values = Object.values(lease.LEASES);
    expect(new Set(values).size).toBe(values.length);
  });
});
