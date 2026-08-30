/**
 * The wire to Upstash. Bounded, never throws, and never a reason a request
 * fails.
 *
 * ── Why this is a fetch client and not `@upstash/redis` ──
 *
 * The same argument `search/pineconeClient.js` makes, and it lands the same way
 * here. What this integration actually needs from the transport is the part an
 * SDK does not give: a hard timeout, a failure that is *counted rather than
 * thrown*, a circuit breaker so an outage costs one timeout per window rather
 * than one per request, and a command counter that can answer "how much of the
 * free tier have we spent". Wrapping an SDK to obtain those is more code than
 * the four functions below, and ENGINEERING_GUIDE §3.2 treats an unexplained
 * lockfile diff as a supply-chain risk on an application holding minors' data.
 *
 * It is also the anti-lock-in seam. Everything above this file speaks in Redis
 * commands — `['INCR', key]` — not in Upstash concepts. Moving to a
 * self-hosted Redis or a different managed provider is a replacement of this
 * one file, not a rewrite of the callers.
 *
 * What is NOT reimplemented: the endpoints, the request shapes and the auth
 * header are Upstash's, used as documented. Both paths below were read from
 * Upstash's REST API reference on 2026-08-28:
 *
 *   POST {url}            a single command, as a JSON array in the body
 *   POST {url}/pipeline   an array of commands, results in order
 *
 * The command form is a POST with the command in the BODY rather than the
 * documented `GET {url}/set/foo/bar` path form. That is deliberate: a path-form
 * command puts its arguments in a URL, where a proxy or an access log captures
 * them in passing, and this client's arguments include rate-limiter keys.
 *
 * ── The one rule ──
 *
 * Every function here returns `{ ok: true, … }` or `{ ok: false, reason }`.
 * None of them throw, and none of them reject. A caller that forgets to check
 * `ok` gets a falsy result, never an exception in the middle of a request
 * handler.
 */
import { redisConfig, REQUEST_TIMEOUT_MS, BREAKER_OPEN_MS } from './redisConfig.js';

/**
 * Usage, accumulated for the life of the process.
 *
 * `commands` is the number this integration believes it has spent against the
 * free plan's monthly allowance, counted the way Upstash bills: every command,
 * including each command executed inside a Lua script. `requests` is HTTP round
 * trips, which is what latency is proportional to. The two differ, and keeping
 * both is what makes "batch this" and "spend less quota" distinguishable —
 * pipelining improves the second number and not the first.
 */
const usage = {
  requests: 0,
  commands: 0,
  hits: 0,
  misses: 0,
  failures: 0,
  timeouts: 0,
  breakerTrips: 0,
  breakerSkips: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0,
};

export function redisUsage() {
  return { ...usage, avgLatencyMs: usage.requests ? Math.round(usage.totalLatencyMs / usage.requests) : 0 };
}

export function __resetRedisUsage() {
  for (const key of Object.keys(usage)) usage[key] = 0;
  breakerOpenUntil = 0;
}

/** Records a cache outcome. Kept here so one module owns the counters. */
export function noteCacheOutcome(hit) {
  if (hit) usage.hits += 1; else usage.misses += 1;
}

/* ── The breaker ──────────────────────────────────────────────────────────── */

let breakerOpenUntil = 0;

/**
 * Whether the breaker is currently open.
 *
 * One failure opens it. That is aggressive on purpose: every caller of this
 * module has a correct answer available without Redis, so the cost of being
 * wrong about an outage is a cache miss or an in-memory counter, while the cost
 * of being right is that a sign-in does not wait 800 ms for a dead dependency.
 */
function breakerOpen(now) {
  return now < breakerOpenUntil;
}

function tripBreaker(now) {
  if (!breakerOpen(now)) usage.breakerTrips += 1;
  breakerOpenUntil = now + BREAKER_OPEN_MS;
}

/** Whether the transport is currently believed healthy. For the status surface. */
export function redisHealth() {
  const now = Date.now();
  return {
    breakerOpen: breakerOpen(now),
    breakerClearsInMs: breakerOpen(now) ? breakerOpenUntil - now : 0,
  };
}

/* ── The wire ─────────────────────────────────────────────────────────────── */

