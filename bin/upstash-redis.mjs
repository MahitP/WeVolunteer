#!/usr/bin/env node
/**
 * Checking and operating the Upstash Redis layer: is it reachable, what is in
 * it, what is it costing, and how do you clean up after yourself.
 *
 * ── Why the application does none of this ──
 *
 * Same reason as `bin/pinecone-index.mjs`. Anything that enumerates or deletes
 * keys is an act somebody performs on purpose, from a shell, having read what
 * it is about to do — not something a boot path does on a developer's laptop
 * against a production keyspace. The free plan allows ONE database, so
 * development and production genuinely share a keyspace and the only separation
 * is the prefix. That makes a careless `purge` a production incident, which is
 * why the one below refuses anything but the current environment's own prefix.
 *
 * ── Usage ──
 *
 *   node bin/upstash-redis.mjs ping        is it reachable, and how far away
 *   node bin/upstash-redis.mjs status      configuration, prefix, plan limits
 *   node bin/upstash-redis.mjs keys        what this environment currently holds
 *   node bin/upstash-redis.mjs validate    a controlled end-to-end check, cleaned up after
 *   node bin/upstash-redis.mjs purge --yes delete THIS environment's keys
 *
 * `validate` is the command to run after creating the database: it exercises
 * set/get/TTL/expiry/counter/script against a handful of keys under a
 * `validation:` sub-prefix and deletes every one of them before it exits. It
 * spends roughly twenty commands out of a monthly 500,000.
 *
 * Reads `.env` through `--env-file-if-exists`, like every other privileged
 * script here.
 */
import process from 'node:process';

const { redisConfig, keyPrefix, FREE_TIER, LIMITS_READ_ON, REQUEST_TIMEOUT_MS } =
  await import('../server/redis/redisConfig.js');
const { redisCommand, redisPipeline, redisEval, redisPing, redisUsage } =
  await import('../server/redis/redisClient.js');

const line = (msg = '') => console.log(msg);

/**
 * Every key this environment owns.
 *
 * `SCAN` rather than `KEYS`: `KEYS` blocks the server for the duration and is
 * the classic way to make a shared instance briefly unusable. The cursor loop
 * is bounded so a keyspace that is somehow enormous cannot turn a diagnostic
 * into an unbounded spend.
 */
async function scanPrefix(prefix, { maxBatches = 50 } = {}) {
  const found = [];
  let cursor = '0';
  for (let i = 0; i < maxBatches; i++) {
    const res = await redisCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '200']);
    if (!res.ok) return { ok: false, reason: res.reason, keys: found };
    const [next, batch] = Array.isArray(res.result) ? res.result : ['0', []];
    found.push(...(batch ?? []));
    cursor = String(next);
    if (cursor === '0') return { ok: true, keys: found, complete: true };
  }
  return { ok: true, keys: found, complete: false };
}

function requireEnabled() {
  const cfg = redisConfig();
  if (cfg.enabled) return true;
  line(`Upstash is not available to this process (${cfg.reason}).`);
  line('');
  line('  unconfigured  neither UPSTASH_REDIS_REST_URL nor _TOKEN is set.');
  line('  incomplete    one of the pair is set and the other is not. Both or neither.');
  line('  insecure_url  the URL is not https. The token is a bearer credential;');
  line('                it is refused rather than quietly upgraded.');
  line('');
  line('See docs/operations/upstash.md for how to create the database.');
  process.exitCode = 1;
  return false;
}

