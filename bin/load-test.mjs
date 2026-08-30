#!/usr/bin/env node
/**
 * HTTP load test for WeVolunteer.
 *
 * ── Why this exists, next to bin/scale-probe.mjs ──
 *
 * `scale-probe.mjs` measures SQL. It opens a pool, runs the queries the
 * application would run, and reports p95 with the plan behind it. Everything it
 * says is true and none of it involves Express, JWT verification, bcrypt,
 * capability checks, serialisation, compression, the rate limiters, or two
 * requests happening at once. Those are most of what a request actually costs,
 * and until this file nothing in the repository measured them.
 *
 * The two are complements: a regression here with no matching regression in
 * scale-probe is in the application layer, and that is a useful thing to be able
 * to tell.
 *
 * ── What it does ──
 *
 * Boots the REAL server as a child process against a throwaway PostgreSQL
 * database, seeds a synthetic corpus, signs in a pool of users, and drives six
 * scenarios with `autocannon`. Scenario F is not autocannon: it fires simultaneous
 * writes at ONE slot and then checks the database for an oversell, which is a
 * correctness assertion rather than a throughput measurement.
 *
 * ── Safety ──
 *
 * Refuses any Supabase host. Refuses a database that already holds people.
 * Refuses `NODE_ENV=production`. It CREATES tables and INSERTS tens of thousands
 * of rows; pointing it at something real would be a very bad day. The child
 * server runs with mail in mock mode and no third-party keys, so nothing leaves
 * the machine.
 *
 * ── Usage ──
 *
 *   createdb wv_load
 *   LOAD_DB_URL=postgres://you@localhost:5432/wv_load node bin/load-test.mjs
 *   dropdb wv_load
 *
 * Options:
 *   --users N        synthetic users        (default 2000)
 *   --events N       synthetic events       (default 1000)
 *   --duration N     seconds per scenario   (default 5)
 *   --connections N  concurrent connections (default 20)
 *   --only A,C,F     run a subset of scenarios
 *   --json PATH      write the raw results
 *   --label TEXT     a name for this run, printed and stored in the JSON
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import autocannon from 'autocannon';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ────────────────────────────────────────────────────────────────────────────
 * Arguments and safety
 * ──────────────────────────────────────────────────────────────────────────── */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const DB_URL = process.env.LOAD_DB_URL;
const USERS = Number(arg('users', 2000));
const EVENTS = Number(arg('events', 1000));
const DURATION = Number(arg('duration', 5));
const CONNECTIONS = Number(arg('connections', 20));
const ONLY = arg('only', null)?.split(',').map(s => s.trim().toUpperCase());
const JSON_OUT = arg('json', null);
const LABEL = arg('label', 'unlabelled');
/**
 * The blanket API limiter's ceiling for the run.
 *
 * Raised by default, deliberately. `apiLimiter` is 600 per fifteen minutes in
 * production and 10,000 under DEMO_MODE; a scenario driving thousands of
 * requests a second passes either in seconds and then measures nothing but 429s
 * — "3,061 req/s at p50 0 ms", which is what the first run of this harness
 * proudly reported.
 *
 * Set `--api-limit 600` to measure the limiter ITSELF rather than the
 * application behind it. That is a legitimate and different question: how long a
 * shared address survives before the ceiling bites.
 */
const API_LIMIT = Number(arg('api-limit', 1_000_000));
/**
 * Milliseconds of artificial round-trip latency between the app and PostgreSQL.
 *
 * ── Why this option exists ──
 *
 * Loopback PostgreSQL answers in about a tenth of a millisecond, so a handler
 * that issues fourteen queries in series looks almost identical to one that
 * issues five. Production is not loopback: the database is a managed provider
 * reached over the network, and there a round trip is milliseconds. Measuring
 * round-trip reduction on loopback and reporting it as an improvement would be
 * measuring the wrong machine.
 *
 * With `--db-latency 5`, every statement costs 5 ms more than it did, which is a
 * plausible figure for an application and a database in the same region. The
 * difference between the two runs is then the round-trip count, which is the
 * thing being changed.
 *
 * Zero (the default) means the app talks to PostgreSQL directly.
 */
const DB_LATENCY_MS = Number(arg('db-latency', 0));

