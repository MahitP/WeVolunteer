import express from 'express';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { buildImpact } from '../impact.js';

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

export default router;
