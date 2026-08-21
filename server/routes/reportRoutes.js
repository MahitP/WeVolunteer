import express from 'express';
import { authenticateToken } from '../utils.js';
import { createReport } from '../reportService.js';
import { reportLimiter } from '../reportLimiter.js';
import { isValidCategory } from '../moderation.js';

const router = express.Router();

router.post('/api/reports', authenticateToken, reportLimiter, async (req, res) => {
  const { targetType, targetId, reason, details } = req.body;

  /**
   * `reason` is a deprecated alias for `description`, and this mapping is what
   * keeps the shipped client working.
   *
   * The unified model replaced free-text `reason` with a `category` from a fixed
   * taxonomy, and this route passed `reason` straight through as the category.
   * `src/components/ReportModal.jsx` sends the student's own words there — so
   * every report of an event or a comment answered
   * `400 "Choose a reason for the report."` while the modal offered no reasons
   * to choose from. Reproduced against the running server, not inferred: the
   * exact payload the modal sends returns 400; a taxonomy value returns 200.
   *
   * A server that 400s its own shipped client is a self-inflicted outage, and on
   * this surface the outage is a student unable to report a comment. So prose
   * falls back to `other` — a real category, deliberately not a barrier — and
   * the words the student typed are preserved as the description, which is the
   * authoritative content of a report anyway.
   *
   * When the client is rewritten to send a category, this branch stops being
   * taken; it can be removed once no build in the wild sends prose.
   */
  /**
   * A present-but-non-string `reason` is a malformed request, not prose.
   *
   * The fallback below turns anything unrecognised into `other` plus a
   * description, and without this guard an object or an array would sail
   * through as a filed report — reintroducing the 500-shaped class of bug that
   * `routes.malformed.test.js` exists to keep out. Absent is still fine: a
   * category is required, and `createReport` answers for that.
   */
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return res.status(400).json({
      error: 'Choose a reason for the report.', code: 'bad_category',
    });
  }

  const categoryGiven = isValidCategory(reason);
  const category = categoryGiven ? reason : 'other';
  const description = categoryGiven
    ? details
    : [reason, details].filter(t => typeof t === 'string' && t.trim()).join('\n\n') || null;

  const result = await createReport({
    reporter: req.user,
    targetType,
    targetId,
    category,
    description
  });

  if (!result.ok) {
    return res.status(result.status || 400).json({ error: result.error, code: result.code });
  }

  res.status(200).json({ 
    success: true, 
    message: 'Report submitted successfully', 
    reportId: result.reportId,
    duplicate: result.duplicate
  });
});

export default router;