if (!DB_URL) {
  console.error('LOAD_DB_URL is required. Use a throwaway database:');
  console.error('  createdb wv_load');
  console.error('  LOAD_DB_URL=postgres://you@localhost:5432/wv_load node bin/load-test.mjs');
  process.exit(1);
}
if (/supabase\.co/.test(DB_URL)) {
  console.error('REFUSING: that is a Supabase host. This tool writes tens of thousands of');
  console.error('synthetic rows and drives sustained write load. Throwaway databases only.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('REFUSING: NODE_ENV=production.');
  process.exit(1);
}

/**
 * The demo password, which is the seeded accounts' password and is published in
 * the README. Not a secret, and deliberately not read from the environment: a
 * load test that could be pointed at real credentials is a load test that will
 * be, once.
 */
const DEMO_PASSWORD = 'password123';

const pool = new pg.Pool({ connectionString: DB_URL, max: 8 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/* ────────────────────────────────────────────────────────────────────────────
 * The child server
 * ──────────────────────────────────────────────────────────────────────────── */

let child = null;
let BASE = null;
let latencyProxy = null;

/**
 * A TCP proxy that delays every byte in both directions.
 *
 * Deliberately dumb: it does not parse the PostgreSQL protocol, it just holds
 * each chunk for half the configured latency before passing it on, so a
 * request/response pair costs the full amount. That is exactly the shape of
 * network latency and it needs no privileges, unlike the kernel traffic-shaping
 * tools that would otherwise be required.
 *
 * Only the APPLICATION goes through it. Seeding and the verification queries use
 * the direct connection, because slowing down a bulk insert of half a million
 * rows measures nothing and takes all afternoon.
 */
async function startLatencyProxy(target, delayMs) {
  const { hostname, port } = new global.URL(target);
  const half = delayMs / 2;

  const server = net.createServer((client) => {
    const upstream = net.connect({
      host: hostname || '127.0.0.1',
      port: Number(port) || 5432,
    });
    const pipeDelayed = (from, to) => {
      from.on('data', (chunk) => {
        setTimeout(() => { if (!to.destroyed) to.write(chunk); }, half);
      });
      from.on('close', () => setTimeout(() => to.destroy(), half + 50));
      from.on('error', () => to.destroy());
    };
    pipeDelayed(client, upstream);
    pipeDelayed(upstream, client);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  latencyProxy = server;

  const proxied = new global.URL(target);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(server.address().port);
  console.log(`[load] injecting ${delayMs}ms of database round-trip latency`);
  return proxied.toString();
}

/**
 * Boots the real `server/server.js`, not an in-process Express app.
 *
 * In-process would be easier and would measure the wrong thing: the workers, the
 * schedulers, the instance lock and the socket server all start in `server.js`,
 * and their contribution to latency under load is part of what is being
 * measured. A child process also means the load generator's own CPU use does not
 * compete with the server's inside one event loop, which would flatter the
 * server on a throughput test and is the classic way to publish a wrong number.
 */
async function startServer(port, databaseUrl) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DEMO_MODE: 'true',
    DATABASE_ENGINE: 'postgres',
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: 'false',
    API_PORT: String(port),
    BIND_ADDRESS: '127.0.0.1',
    JWT_SECRET: `load-test-${randomUUID()}`,
    /* Mail stays mocked and no third-party key is passed through, so a load run
       cannot send a message or spend a metered allowance. */
    EMAIL_MOCK: 'true',
    REQUIRE_EMAIL_VERIFICATION: 'false',
    REQUIRE_ADMIN_2FA: 'false',
    /* The pool numbers are the point of the exercise. */
    HEALTH_POOL_STATS: 'true',
    API_RATE_LIMIT: String(API_LIMIT),
    /* Sweeps and workers stay ON — they are part of the load. The search
       indexer is a no-op without Pinecone credentials, which is correct: this
       must not call a vendor. */
    TELEMETRY_ENABLED: 'false',
  };
  /* Explicitly removed rather than left to chance: an ambient key in the
     developer's shell must not be inherited into a load run. */
  for (const k of ['PINECONE_API_KEY', 'RESEND_API_KEY', 'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN', 'BETTERSTACK_SOURCE_TOKEN', 'SMTP_HOST']) {
    delete env[k];
  }

  child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n[load] server exited with code ${code}:\n${logs.slice(-40).join('')}`);
    }
  });

  BASE = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  console.error(`[load] server did not become healthy:\n${logs.join('')}`);
  throw new Error('server never became healthy');
}

async function stopServer() {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
    child.on('exit', () => { clearTimeout(t); resolve(); });
  });
  child = null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Seeding
 * ──────────────────────────────────────────────────────────────────────────── */

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString();

async function refuseNonEmpty() {
  const [{ exists }] = await q("SELECT to_regclass('public.users') IS NOT NULL AS exists");
  if (!exists) return;
  const [{ c }] = await q("SELECT COUNT(*)::int c FROM users WHERE id <> 'system-cli'");
  if (c > 0) {
    console.error(`REFUSING: ${c} users already exist in that database.`);
    console.error('This tool only ever runs against an empty throwaway database.');
    process.exit(1);
  }
}

/**
 * Bulk synthetic corpus, on top of the demo seed the server writes at boot.
 *
 * Every synthetic account reuses ONE bcrypt hash — the demo accounts' — so the
 * users are genuinely signable-in without paying to hash two thousand passwords
 * during setup. The cost of *verifying* a password is unchanged, and scenario B
 * exists to measure exactly that.
 */
async function seed() {
  console.log(`[load] seeding ${USERS} users / ${EVENTS} events…`);
  const [{ password_hash: hash }] = await q(
    "SELECT password_hash FROM users WHERE id = 'user-student-1'"
  );
  const ORGS = Math.max(1, Math.floor(EVENTS / 20));

  await q(`
    INSERT INTO users (id, name, email, password_hash, grade, role, verified, email_verified,
                       account_status, created_at, token_version, username, school)
    SELECT 'lu-'||g, 'Load User '||g, 'load'||g||'@load.invalid', $1,
           (ARRAY['9','10','11','12','Adult'])[1 + (g % 5)],
           CASE WHEN g % 50 = 0 THEN 'organizer' ELSE 'student' END,
           1, 1, 'active', $2, 1, 'loaduser'||g, 'School '||(g % 12)
    FROM generate_series(1, $3) g ON CONFLICT DO NOTHING
  `, [hash, iso(-100), USERS]);

  await q(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at, created_by)
    SELECT 'lorg-'||g, 'Load Org '||g, 'load-org-'||g, $1, $1, 'lu-50'
    FROM generate_series(1, $2) g ON CONFLICT DO NOTHING
  `, [iso(-90), ORGS]);

  await q(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, organization_id, status, created_at)
    SELECT 'le-'||g, 'Load Event '||g, 'Description for load event '||g,
           (ARRAY['School','5K','Food Pantry','Fundraiser','Other'])[1 + (g % 5)],
           'Location '||(g % 40), $1,
           'lu-'||(50 * (1 + (g % GREATEST(1, $3 / 50)))),
           'lorg-'||(1 + (g % $4)), 'open', $2
    FROM generate_series(1, $5) g ON CONFLICT DO NOTHING
  `, [iso(10), iso(-60), USERS, ORGS, EVENTS]);

  await q(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    SELECT 'ls-'||g||'-'||n, 'le-'||g, 'Shift '||n, 'Shift '||n||' description', $1, $2, 10
    FROM generate_series(1, $3) g, generate_series(1, 2) n ON CONFLICT DO NOTHING
  `, [iso(14), iso(14), EVENTS]);

  await q(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    SELECT 'la-'||g||'-'||n,
           'lu-'||(1 + ((g * 7 + n * 13) % GREATEST(1, $1))),
           'le-'||g, 'ls-'||g||'-'||(1 + (n % 2)),
           (ARRAY['pending','accepted','rejected','waitlisted'])[1 + (n % 4)], $2
    FROM generate_series(1, $3) g, generate_series(1, 8) n ON CONFLICT DO NOTHING
  `, [USERS, iso(-30), EVENTS]);

  await q(`
    INSERT INTO notifications (id, user_id, kind, title, body, read, created_at)
    SELECT 'ln-'||g||'-'||n, 'lu-'||g, 'generic', 'Title '||g, 'Message '||g, (n % 2), $2
    FROM generate_series(1, $1) g, generate_series(1, 3) n ON CONFLICT DO NOTHING
  `, [USERS, iso(-10)]);

  /**
   * Credited attendance, and this is not optional decoration.
   *
   * `GET /api/applications` used to load the WHOLE of `attendance` into a `Map`
   * on every call, twice. A corpus with no attendance rows makes that read free,
   * so a load test without this seeds exactly the condition under which the
   * defect is invisible — the first run of this harness did, and reported the
   * before and after as identical.
   *
   * One row per accepted application, on the ~quarter of them that are accepted.
   */
  await q(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    SELECT a.event_id, a.slot_id, a.user_id, 1, 2.0
    FROM applications a
    WHERE a.status = 'accepted'
    ON CONFLICT DO NOTHING
  `);

  /**
   * A moderation backlog, for the same reason.
   *
   * The appeals queue answered "may this reviewer decide this?" with six
   * statements per appeal. An empty queue costs nothing however it is written,
   * so the N+1 is unmeasurable without a backlog to measure it against.
   *
   * Suspended accounts, because that is what an appeal is about, and the
   * conflict rules read `users.suspended_by`.
   */
  /**
   * Suspended accounts are taken from HIGH ids, well clear of the session pool.
   *
   * `lu-1`..`lu-40` are the accounts the scenarios sign in as, and `lu-50` is
   * the organizer. A suspended account cannot authenticate at all, so suspending
   * from the bottom of the range — which the first version of this did — logs
   * the load test out of its own fixtures.
   */
  const SUSPEND_FROM = 501;
  const APPEALS = Math.max(0, Math.min(120, USERS - SUSPEND_FROM));
  if (APPEALS > 0) {
    await q(`
      UPDATE users SET account_status = 'suspended', suspended_by = 'user-admin',
                       suspension_reason = 'Synthetic load fixture', suspended_at = $1
      WHERE id IN (SELECT 'lu-'||g FROM generate_series($2::int, $3::int) g)
    `, [iso(-5), SUSPEND_FROM, SUSPEND_FROM + APPEALS - 1]);

    await q(`
      INSERT INTO appeals (id, user_id, status, subject, statement, created_at, updated_at,
                           suspended_by_snapshot, suspension_reason_snapshot, suspended_at_snapshot)
      SELECT 'lap-'||g, 'lu-'||g, 'open', 'suspension',
             'I would like this decision looked at again, please.', $1, $1,
             'user-admin', 'Synthetic load fixture', $2
      FROM generate_series($3::int, $4::int) g ON CONFLICT DO NOTHING
    `, [iso(-4), iso(-5), SUSPEND_FROM, SUSPEND_FROM + APPEALS - 1]);
  } else {
    console.log('  (corpus too small for an appeals backlog — scenario E3 will measure an empty queue)');
  }

  /**
   * One student with a long service history.
   *
   * The bulk corpus spreads applications evenly, so every synthetic volunteer
   * has a handful of completed events and a per-row lookup over them costs
   * nothing. A real four-year volunteer has dozens, and `GET /api/certificates`
   * does a get-or-create per event — so the shape only becomes visible against
   * somebody who has actually been volunteering. `lu-1` is that person.
   */
  await q(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    SELECT 'lah-'||g, 'lu-1', 'le-'||g, 'ls-'||g||'-1', 'accepted', $1
    FROM generate_series(1, LEAST($2::int, 80)) g
    ON CONFLICT DO NOTHING
  `, [iso(-40), EVENTS]);

  await q(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    SELECT a.event_id, a.slot_id, a.user_id, 1, 3.0
    FROM applications a WHERE a.user_id = 'lu-1' AND a.status = 'accepted'
    ON CONFLICT DO NOTHING
  `);

  await q('ANALYZE');

  const counts = {};
  for (const t of ['users', 'events', 'slots', 'applications', 'notifications',
    'organizations', 'attendance', 'appeals']) {
    const [{ c }] = await q(`SELECT COUNT(*)::int c FROM ${t}`);
    counts[t] = c;
    console.log(`  ${t.padEnd(15)} ${c}`);
  }
  return counts;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Sessions
 * ──────────────────────────────────────────────────────────────────────────── */

/** Signs in and returns the session cookie value. */
async function login(identifier, password = DEMO_PASSWORD) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: identifier, password }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map(c => c.match(/wev_session=([^;]+)/)?.[1]).find(Boolean);
  if (!cookie) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return cookie;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Measurement
 * ──────────────────────────────────────────────────────────────────────────── */

const results = [];

const cookieHeader = (cookie) => ({ Cookie: `wev_session=${cookie}` });

/**
 * Issues each of a scenario's requests ONCE and reports the status.
 *
 * ── Why a load test needs this ──
 *
 * The first run of this harness reported 3,061 req/s at a p50 of 0 ms, which
 * looked wonderful and measured nothing: every response was a refusal. A load
 * generator is very good at going fast when the server is saying no, and
 * "beautiful latency, all of it 401" is the single most common way to publish a
 * meaningless benchmark.
 *
 * So every scenario is proved reachable before it is measured. A preflight
 * failure aborts the scenario rather than producing a number, because a number
 * produced here would be believed.
 */
async function preflight(id, requests, headers) {
  const bad = [];
  for (const r of requests) {
    const res = await fetch(BASE + r.path, {
      method: r.method ?? 'GET',
      headers: { ...(headers ?? {}), ...(r.headers ?? {}) },
      body: r.body,
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
      bad.push(`${r.method ?? 'GET'} ${r.path} -> ${res.status} ${detail}`);
    }
  }
  if (bad.length) {
    console.log(`      PREFLIGHT FAILED — not measuring a scenario that does not work:`);
    for (const b of bad) console.log(`        ${b}`);
    results.push({ id, name: 'preflight failed', preflightFailures: bad, healthy: false });
    return false;
  }
  return true;
}

/**
 * Runs one autocannon scenario and records it.
 *
 * Every scenario is preflighted first (above), and the status-class buckets are
 * carried into the record so a run that degrades into 429s halfway through is
 * visible in the output rather than hidden inside a good-looking average.
 */
async function scenario(id, name, opts) {
  if (ONLY && !ONLY.includes(id)) return null;
  process.stdout.write(`\n[${id}] ${name}\n`);

  const headers = opts.headers ?? {};
  if (!await preflight(id, opts.requests, headers)) return null;

  const run = await autocannon({
    url: BASE,
    connections: opts.connections ?? CONNECTIONS,
    duration: opts.duration ?? DURATION,
    headers,
    requests: opts.requests,
  });

  const total = run.requests.total || 0;
  const nonOk = (run.non2xx || 0) + (run.errors || 0) + (run.timeouts || 0);
  const record = {
    id,
    name,
    rps: Number(run.requests.average.toFixed(1)),
    p50: run.latency.p50,
    p95: run.latency.p97_5,          // autocannon reports 97.5, not 95
    p99: run.latency.p99,
    max: run.latency.max,
    total,
    statusClasses: {
      '1xx': run['1xx'] || 0, '2xx': run['2xx'] || 0, '3xx': run['3xx'] || 0,
      '4xx': run['4xx'] || 0, '5xx': run['5xx'] || 0,
    },
    non2xx: run.non2xx || 0,
    errors: run.errors || 0,
    timeouts: run.timeouts || 0,
    bytesPerSec: Math.round(run.throughput.average),
    healthy: total > 0 && nonOk / Math.max(1, total) < 0.01,
  };
  results.push(record);

  console.log(
    `      ${record.rps} req/s   p50=${record.p50}ms  p97.5=${record.p95}ms  p99=${record.p99}ms`
    + `   2xx=${record.statusClasses['2xx']} 4xx=${record.statusClasses['4xx']} 5xx=${record.statusClasses['5xx']}`
    + (record.healthy ? '' : '   ** UNHEALTHY — the latency below is not a real measurement **')
  );
  return record;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Scenario F — concurrency, which is a correctness test rather than a benchmark
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Fires N simultaneous applications at ONE slot with capacity 1, then asks the
 * database how many were accepted.
 *
 * This is the property `application.postgresConcurrency.test.js` proves in
 * process. What it does not prove is that the property survives the whole HTTP
 * stack under real concurrency — connection pooling, the async context that
 * binds a transaction to one client, and Express's own scheduling all sit
 * between the request and the `SELECT … FOR UPDATE`.
 *
 * An oversell here is a defect, not a slow number, so it is reported separately
 * from the latency table and fails the run.
 */
async function concurrencyScenario(cookies) {
  if (ONLY && !ONLY.includes('F')) return null;
  console.log('\n[F] concurrency — simultaneous applications to one capacity-1 slot');

  const eventId = 'load-race-event';
  const slotId = 'load-race-slot';
  /**
   * The DEMO organizer, not a synthetic one.
   *
   * The first version of this scenario used `lu-50`, a bulk-seeded account with
   * `role = 'organizer'`. Every accept came back 403 and the run cheerfully
   * reported "capacity held" — because nothing had been accepted at all, so the
   * race was never run. An organizer's event-management capabilities are
   * WITHHELD until they accept the Organizer Agreement
   * (`server/organizerAgreement.js`), and a row inserted straight into `users`
   * has accepted nothing.
   *
   * `user-org-1` is seeded by DEMO_MODE with its acceptance in place, so it can
   * actually decide applications. Forging an acceptance for a synthetic account
   * would work too and would be worse: it would make this harness depend on the
   * internals of a consent record whose whole purpose is to be hard to forge.
   */
  const organizer = 'user-org-1';

  await q('DELETE FROM applications WHERE slot_id = $1', [slotId]);
  await q('DELETE FROM slots WHERE id = $1', [slotId]);
  await q('DELETE FROM events WHERE id = $1', [eventId]);
  await q(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, status, created_at, auto_approve)
    VALUES ($1, 'Race Event', 'One seat, many hands', 'Other', 'Hall', $2, $3, 'open', $4, 0)
  `, [eventId, iso(10), organizer, iso(-1)]);
  await q(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES ($1, $2, 'The only shift', 'One seat', $3, $4, 1)
  `, [slotId, eventId, iso(14), iso(14)]);

  /* Applicants come from the session pool, which is signed in BEFORE the
     suspension fixture runs — so they are re-checked here rather than assumed.
     A suspended account cannot authenticate and its apply would 403, which would
     silently shrink the race instead of failing it. */
  const applicants = cookies.slice(0, Math.min(40, cookies.length));
  const applied = await Promise.all(applicants.map(async ({ cookie }) => {
    const res = await fetch(`${BASE}/api/events/${eventId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(cookie) },
      body: JSON.stringify({ slotId }),
    });
    return res.status;
  }));

  const pending = await q(
    "SELECT id FROM applications WHERE slot_id = $1 AND status = 'pending'", [slotId]
  );

  /* Accepting them all at once is where the oversell used to happen: three
     concurrent bulk accepts put six volunteers into a two-spot slot and returned
     200 to all three. Every id is offered to every caller, so the only thing
     stopping an oversell is the row lock inside the transaction. */
  const organizerCookie = await login('jordan.whitfield@example.org');
  const acceptStatuses = await Promise.all(pending.map(async (row) => {
    const res = await fetch(`${BASE}/api/applications/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(organizerCookie) },
      body: JSON.stringify({ status: 'accepted' }),
    });
    return res.status;
  }));

  const [{ c: accepted }] = await q(
    "SELECT COUNT(*)::int c FROM applications WHERE slot_id = $1 AND status = 'accepted'", [slotId]
  );

  const record = {
    id: 'F',
    name: 'concurrency — one capacity-1 slot',
    applicants: applicants.length,
    applicationsCreated: pending.length,
    concurrentAcceptCalls: acceptStatuses.length,
    accepted,
    capacity: 1,
    oversold: accepted > 1,
    applyStatuses: tally(applied),
    acceptStatuses: tally(acceptStatuses),
  };
  results.push(record);

  console.log(`      ${applicants.length} applicants -> ${pending.length} applications`);
  console.log(`      ${acceptStatuses.length} concurrent accepts -> ${accepted} accepted (capacity 1)`);
  console.log(`      apply: ${JSON.stringify(record.applyStatuses)}  accept: ${JSON.stringify(record.acceptStatuses)}`);
  if (record.oversold) {
    console.log('      ** OVERSOLD — the capacity guard did not hold under HTTP concurrency **');
  } else if (accepted === 0) {
    /* Zero accepted is NOT a pass. It means every accept was refused, so the
       race was never run — and reporting that as "capacity held" is how a
       concurrency test comes to prove nothing while looking green. */
    console.log('      ** INCONCLUSIVE — nothing was accepted, so no race took place **');
    record.inconclusive = true;
  } else {
    console.log(`      capacity held (${accepted} of ${acceptStatuses.length} accepts succeeded)`);
  }
  return record;
}

