import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';

import { DEMO_MODE } from './config.js';
import { limitHandler } from './rateLimitResponse.js';
import { createRedisLimitStore } from './redis/limitStore.js';
import { createTokenBucket } from './redis/volumeLimit.js';

/**
 * Rate limits for check-in codes and for scanning them.
 *
 * ── Keyed on the account, never the address ──
 *
 * The reasoning `mailLimiter` and `reportLimiter` record applies here with full
 * force: a school NATs its whole campus behind one address. Two organizers
 * running two events on one Saturday morning would share a per-IP budget, and
 * the one who ran out would be the one told to stop checking people in. The key
 * is a hash of the user id, so the limiter's own store never holds a raw
 * identifier.
 *
 * `ipKeyGenerator` is the unauthenticated fallback rather than a bare `req.ip`,
 * because express-rate-limit refuses a bare `req.ip` in a custom key generator
 * — an IPv6 client gets a fresh address per request and can walk around any
 * per-address limit. In practice the branch is unreachable, since both limiters
 * are mounted after `authenticateToken`, but a fallback that silently does
 * nothing is worse than no fallback.
 */

const hashedUserKey = (req, res) => {
  if (!req.user?.id) return ipKeyGenerator(req.ip);
  return createHash('sha256').update(req.user.id).digest('hex');
};

/* ── The scan limiter, and why it is not a fixed window ─────────────────── */

/**
 * How many scans an organizer may do back to back, and how fast the allowance
 * comes back.
 *
 * ── Why a bucket and not the fifteen-minute window everything else uses ──
 *
 * The traffic here is not spread out; it is a rush. A hundred and fifty
 * volunteers arrive at a park in the ten minutes around the start, queue, and
 * get scanned as fast as the organizer can point a camera. A fixed window sized
 * for that rush is enormous for the rest of the day; a fixed window sized for
 * the rest of the day stops the organizer dead at the one moment the feature
 * exists for, and the fallback — typing a hundred and fifty names — is the
 * thing the feature was meant to replace.
 *
 * A bucket expresses the real shape: a large burst, refilled steadily. The
 * capacity covers a whole arrival rush with nothing throttled at all, and the
 * refill still permits an all-day event without ever permitting a sustained
 * machine-speed flood.
 *
 * The real defence against a runaway scanner is on the client anyway — the
 * decode loop is throttled and refuses to submit the same decoded string twice
 * in a row. This is the backstop for when that is bypassed.
 */
export const CHECKIN_SCAN_BURST_LIMIT = Number(process.env.CHECKIN_SCAN_BURST_LIMIT)
  || (DEMO_MODE ? 5000 : 150);

/** Sustained scans per minute once the burst is spent. */
export const CHECKIN_SCAN_RATE_LIMIT = Number(process.env.CHECKIN_SCAN_RATE_LIMIT)
  || (DEMO_MODE ? 5000 : 30);

/**
 * A token bucket behind express-rate-limit's store interface.
 *
 * The library ships one store, and it is a fixed window. The interface it
 * expects is small — `increment` returning `{totalHits, resetTime}`, plus
 * `decrement` and `resetKey` — so the policy can be swapped without swapping
 * the middleware, the 429 shape, or the headers.
 *
 * `totalHits` is reported as 1 when a request is allowed and as `limit + 1`
 * when it is refused, which is the only contract the middleware needs and does
 * not depend on whether it compares with `>` or `>=`.
 */
class TokenBucketStore {
  constructor({ name, capacity, refillPerMinute }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMinute / 60000;
    this.buckets = new Map();
    /**
     * The SHARED bucket, when Redis is configured.
     *
     * This store used to be purely per-process, on the argument that
     * `instanceLock` allows only one instance so per-process is
     * application-wide. That argument is true today and stops being true the
     * moment a second instance runs — and unlike the window limiters, a token
     * bucket cannot be approximated by a fixed window without changing the
     * policy, because the burst allowance is the whole point of scanning a
     * queue of people at a door.
     *
     * So the bucket itself is distributed, atomically, in one Lua script. See
     * `redis/volumeLimit.js` for why read-modify-write would let two instances
     * issue two tokens for one — and, worse, refill faster than configured.
     */
    this.shared = createTokenBucket({
      name: name ?? 'bucket', capacity, refillPerMinute,
    });
    /* False once a shared bucket exists: the count is no longer this process's
       own, which is what the library's double-counting check reads. */
    this.localKeys = false;
  }

