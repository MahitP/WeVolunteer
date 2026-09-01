/**
 * A local server that speaks Upstash's REST protocol.
 *
 * ── Why a stub and not the real database ──
 *
 * The load harness needs to exercise the Redis code paths — `redisClient.js`,
 * the limiter stores, `volumeLimit.js`, the lookup caches, the throttle —
 * including their serialisation, their circuit breaker and their command
 * counting. What it must NOT do is spend a metered free-tier allowance, depend
 * on a vendor being reachable, or carry a production credential into a load run.
 *
 * Pointing the real client at this covers everything except the wire. Every
 * byte the client builds, every script it sends, every response shape it parses
 * is the real one; only the host is local. And it buys two things the real
 * service cannot give a test at all:
 *
 *   • **Failure on demand.** `setFailing(true)` makes every request fail, which
 *     is how the harness measures what an outage costs. There is no safe way to
 *     make Upstash fail.
 *   • **Latency on demand.** The Redis work measured a 222 ms warm round trip to
 *     the database as configured (`docs/operations/upstash.md` §1.2). `--redis-latency`
 *     reproduces that against a local server, so a run can answer "what does
 *     this cost at the real service's latency" without the real service.
 *
 * The command counter is authoritative here rather than asked of the
 * application, because it counts what actually arrived.
 *
 * This implements the subset of Redis the application uses. Anything else
 * answers an error, deliberately — a stub that silently accepted an unknown
 * command would let a wrong call site pass a load run.
 */
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A throwaway self-signed certificate for 127.0.0.1.
 *
 * ── Why the stub needs TLS at all ──
 *
 * `redis/redisConfig.js` refuses any URL that is not `https://`, and it is right
 * to: the Upstash token is a bearer credential with full database privileges, so
 * a plaintext URL would put it on the wire. Quietly rewriting it to HTTPS would
 * hide exactly the configuration mistake an operator needs to see.
 *
 * That rule is a security control and the harness does not get to weaken it —
 * not even behind a test flag, because a flag that disables a credential
 * protection is a flag somebody eventually sets in the wrong place. So the stub
 * speaks real TLS instead, and the child process is given the certificate
 * through `NODE_EXTRA_CA_CERTS` so it can verify it properly.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` would also have worked and is deliberately
 * not used: it disables verification for EVERY connection the process makes, in
 * a process that also talks to a database.
 */
function selfSignedCert() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wev-stub-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });
  return { dir, keyPath: key, certPath: cert, key: readFileSync(key), cert: readFileSync(cert) };
}

export function createUpstashStub({ latencyMs = 0 } = {}) {
  /** key -> { value, expiresAt } for strings; sorted sets are not used here. */
  const store = new Map();
  const state = {
    requests: 0,
    commands: 0,
    failing: false,
    latencyMs,
    byCommand: new Map(),
    maxKeys: 0,
  };

  const live = (k) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) { store.delete(k); return null; }
    return e;
  };

  function note(name) {
    state.commands += 1;
    state.byCommand.set(name, (state.byCommand.get(name) || 0) + 1);
  }

  function runScript(script, keys, argv) {
    const key = keys[0];
    /* INCR + PEXPIRE-once, optionally returning the PTTL. */
    if (script.startsWith("local c = redis.call('INCR'")) {
      note('INCR');
      const existing = live(key);
      const next = (existing ? Number(existing.value) : 0) + 1;
      const expiresAt = existing ? existing.expiresAt : Date.now() + Number(argv[0]);
      if (!existing) note('PEXPIRE');
      store.set(key, { value: next, expiresAt });
      if (script.includes('PTTL')) {
        note('PTTL');
        return [next, expiresAt === null ? -1 : expiresAt - Date.now()];
      }
      return next;
    }
    /* INCRBY + PEXPIRE-once — the volume coordinator's script. */
    if (script.startsWith("local c = redis.call('INCRBY'")) {
      note('INCRBY');
      const existing = live(key);
      const by = Number(argv[0]);
      const next = (existing ? Number(existing.value) : 0) + by;
      const expiresAt = existing ? existing.expiresAt : Date.now() + Number(argv[1]);
      if (!existing) note('PEXPIRE');
      store.set(key, { value: next, expiresAt });
      return next;
    }
    if (script.startsWith("if redis.call('EXISTS'")) {
      note('EXISTS');
      const existing = live(key);
      if (!existing) return 0;
      note('DECR');
      const next = Number(existing.value) - 1;
      store.set(key, { value: next, expiresAt: existing.expiresAt });
      return next;
    }
    throw new Error(`upstash-stub: unknown script ${script.slice(0, 48)}`);
  }

  function run(cmd) {
    const [name, ...args] = cmd;
    const upper = String(name).toUpperCase();
    switch (upper) {
      case 'PING': note('PING'); return 'PONG';
      case 'GET': { note('GET'); const e = live(args[0]); return e === null ? null : String(e.value); }
      case 'SET': {
        note('SET');
        /* `SET key value EX seconds` / `PX ms` — the cache's shape. */
        let expiresAt = null;
        for (let i = 1; i < args.length - 1; i++) {
          const flag = String(args[i]).toUpperCase();
          if (flag === 'EX') expiresAt = Date.now() + Number(args[i + 1]) * 1000;
          if (flag === 'PX') expiresAt = Date.now() + Number(args[i + 1]);
        }
        store.set(args[0], { value: args[1], expiresAt });
        return 'OK';
      }
      case 'DEL': { note('DEL'); const had = live(args[0]) ? 1 : 0; store.delete(args[0]); return had; }
      case 'PTTL': {
        note('PTTL');
        const e = live(args[0]);
        if (!e) return -2;
        return e.expiresAt === null ? -1 : e.expiresAt - Date.now();
      }
      case 'EVAL': {
        note('EVAL');
        const n = Number(args[1]);
        return runScript(args[0], args.slice(2, 2 + n), args.slice(2 + n));
      }
      default:
        throw new Error(`upstash-stub: unsupported command ${upper}`);
    }
  }

  const tls = selfSignedCert();

  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      state.requests += 1;
      state.maxKeys = Math.max(state.maxKeys, store.size);

      if (state.latencyMs > 0) {
        await new Promise(r => setTimeout(r, state.latencyMs));
      }
      if (state.failing) {
        /* A transport-level failure, which is what the breaker is built for. */
        res.socket?.destroy();
        return;
      }

      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'bad body' }));
      }

      const isPipeline = String(req.url).endsWith('/pipeline');
      const answer = isPipeline
        ? parsed.map((cmd) => {
          try { return { result: run(cmd) }; } catch (err) { return { error: err.message }; }
        })
        : (() => {
          try { return { result: run(parsed) }; } catch (err) { return { error: err.message }; }
        })();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  };

  const server = createHttpsServer({ key: tls.key, cert: tls.cert }, handler);

  return {
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      await new Promise(r => server.close(() => r()));
      rmSync(tls.dir, { recursive: true, force: true });
    },
    /** The CA the child process must trust, and nothing else. */
    caPath: tls.certPath,
    setFailing(v) { state.failing = v; },
    setLatency(ms) { state.latencyMs = ms; },
    stats() {
      return {
        requests: state.requests,
        commands: state.commands,
        keys: store.size,
        maxKeys: state.maxKeys,
        byCommand: Object.fromEntries([...state.byCommand].sort((a, b) => b[1] - a[1])),
      };
    },
    reset() {
      state.requests = 0; state.commands = 0; state.byCommand.clear(); state.maxKeys = 0;
    },
    keys: () => [...store.keys()],
    clear: () => store.clear(),
  };
}
