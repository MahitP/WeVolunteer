/**
 * The ceiling on how many reports one account can file in a day.
 *
 * ── Why a limiter at all ──
 *
 * Report-bombing is the obvious abuse of this surface, and it is trivially
 * available: eleven of the eighteen categories self-select into the urgent lane
 * and `something_feels_wrong` needs no prose, so burying a real report behind a
 * hundred fake ones costs a student about a minute. `idx_reports_no_dup` stops
 * the same target being reported twice, so the flood has to spread across
 * targets — which this bounds.
 *
 * ── Why it is keyed on the account, not the address ──
 *
 * The reasoning `mailLimiter` records applies here with full force: a school
 * NATs its whole campus behind one address. An IP-keyed limiter would let one
 * student spend the district's entire allowance and lock every other student out
 * of reporting — on the surface where being locked out is most costly. The key
 * is the hashed user id, so the limiter's own store never holds a raw identifier.
 *
 * `ipKeyGenerator` is used for the unauthenticated fallback rather than `req.ip`
 * directly. express-rate-limit refuses a bare `req.ip` in a custom key generator
 * because an IPv6 client gets a fresh address per request and can walk around
 * any per-address limit; the helper normalises to the /56 prefix. In practice
 * this branch is unreachable — the limiter is always mounted after
 * `authenticateToken` — but a fallback that silently does nothing is worse than
 * no fallback, and the library logs a validation error for it at import.
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';

import { DEMO_MODE } from './config.js';
import { limitHandler } from './rateLimitResponse.js';

/**
 * Twenty a day. Enough that no honest student meets it — the queue's own
 * duplicate suppression means twenty reports is twenty distinct things — and low
 * enough that a flood is over before it buries anything.
 *
 * `REPORT_RATE_LIMIT` exists so a test can drive the limiter to its ceiling:
 * DEMO_MODE raises it to 1000, which is high enough that a test claiming to
 * prove the limiter fires would pass without ever reaching it.
 */
export const REPORT_LIMIT = Number(process.env.REPORT_RATE_LIMIT) || (DEMO_MODE ? 1000 : 20);

export const reportLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: REPORT_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    if (!req.user?.id) return ipKeyGenerator(req.ip);
    return createHash('sha256').update(req.user.id).digest('hex');
  },
  handler: limitHandler('You have reached the maximum number of reports allowed in 24 hours.'),
});