async function main() {
  const command = process.argv[2] || 'status';
  const flags = new Set(process.argv.slice(3));

  if (command === 'status') {
    const cfg = redisConfig();
    line('Upstash Redis');
    line(`  configured     ${cfg.enabled ? 'yes' : `no (${cfg.reason})`}`);
    /* The host, never the token. The URL identifies the database and the region
       and is not a credential; the token is one. */
    line(`  endpoint       ${cfg.enabled ? cfg.url : '—'}`);
    line(`  key prefix     ${keyPrefix()}`);
    line(`  timeout        ${REQUEST_TIMEOUT_MS} ms`);
    line('');
    line(`Free plan, as documented on ${LIMITS_READ_ON}`);
    line(`  commands       ${FREE_TIER.commandsPerMonth.toLocaleString()} / month`);
    line(`  storage        ${FREE_TIER.storageBytes / (1024 * 1024)} MB`);
    line(`  databases      ${FREE_TIER.databases}  ← why the prefix above is load-bearing`);
    line(`  idle policy    archived after ${FREE_TIER.idleArchiveDays} days with no traffic`);
    line('');
    line('Actual monthly usage is on the Upstash console. This process can only');
    line('report what IT has spent since boot — see `usage` in the status panel.');
    return;
  }

  if (command === 'ping') {
    if (!requireEnabled()) return;
    const res = await redisPing();
    if (!res.ok) {
      line(`unreachable (${res.reason})`);
      if (res.reason === 'http_401') line('  A 401 means the token is wrong or has been rotated.');
      if (res.reason === 'timeout') line(`  No answer within ${REQUEST_TIMEOUT_MS} ms. Check the region is near this host.`);
      process.exitCode = 1;
      return;
    }
    line(`ok — ${res.latencyMs} ms round trip`);
    /* Worth stating plainly: this number is the whole reason no database query
       is cached in Redis. Local Postgres answers the hot ones in well under a
       millisecond. */
    line('');
    line('For comparison, the application\'s hot database queries are 0.3-0.5 ms');
    line('(docs/operations/postgres-scale-measurements.md). That is why Redis here');
    line('caches third-party lookups and security counters, and no SQL queries.');
    return;
  }

  if (command === 'keys') {
    if (!requireEnabled()) return;
    const prefix = keyPrefix();
    const res = await scanPrefix(prefix);
    if (!res.ok) { line(`scan failed (${res.reason})`); process.exitCode = 1; return; }

    line(`${res.keys.length} key(s) under ${prefix}${res.complete ? '' : ' (truncated)'}`);
    const byDomain = new Map();
    for (const key of res.keys) {
      const domain = key.slice(prefix.length).split(':').slice(0, 2).join(':');
      byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
    }
    for (const [domain, count] of [...byDomain].sort()) line(`  ${String(count).padStart(5)}  ${domain}`);
    line('');
    line('Key segments after the domain are digests. That is deliberate: a listing');
    line('of this keyspace must not be a list of who signed in or what was searched.');
    return;
  }

  if (command === 'validate') {
    if (!requireEnabled()) return;
    const prefix = `${keyPrefix()}validation:`;
    const created = [];
    let failures = 0;

    const check = (name, passed, detail = '') => {
      line(`  ${passed ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
      if (!passed) failures += 1;
    };

    line(`Validating against ${redisConfig().url}`);
    line(`Keys are written under ${prefix} and deleted before this exits.`);
    line('');

    try {
      const k = (n) => { const key = `${prefix}${n}`; created.push(key); return key; };

      const ping = await redisPing();
      check('authentication and reachability', ping.ok, ping.ok ? `${ping.latencyMs} ms` : ping.reason);

      const setRes = await redisCommand(['SET', k('string'), 'hello', 'PX', '10000']);
      check('SET with an expiry', setRes.ok && setRes.result === 'OK');

      const getRes = await redisCommand(['GET', `${prefix}string`]);
      check('GET returns what was written', getRes.ok && getRes.result === 'hello');

      const ttlRes = await redisCommand(['PTTL', `${prefix}string`]);
      const ttl = Number(ttlRes.result);
      check('the key carries a TTL', ttlRes.ok && ttl > 0 && ttl <= 10_000, `${ttl} ms left`);

      const expiring = await redisCommand(['SET', k('expiring'), 'x', 'PX', '150']);
      await new Promise(r => setTimeout(r, 400));
      const gone = await redisCommand(['GET', `${prefix}expiring`]);
      check('an expired key is actually gone', expiring.ok && gone.ok && gone.result === null);

      const script = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return {c, redis.call('PTTL', KEYS[1])}";
      const first = await redisEval(script, [k('counter')], ['10000'], 4);
      const second = await redisEval(script, [`${prefix}counter`], ['10000'], 3);
      check('the counter script increments atomically',
        first.ok && second.ok && Number(second.result?.[0]) === 2);
      check('the counter script sets a TTL on creation only',
        Array.isArray(second.result) && Number(second.result[1]) > 0 && Number(second.result[1]) <= 10_000);

      const pipe = await redisPipeline([['SET', k('p1'), '1'], ['SET', k('p2'), '2'], ['GET', `${prefix}p1`]]);
      check('pipelines return results in order', pipe.ok && pipe.results[2] === '1');

      const scan = await scanPrefix(prefix);
      check('SCAN finds this environment\'s keys', scan.ok && scan.keys.length > 0, `${scan.keys?.length ?? 0} found`);
    } finally {
      /* Always, including after a failure: a validation run must not leave keys
         behind on a 256 MB plan, and a half-finished run is exactly when
         somebody forgets. */
      const unique = [...new Set(created)];
      if (unique.length) {
        const del = await redisCommand(['DEL', ...unique]);
        line('');
        line(`Cleaned up ${del.ok ? del.result : '?'} of ${unique.length} validation key(s).`);
        const left = await scanPrefix(prefix);
        if (left.ok && left.keys.length) {
          line(`WARNING: ${left.keys.length} validation key(s) remain. Run: node bin/upstash-redis.mjs purge --yes`);
        }
      }
      const usage = redisUsage();
      line(`Spent ${usage.commands} command(s) across ${usage.requests} request(s); ` +
           `avg ${usage.avgLatencyMs} ms, max ${usage.maxLatencyMs} ms.`);
    }

    if (failures) { line(''); line(`${failures} check(s) failed.`); process.exitCode = 1; }
    else { line(''); line('All checks passed.'); }
    return;
  }

  if (command === 'purge') {
    if (!requireEnabled()) return;
    const prefix = keyPrefix();

    /**
     * Two gates, because one is not enough for a destructive command against a
     * keyspace that development and production share.
     *
     * The first is `--yes`, matching every other destructive tool in `bin/`.
     * The second is that the prefix cannot be chosen: it is always THIS
     * process's own environment prefix, so the only way to purge production is
     * to run this on the production host with production's environment — which
     * is a deliberate act rather than a mistyped argument.
     */
    if (!flags.has('--yes')) {
      const res = await scanPrefix(prefix);
      line(`Would delete ${res.keys.length} key(s) under ${prefix}`);
      line('');
      line('Nothing here is a source of truth: every key is a cache entry or a');
      line('rate-limit counter, and deleting them costs a cold cache and a reset');
      line('window. It does NOT affect any application data.');
      line('');
      line('Re-run with --yes to proceed.');
      return;
    }

    const res = await scanPrefix(prefix);
    if (!res.ok) { line(`scan failed (${res.reason})`); process.exitCode = 1; return; }
    if (!res.keys.length) { line(`Nothing to delete under ${prefix}`); return; }

    /* In batches: one DEL with ten thousand arguments is a 10 MB request limit
       waiting to be hit, and a partial failure is easier to read in batches. */
    let deleted = 0;
    for (let i = 0; i < res.keys.length; i += 200) {
      const batch = res.keys.slice(i, i + 200);
      const del = await redisCommand(['DEL', ...batch], batch.length);
      if (del.ok) deleted += Number(del.result) || 0;
    }
    line(`Deleted ${deleted} key(s) under ${prefix}`);
    if (!res.complete) line('The scan was truncated; run again to remove the rest.');
    return;
  }

  line(`Unknown command: ${command}`);
  line('Try: status | ping | keys | validate | purge --yes');
  process.exitCode = 1;
}

main().catch((err) => {
  /* The client never throws — it returns `{ ok: false }` — so anything arriving
     here came from this script. A bare name is not an answer anybody can act
     on, and this is a tool people run when something is already wrong. */
  const detail = typeof err?.message === 'string' ? `: ${err.message.slice(0, 200)}` : '';
  line(`upstash-redis failed (${err?.name || 'error'})${detail}`);
  process.exitCode = 1;
});
