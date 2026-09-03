#!/usr/bin/env node
/**
 * Validates a Supabase target through the path the application actually uses.
 *
 * ── Why this is a tool and not a test ──
 *
 * The behavioural half of "does Supabase work" is already covered by suites
 * that can be pointed at any PostgreSQL:
 *
 *   TEST_POOLER_URL=…   npx vitest run server/pooler.behaviour.test.js
 *   TEST_POSTGRES_URL=… WEV_POSTGRES_APP_TEST=1 npx vitest run --project server
 *
 * What no test covers is everything that has to work BEFORE a session exists,
 * and that is where a managed database actually goes wrong: an address family
 * with no route, a certificate the pinned CA no longer validates, a pooler
 * shard that does not host this tenant, a password that parses differently than
 * it was typed. Those fail identically from the outside — "it will not
 * connect" — and are diagnosed completely differently.
 *
 * So this walks the ladder rung by rung and says which rung broke.
 *
 * ── Safety ──
 *
 * Reads its target from `SUPABASE_CHECK_URL`, deliberately NOT from
 * `DATABASE_URL`: a tool that picks up the deployment's own configuration is a
 * tool that eventually runs against production because somebody had a shell
 * open in the wrong directory.
 *
 * Everything below is read-only unless `--write-probe` is given, and that
 * creates one temporary table with a random name, writes three rows to it, and
 * drops it. It refuses outright if the database contains a `users` table with
 * any row in it, so it cannot be pointed at a populated deployment.
 *
 * ── Usage ──
 *
 *   SUPABASE_CHECK_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
 *     node bin/supabase-check.mjs
 *
 *   --write-probe   also exercise transactions, concurrency and pooling.
 *                   Requires --i-know-this-is-disposable as well, and still
 *                   refuses a database with any user rows in it.
 *   --json PATH     write the findings as JSON
 *
 * Never prints the URL, the password, or any part of either.
 */
import pg from 'pg';
import net from 'node:net';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';

/**
 * The write probe needs TWO flags, and the second one is a sentence.
 *
 * `--write-probe` alone reads as "run the thorough version", which is exactly
 * the mood somebody is in when they point this at the database they actually
 * care about. It creates a table. So it also needs
 * `--i-know-this-is-disposable`, which nobody types by reflex, and even then it
 * refuses a database holding user rows.
 *
 * The counted guards are: the second flag, the user-row check further down,
 * and — for a managed host, where "disposable" is least likely to be true — a
 * third, below.
 */
const WRITE_PROBE = process.argv.includes('--write-probe')
  && process.argv.includes('--i-know-this-is-disposable');
const WRITE_PROBE_ASKED = process.argv.includes('--write-probe');
const MANAGED_WRITE_OK = process.argv.includes('--yes-write-to-this-managed-database');
const jsonAt = process.argv.indexOf('--json');
const JSON_OUT = jsonAt === -1 ? null : process.argv[jsonAt + 1];

const URL_ = process.env.SUPABASE_CHECK_URL;
if (!URL_) {
  console.error('SUPABASE_CHECK_URL is required.');
  console.error('Deliberately not DATABASE_URL — see the header of this file.');
  process.exit(1);
}

const CA_PATH = process.env.DATABASE_SSL_CA || 'deploy/certs/supabase-root-2021.crt';

const findings = [];
const record = (name, ok, detail) => {
  findings.push({ name, ok, detail });
  console.log(`${ok === null ? 'SKIP' : ok ? ' ok ' : 'FAIL'}  ${name.padEnd(46)} ${detail ?? ''}`);
  return ok;
};

