/**
 * The Socket.IO adapter seam: dormant today, one setting away from working.
 *
 * ── What an adapter is for, and why the absence of one is a defect ──
 *
 * Socket.IO rooms live in the process that owns the socket. With one server that
 * is invisible; with two, `emitToUser` reaches only the clients attached to the
 * instance that happened to handle the write, so notifications, messages and
 * read receipts are delivered to roughly half the connected users — silently,
 * and differently on every request. An adapter is the shared bus that fixes it.
 *
 * `instanceLock.js` still refuses a second production instance, so nothing here
 * is switched on. What this module removes is the part that would otherwise be
 * discovered late: the dependency, the table, the connection requirement and the
 * failure modes are all settled and tested now, and turning it on later is one
 * environment variable rather than a design.
 *
 * ── Why the PostgreSQL adapter and not the Redis one ──
 *
 * `@socket.io/postgres-adapter` broadcasts over `LISTEN`/`NOTIFY`, so the bus is
 * the database this application already cannot run without. That is the whole
 * argument:
 *
 *   • No new service, no new credential, no new free-tier ceiling to watch.
 *   • `pg` is already a dependency, at a version the adapter accepts.
 *   • The Redis branch measured a **222 ms warm round trip** to the Upstash
 *     database as configured (`docs/operations/upstash.md` §1.2). An adapter sits
 *     on the message path, so every realtime event would pay that twice. A
 *     regional Redis would fix the number, but "buy a second service and move it
 *     closer" is a worse answer than "use the database that is already there".
 *
 * The cost is one real constraint, and it is in §Connection below.
 *
 * ── Connection: this must NOT go through a transaction-mode pooler ──
 *
 * `LISTEN` holds state on a connection between statements. Supavisor in
 * TRANSACTION mode (port 6543) hands a connection back to the pool after every
 * transaction, so a `LISTEN` registered on one is simply gone — no error, no
 * notifications, and a cluster that looks healthy while broadcasting nothing.
 *
 * `deploy/wevolunteer.env.example` tells operators to point `DATABASE_URL` at
 * exactly that pooler, because it is right for the application's own queries. So
 * the adapter gets its OWN connection string, and the default is deliberately
 * not to inherit `DATABASE_URL`: silently reusing it would be correct on a
 * direct connection and broken on the pooler the runbook recommends.
 *
 * Use the session-mode pooler (port 5432 on the pooler host) or a direct
 * connection for `REALTIME_ADAPTER_URL`.
 *
 * ── Failing loudly ──
 *
 * A misconfigured adapter throws at boot rather than degrading. The failure it
 * would otherwise produce — half the users silently missing half their realtime
 * events — is not observable from inside the application, and an operator who
 * asked for an adapter and did not get one has no way to find out.
 */
import { Pool } from 'pg';

export const REALTIME_ADAPTERS = ['postgres'];

/**
 * Settings are read LAZILY, from an `env` argument, rather than captured at
 * module load.
 *
 * The same reasoning `db/engine.js` gives for `postgresConfig(env)`: a module
 * that snapshots `process.env` at import time can only ever be one
 * configuration per process, which makes the failure branches untestable
 * without re-importing the module — and Vite cannot re-import a module with a
 * cache-busting query string, so "just import it again" is not available here.
 *
 * Reading them per call costs nothing and means every branch below is
 * reachable from a test.
 */
function settings(env = process.env) {
  return {
    adapter: (env.REALTIME_ADAPTER || '').trim().toLowerCase(),
    /* Never defaulted to `DATABASE_URL` — see the header. */
    url: env.REALTIME_ADAPTER_URL || '',
  };
}

/** Whether an adapter has been asked for at all. */
export const realtimeAdapterRequested = (env = process.env) => settings(env).adapter !== '';

/**
 * The pool the adapter broadcasts over, kept so shutdown can close it.
 *
 * Module scope rather than attached to `io`, because there is at most one of
 * these per process by construction — unlike the session-sweep timer, which is
 * per server and therefore lives on the server it belongs to.
 */
let adapterPool = null;

/**
 * Installs the configured adapter on `io`, or does nothing.
 *
 * Returns a description of what happened, so the boot log can say which of the
 * two states the process is in rather than leaving it to be inferred from
 * silence.
 *
 * @returns {Promise<{enabled: boolean, adapter: string|null, detail: string}>}
 */