const tally = (arr) => arr.reduce((acc, s) => ({ ...acc, [s]: (acc[s] || 0) + 1 }), {});

/**
 * How long a broadcast to every confirmed volunteer takes.
 *
 * ── Why this is timed once rather than driven by autocannon ──
 *
 * Cancelling an event is a one-shot state change: the second request finds an
 * event that is already cancelled and does no work at all, so a throughput
 * number would average one real broadcast with hundreds of no-ops and report
 * something meaningless.
 *
 * ── What it is looking for ──
 *
 * The fan-out is a loop of `notificationService.dispatch` calls, and each
 * dispatch writes two rows: the in-app notification and the outbox job. So a
 * broadcast to N volunteers is 2N statements inside one HTTP request, and the
 * cost is linear in how popular the event was. The SENDING is already
 * asynchronous — the outbox worker does that — so what is measured here is only
 * the enqueueing.
 *
 * This is deliberately a measurement rather than a change. Batching those
 * inserts would touch the notification dedupe key and the outbox contract, both
 * of which are load-bearing, and the number below is what decides whether that
 * risk is worth taking.
 */
async function fanOutScenario() {
  if (ONLY && !ONLY.includes('G')) return null;
  console.log('\n[G] notification fan-out — cancelling an event with many confirmed volunteers');

  const eventId = 'load-fanout-event';
  const slotId = 'load-fanout-slot';
  const RECIPIENTS = 150;

  await q('DELETE FROM applications WHERE slot_id = $1', [slotId]);
  await q('DELETE FROM slots WHERE id = $1', [slotId]);
  await q('DELETE FROM events WHERE id = $1', [eventId]);
  await q(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, status, created_at, auto_approve)
    VALUES ($1, 'Fan-out Event', 'Many volunteers, one cancellation', 'Other', 'Hall',
            $2, 'user-org-1', 'open', $3, 0)
  `, [eventId, iso(10), iso(-1)]);
  await q(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES ($1, $2, 'Shift', 'Room for everybody', $3, $4, $5)
  `, [slotId, eventId, iso(14), iso(14), RECIPIENTS + 10]);

  /* Accepted directly in SQL: driving 150 applications through the API would
     measure the apply path, which scenario C already covers. */
  await q(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    SELECT 'lfo-'||g, 'lu-'||g, $1, $2, 'accepted', $3
    FROM generate_series(101::int, (100 + $4)::int) g
    ON CONFLICT DO NOTHING
  `, [eventId, slotId, iso(-2), RECIPIENTS]);

  const [{ c: confirmed }] = await q(
    "SELECT COUNT(*)::int c FROM applications WHERE slot_id = $1 AND status = 'accepted'", [slotId]
  );

  const organizerCookie = await login('jordan.whitfield@example.org');

  /* Counted as a DELTA rather than by kind. The in-app row's `kind` is mapped
     from the event name by `getInAppContent`, so filtering on the event name
     finds nothing and reports a broadcast that happened as one that did not —
     which is exactly the false negative the preflight elsewhere exists to
     prevent. */
  const [{ c: before }] = await q('SELECT COUNT(*)::int c FROM notifications');
  const [{ c: jobsBefore }] = await q('SELECT COUNT(*)::int c FROM notification_jobs');

  const started = process.hrtime.bigint();
  const res = await fetch(`${BASE}/api/events/${eventId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...cookieHeader(organizerCookie) },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  const [{ c: after }] = await q('SELECT COUNT(*)::int c FROM notifications');
  const [{ c: jobsAfter }] = await q('SELECT COUNT(*)::int c FROM notification_jobs');
  const notifications = after - before;
  const jobs = jobsAfter - jobsBefore;

  const record = {
    id: 'G',
    name: 'notification fan-out on cancellation',
    confirmedVolunteers: confirmed,
    status: res.status,
    elapsedMs: Math.round(ms),
    perRecipientMs: confirmed ? Number((ms / confirmed).toFixed(2)) : null,
    notificationsWritten: notifications,
    outboxJobsWritten: jobs,
    /* A broadcast that wrote nothing is a measurement of nothing. */
    inconclusive: notifications === 0,
  };
  results.push(record);

  console.log(`      ${confirmed} confirmed volunteers -> HTTP ${res.status} in ${record.elapsedMs}ms`);
  console.log(`      ${record.perRecipientMs}ms per recipient; `
    + `${notifications} in-app rows and ${jobs} outbox jobs written`);
  if (record.inconclusive) {
    console.log('      ** INCONCLUSIVE — no notifications were written, so nothing was measured **');
  }
  return record;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────────────────── */

async function main() {
  await refuseNonEmpty();

  const port = 5100 + Math.floor(Math.random() * 300);
  const appDbUrl = DB_LATENCY_MS > 0
    ? await startLatencyProxy(DB_URL, DB_LATENCY_MS)
    : DB_URL;
  console.log(`[load] booting the server on ${port} against ${redact(DB_URL)}…`);
  await startServer(port, appDbUrl);
  console.log('[load] healthy.');

  const counts = await seed();

  /* A pool of sessions, so the authenticated scenarios are not one user's
     cache-warm path measured twenty times. */
  console.log('[load] signing in a pool of users…');
  const cookies = [];
  for (let i = 1; i <= 40; i++) {
    cookies.push({ id: `lu-${i}`, cookie: await login(`load${i}@load.invalid`) });
  }
  const student = cookies[0].cookie;
  const organizerCookie = await login('load50@load.invalid');
  const adminCookie = await login('admin@example.gov');

  await scenario('A', 'public browse — events list, search, detail', {
    headers: cookieHeader(student),
    requests: [
      { method: 'GET', path: '/api/events?limit=50' },
      { method: 'GET', path: '/api/events?limit=20&search=food' },
      { method: 'GET', path: '/api/events?limit=20&sort=soonest' },
    ],
  });

  await scenario('B', 'authentication — sign in and fetch profile', {
    /* Deliberately fewer connections. bcrypt is CPU-bound BY DESIGN, so a
       sign-in flood saturates the event loop rather than the database, and
       driving it at full concurrency measures the cost function, not the app. */
    connections: 8,
    headers: cookieHeader(student),
    requests: [
      {
        method: 'POST',
        path: '/api/auth/login',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'load1@load.invalid', password: DEMO_PASSWORD }),
      },
      { method: 'GET', path: '/api/auth/me' },
    ],
  });

  await scenario('C', 'student activity — browse, applications, notifications, profile', {
    headers: cookieHeader(student),
    requests: [
      { method: 'GET', path: '/api/events?limit=20' },
      { method: 'GET', path: '/api/applications' },
      { method: 'GET', path: '/api/notifications?limit=20' },
      { method: 'GET', path: '/api/auth/me' },
    ],
  });

  /**
   * The same endpoint, paginated.
   *
   * Run beside C rather than instead of it, because the interesting number is
   * the DIFFERENCE: `GET /api/applications` with no `limit` is the legacy shape
   * every current client uses, and this pass gave it a cap and page-scoped batch
   * loads. Measuring only the paginated form would hide whether the legacy path
   * actually improved.
   */
  await scenario('C2', 'student activity — applications, paginated', {
    headers: cookieHeader(student),
    requests: [{ method: 'GET', path: '/api/applications?limit=20' }],
  });

  await scenario('C3', 'student activity — applications, legacy unpaginated', {
    headers: cookieHeader(student),
    requests: [{ method: 'GET', path: '/api/applications' }],
  });

  await scenario('C4', 'student — certificates for a long service history', {
    headers: cookieHeader(student),
    requests: [{ method: 'GET', path: '/api/certificates' }],
  });

  await scenario('D', 'organizer activity — review applications and rosters', {
    headers: cookieHeader(organizerCookie),
    requests: [
      { method: 'GET', path: '/api/applications?limit=50' },
      { method: 'GET', path: '/api/events?limit=20' },
      { method: 'GET', path: '/api/notifications?limit=20' },
    ],
  });

  await scenario('E', 'admin — dashboard, users, moderation queue', {
    /* Admins are few by construction, so this measures the endpoints' cost
       rather than a crowd. */
    connections: 4,
    headers: cookieHeader(adminCookie),
    requests: [
      { method: 'GET', path: '/api/admin/stats' },
      /* The moderation queue and the report queue — the two lists the demo
         administrator actually holds capabilities for.
         `/api/admin/users` does not exist (the first version of this scenario
         asked for it and measured 404s) and `/api/admin/audit-logs` needs
         `audit.read`, which this account does not hold (403). The preflight
         caught both rather than letting them be published as latency. */
      { method: 'GET', path: '/api/admin/reports' },
      { method: 'GET', path: '/api/admin/appeals' },
    ],
  });

  await scenario('E2', 'admin — stats alone (the consolidated aggregate)', {
    connections: 4,
    headers: cookieHeader(adminCookie),
    requests: [{ method: 'GET', path: '/api/admin/stats' }],
  });

  await scenario('E3', 'admin — appeals queue alone (the batched conflict check)', {
    connections: 4,
    headers: cookieHeader(adminCookie),
    requests: [{ method: 'GET', path: '/api/admin/appeals' }],
  });

  await concurrencyScenario(cookies);
  await fanOutScenario();

  /* Pool saturation, read after the load rather than during it: `waiting` is
     cumulative pressure and a reading taken while idle is the honest "did it
     recover" answer. */
  let pool = null;
  try {
    pool = (await (await fetch(`${BASE}/health`)).json()).pool ?? null;
  } catch { /* the summary survives without it */ }

  summarise({ counts, pool });
}

