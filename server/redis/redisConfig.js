/**
 * Whether this process may talk to Upstash Redis, where, and under what budget.
 *
 * ── The free tier is the architecture, not a footnote ──
 *
 * Every number below was read from Upstash's own pricing and documentation on
 * 2026-08-28, for the **Free** plan, which is the plan this integration is
 * designed to live inside permanently:
 *
 *   commands per month            500,000        ← the binding constraint
 *   data size                     256 MB
 *   bandwidth per month           10 GB
 *   databases per account         1              ← forces prefix isolation
 *   max commands per second       10,000
 *   max request size              10 MB
 *   max record size               100 MB
 *   idle policy                   archived after ≥30 days with no traffic
 *
 * Two of those shaped the design more than the rest.
 *
 * **500,000 commands a month** is about 16,600 a day, and Upstash counts every
 * command — including each command inside a pipeline or a Lua script, which is
 * why batching saves round trips and not quota. That budget cannot carry a
 * general API throttle: `apiLimiter` in app.js allows 600 requests per fifteen
 * minutes per device, and a rate-limit check costs two to three commands, so a
 * single busy afternoon would spend the month. It comfortably carries the two
 * things this integration actually does, because both are rare by construction
 * — a failed sign-in, or an upstream lookup that was not already cached in
 * process memory.
 *
 * **One database** means development, test and production share a keyspace.
 * There is no second database to separate them into, so separation is a key
 * prefix and it is not optional: see `keyPrefix` below.
 *
 * ── One documented conflict, resolved downwards ──
 *
 * Upstash's pricing page says 500K commands per month; its FAQ page still says
 * "10,000 requests per day" (300K/month). The FAQ appears to be stale, but this
 * integration is sized against the tighter of the two, so it does not matter
 * which is current. `docs/operations/upstash.md` records both and the date.
 *
 * ── Regional, never global ──
 *
 * Upstash's global databases replicate writes to read regions and **count each
 * replication as a command**, so one read region doubles the spend. WeVolunteer
 * is one server in one place. The ops document says to create a regional
 * database in the region nearest the host, and says why.
 *
 * If Upstash changes these, this file is the one place to change, and
 * `docs/operations/upstash.md` records the date they were read.
 */
import crypto from 'node:crypto';

/** The date the numbers above were read, surfaced by the CLI so it can go stale visibly. */
export const LIMITS_READ_ON = '2026-08-28';

/** The free plan, as documented, for the status output and the ops doc to agree on. */
export const FREE_TIER = Object.freeze({
  commandsPerMonth: 500_000,
  storageBytes: 256 * 1024 * 1024,
  bandwidthBytesPerMonth: 10 * 1024 * 1024 * 1024,
  databases: 1,
  maxCommandsPerSecond: 10_000,
  idleArchiveDays: 30,
});

/**
 * How long a single Upstash call may take before the caller gives up.
 *
 * Deliberately short. Every caller has a correct answer available without
 * Redis — an in-process cache entry, an upstream request, or an in-memory
 * counter — so waiting is strictly worse than falling back. 800 ms is generous
 * for an HTTPS round trip to a nearby region and far below anything a person
 * would tolerate added to a sign-in.
 */
export const REQUEST_TIMEOUT_MS = Number(process.env.UPSTASH_TIMEOUT_MS) || 800;

/**
 * How long the breaker stays open after a failure.
 *
 * Without this, an Upstash outage costs one timeout on EVERY request that would
 * have used it — which on the sign-in path turns a degraded dependency into a
 * degraded application. One failure opens the breaker; while it is open every
 * call returns `{ ok: false, reason: 'circuit_open' }` immediately and the
 * caller takes its fallback with no added latency.
 *
 * Short, because recovery should be automatic and quick. The cost of closing
 * too early is one more timeout.
 */
export const BREAKER_OPEN_MS = Number(process.env.UPSTASH_BREAKER_MS) || 30_000;

/**
 * The key prefix, and why it is load-bearing rather than tidy.
 *
 * The free plan allows ONE database per account, so a developer running the
 * suite locally and the production server are writing into the same keyspace.
 * Without a prefix, a test that sets a login-failure counter for a seeded user
 * id would be setting production's counter for that id.
 *
 * `NODE_ENV` drives it by default, so the separation happens whether or not
 * anybody remembers to configure it — the same defaulting `PINECONE_NAMESPACE`
 * uses, for the same reason. `UPSTASH_KEY_PREFIX` overrides it for a deployment
 * that runs two environments with the same NODE_ENV.
 *
 * The trailing colon is added here, once, so no call site can forget it and
 * produce `wev:developmentcache:…`.
 */
