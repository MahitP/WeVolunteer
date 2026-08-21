import express from 'express';
import { runInTransaction } from '../db/connectionContext.js';
import { db } from '../db.js';
import { authenticateToken } from '../utils.js';
import { DEMO_MODE } from '../config.js';
import { requireAAL2 } from '../authz.js';
import { ChallengeNotSpent, refuseReauth, spendChallenge } from '../reauthResponses.js';
import { recordAudit } from '../auditLog.js';
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
router.post('/api/privacy/export', authenticateToken, requireAAL2('data.export'), exportLimiter, async (req, res) => {
  const userId = req.user.id;

  /**
   * Checked BEFORE the grant is spent.
   *
   * "You already have an export running" is a refusal of the request, so it must
   * not cost the user the verification they just performed — they would have to
   * do it again for an export that never started.
   */
  const existingJob = await db.prepare(`
    SELECT id, status FROM data_export_jobs
    WHERE user_id = ? AND status IN ('pending', 'processing')
  `).get(userId);

  if (existingJob) {
    return res.status(409).json({ error: 'An export is already in progress.', status: existingJob.status });
  }

  const jobId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await runInTransaction(db, async (tx) => {
      // Spent with the job it authorises: no export queued without a spent
      // grant, and no spent grant without a queued export.
      await spendChallenge(tx, req, 'data.export', {});

      await tx.prepare(`
        INSERT INTO data_export_jobs (id, user_id, status, created_at)
        VALUES (?, ?, 'pending', ?)
      `).run(jobId, userId, new Date().toISOString());

      // Audit log. admin_id is the account itself — this is a self-service
      // action and the column is NOT NULL with a foreign key, so there is no
      // administrator to name. (admin_audit_logs is the only audit table this
      // application has; it carries system rows as well as admin ones.)
      await recordAudit(tx, {
        adminId: userId,
        action: 'DATA_EXPORT_REQUESTED',
        targetUserId: userId,
        details: 'User requested a data export'
      });
    });

    res.status(202).json({ message: 'Export request queued', jobId });
  } catch (error) {
    if (error instanceof ChallengeNotSpent) return refuseReauth(res, error.result);
    console.error('Failed to queue export:', error);
    res.status(500).json({ error: 'Failed to request export' });
  }
});

router.get('/api/privacy/export/status', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  const job = await db.prepare(`
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

/**
 * Hands over the archive, behind a fresh proof of identity for THIS archive.
 *
 * ── Why the gate had to be here too (v1.2b audit, F-1) ──
 *
 * `POST /api/privacy/export` above was gated and this was not, which protected
 * the request and not the disclosure. An archive lives seven days
 * (`exportWorker.js`), and `GET /api/privacy/export/status` hands its id to any
 * authenticated caller — so for a week after any legitimate export, the
 * complete personal-data archive of a mostly-minor population was retrievable
 * by anyone holding a borrowed session, having proved nothing. The gate raised
 * the bar only while no archive existed, which is the window in which there was
 * nothing to take.
 *
 * `data.download` rather than `data.export`, and it binds `jobId`: a grant
 * authorises pulling down ONE archive, not "anything export-shaped". See the
 * registry entry for the full reasoning.
 *
 * ── Ordering ──
 *
 * Every refusal below — foreign or missing job, not ready, expired, file gone —
 * is answered BEFORE the grant is spent, for the same reason the
 * "already in progress" check precedes the spend on the request endpoint: a
 * request that delivers nothing must not cost the user a verification they then
 * have to repeat. The spend is the last thing before the bytes move.
 */
router.get('/api/privacy/export/download/:id', authenticateToken, requireAAL2('data.download'), async (req, res) => {
  const userId = req.user.id;
  const jobId = req.params.id;

  const job = await db.prepare(`
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

  /**
   * Spent last, and bound to the id in the path — the archive actually about to
   * be sent, never a value the caller could vary independently of the write.
   *
   * Once this commits, the grant is gone whether or not the transfer below
   * completes. That is the honest trade: `res.download` streams outside any
   * transaction, so there is no way to make "the bytes arrived" atomic with
   * "the grant was spent", and of the two failure directions the safe one is a
   * user re-verifying after a broken download rather than a spendable grant
   * left behind by one that succeeded.
   */
  try {
    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, 'data.download', { jobId });
    });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
    console.error('Failed to spend the download verification:', err);
    return res.status(500).json({ error: 'Failed to download export' });
  }

  /**
   * The archive must not be written to any cache.
   *
   * `res.download` delegates to the `send` library, which defaults to
   * `Cache-Control: public, max-age=0` — observed on the wire, not assumed. On a
   * zip containing one (usually minor) person's complete record, `public` is the
   * wrong word: it invites shared caches to store it, and it lets the browser
   * write the body to its on-disk HTTP cache, where it outlives the tab. That is
   * the same threat `src/utils/stepUp.js` reasons about when it keeps grants in
   * `sessionStorage` rather than `localStorage` — the shared school Chromebook
   * somebody walks away from.
   *
   * Set here rather than passed as an option because `send` only supplies its
   * own value when the header is absent, so an explicit one wins; the regression
   * test asserts the emitted header rather than this call, since that is the
   * only form of the check that survives a library upgrade changing the rule.
   *
   * This does not weaken the step-up gate — a cached copy would have bypassed it
   * entirely, which is why it belongs with that fix rather than after it.
   */
  res.set('Cache-Control', 'no-store');

  res.download(job.file_location, 'wevolunteer-data-export.zip', async (err) => {
    if (err) {
      console.error('Error downloading file:', err);
    } else {
      /**
       * Log successful download.
       *
       * The one call site in the application that catches. `recordAudit` never
       * swallows — every other caller runs inside a transaction where a failed
       * audit must take the work down with it — but this runs in `res.download`'s
       * completion callback, after the archive has already been streamed to the
       * user. There is no response left to fail and no transaction left to roll
       * back, so a throw here would be an unhandled exception in a callback
       * rather than an error anybody sees.
       *
       * The cost is real and is stated rather than hidden: a database failure at
       * this instant loses the record that the archive was collected, while the
       * archive still leaves. That is the wrong trade for a download of a
       * personal-data export and it is recorded as a finding rather than fixed
       * here — moving the audit ahead of `res.download`, so it is written before
       * the bytes move and can refuse the download, is a behaviour change beyond
       * this task's "convert the call sites, refactor nothing" boundary.
       */
      try {
        await recordAudit(db, {
          adminId: userId,
          action: 'DATA_EXPORT_DOWNLOADED',
          targetUserId: userId,
          details: 'User downloaded data export'
        });
      } catch (e) {
        console.error('Audit log failed:', e);
      }
    }
  });
});

export default router;