function redact(url) {
  try {
    const u = new global.URL(url);
    return `${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, '')}`;
  } catch { return '(unparseable url)'; }
}

function summarise({ counts, pool }) {
  console.log('\n================ SUMMARY ================');
  console.log(`label=${LABEL}  users=${counts.users}  events=${counts.events}  `
    + `applications=${counts.applications}  connections=${CONNECTIONS}  duration=${DURATION}s  `
    + `apiLimit=${API_LIMIT}  dbLatency=${DB_LATENCY_MS}ms`);
  console.log('');
  console.log('  id   req/s      p50      p97.5      p99   non-2xx  scenario');
  for (const r of results) {
    if (r.id === 'F' || r.id === 'G') continue;
    console.log(
      `  ${r.id.padEnd(3)} ${String(r.rps).padStart(7)} `
      + `${String(r.p50).padStart(8)}ms ${String(r.p95).padStart(8)}ms ${String(r.p99).padStart(7)}ms `
      + `${String(r.non2xx).padStart(8)}  ${r.name}`
    );
  }

  const fan = results.find(r => r.id === 'G');
  if (fan) {
    console.log('');
    console.log(`  G   fan-out to ${fan.confirmedVolunteers} volunteers: ${fan.elapsedMs}ms `
      + `(${fan.perRecipientMs}ms each, ${fan.notificationsWritten} rows)`
      + (fan.inconclusive ? '  — INCONCLUSIVE, nothing was written' : ''));
  }

  const race = results.find(r => r.id === 'F');
  if (race) {
    console.log('');
    const verdict = race.oversold ? 'OVERSOLD'
      : race.inconclusive ? 'INCONCLUSIVE — nothing was accepted' : 'held';
    console.log(`  F   capacity ${race.capacity}, accepted ${race.accepted} — ${verdict}`);
  }
  if (pool) {
    console.log('');
    console.log(`  pool after the run: total=${pool.total} idle=${pool.idle} waiting=${pool.waiting}`);
  }

  const unhealthy = results.filter(r => r.healthy === false);
  if (unhealthy.length) {
    console.log('');
    console.log('  WARNING: these scenarios returned mostly non-2xx responses, so their');
    console.log('  latency figures measure refusals rather than work:');
    for (const r of unhealthy) console.log(`    ${r.id} ${r.name}`);
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({
      label: LABEL,
      recordedAt: new Date().toISOString(),
      corpus: counts,
      settings: {
        users: USERS, events: EVENTS, duration: DURATION,
        connections: CONNECTIONS, apiLimit: API_LIMIT, dbLatencyMs: DB_LATENCY_MS,
      },
      pool,
      results,
    }, null, 2));
    console.log(`\n[load] wrote ${JSON_OUT}`);
  }

  if (race?.oversold) {
    console.log('\n[load] FAILING: the capacity guard did not hold.');
    process.exitCode = 1;
  } else if (race?.inconclusive) {
    console.log('\n[load] FAILING: the concurrency scenario proved nothing — every accept was refused.');
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('\n[load] failed:', err.message);
  process.exitCode = 1;
} finally {
  await stopServer();
  await pool.end();
  latencyProxy?.close();
}