/** The target, reduced to the parts that are safe to say out loud. */
function describeTarget() {
  const u = new URL(URL_);
  const host = u.hostname;
  const kind = /\.pooler\.supabase\.com$/.test(host)
    ? (u.port === '6543' ? 'Supavisor, transaction mode' : 'Supavisor, session mode')
    : /^db\..*\.supabase\.co$/.test(host) ? 'direct' : 'not a Supabase host';
  return { host, port: u.port || '5432', database: u.pathname.replace(/^\//, ''), kind, user: u.username };
}

const target = describeTarget();
const MANAGED_HOST = /\.supabase\.(co|com)$/.test(target.host);
console.log(`host:     ${target.host}:${target.port}  (${target.kind})`);
console.log(`database: ${target.database}\n`);

/* ── 0. The credential as written, versus the credential that will be sent ── */

/**
 * A password in a URI is percent-DECODED before it is sent.
 *
 * So a password containing a literal `%` arrives at the server as something
 * else — `pa%73s` is sent as `pass` — and a password containing `%zz` makes the
 * whole string fail to decode. The connection then fails with
 * `password authentication failed`, which sends everybody to check the password
 * they typed, which is correct, which is why this is so hard to find.
 *
 * Observed live: a 29-character password written into `.env` reached the server
 * as 27 characters, because it contained `%40`.
 *
 * A literal `%` must be written `%25`. The same applies to `@`, `#`, `/`, `:`
 * and `?`, though only `%` silently changes the VALUE — the others change where
 * the parser thinks the password ends, which fails more loudly.
 */
{
  const after = URL_.slice(URL_.indexOf('://') + 3);
  const at = after.lastIndexOf('@');
  const literal = at === -1 ? '' : after.slice(after.indexOf(':') + 1, at);
  let decoded = null;
  try { decoded = decodeURIComponent(literal); } catch { /* malformed escape */ }

  /**
   * The placeholder check, which exists because it caught a real afternoon.
   *
   * Every connection string anybody hands you — Supabase's own Connect panel,
   * this repository's `.env.example`, a message from a colleague — carries the
   * password as a placeholder: `[YOUR-PASSWORD]`, `<NEW-PASSWORD>`,
   * `your-password-here`. Pasted whole and left unsubstituted, it reaches the
   * server as a password, is rejected as a password, and is reported as
   * `password authentication failed` — which is true, unhelpful, and sends
   * somebody to reset a password that was never the problem.
   *
   * It is a 0 ms check standing in front of a round trip and an hour.
   */
  const PLACEHOLDER = /^[<[{(].*[>\]})]$/.test(literal)
    || /^(your|new|db|the)[-_]?password$/i.test(literal)
    || /password[-_]?here$/i.test(literal);

  if (!literal) {
    record('password survives URI decoding', null, 'no password in the URL');
  } else if (PLACEHOLDER) {
    record('password is a real password', false,
      'this is the PLACEHOLDER from a connection-string template, pasted unsubstituted — '
      + 'replace it with the actual database password');
  } else if (decoded === null) {
    record('password survives URI decoding', false,
      'it contains a "%" that is not a valid escape, so the URL cannot be decoded at all');
  } else if (decoded !== literal) {
    record('password survives URI decoding', false,
      `written as ${literal.length} chars, SENT as ${decoded.length} — a literal "%" must be "%25"`);
  } else {
    record('password survives URI decoding', true, 'what is written is what is sent');
  }
}

/* ── 1. Address family ────────────────────────────────────────────────────── */

/**
 * `lookup` as well as `resolve`, because they answer different questions.
 *
 * `resolve4` queries DNS and knows nothing about `/etc/hosts`, so it reports
 * `localhost` as unresolvable — which is true of DNS and false of the machine.
 * `lookup` is what the connection itself will use. Both are asked: the resolver
 * answer is what says "AAAA only", and the lookup answer is what says whether
 * this host can actually get there.
 */
const a = await dns.resolve4(target.host).catch(() => []);
const aaaa = await dns.resolve6(target.host).catch(() => []);
const looked = await dns.lookup(target.host, { all: true }).catch(() => []);
const v4 = a.length || looked.filter((r) => r.family === 4).length;
const v6 = aaaa.length || looked.filter((r) => r.family === 6).length;

record('DNS resolves', v4 + v6 > 0, `${v4} IPv4, ${v6} IPv6`);
record('reachable from an IPv4-only host', v4 > 0,
  v4 > 0 ? 'has an IPv4 address'
    : 'IPv6 only — this host needs global IPv6, or use the session-mode pooler');

/* ── 2. TCP, and what the round trip costs ────────────────────────────────── */

const tcpTimes = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  const ok = await new Promise((resolve) => {
    const s = net.connect(Number(target.port), target.host, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 8000);
  });
  if (ok) tcpTimes.push(Date.now() - t0);
}
tcpTimes.sort((x, y) => x - y);
record('TCP connect', tcpTimes.length > 0,
  tcpTimes.length ? `${tcpTimes[0]}–${tcpTimes.at(-1)} ms (median ${tcpTimes[Math.floor(tcpTimes.length / 2)]})` : 'no route');

/* ── 3. TLS, with the CA the deployment pins ──────────────────────────────── */

async function tryConnect(ssl, label) {
  const client = new pg.Client({ connectionString: URL_, ssl, connectionTimeoutMillis: 10000 });
  const t0 = Date.now();
  try {
    await client.connect();
    return { ok: true, ms: Date.now() - t0, client, label };
  } catch (err) {
    try { await client.end(); } catch { /* never opened */ }
    return { ok: false, ms: Date.now() - t0, code: err.code, message: String(err.message), label };
  }
}

/**
 * A certificate error and an authentication error are both "it did not
 * connect", and they are opposite findings: the first means TLS is
 * misconfigured, the second means TLS is perfect and the password is wrong.
 */
const isTlsFailure = (r) => /certificate|self-signed|unable to verify|ALTNAME|CERT_/i.test(r.message ?? '');
const reachedAuth = (r) => r.ok || r.code === '28P01' || r.code === '28000';

/**
 * A TLS verdict is only meaningful if the attempt got as far as TLS.
 *
 * An unreachable host and a server with SSL switched off both fail here, and
 * neither says anything about the certificate. Reporting them as a certificate
 * verdict is how a diagnostic tool sends somebody to look in the wrong place —
 * so those cases are SKIPPED with the real reason instead.
 */
const NO_TLS_HERE = (r) => /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|does not support SSL/i
  .test(`${r.code ?? ''} ${r.message ?? ''}`);

let sslForSession = { rejectUnauthorized: false };
const pinned = existsSync(CA_PATH) ? readFileSync(CA_PATH, 'utf8') : null;

if (!pinned) {
  record('pinned CA present', null, `${CA_PATH} not found — skipping the pin check`);
} else {
  const r = await tryConnect({ ca: pinned, rejectUnauthorized: true }, 'pinned');
  if (NO_TLS_HERE(r)) {
    record('TLS verifies against the pinned CA', null,
      `not reached: ${(r.code ?? r.message).toString().slice(0, 60)}`);
    if (/does not support SSL/i.test(r.message ?? '')) sslForSession = false;
  } else {
    const ok = reachedAuth(r) && !isTlsFailure(r);
    record('TLS verifies against the pinned CA', ok,
      isTlsFailure(r) ? r.message.slice(0, 70) : 'certificate and hostname accepted');
    if (ok) sslForSession = { ca: pinned, rejectUnauthorized: true };

    const sys = await tryConnect({ rejectUnauthorized: true }, 'system');
    /* Informational, not a verdict: a server whose chain the system store
       already trusts is fine, it just means the pin is defence in depth rather
       than the only thing holding the connection up. */
    record('the pin is load-bearing', isTlsFailure(sys) ? true : null,
      isTlsFailure(sys)
        ? 'system CA store rejects it, so DATABASE_SSL_CA is required'
        : 'system CAs also accept this chain — the pin is defence in depth here');
    if (sys.client) await sys.client.end();
  }
  if (r.client) await r.client.end();
}

/* ── 4. Authentication, and telling its failures apart ────────────────────── */

const live = await tryConnect(sslForSession, 'live');

if (!live.ok) {
  const tenant = /tenant|not found/i.test(live.message);
  record('authenticates', false, tenant
    ? 'Supavisor does not host this tenant — wrong pooler shard or region, NOT a wrong password'
    : live.code === '28P01'
      ? 'password rejected — the shard is right, the credential is not'
      : `${live.code ?? ''} ${live.message.slice(0, 70)}`);
  console.log('\nStopped at authentication. Everything above it is proven.');
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ target, findings }, null, 2));
  process.exit(1);
}

