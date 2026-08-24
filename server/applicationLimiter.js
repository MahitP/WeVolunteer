/**
 * How fast one student may apply, as distinct from how much they may hold.
 *
 * ── Why this exists alongside PENDING_APPLICATION_LIMIT ──
 *
 * These are two different controls and neither one implies the other. The
 * quota in `config.js` bounds outstanding STATE — how many opportunities a
 * student can have waiting for a decision at once. This bounds the RATE of
 * requests, and it is what stops the quota being trivially churned: withdraw,
 * apply, withdraw, apply. Withdrawal is deliberately free and leaves no record,
 * for good reasons recorded in `applicationRoutes.js`, so the quota alone puts
 * no ceiling at all on how many applications a script can create and discard in
 * a minute.
 *
 * Before either existed, `POST /api/events/:id/apply` had no bound but the
 * blanket per-IP `/api` ceiling. It is the highest write-amplification path in
 * the product: five reads, a write, an organizer notification, and a fan-out
 * notification to every friend of the applicant.
 *
 * ── The key is the user, not the address ──
 *
 * Same reasoning as `reportLimiter` and `mailLimiter`, and it applies here with
 * particular force. A school NATs its whole campus behind one address, and
 * applying is the single most common thing a student does on this platform. An
 * IP-keyed limiter would let one enthusiastic student — or one script — spend
 * the district's whole allowance and lock every other student out of signing up
 * for anything. On signup morning that is not an edge case, it is the morning.
 *
 * The key is a hash of the user id so the limiter's in-memory store never holds
 * a raw identifier. `ipKeyGenerator` is the unauthenticated fallback: it is
 * unreachable in practice because the limiter mounts after `authenticateToken`,
 * but a fallback that silently does nothing is worse than no fallback, and
 * express-rate-limit logs a validation error for a bare `req.ip`.
 *
 * ── Thirty a quarter-hour ──
 *
 * Applying is a deliberate act with a form behind it. A student browsing on a
 * free period and signing up for a burst of shifts is plausibly a dozen or two;
 * thirty leaves room for that plus mistakes and re-applications, and it is not
 * loose enough to matter for a script, which wants thousands. The quota is what
 * bounds the outcome; this bounds the traffic and the notification fan-out
 * getting there.
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';

import { DEMO_MODE } from './config.js';
import { limitHandler } from './app.js';

/**
 * `APPLICATION_RATE_LIMIT` exists so a test can drive the limiter to its
 * ceiling: DEMO_MODE raises it high enough that a test claiming to prove the
 * limiter fires would pass without ever reaching it.
 */
export const APPLICATION_LIMIT = Number(process.env.APPLICATION_RATE_LIMIT) || (DEMO_MODE ? 1000 : 30);

export const applicationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: APPLICATION_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (!req.user?.id) return ipKeyGenerator(req, res);
    return createHash('sha256').update(req.user.id).digest('hex');
  },
  handler: limitHandler('You have applied to a lot of shifts in a short time.'),
});
