import express from 'express';
import { db } from '../db.js';
import { authenticateToken, inTransaction } from '../utils.js';
import { DEMO_MODE } from '../config.js';
import { requireAAL2 } from '../authz.js';
import { ChallengeNotSpent, refuseReauth, spendChallenge } from '../reauthResponses.js';
import rateLimit from 'express-rate-limit';
import fs from 'fs';

const router = express.Router();

/**
 * Three archive builds per address per fifteen minutes.
 *
 * The DEMO_MODE ceiling matches every other limiter in this application (see
 * app.js): the seeded demo shares one address, and so does the whole test suite,
 * so a production-tight limit there throttles the fixtures rather than an
 * attacker. This limiter was the one outlier without that escape, which stopped
 * mattering only because there were two export tests; step-up gave the endpoint
 * enough of them to hit it.
 */
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: Number(process.env.EXPORT_RATE_LIMIT) || (DEMO_MODE ? 1000 : 3),
  message: { error: 'Too many export requests from this IP, please try again after 15 minutes' }
});

/**
 * Queues a full copy of everything this account holds.
 *
 * ── Why this gained a gate it never had (v1.2b Task 6) ──
 *
 * This was the one endpoint in the enumeration with no step-up at all: an
 * authenticated request and a rate limit, and a complete personal-data archive
 * lands in a downloadable file. That is bulk PII egress about a minor, and it is
 * precisely what somebody holding a borrowed or stolen session would take —
 * quietly, in one request, without changing anything the account holder would
 * later notice. Deletion, password and email all demanded a credential; the one
 * action that copies everything out demanded nothing.
 *
 * `requireAAL2` sits BEFORE `exportLimiter` deliberately. The limiter allows
 * three requests per fifteen minutes, and a client that has not yet verified
 * gets a 403 telling it to — so counting those refusals would mean two honest
 * export attempts exhaust the window. The gate itself costs no query beyond the
 * one `authenticateToken` has already done.
 */
router.post('/api/privacy/export', authenticateToken, requireAAL2('data.export'), exportLimiter, (req, res) => {
  const userId = req.user.id;

  /**
   * Checked BEFORE the grant is spent.
   *
   * "You already have an export running" is a refusal of the request, so it must
   * not cost the user the verification they just performed — they would have to
   * do it again for an export that never started.
   */
  const existingJob = db.prepare(`
    SELECT id, status FROM data_export_jobs
    WHERE user_id = ? AND status IN ('pending', 'processing')
  `).get(userId);

  if (existingJob) {
    return res.status(409).json({ error: 'An export is already in progress.', status: existingJob.status });
  }

  const jobId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    inTransaction(() => {
      // Spent with the job it authorises: no export queued without a spent
      // grant, and no spent grant without a queued export.
      spendChallenge(db, req, 'data.export', {});

      db.prepare(`
        INSERT INTO data_export_jobs (id, user_id, status, created_at)
        VALUES (?, ?, 'pending', ?)
      `).run(jobId, userId, new Date().toISOString());

      // Audit log
      const auditId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
        VALUES (?, ?, 'DATA_EXPORT_REQUESTED', ?, 'User requested a data export', ?)
      `).run(auditId, userId, userId, new Date().toISOString()); // Note: Using admin_audit_logs for system logs for now, or we could skip it since WeVolunteer just has admin_audit_logs
    });

    res.status(202).json({ message: 'Export request queued', jobId });
  } catch (error) {
    if (error instanceof ChallengeNotSpent) return refuseReauth(res, error.result);
    console.error('Failed to queue export:', error);
    res.status(500).json({ error: 'Failed to request export' });
  }
});

router.get('/api/privacy/export/status', authenticateToken, (req, res) => {
  const userId = req.user.id;

  const job = db.prepare(`
    SELECT id, status, created_at, completed_at, expires_at 
    FROM data_export_jobs 
    WHERE user_id = ? 
    ORDER BY created_at DESC LIMIT 1
  `).get(userId);

  if (!job) {
    return res.json({ status: 'none' });
  }

  res.json(job);
});

router.get('/api/privacy/export/download/:id', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const jobId = req.params.id;

  const job = db.prepare(`
    SELECT id, user_id, status, file_location, expires_at 
    FROM data_export_jobs 
    WHERE id = ?
  `).get(jobId);

  /**
   * A foreign export is answered exactly like a missing one.
   *
   * This used to return 403 'Unauthorized to access this export' for somebody
   * else's export and 404 for a nonexistent id. No data crossed — the ownership
   * check held — but the two codes together are an existence oracle, and export ids
   * are `export-${Date.now()}-${6 chars}`, so the timestamp half is guessable. That
   * made "did this student request a copy of their personal data around this time"
   * discoverable by any other authenticated student.
   *
   * Collapsing both to 404 matches the convention the messaging routes already
   * follow and are tested on: an uninvolved student reading another's conversation
   * gets 404 rather than 403, so existence never leaks. This endpoint was the
   * outlier. Covered by server/privacyExportIdor.test.js.
   */
  if (!job || job.user_id !== userId) {
    return res.status(404).json({ error: 'Export not found' });
  }

  if (job.status !== 'completed' || !job.file_location) {
    return res.status(400).send('Export is not ready for download');
  }

  if (new Date(job.expires_at) < new Date()) {
    return res.status(410).send('Export has expired');
  }

  if (!fs.existsSync(job.file_location)) {
    return res.status(404).send('Export file is missing from server');
  }

  res.download(job.file_location, 'wevolunteer-data-export.zip', (err) => {
    if (err) {
      console.error('Error downloading file:', err);
    } else {
      // Log successful download
      try {
        const auditId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        db.prepare(`
          INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
          VALUES (?, ?, 'DATA_EXPORT_DOWNLOADED', ?, 'User downloaded data export', ?)
        `).run(auditId, userId, userId, new Date().toISOString());
      } catch (e) {
        console.error('Audit log failed:', e);
      }
    }
  });
});

export default router;
