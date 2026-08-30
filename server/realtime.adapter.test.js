import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The Socket.IO adapter seam, in both of its states.
 *
 * ── What is being guarded ──
 *
 * Socket.IO rooms live in the process that owns the socket, so with two
 * instances and no adapter `emitToUser` reaches only the clients attached to the
 * instance that handled the write. Notifications, messages and read receipts
 * would be delivered to roughly half the connected users, silently.
 *
 * The deployment runs ONE instance and `instanceLock.js` enforces that, so the
 * adapter is off. This file exists because a dormant seam that has never been
 * executed is not a seam, it is an intention — and the moment it matters is the
 * moment somebody is bringing a second instance up under pressure.
 *
 * Two halves:
 *
 *   1. **Disabled** — the default. Nothing is installed, no pool is opened, the
 *      package is never even imported. This half runs everywhere.
 *   2. **Enabled** — a real adapter over a real PostgreSQL connection, with two
 *      independent Socket.IO servers, proving a broadcast on one reaches a
 *      client attached to the other. This half needs `TEST_POSTGRES_URL` and is
 *      skipped without it, the way the other PostgreSQL suites are.
 */
const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

describe('with no adapter configured — the deployed state', () => {
  let mod;

  beforeAll(async () => {
    mod = await import('./realtime/adapter.js');
  });

  it('reports that none was requested', () => {
    expect(mod.realtimeAdapterRequested({})).toBe(false);
  });

  it('installs nothing and says why', async () => {
    let installed = null;
    const io = { adapter: (a) => { installed = a; } };

    const state = await mod.configureRealtimeAdapter(io, {});

    expect(state.enabled).toBe(false);
    expect(state.adapter).toBeNull();
    expect(state.detail).toMatch(/per-process/);
    expect(installed, 'an adapter was installed when none was configured').toBeNull();
  });

  it('closing is a no-op when nothing was opened', async () => {
    await expect(mod.closeRealtimeAdapter()).resolves.toBeUndefined();
  });
});

describe('misconfiguration fails the boot rather than degrading', () => {
  /**
   * Both cases below would otherwise produce the same silent outcome: an
   * operator asked for an adapter, did not get one, and nothing anywhere says
   * so. On one instance that is invisible; on two it is half the users missing
   * half their realtime events.
   */
  it('refuses an adapter name it does not know', async () => {
    const mod = await import('./realtime/adapter.js');
    await expect(mod.configureRealtimeAdapter({ adapter() {} }, { REALTIME_ADAPTER: 'redis-but-typoed' }))
      .rejects.toThrow(/not a known adapter/);
  });

  it('refuses to inherit DATABASE_URL for the adapter connection', async () => {
    /**
     * The important one. `DATABASE_URL` is meant to point at Supavisor in
     * TRANSACTION mode, where a `LISTEN` registered on a connection is discarded
     * when that connection returns to the pool — so the adapter would broadcast
     * nothing, with no error. Defaulting to it would be correct on a direct
     * connection and broken on the pooler the runbook actually recommends.
     */
    const mod = await import('./realtime/adapter.js');
    await expect(mod.configureRealtimeAdapter({ adapter() {} }, {
      REALTIME_ADAPTER: 'postgres',
      DATABASE_URL: 'postgres://someone@example.invalid:6543/db',
    })).rejects.toThrow(/REALTIME_ADAPTER_URL/);
  });
});

