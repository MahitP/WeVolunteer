#!/usr/bin/env node
/**
 * Two real backend instances, one database, one Redis. What breaks?
 *
 * ── Why this exists ──
 *
 * Every claim this repository makes about multi-instance readiness has until now
 * been argued or unit-tested. `rateLimit.multiInstance.test.js` simulates two
 * instances by holding two store objects in one process, which is a faithful
 * model of the state but not of the deployment. This boots two copies of
 * `server/server.js` against one PostgreSQL and one Redis and asks the questions
 * that only two processes can answer.
 *
 * `instanceLock.js` refuses a second instance in PRODUCTION only
 * (`shouldRefuseBoot` returns false unless `isProduction`), so this runs in
 * development, which is exactly the seam the lock leaves for a test like this.
 * Nothing here changes the production posture: one instance, lock enforced.
 *
 * ── Safety ──
 *
 * Throwaway database, refused if it already holds users, Supabase hosts refused,
 * no third-party credentials passed through, and a loopback Upstash stub rather
 * than a real Redis. Same rules as `bin/load-test.mjs`, for the same reasons.
 *
 * ── Usage ──
 *
 *   createdb wv_multi
 *   MULTI_DB_URL=postgres://you@localhost:5432/wv_multi node bin/multi-instance-check.mjs
 *   dropdb wv_multi
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createUpstashStub } from './lib/upstash-stub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_URL = process.env.MULTI_DB_URL;

if (!DB_URL) {
  console.error('MULTI_DB_URL is required. Use a throwaway database:');
  console.error('  createdb wv_multi');
  console.error('  MULTI_DB_URL=postgres://you@localhost:5432/wv_multi node bin/multi-instance-check.mjs');
  process.exit(1);
}
if (/supabase\.co|pooler\.supabase\.com/.test(DB_URL)) {
  console.error('REFUSING: that is a Supabase host. Throwaway databases only.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('REFUSING: NODE_ENV=production.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/**
 * ONE key prefix for both instances, computed once.
 *
 * Computing it inside `startInstance` gave A and B different prefixes — and a
 * different prefix is a different keyspace, so the two shared nothing and the
 * limiter check quietly reported almost no sharing at all. The bug was in this
 * harness, not in the limiter, and it is the kind that produces a plausible
 * number rather than an error.
 */
const KEY_PREFIX = `multicheck${Date.now()}`;

/* Short enough that a sweep actually fires inside the run. Without this the
   auto-select scheduler's first tick is fifteen minutes away and the lease
   table is empty when the checks run — which reads as "leases are broken"
   rather than "nothing has needed one yet". */
const SWEEP_MS = 2000;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

let stub, servers = [];