  init(options) {
    this.limit = typeof options.limit === 'number' ? options.limit : this.capacity;
  }

  #bucket(key, now) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, at: now };
      /* Bounded, with the same trade the other hand-rolled throttles in this
         codebase make: an unbounded map is a memory-exhaustion surface, and
         eviction can only ever GIVE a key a fresh allowance, never take one. */
      if (this.buckets.size >= 5000) {
        for (const k of [...this.buckets.keys()].slice(0, 1000)) this.buckets.delete(k);
      }
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  async increment(key) {
    const now = Date.now();

    /**
     * The local bucket is advanced on EVERY call, whether or not Redis answers.
     *
     * That is what makes an outage a continuation rather than a reset: an
     * instance that loses Redis mid-burst carries on from the tokens it has
     * been tracking all along, instead of handing the caller a fresh capacity
     * at exactly the moment coordination stopped. Same reasoning as the local
     * mirror in `redis/limitStore.js`.
     */
    const bucket = this.#bucket(key, now);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
    bucket.at = now;
    const localAllowed = bucket.tokens >= 1;
    if (localAllowed) bucket.tokens -= 1;

    /* The shared bucket decides when it can. It can only ever be at or below
       this instance's own view — every other instance's scans have also been
       taken from it — so deferring to it never loosens the limit. */
    const shared = await this.shared.take(key, now);
    const allowed = shared ? shared.allowed : localAllowed;
    const remaining = shared ? shared.tokens : bucket.tokens;

    if (allowed) return { totalHits: 1, resetTime: undefined };

    const msToNextToken = Math.ceil((1 - Math.max(0, remaining)) / this.refillPerMs);
    return {
      totalHits: (this.limit ?? this.capacity) + 1,
      resetTime: new Date(now + msToNextToken),
    };
  }

  async decrement(key) {
    const bucket = this.buckets.get(key);
    if (bucket) bucket.tokens = Math.min(this.capacity, bucket.tokens + 1);
  }

  async resetKey(key) {
    this.buckets.delete(key);
  }

  async resetAll() {
    this.buckets.clear();
  }
}

/**
 * The burst limiter for check-in scanning — now a DISTRIBUTED token bucket.
 *
 * This carried a note saying it was deliberately left process-local because a
 * fixed-window store cannot express burst-plus-refill. That reasoning was right
 * about the window and wrong about the conclusion: the answer is not to
 * approximate the bucket with a window, it is to distribute the bucket. See
 * `redis/volumeLimit.js`.
 *
 * The policy is unchanged — same capacity, same refill, same retry-after — and
 * with Redis unconfigured or unreachable it is exactly the per-process bucket
 * it has always been.
 */
export const checkinScanLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: CHECKIN_SCAN_BURST_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: hashedUserKey,
  store: new TokenBucketStore({
    name: 'checkin-scan',
    capacity: CHECKIN_SCAN_BURST_LIMIT,
    refillPerMinute: CHECKIN_SCAN_RATE_LIMIT,
  }),
  handler: limitHandler('Too many scans in a short time. Check people in by name while this clears.'),
});

/* ── Code generation ────────────────────────────────────────────────────── */

/**
 * Twenty refreshes per fifteen minutes.
 *
 * A code lasts five minutes, so an honest volunteer needs about three per shift
 * plus a couple of retries when the organizer is busy. Twenty is far above that
 * and far below anything that matters: minting is cheap, each code retires the
 * last, and only one can be live at a time.
 */
export const CHECKIN_CODE_RATE_LIMIT = Number(process.env.CHECKIN_CODE_RATE_LIMIT)
  || (DEMO_MODE ? 1000 : 20);

export const checkinCodeLimiter = rateLimit({
  store: createRedisLimitStore({ name: 'checkin-code' }),
  windowMs: 15 * 60 * 1000,
  limit: CHECKIN_CODE_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: hashedUserKey,
  handler: limitHandler('You have refreshed your check-in code too many times.'),
});

/** Exported for its own unit test; the middleware above is hard to drive. */
export { TokenBucketStore };