export function keyPrefix() {
  const raw = process.env.UPSTASH_KEY_PREFIX || process.env.NODE_ENV || 'development';
  return `wev:${String(raw).trim().replace(/[^A-Za-z0-9_-]/g, '') || 'development'}:`;
}

/**
 * A key segment derived from caller-supplied text, safely.
 *
 * ── Why everything user-influenced is hashed ──
 *
 * Two reasons, and the second is the one that matters. The first is injection:
 * Upstash's REST API takes a command as URL path segments, so a raw value
 * containing `/` or `?` would change the command being sent. Hashing removes
 * the character class entirely rather than escaping it and hoping.
 *
 * The second is privacy. A rate-limiter key made from an email address is a
 * list of who tried to sign in, stored on somebody else's infrastructure. The
 * codebase already hashes these in memory for exactly that reason (see
 * `loginKeyGenerator` and `mailKeyGenerator` in app.js); sending them over a
 * network makes the argument stronger, not weaker.
 *
 * 32 hex characters — 128 bits — is far beyond collision range for a keyspace
 * of at most a few thousand live counters, and keeps keys short enough to read
 * in a console.
 *
 * ── Why it is keyed ──
 *
 * It was a plain SHA-256, and a hash nobody else can compute is the whole of
 * the privacy argument above. An IPv4 address is a 32-bit space: anybody
 * holding the keys could hash all four billion and read the address behind a
 * counter, and hash a known email once to see whether it had been trying to
 * sign in. The Privacy Policy says the code "cannot be turned back into your
 * email or your address". Keyed with a secret only this server holds, that is
 * true of Upstash and of anybody reading its console.
 *
 * The key is derived from `JWT_SECRET` rather than being a variable of its
 * own, so no deployment can run without one (config.js refuses to boot in
 * production without it), and derived rather than used directly so the
 * signing secret never keys anything but signatures. Rotating `JWT_SECRET`
 * therefore changes every key here too: counters and cached lookups start
 * again from empty once, which is the outcome a restart already had before
 * these were shared.
 *
 * Read from the environment when first needed, not imported from config.js:
 * that module fixes the secret at import, and importing it from here made a
 * test that loads this file before starting its server sign with one secret
 * and verify with another. Without the variable (development only) a fixed
 * string stands in, as config.js's own fallback does.
 */
export function segmentHasher(secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('wevolunteer:upstash-key-segment:v1').digest();
  return (value) => crypto.createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 32);
}

let segmentSecret = null;
let segmentHash = null;

export function hashSegment(value) {
  const secret = process.env.JWT_SECRET || 'wevolunteer-development-only-segment-key';
  if (secret !== segmentSecret) {
    segmentSecret = secret;
    segmentHash = segmentHasher(secret);
  }
  return segmentHash(value);
}

let cached = null;

function resolve() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

  /**
   * Both or neither. Half a configuration is a misconfiguration, and the
   * failure it produces without this check is a 401 on every call — which looks
   * exactly like a revoked token and sends an operator to the wrong place.
   */
  if (!url || !token) {
    return {
      enabled: false,
      reason: url || token ? 'incomplete' : 'unconfigured',
      url: '',
      token: '',
      prefix: keyPrefix(),
    };
  }

  /**
   * HTTPS only, refused rather than upgraded.
   *
   * The token is a bearer credential with full database privileges. A plaintext
   * URL would put it on the wire, and quietly rewriting it to HTTPS would hide
   * a configuration mistake that an operator should see.
   */
  if (!url.startsWith('https://')) {
    return { enabled: false, reason: 'insecure_url', url: '', token: '', prefix: keyPrefix() };
  }

  return { enabled: true, reason: 'ok', url, token, prefix: keyPrefix() };
}

/**
 * The resolved configuration, computed once.
 *
 * Cached because it is read on every cache lookup and every limiter decision,
 * and because `keyPrefix()` allocating a string per call would be the kind of
 * pointless work that shows up in a profile.
 */
export function redisConfig() {
  if (cached === null) cached = resolve();
  return cached;
}

/** Whether Redis is available to this process at all. */
export function redisEnabled() {
  return redisConfig().enabled;
}

/** Test seam: lets a suite change the environment and re-resolve. */
export function __resetRedisConfig() {
  cached = null;
}