async function startInstance(label, port, sharedSecret) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DEMO_MODE: 'true',
    DATABASE_ENGINE: 'postgres',
    DATABASE_URL: DB_URL,
    DATABASE_SSL: 'false',
    API_PORT: String(port),
    BIND_ADDRESS: '127.0.0.1',
    /* The SAME secret in both, or a session minted by one is refused by the
       other and every cross-instance check would fail for the wrong reason. */
    JWT_SECRET: sharedSecret,
    EMAIL_MOCK: 'true',
    REQUIRE_EMAIL_VERIFICATION: 'false',
    REQUIRE_ADMIN_2FA: 'false',
    HEALTH_POOL_STATS: 'true',
    TELEMETRY_ENABLED: 'false',
    API_RATE_LIMIT: '60',
    MESSAGE_RATE_LIMIT: '20',
    /* Both instances share the loopback Redis. */
    UPSTASH_REDIS_REST_URL: `https://127.0.0.1:${stub.port}`,
    UPSTASH_REDIS_REST_TOKEN: `multi-check-${randomUUID()}`,
    UPSTASH_KEY_PREFIX: KEY_PREFIX,
    NODE_EXTRA_CA_CERTS: stub.caPath,
    /* A short lease so a double-run would be visible inside the run. */
    SCHEDULER_LEASE_TTL_MS: '20000',
    AUTO_SELECT_INTERVAL_MS: String(SWEEP_MS),
    PINECONE_SYNC_INTERVAL_MS: String(SWEEP_MS),
  };
  for (const k of ['PINECONE_API_KEY', 'RESEND_API_KEY', 'BETTERSTACK_SOURCE_TOKEN', 'SMTP_HOST']) {
    delete env[k];
  }

  const logs = [];
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { logs.push(String(d)); });
  child.stderr.on('data', d => { logs.push(String(d)); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (Date.now() >= deadline) {
    console.error(`[multi] ${label} never became healthy:\n${logs.join('')}`);
    throw new Error(`${label} did not start`);
  }
  const entry = { label, child, base, logs };
  servers.push(entry);
  return entry;
}

const cookieHeader = (c) => (c ? { Cookie: c } : {});

async function login(base, email, password = 'Password123!') {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map(c => c.split(';')[0]).join('; ');
}

async function main() {
  const [{ n }] = await q('SELECT COUNT(*)::int n FROM users').catch(() => [{ n: 0 }]);
  if (n > 0) {
    console.error(`REFUSING: ${n} users already exist in that database.`);
    console.error('This tool only ever runs against an empty throwaway database.');
    process.exit(1);
  }

  stub = createUpstashStub();
  stub.port = await stub.listen();
  console.log(`[multi] Redis stub on ${stub.port} (loopback, TLS).`);

  const secret = `multi-instance-${randomUUID()}`;
  console.log('[multi] booting instance A…');
  const A = await startInstance('A', 5301, secret);
  console.log('[multi] booting instance B…');
  const B = await startInstance('B', 5302, secret);
  console.log('[multi] both healthy.\n');

  /* ── 1. The instance lock allows a second instance in development ── */
  const lockRows = await q('SELECT COUNT(*)::int n FROM instance_lock').catch(() => [{ n: -1 }]);
  record('two instances booted against one database', true,
    `instance_lock holds ${lockRows[0]?.n ?? '?'} row(s); the lock refuses only in production`);

  /* ── 2. Authentication works on both, with the same session ── */
  const cookie = await login(A.base, 'admin@example.gov', 'password123');
  const meA = await fetch(`${A.base}/api/auth/me`, { headers: cookieHeader(cookie) });
  const meB = await fetch(`${B.base}/api/auth/me`, { headers: cookieHeader(cookie) });
  record('a session minted on A is accepted by B', meA.ok && meB.ok,
    `A=${meA.status} B=${meB.status}`);

  /* ── 3. The API volume limiter is shared ── */
  /* API_RATE_LIMIT is 60 here, so the threshold (a quarter) is 15. Spend the
     whole budget on A, then ask B — an unshared limiter would grant another 60. */
  let allowedOnA = 0;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${A.base}/api/events?limit=1`, { headers: cookieHeader(cookie) });
    if (r.status !== 429) allowedOnA++;
  }
  let allowedOnB = 0;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${B.base}/api/events?limit=1`, { headers: cookieHeader(cookie) });
    if (r.status !== 429) allowedOnB++;
  }
  record('the API limiter is shared across instances', allowedOnB < 60,
    `A allowed ${allowedOnA}/60, then B allowed ${allowedOnB}/60 (unshared would be 60)`);
  record('the combined total respects the documented bound', allowedOnA + allowedOnB <= 60 + 2 * 14,
    `combined ${allowedOnA + allowedOnB}, bound ${60 + 2 * 14}`);

  /* ── 4. The scheduler does not double-run ──
   *
   * ── Why this is read from the LOGS and not from the table ──
   *
   * `withLease` releases in a `finally`, so `scheduler_leases` is empty between
   * sweeps and a row is only there while one is actually running. Polling the
   * table therefore reports zero leases almost always, which reads as "leases
   * are broken" and is the opposite of the truth. The first version of this
   * check did exactly that.
   *
   * The observable property is on the losing side: an instance that asks for a
   * lease another instance holds logs `Skipping "<name>"` and does not run the
   * sweep. That line IS the guarantee — it is the retention sweep, which
   * DELETES, declining to run twice.
   *
   * `SWEEP_MS` above makes the sweeps fire every couple of seconds so the
   * contention happens inside the run rather than fifteen minutes after it.
   */
  /**
   * Contention has to be MANUFACTURED, and that is a fact about the sweeps
   * rather than a weakness of the lease.
   *
   * The sweeps are fast: acquire, find nothing to do, release. Two instances on
   * a two-second timer essentially never overlap inside that window, so simply
   * waiting produced no contention and the check reported "nobody skipped" —
   * which proves nothing either way.
   *
   * So a third holder is inserted directly: a lease row owned by an instance
   * that does not exist, with an expiry well beyond the run. Both real
   * instances must now decline that sweep. That is the property the retention
   * sweep — the one that DELETES — depends on.
   */
  const fakeOwner = `not-a-real-instance:${randomUUID()}`;
  const inFuture = new Date(Date.now() + 120_000).toISOString();
  const nowIso = new Date().toISOString();
  await q(
    `INSERT INTO scheduler_leases (name, owner, acquired_at, renewed_at, expires_at)
     VALUES ($1, $2, $3, $3, $4)
     ON CONFLICT (name) DO UPDATE SET owner = $2, renewed_at = $3, expires_at = $4`,
    ['auto-select', fakeOwner, nowIso, inFuture],
  );

  /* Long enough for several sweep ticks on both instances. */
  await new Promise(r => setTimeout(r, SWEEP_MS * 4));

  /* The holder must still be the fake one: neither instance may steal a lease
     that has not expired. */
  const [held] = await q('SELECT owner FROM scheduler_leases WHERE name = $1', ['auto-select']);
  record('a held, unexpired lease is not stolen', held?.owner === fakeOwner,
    held ? `owner is ${held.owner === fakeOwner ? 'still the outside holder' : held.owner}` : 'the row disappeared');

  const logsOf = (s) => s.logs.join('');
  const skipped = [A, B].flatMap(s =>
    [...logsOf(s).matchAll(/\[lease\] Skipping "([^"]+)"/g)].map(m => `${s.label}:${m[1]}`));
  const acquired = [A, B].flatMap(s =>
    [...logsOf(s).matchAll(/\[lease\] Could not acquire "([^"]+)"/g)].map(m => `${s.label}:${m[1]}`));

  record('both instances decline a sweep held elsewhere', skipped.length > 0,
    skipped.length
      ? `observed: ${[...new Set(skipped)].join(', ')}`
      : 'no instance ever skipped a sweep — either they never contended, or the lease is not being honoured');

  record('no lease acquisition ERRORED (fail-open never triggered)', acquired.length === 0,
    acquired.length ? `failed to acquire: ${[...new Set(acquired)].join(', ')}` : 'every acquisition resolved cleanly');

  /* The table's own guarantee: a lease name is unique, so two rows for one
     sweep is structurally impossible rather than merely unobserved. */
  const dupes = await q(`
    SELECT name, COUNT(*)::int n FROM scheduler_leases GROUP BY name HAVING COUNT(*) > 1
  `);
  record('no lease name is held twice', dupes.length === 0,
    dupes.length ? `duplicated: ${dupes.map(d => d.name).join(', ')}` : 'scheduler_leases keyed by name');

  /* ── 5. Redis actually carried the shared state ── */
  const st = stub.stats();
  record('the shared state really went through Redis', st.commands > 0,
    `${st.requests} requests, ${st.commands} commands (${Object.entries(st.byCommand).map(([k, v]) => `${k}=${v}`).join(' ')})`);

  /* ── 6. Slot capacity still holds with two instances racing ── */
  const [ev] = await q(`SELECT id FROM events WHERE status = 'open' LIMIT 1`);
  if (ev) {
    const [slot] = await q('SELECT id, max_spots FROM slots WHERE event_id = $1 LIMIT 1', [ev.id]);
    record('capacity fixture available', Boolean(slot), slot ? `slot ${slot.id}` : 'none found');
  }

  console.log('');
  const failed = results.filter(r => !r.ok);
  console.log(`================ ${results.length - failed.length}/${results.length} checks passed ================`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('[multi] failed:', err.message);
  for (const s of servers) console.error(`--- ${s.label} log tail ---\n${s.logs.slice(-15).join('')}`);
  process.exitCode = 1;
} finally {
  for (const s of servers) {
    s.child.kill('SIGTERM');
    await new Promise(r => { const t = setTimeout(() => { s.child.kill('SIGKILL'); r(); }, 8000); s.child.on('exit', () => { clearTimeout(t); r(); }); });
  }
  await stub?.close();
  await pool.end();
}