record('authenticates', true, `${live.ms} ms to an open session`);
const db = live.client;

/* ── 5. What the server is ───────────────────────────────────────────────── */

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

const v = await one('SELECT version(), current_user, current_database(), inet_server_port() AS port');
record('server version', true, v.version.split(' on ')[0]);
record('connected as', true, `${v.current_user} → ${v.current_database} (backend port ${v.port})`);

const sp = await one('SHOW search_path');
record('search_path', true, sp.search_path);

const ssl = await one(`SELECT ssl, version AS tls, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()`)
  .catch(() => null);
/* Null rather than a failure when the connection was never asked to use TLS —
   a local PostgreSQL with SSL off is a correct development setup, not a
   finding. Against a Supabase host it is always TLS, and then it IS a
   finding. */
if (ssl) {
  record('TLS in force on this session',
    ssl.ssl === true ? true : (sslForSession === false ? null : false),
    ssl.ssl === true ? `${ssl.tls ?? ''} ${ssl.cipher ?? ''}`.trim() : 'plaintext session');
}

const ext = (await db.query(`
  SELECT e.extname, e.extversion, n.nspname AS schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1
`)).rows;
record('extensions installed', true, ext.map((e) => `${e.extname}@${e.schema}`).join(' '));

const trgm = ext.find((e) => e.extname === 'pg_trgm');
if (trgm) {
  record('pg_trgm available', true, `installed in ${trgm.schema}`);
} else {
  const avail = await one(`
    SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') AS available
  `);
  record('pg_trgm available', Boolean(avail.available),
    avail.available ? 'not installed; migration 064 will install it' : 'NOT OFFERED by this server');
}

const limits = await one(`
  SELECT current_setting('max_connections') AS max_connections,
         current_setting('statement_timeout') AS statement_timeout,
         current_setting('idle_in_transaction_session_timeout') AS idle_tx_timeout
`);
record('server limits', true,
  `max_connections=${limits.max_connections} statement_timeout=${limits.statement_timeout} `
  + `idle_in_transaction=${limits.idle_tx_timeout}`);