describe.skipIf(!POSTGRES_URL)('with the adapter enabled, against a real PostgreSQL', () => {
  let pg, pool, servers = [], clients = [];

  beforeAll(async () => {
    pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });
    /* The adapter's own table. Migration 062 creates it on a real deployment;
       this suite talks to the database directly and owns its own setup. */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS socket_io_attachments (
        id bigserial UNIQUE, created_at timestamptz DEFAULT NOW(), payload bytea
      )
    `);
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) c.close();
    for (const s of servers) {
      await new Promise(resolve => s.io.close(() => resolve()));
      await new Promise(resolve => s.http.close(() => resolve()));
    }
    await pool?.end();
  });

  /** A Socket.IO server on its own port, sharing the adapter's bus. */
  async function startServer() {
    const { createServer } = await import('http');
    const { Server } = await import('socket.io');
    const { createAdapter } = await import('@socket.io/postgres-adapter');

    const http = createServer();
    const io = new Server(http, { cors: { origin: true, credentials: true } });
    const ownPool = new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });
    io.adapter(createAdapter(ownPool));

    http.listen(0, '127.0.0.1');
    await new Promise(r => http.once('listening', r));
    const entry = { http, io, pool: ownPool, port: http.address().port };
    servers.push(entry);
    return entry;
  }

  it('delivers a broadcast made on one instance to a client on the other', async () => {
    /**
     * THE property. Without an adapter this test fails by timing out, because
     * the room the client joined exists only in server A's memory and server B
     * has no way to reach it — which is exactly the production failure a second
     * instance would produce today.
     */
    const { io: ioClient } = await import('socket.io-client');
    const a = await startServer();
    const b = await startServer();

    /* A client on A, in a room. */
    const client = ioClient(`http://127.0.0.1:${a.port}`, {
      transports: ['websocket'], reconnection: false,
    });
    clients.push(client);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 8000);
    });

    const room = `user:cross-instance-${Date.now()}`;
    const sockets = await a.io.fetchSockets();
    expect(sockets, 'the client did not attach to server A').toHaveLength(1);
    await sockets[0].join(room);

    /* Give the adapters a moment to see each other's heartbeat. */
    await new Promise(r => setTimeout(r, 500));

    const received = new Promise((resolve) => {
      client.once('cross.instance', resolve);
      setTimeout(() => resolve(null), 8000);
    });

    /* Emitted from B — the instance the client is NOT connected to. */
    b.io.to(room).emit('cross.instance', { hello: 'from B' });

    expect(
      await received,
      'a broadcast from the other instance never arrived — the adapter is not carrying it'
    ).toEqual({ hello: 'from B' });
  }, 30_000);

  it('the configured module installs an adapter and verifies its table', async () => {
    const mod = await import('./realtime/adapter.js');
    let installed = null;
    const state = await mod.configureRealtimeAdapter(
      { adapter: (a) => { installed = a; } },
      { REALTIME_ADAPTER: 'postgres', REALTIME_ADAPTER_URL: POSTGRES_URL },
    );

    expect(state).toMatchObject({ enabled: true, adapter: 'postgres' });
    expect(installed, 'no adapter was handed to io.adapter()').toBeTruthy();

    await mod.closeRealtimeAdapter();
  }, 30_000);

  it('creates its own attachment table on a database that has never had one', async () => {
    /**
     * The adapter needs `socket_io_attachments` for any broadcast too large for
     * a NOTIFY payload, and it starts happily without it — failing later, on the
     * first oversized message, as a dropped event rather than a boot error.
     *
     * This was a migration until it turned out not to work: `applyPostgresSchema`
     * records every registry version as already supplied when it provisions a
     * FRESH database, so a PostgreSQL-only migration is skipped on exactly the
     * databases that have never had the table. Creating it here — the pattern
     * `createInstanceLockTable` already sets — is correct on a fresh database, a
     * migrated one, and a re-run.
     *
     * A scratch schema stands in for "a database that has never had the table".
     */
    const scratch = `wv_adapter_probe_${Date.now()}`;
    await pool.query(`CREATE SCHEMA ${scratch}`);
    try {
      const url = new URL(POSTGRES_URL);
      url.searchParams.set('options', `-c search_path=${scratch}`);

      const before = await pool.query(
        `SELECT to_regclass('${scratch}.socket_io_attachments') AS present`
      );
      expect(before.rows[0].present, 'the scratch schema already had the table').toBeNull();

      const mod = await import('./realtime/adapter.js');
      const state = await mod.configureRealtimeAdapter({ adapter() {} }, {
        REALTIME_ADAPTER: 'postgres', REALTIME_ADAPTER_URL: url.toString(),
      });
      expect(state.enabled).toBe(true);
      await mod.closeRealtimeAdapter();

      const after = await pool.query(
        `SELECT to_regclass('${scratch}.socket_io_attachments') AS present`
      );
      expect(after.rows[0].present, 'the adapter did not create its table').not.toBeNull();
    } finally {
      await pool.query(`DROP SCHEMA ${scratch} CASCADE`);
    }
  }, 30_000);

  it('refuses when the connection string does not work', async () => {
    /* An adapter that cannot reach its database must stop the boot rather than
       leave a cluster broadcasting into nothing. */
    const mod = await import('./realtime/adapter.js');
    await expect(mod.configureRealtimeAdapter({ adapter() {} }, {
      REALTIME_ADAPTER: 'postgres',
      REALTIME_ADAPTER_URL: 'postgres://nobody@127.0.0.1:1/nonexistent',
    })).rejects.toThrow();
    await mod.closeRealtimeAdapter();
  }, 30_000);
});
