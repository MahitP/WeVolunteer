import express from 'express';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { buildImpact, buildPublicImpact } from '../impact.js';

const router = express.Router();

/**
 * GET /api/impact — the community impact figures.
 *
 * ── One endpoint, not one per figure ──
 *
 * The screen shows the whole picture at once, and the figures are read against
 * each other: total hours means something different beside the number of
 * volunteers than it does alone. Six endpoints would let a client render four of
 * them and quietly omit the two that made the others honest.
 *
 * ── No filters, deliberately ──
 *
 * A date range or a category filter here would be a way to ask about smaller and
 * smaller groups until a bucket describes one person, which is precisely what
 * `MIN_BUCKET` exists to prevent. The suppression cannot be applied to a query
 * it does not know about. If filtering is ever wanted, the threshold has to be
 * applied to the FILTERED set and the endpoint has to refuse ranges that make
 * every bucket suppressed, rather than returning an empty page that looks like
 * "nothing happened".
 *
 * ── Cost ──
 *
 * Five aggregate queries over `attendance` joined to `slots` and `events`. It is
 * not cached: these tables are small, the figures are read rarely, and a cache
 * is a second source of truth for numbers whose whole value is being the first
 * one. If it ever needs one, the cache belongs in front of this handler with an
 * explicit age shown on the page — a stale impact figure presented as live is
 * the failure this comment exists to prevent.
 */
router.get('/api/impact', authenticateToken, requireCap('analytics.impact'), (req, res) => {
  try {
    res.json(buildImpact(db));
  } catch (err) {
    console.error('Failed to build impact figures:', err);
    res.status(500).json({ error: 'Could not load the impact figures.' });
  }
});

/**
 * GET /api/public/impact — the figures anybody may see, with no account.
 *
 * ── Why this exists ──
 *
 * Three of the four reasons the impact figures were built — marketing, grant
 * applications, community trust — are about people who do not have an account and
 * are not going to make one. A grant reviewer will not sign up, and a link that
 * asks them to is a link they close.
 *
 * ── Why it is a SEPARATE route and not a relaxed gate ──
 *
 * `/api/impact` answers to somebody the platform can name. This answers to
 * anybody at all, including somebody who already knows things about a particular
 * school and wants one more number to line them up against. Two audiences, two
 * threat models, two handlers — and `buildPublicImpact` names the fields it emits
 * rather than filtering the private payload, so a breakdown added to
 * `buildImpact` later cannot arrive here by inheritance.
 *
 * ── No `authenticateToken`, deliberately ──
 *
 * Adding it would make this an authenticated route with no capability gate, which
 * is exactly the shape `authz.completeness.test.js` Guard 2 exists to catch, and
 * it would be the wrong shape: there is no principal here and nothing that varies
 * by who is asking. The response is identical for every caller, which is the
 * property that makes it safe to publish and also the property that makes it
 * cacheable by anything in front of the server.
 *
 * The blanket `apiLimiter` still applies — this is under `/api` — so the endpoint
 * cannot be used to hammer five aggregate queries in a loop.
 */
router.get('/api/public/impact', (req, res) => {
  try {
    res.json(buildPublicImpact(db));
  } catch (err) {
    console.error('Failed to build public impact figures:', err);
    res.status(500).json({ error: 'Could not load the community figures.' });
  }
});

export default router;
