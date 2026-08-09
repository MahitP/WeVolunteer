import express from 'express';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { buildImpact, buildAdminImpact } from '../impact.js';

const router = express.Router();

/**
 * GET /api/impact — the community impact figures.
 *
 * ── Who may read them ──
 *
 * `analytics.impact`, which is held by `admin` and (through the `'*'` wildcard)
 * `super_admin`, and by nobody below. It used to be held by every signed-in role;
 * see the note beside it in `authz.js`, which carries the reasoning. Nothing in
 * this file expresses the policy — the capability does — which is what lets the
 * rail, the client route and this handler agree by naming one word.
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
 * GET /api/admin/impact — the platform-wide figures, for the owner.
 *
 * ── What this replaced ──
 *
 * `/api/public/impact`, which took no session at all and served a deliberately
 * small payload to anybody on the internet. That endpoint is deleted rather
 * than gated, and `routes.adminImpact.test.js` asserts it 404s, because the
 * reason it existed — marketing, grant applications, community trust, none of
 * which needs an account — turned out not to be what the figures were wanted
 * for. They are an internal view of how the programme is doing.
 *
 * ── Why a separate route rather than a parameter on `/api/impact` ──
 *
 * `/api/impact` answers `analytics.impact`, which administrators hold. This
 * answers `analytics.platform`, which is SUPER_ONLY. Keeping them as two routes
 * means the gate is a property of the URL rather than of a branch inside a
 * handler, which is the form `authz.completeness.test.js` can actually check.
 *
 * The payload is a superset today (see `buildAdminImpact`) and that is safe
 * precisely because the audience is narrower: a super_admin holds `'*'` and can
 * already read everything `/api/impact` returns.
 */
router.get('/api/admin/impact', authenticateToken, requireCap('analytics.platform'), (req, res) => {
  try {
    res.json(buildAdminImpact(db));
  } catch (err) {
    console.error('Failed to build admin impact figures:', err);
    res.status(500).json({ error: 'Could not load the community figures.' });
  }
});

export default router;