export async function configureRealtimeAdapter(io, env = process.env) {
  const { adapter: ADAPTER, url: ADAPTER_URL } = settings(env);

  if (!ADAPTER) {
    return {
      enabled: false,
      adapter: null,
      detail: 'no adapter configured — Socket.IO rooms are per-process, which is correct for one instance',
    };
  }

  if (!REALTIME_ADAPTERS.includes(ADAPTER)) {
    throw new Error(
      `FATAL: REALTIME_ADAPTER="${env.REALTIME_ADAPTER}" is not a known adapter.\n`
      + `       Valid values are: ${REALTIME_ADAPTERS.join(', ')} (or unset for none).\n`
      + '       Refusing to fall back to no adapter: a typo here would leave a\n'
      + '       multi-instance deployment delivering realtime events to a fraction\n'
      + '       of its users, with nothing in any log to say so.'
    );
  }

  if (!ADAPTER_URL) {
    throw new Error(
      'FATAL: REALTIME_ADAPTER=postgres requires REALTIME_ADAPTER_URL.\n'
      + '\n'
      + '  It is deliberately NOT defaulted to DATABASE_URL. The adapter broadcasts\n'
      + '  over LISTEN/NOTIFY, which holds state on a connection between statements,\n'
      + '  and DATABASE_URL is meant to point at Supavisor in TRANSACTION mode\n'
      + '  (port 6543) — where that state is discarded after every transaction. The\n'
      + '  adapter would register its LISTEN, lose it, and broadcast nothing, with\n'
      + '  no error anywhere.\n'
      + '\n'
      + '  Point it at the SESSION-mode pooler (port 5432 on the pooler host) or at\n'
      + '  a direct connection.'
    );
  }

  /* Imported here, not at module scope, so a deployment with no adapter never
     loads the package or its msgpack dependency at all. */
  const { createAdapter } = await import('@socket.io/postgres-adapter');

  adapterPool = new Pool({ connectionString: ADAPTER_URL, max: 4 });

  /* An idle client that errors — a server restart, a pooler timeout — emits on
     the pool. Unhandled, that is an uncaught exception that takes the process
     down. Same treatment, and the same reasoning, as the application pool in
     `db/postgresConnection.js`. */
  adapterPool.on('error', (err) => {
    console.error('[realtime] idle adapter client error (client discarded):', err.message);
  });

  /**
   * The adapter's own table, created here rather than by a migration.
   *
   * ── Why not a migration ──
   *
   * It was one, briefly, and it did not work. `applyPostgresSchema` records
   * every registry version as already supplied whenever it provisions a FRESH
   * database — so a PostgreSQL-only migration is skipped on exactly the
   * databases that have never had the table. Writing it on the SQLite side
   * instead would put it through the schema generator, which would produce
   * `TEXT` for `created_at`; the adapter's own cleanup compares that column
   * against `now() - interval`, so it has to be a real `timestamptz`.
   *
   * `instanceLock.js` sets the precedent this follows: `createInstanceLockTable`
   * is called at boot by the component that owns the table, for the same reason.
   * The table only exists on deployments that asked for an adapter, and it is
   * correct on a fresh database, a migrated one, and a re-run.
   *
   * The DDL is the adapter's own, from its README, unchanged.
   */
  await adapterPool.query(`
    CREATE TABLE IF NOT EXISTS socket_io_attachments (
      id          bigserial UNIQUE,
      created_at  timestamptz DEFAULT NOW(),
      payload     bytea
    )
  `);

  /**
   * Proved before it is trusted.
   *
   * `LISTEN` through a transaction-mode pooler does not error — it silently does
   * nothing — so a connection check alone would pass on exactly the
   * misconfiguration this is most likely to hit. Reading the table back is the
   * cheapest thing that fails when the connection cannot be used, and it also
   * catches a `CREATE` that silently went to a different search path.
   */
  await adapterPool.query('SELECT 1 FROM socket_io_attachments LIMIT 1');

  io.adapter(createAdapter(adapterPool));

  return {
    enabled: true,
    adapter: ADAPTER,
    detail: 'broadcasting over PostgreSQL LISTEN/NOTIFY',
  };
}

/** Closes the adapter's pool. Safe to call when no adapter was installed. */
export async function closeRealtimeAdapter() {
  if (!adapterPool) return;
  try {
    await adapterPool.end();
  } catch (err) {
    console.error('[realtime] adapter pool close failed:', err.message);
  } finally {
    adapterPool = null;
  }
}