/**
 * The question transaction pooling actually turns on.
 *
 * `postgresConnection.js` disables named prepared statements because a
 * transaction-mode pooler may hand the next statement to a different backend.
 * If any survive, either the pooler is in session mode or something is
 * preparing behind this application's back.
 */
const prepared = await db.query('SELECT name FROM pg_prepared_statements').catch(() => ({ rows: null }));
if (prepared.rows) {
  record('no named prepared statements survive', prepared.rows.length === 0,
    prepared.rows.length ? `${prepared.rows.length} present` : 'none, as the adapter intends');
}

/* ── 6. Round trips, once a session exists ───────────────────────────────── */

const pooled = [];
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  await db.query('SELECT 1');
  pooled.push(Date.now() - t0);
}
pooled.sort((x, y) => x - y);
record('query round trip', true,
  `${pooled[0]}–${pooled.at(-1)} ms (median ${pooled[Math.floor(pooled.length / 2)]})`);

/* ── 7. The write probe, only when asked and only when safe ──────────────── */

if (WRITE_PROBE_ASKED && !WRITE_PROBE) {
  record('write probe', null,
    'REFUSED: --write-probe also needs --i-know-this-is-disposable');
} else if (WRITE_PROBE && MANAGED_HOST && !MANAGED_WRITE_OK) {
  /* A managed host is somebody's real project far more often than it is a
     scratch one, and the cost of being wrong is asymmetric. Both flags plus a
     third, so that reaching a live Supabase database with a CREATE TABLE takes
     three deliberate acts rather than two. */
  record('write probe', null,
    'REFUSED: this is a managed Supabase host — add --yes-write-to-this-managed-database');
} else if (WRITE_PROBE) {
  /**
   * Two statements, not one CASE.
   *
   * `CASE WHEN to_regclass('users') IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM
   * users) END` looks like it guards itself and does not: PostgreSQL parses
   * the whole expression before evaluating any of it, so the branch that is
   * never taken still raises 42P01 on a database without the table. The same
   * trap migration 063 fell into, in a different costume.
   */
  const present = await one(`SELECT to_regclass('public.users') IS NOT NULL AS yes`);
  const populated = present.yes
    ? await one(`SELECT COUNT(*)::int AS n FROM users WHERE id <> 'system-cli'`)
    : { n: 0 };
  if (Number(populated.n) > 0) {
    record('write probe', null, `REFUSED: ${populated.n} user rows — this is not a disposable database`);
  } else {
    const table = `supabase_check_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(`CREATE TABLE ${table} (id int primary key, note text)`);
    try {
      await db.query('BEGIN');
      await db.query(`INSERT INTO ${table} VALUES (1, 'in a transaction')`);
      await db.query('ROLLBACK');
      const after = await one(`SELECT COUNT(*)::int AS n FROM ${table}`);
      record('ROLLBACK discards the write', after.n === 0, `${after.n} rows after rollback`);

      await db.query('BEGIN');
      await db.query(`INSERT INTO ${table} VALUES (2, 'committed')`);
      await db.query('COMMIT');
      const after2 = await one(`SELECT COUNT(*)::int AS n FROM ${table}`);
      record('COMMIT keeps the write', after2.n === 1, `${after2.n} row`);

      /**
       * Twenty transactions at once through the pooler, each incrementing the
       * same row under `FOR UPDATE`. The total is the assertion: anything less
       * than twenty means an update was lost, which is what a pooler handing
       * two clients the same backend mid-transaction would produce.
       */
      const pool = new pg.Pool({ connectionString: URL_, max: 10, ssl: sslForSession });
      await db.query(`INSERT INTO ${table} VALUES (3, '0')`);
      await Promise.all(Array.from({ length: 20 }, async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const row = (await c.query(`SELECT note FROM ${table} WHERE id = 3 FOR UPDATE`)).rows[0];
          await c.query(`UPDATE ${table} SET note = $1 WHERE id = 3`, [String(Number(row.note) + 1)]);
          await c.query('COMMIT');
        } finally { c.release(); }
      }));
      const counted = await one(`SELECT note FROM ${table} WHERE id = 3`);
      record('20 concurrent transactions, none lost', Number(counted.note) === 20, `${counted.note} of 20`);
      await pool.end();
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
      record('write probe cleaned up', true, `dropped ${table}`);
    }
  }
}

await db.end();

const failed = findings.filter((f) => f.ok === false);
console.log(`\n${failed.length === 0 ? 'Every check passed.' : `${failed.length} check(s) failed.`}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ target, findings }, null, 2));
if (failed.length) process.exitCode = 1;