/**
 * One HTTP request, with a deadline and no way to throw.
 *
 * `commandCount` is what the caller believes this request will cost against the
 * monthly allowance — one per command for a pipeline, and for a script the
 * number of `redis.call`s it makes plus the EVAL itself. It is charged whether
 * or not the response parses, because Upstash charged for it either way.
 *
 * The token never appears in a log. The error path records the STATUS and the
 * failure kind, never the request, because a request carries the header that
 * carries the token — the same rule `pineconeClient.js` follows.
 */
async function post(path, body, commandCount) {
  const cfg = redisConfig();
  if (!cfg.enabled) return { ok: false, reason: cfg.reason };

  const now = Date.now();
  if (breakerOpen(now)) {
    usage.breakerSkips += 1;
    return { ok: false, reason: 'circuit_open' };
  }

  const started = now;
  try {
    const res = await fetch(cfg.url + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const elapsed = Date.now() - started;
    usage.requests += 1;
    usage.commands += commandCount;
    usage.totalLatencyMs += elapsed;
    if (elapsed > usage.maxLatencyMs) usage.maxLatencyMs = elapsed;

    if (!res.ok) {
      usage.failures += 1;
      tripBreaker(Date.now());
      /* The status is the whole diagnosis an operator needs: 401 is a bad or
         revoked token, 429 is the plan's rate ceiling, 5xx is Upstash. */
      return { ok: false, reason: `http_${res.status}` };
    }

    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    if (parsed === null) {
      usage.failures += 1;
      return { ok: false, reason: 'malformed_response' };
    }

    return { ok: true, body: parsed };
  } catch (err) {
    usage.requests += 1;
    usage.commands += commandCount;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    if (timedOut) usage.timeouts += 1; else usage.failures += 1;
    tripBreaker(Date.now());
    return { ok: false, reason: timedOut ? 'timeout' : 'network_error' };
  }
}

/**
 * One Redis command.
 *
 * @param {Array<string|number>} command e.g. `['GET', 'wev:development:cache:x']`
 * @param {number} [cost] commands to charge; defaults to one
 */
export async function redisCommand(command, cost = 1) {
  const res = await post('', command, cost);
  if (!res.ok) return res;

  /* Upstash answers `{ result }` for success and `{ error }` for a command that
     ran and was refused — a wrong type, a bad argument. That is not a transport
     failure and must not trip the breaker: the connection is fine and retrying
     will fail identically. */
  if (res.body && typeof res.body === 'object' && 'error' in res.body) {
    usage.failures += 1;
    return { ok: false, reason: 'command_error' };
  }
  return { ok: true, result: res.body?.result ?? null };
}

/**
 * Several commands in one round trip.
 *
 * Saves latency, NOT quota — Upstash bills each command in the pipeline
 * separately. Used where a caller genuinely needs two values and would
 * otherwise pay two round trips for them.
 *
 * A pipeline is not a transaction. Anything needing atomicity uses `redisEval`.
 */
export async function redisPipeline(commands) {
  if (!commands.length) return { ok: true, results: [] };
  const res = await post('/pipeline', commands, commands.length);
  if (!res.ok) return res;
  if (!Array.isArray(res.body)) return { ok: false, reason: 'malformed_response' };
  return {
    ok: true,
    results: res.body.map(entry => (entry && 'error' in entry ? null : entry?.result ?? null)),
  };
}

/**
 * A Lua script, run atomically.
 *
 * ── Why scripts, when they do not save quota ──
 *
 * They do not: Upstash counts the EVAL and every `redis.call` inside it. What
 * they buy is atomicity in ONE round trip. The counter increments below have to
 * set an expiry on the key they just created, and a pipeline that does
 * `INCR` then `PEXPIRE` can be interrupted between the two — leaving a
 * rate-limit counter with no TTL, which is a key that never expires and a limit
 * that never resets. On a 256 MB plan an unbounded key is not a leak, it is the
 * whole budget.
 *
 * `cost` is stated by the caller rather than inferred, because only the caller
 * knows how many `redis.call`s its script makes on each path.
 */
export async function redisEval(script, keys, args, cost) {
  const res = await redisCommand(['EVAL', script, String(keys.length), ...keys, ...args], cost);
  return res;
}

/** Liveness, for the CLI and the operator status panel. One command. */
export async function redisPing() {
  const started = Date.now();
  const res = await redisCommand(['PING']);
  return res.ok
    ? { ok: true, latencyMs: Date.now() - started, result: res.result }
    : res;
}
