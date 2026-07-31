import express from 'express';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import rateLimit from 'express-rate-limit';
import fs from 'fs';

const router = express.Router();

const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // limit each IP to 3 export requests per windowMs
  message: { error: 'Too many export requests from this IP, please try again after 15 minutes' }
});

router.post('/api/privacy/export', authenticateToken, exportLimiter, (req, res) => {
  const userId = req.user.id;

  // Check if they already have a pending or processing job
  const existingJob = db.prepare(`
    SELECT id, status FROM data_export_jobs 
    WHERE user_id = ? AND status IN ('pending', 'processing')
  `).get(userId);

  if (existingJob) {
    return res.status(409).json({ error: 'An export is already in progress.', status: existingJob.status });
  }

  const jobId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  try {
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

    res.status(202).json({ message: 'Export request queued', jobId });
  } catch (error) {
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
