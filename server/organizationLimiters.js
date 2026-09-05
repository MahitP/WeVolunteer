import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';

import { DEMO_MODE } from './config.js';
import { limitHandler } from './rateLimitResponse.js';
import { createRedisLimitStore } from './redis/limitStore.js';

/**
 * The two throttles the organization membership feature needs.
 *
 * Both are abuse-shaped rather than volume-shaped — a request that presents a
 * token, and a request to join a club — so both carry a Redis store, under the
 * rule `redis/limitStore.js` sets out: shared counters go to the throttles that
 * tick on failure or on abuse and are therefore rare, never to the blanket
 * volume limiters that would spend the free tier in an afternoon.
 */

/**
 * Attempts to resolve an invitation token, per device.
 *
 * ── Why this is modelled on `verifyLimiter` and not on `apiLimiter` ──
 *
 * The public endpoint is unauthenticated by design: somebody handed a link has
 * no account, which is the whole point. So there is no principal to key on and
 * no other guard standing between it and being hammered. `verifyLimiter` — the
 * certificate check — is the same shape and the same trade, and this copies its
 * two deliberate choices:
 *
 *   • **Successes are counted.** No `skipSuccessfulRequests`. A successful
 *     resolution is exactly what enumeration looks like from outside, and
 *     skipping successes would leave the one case worth bounding unbounded.
 *
 *   • **The refusal must not read as a verdict on the link.** A club sharing a
 *     link with thirty students in one lesson is the expected way to reach this,
 *     and telling them a working link is invalid would be worse than making them
 *     wait.
 *
 * Guessing is not the threat this bounds — the token is 256 bits, so the rate
 * limit is irrelevant to a search of that space. What it bounds is somebody
 * walking a list of tokens harvested elsewhere, and the cost of an unauthenticated
 * endpoint being used as a free database probe.
 *
 * ── Why the number is 120 and not 20 ──
 *
 * `verifyLimiter` sits at 20 because one school office checks a handful of
 * printouts. The expected shape HERE is the opposite: a teacher puts a club's
 * link on the board and thirty students open it in the same lesson, from one
 * school address, inside one window — and the signed-in ones resolve the token
 * here too before being redirected. At 20 the students at the back of the class
 * would be told the link does not work, which is the failure this whole feature
 * exists to avoid.
 *
 * 120 covers a full year group and is still far below anything useful as a probe
 * against a 256-bit space. It matches `MAIL_IP_CEILING`, which reasons about the
 * same campus from the same starting point.
 */
export const ORG_INVITE_RATE_LIMIT = Number(process.env.ORG_INVITE_RATE_LIMIT)
  || (DEMO_MODE ? 1000 : 120);

export const shareTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  store: createRedisLimitStore({ name: 'org-invite' }),
  limit: ORG_INVITE_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler(
    'Too many invitation links checked from this device. This is not a verdict on the link.'
  ),
});

/**
 * Joining, and asking to join, per ACCOUNT.
 *
 * This is the ONLY limiter on the authenticated join route, and the reason it is
 * not `shareTokenLimiter` as well is the same reason that one is keyed on the
 * address: a school NATs its whole campus, so an address-keyed limiter on a
 * route a class uses together refuses the students at the back. That route has a
 * principal; the public one does not.
 *
 * ── Keyed on the account, never the address ──
 *
 * The reasoning `checkinLimiters.js`, `mailLimiter` and `reportLimiter` all
 * record: a school NATs its whole campus behind one address. A class of thirty
 * students joining the same club in the same lesson — which is precisely what a
 * teacher sharing a link produces — would share one per-address budget, and the
 * students at the back would be told to stop. The key is a SHA-256 of the user
 * id, so the limiter's own store never holds a raw identifier.
 *
 * `ipKeyGenerator` is the unauthenticated fallback rather than a bare `req.ip`,
 * because express-rate-limit refuses a bare `req.ip` in a custom key generator:
 * an IPv6 client gets a fresh address per request and walks around any
 * per-address limit. Unreachable in practice — every route carrying this sits
 * behind `authenticateToken` — but a fallback that silently does nothing is
 * worse than no fallback.
 *
 * ── What the number is for ──
 *
 * Not the join itself, which is idempotent and cheap. It bounds two things: a
 * client looping `POST …/membership` with different tokens to find one that
 * works, and a script filing requests at every club on the platform to fill
 * managers' queues. Twenty per quarter hour is far above anything a person does
 * — joining three clubs and changing their mind twice — and far below either of
 * those.
 */
export const ORG_JOIN_RATE_LIMIT = Number(process.env.ORG_JOIN_RATE_LIMIT)
  || (DEMO_MODE ? 1000 : 20);

const hashedUserKey = (req, res) => {
  const id = req.user?.id ?? req.principal?.userId;
  if (!id) return ipKeyGenerator(req.ip);
  return createHash('sha256').update(id).digest('hex');
};

export const joinAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  store: createRedisLimitStore({ name: 'org-join' }),
  limit: ORG_JOIN_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: hashedUserKey,
  handler: limitHandler('Too many attempts to join organizations. Please wait a few minutes.'),
});
