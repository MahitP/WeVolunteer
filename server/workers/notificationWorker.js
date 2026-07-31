import { db } from '../db.js';
import { sendMail, buildHtmlTemplate, escapeHtml } from '../email.js';
import { getInAppContent } from '../services/notificationContent.js';

const APP_NAME = process.env.APP_NAME || 'WeVolunteer';
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? null : 'http://localhost:5173');

/** Attempts before a job is abandoned. Unchanged from the original behaviour. */
const MAX_ATTEMPTS = 5;

/**
 * How long a job may sit in `processing` before it is presumed orphaned.
 *
 * A send that is genuinely in flight finishes in seconds; anything still claimed
 * after this was almost certainly claimed by a process that no longer exists.
 * Ten minutes is deliberately generous — reclaiming too eagerly would deliver the
 * same notification twice, which is worse than delivering it late.
 */
const STALE_PROCESSING_MS = Number(process.env.NOTIFICATION_STALE_MS) || 10 * 60 * 1000;

/**
 * Returns jobs stranded in `processing` to `pending`.
 *
 * The worker claims a job by setting `status = 'processing'` before awaiting the
 * send, but the pickup query selects only `status = 'pending'`. Nothing reclaimed
 * a claimed row, so any process death between the claim and the result — which is
 * to say every `systemctl restart` that lands mid-send — orphaned that
 * notification permanently. Acceptance and cancellation notices are precisely what
 * sits in this queue, so the loss is silent and it matters.
 *
 * Runs at startup (a restart recovers its own orphans) and on every tick (so a
 * crash during a long-running batch recovers without waiting for a redeploy).
 *
 * Jobs that already exhausted `MAX_ATTEMPTS` are moved to `failed` rather than
 * back to `pending` — retrying past the cap would loop forever against a
 * permanently undeliverable address.
 */
export function reclaimStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();

  try {
    const stale = db.prepare(`
      SELECT id, attempts FROM notification_jobs
      WHERE status = 'processing' AND next_attempt_at <= ?
    `).all(cutoff);

    if (stale.length === 0) return 0;

    const toPending = db.prepare(
      "UPDATE notification_jobs SET status = 'pending' WHERE id = ?"
    );
    const toFailed = db.prepare(
      "UPDATE notification_jobs SET status = 'failed', error_log = ? WHERE id = ?"
    );

    let reclaimed = 0;
    for (const job of stale) {
      if (job.attempts >= MAX_ATTEMPTS) {
        toFailed.run('abandoned: attempts exhausted while processing', job.id);
        continue;
      }
      toPending.run(job.id);
      reclaimed++;
    }

    if (reclaimed > 0) {
      console.warn(
        `[Worker] Reclaimed ${reclaimed} notification job(s) stranded in "processing" — `
        + 'a previous run was interrupted mid-send.'
      );
    }
    return reclaimed;
  } catch (err) {
    // Reclaiming is best-effort recovery. If it cannot run, the tick that follows
    // must still be attempted rather than the whole loop dying here.
    console.error('[Worker] Notification job reclaim failed:', err);
    return 0;
  }
}

/**
 * Queue depth and failure counts, for the admin system-status endpoint.
 *
 * Jobs that exhausted their attempts used to land in `status = 'failed'` with the
 * reason in a column nobody reads — no log line, no metric, no view. An SMTP
 * outage lasting longer than the ~62 minutes of backoff discarded every queued
 * notification and the only way to find out was to query SQLite by hand.
 */
export function getQueueHealth() {
  try {
    const byStatus = db.prepare(
      'SELECT status, COUNT(*) AS c FROM notification_jobs GROUP BY status'
    ).all();
    const counts = Object.fromEntries(byStatus.map(r => [r.status, r.c]));
    const oldest = db.prepare(
      "SELECT MIN(created_at) AS t FROM notification_jobs WHERE status = 'pending'"
    ).get();

    return {
      pending: counts.pending || 0,
      processing: counts.processing || 0,
      failed: counts.failed || 0,
      oldestPendingAt: oldest?.t || null
    };
  } catch (err) {
    console.error('[Worker] Could not read notification queue health:', err);
    return { pending: null, processing: null, failed: null, oldestPendingAt: null, error: true };
  }
}

/**
 * Processes up to ten due jobs.
 *
 * ── Why the whole body is wrapped ──
 *
 * The `SELECT` used to sit outside any `try`, and this function is driven by
 * `setInterval` with no `.catch`. A database error there — a lock held past
 * `busy_timeout`, a full disk — rejected the returned promise with nothing
 * listening, and Node's default `--unhandled-rejections=throw` turns that into
 * process termination. systemd restarts on failure, so a persistent fault burned
 * `StartLimitBurst=5` within 120 seconds and left the service DOWN until someone
 * ran `systemctl reset-failed`. A full disk should degrade mail delivery, not take
 * the whole platform offline with no alert.
 *
 * The per-job bookkeeping in the catch block is wrapped for the same reason: a
 * database too unhealthy to send is also too unhealthy to record the failure.
 */
export async function processNotificationJobs() {
  try {
    reclaimStaleJobs();

    const pendingJobs = db.prepare(`
      SELECT * FROM notification_jobs
      WHERE status = 'pending' AND next_attempt_at <= ?
      LIMIT 10
    `).all(new Date().toISOString());

    for (const job of pendingJobs) {
      // The claim doubles as the staleness clock: reclaimStaleJobs compares
      // next_attempt_at against its cutoff, so stamping it now means a job
      // abandoned by a crash becomes reclaimable STALE_PROCESSING_MS later.
      db.prepare(
        "UPDATE notification_jobs SET status = 'processing', next_attempt_at = ? WHERE id = ?"
      ).run(new Date().toISOString(), job.id);

      try {
        if (job.channel === 'email') {
          await handleEmailJob(job);
        } else {
          throw new Error(`Unknown channel: ${job.channel}`);
        }

        // On success, we just delete the job to save space
        db.prepare("DELETE FROM notification_jobs WHERE id = ?").run(job.id);
      } catch (err) {
        try {
          const newAttempts = job.attempts + 1;
          const backoffMs = Math.pow(2, newAttempts) * 60000;
          const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
          const exhausted = newAttempts >= MAX_ATTEMPTS;
          const status = exhausted ? 'failed' : 'pending';

          db.prepare(`
            UPDATE notification_jobs
            SET status = ?, attempts = ?, next_attempt_at = ?, error_log = ?
            WHERE id = ?
          `).run(status, newAttempts, nextAttemptAt, String(err.message), job.id);

          if (exhausted) {
            // The one place a permanently lost notification becomes visible.
            console.error(
              `[Worker] Notification job ${job.id} FAILED permanently after `
              + `${newAttempts} attempts: ${err.message}`
            );
          } else {
            console.warn(
              `[Worker] Notification job ${job.id} attempt ${newAttempts} failed `
              + `(retrying): ${err.message}`
            );
          }
        } catch (bookkeepingErr) {
          console.error(
            `[Worker] Could not record failure for notification job ${job.id}:`,
            bookkeepingErr
          );
        }
      }
    }
  } catch (err) {
    // Terminal for this tick only. The interval fires again in ten seconds.
    console.error('[Worker] Notification job loop failed for this tick:', err);
  }
}

async function handleEmailJob(job) {
  const { event, payload, userId } = JSON.parse(job.payload);
  
  const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');
  
  const content = getInAppContent(event, payload);
  const subject = content.title;
  let text = content.body;
  
  let ctaText = null;
  let ctaUrl = null;
  
  if (content.link) {
    if (content.link.startsWith('event:')) {
      const eventId = content.link.split(':')[1];
      ctaText = 'View Event Details';
      ctaUrl = `${APP_URL}/?event=${eventId}`;
    } else {
      ctaText = 'View Details';
      ctaUrl = `${APP_URL}${content.link}`;
    }
  }
  
  /**
   * Every database value is escaped before it enters the HTML.
   *
   * `user.name` is set by the account holder; `title` and `location` below are free
   * text an organizer types. Unescaped, an event titled
   * `Beach Cleanup <a href="https://evil.example">Confirm here</a>` puts a working
   * phishing link inside genuine WeVolunteer mail, sent from the district's domain
   * and passing its SPF/DKIM, to every student on the shift.
   *
   * `\n` → `<br/>`, not `\\n`. The regex was `/\\n/g`, which matches a literal
   * backslash followed by "n" — so real newlines in a notification body were never
   * converted and the paragraph ran together. Escaping happens first so the `<br/>`
   * tags this inserts survive.
   */
  const bodyHtml = escapeHtml(text).replace(/\n/g, '<br/>');

  let htmlContent = `
    <p style="font-size: 16px; margin-bottom: 24px;">Hi ${escapeHtml(user.name)},</p>
    <p style="font-size: 16px; line-height: 1.5;">${bodyHtml}</p>
  `;

  if (payload && payload.eventId) {
    try {
      /**
       * The shift time comes from `slots`, not `events`.
       *
       * This query used to select `e.start_datetime` — a column that does not exist
       * on `events` (it is on `slots`). So it threw `no such column` on EVERY
       * notification email, the catch below logged it, and the entire event-details
       * card — date, time, location, organizer — silently never rendered. Students
       * have been receiving notification mail with no shift details in it at all.
       *
       * MIN(start_datetime) is the event's first shift, which is the right thing to
       * show when the notification is about the event rather than one slot. A
       * payload that names a specific slot uses that instead.
       */
      const dbEvent = db.prepare(`
        SELECT e.title,
               e.location,
               u.name AS org_name,
               (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) AS start_datetime
        FROM events e
        LEFT JOIN users u ON e.organizer_id = u.id
        WHERE e.id = ?
      `).get(payload.eventId);

      const slotStart = payload.slotId
        ? db.prepare('SELECT start_datetime FROM slots WHERE id = ?').get(payload.slotId)?.start_datetime
        : null;
      const startAt = slotStart || dbEvent?.start_datetime;

      if (dbEvent) {
        // An event with no slots yet has no date to show, so the row is omitted
        // rather than rendering "Invalid Date".
        const when = startAt
          ? `${new Date(startAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`
            + ` at ${new Date(startAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
          : null;

        htmlContent += `
          <div style="margin-top: 24px; padding: 16px; background-color: #f7f7f5; border-radius: 8px; border-left: 4px solid #0f6b45;">
            <h3 style="margin: 0 0 8px 0; font-size: 18px; color: #14231c;">${escapeHtml(dbEvent.title)}</h3>
            ${when ? `<p style="margin: 0 0 4px 0; font-size: 14px; color: #66736d;"><strong>Date:</strong> ${escapeHtml(when)}</p>` : ''}
            <p style="margin: 0 0 4px 0; font-size: 14px; color: #66736d;"><strong>Location:</strong> ${escapeHtml(dbEvent.location || 'TBA')}</p>
            <p style="margin: 0; font-size: 14px; color: #66736d;"><strong>Organizer:</strong> ${escapeHtml(dbEvent.org_name || 'Unknown')}</p>
          </div>
        `;
      }
    } catch (e) {
      console.error('[Worker] Failed to append event details to email:', e);
    }
  }

  const html = buildHtmlTemplate(subject, htmlContent, ctaText, ctaUrl);

  if (content.link) {
    // Real newlines. This was `\\n\\n`, which in a template literal emits a
    // backslash and an "n" — so the plain-text part of every notification email
    // literally read `...\n\nLink: https://...`.
    text += `\n\nLink: ${ctaUrl}`;
  }

  await sendMail({
    to: user.email,
    subject: `${subject} - ${APP_NAME}`,
    text,
    html
  });
}

let workerInterval = null;

/**
 * Starts the outbox processor.
 *
 * The interval callback is wrapped in a `.catch` even though
 * `processNotificationJobs` already handles its own errors — belt and braces,
 * because an unhandled rejection here terminates the process and the cost of the
 * extra guard is nothing. `setInterval` does not await the returned promise, so
 * without it any future refactor that lets an error escape becomes a crash rather
 * than a log line.
 *
 * Reclaiming runs once synchronously at startup so a restart recovers the jobs its
 * own predecessor stranded, without waiting a full tick.
 */
export function startNotificationWorker() {
  if (workerInterval) return;

  reclaimStaleJobs();

  workerInterval = setInterval(() => {
    processNotificationJobs().catch(err => {
      console.error('[Worker] Notification tick rejected unexpectedly:', err);
    });
  }, 10000);

  // Lets the process exit on its own if this is the only thing left holding the
  // loop open. Shutdown clears the interval explicitly; this covers the case
  // where it does not get the chance.
  workerInterval.unref?.();

  console.log('[Worker] Notification outbox processor started.');
}

/**
 * Stops the outbox processor.
 *
 * Required for graceful shutdown: without it the interval keeps the event loop
 * alive and `httpServer.close()` never lets the process exit, so systemd waits out
 * its timeout and sends SIGKILL — turning every restart into the abrupt stop the
 * shutdown handler exists to avoid.
 */
export function stopNotificationWorker() {
  if (!workerInterval) return;
  clearInterval(workerInterval);
  workerInterval = null;
  console.log('[Worker] Notification outbox processor stopped.');
}

/** Whether the interval is currently armed. Used by shutdown and by tests. */
export function isRunning() {
  return workerInterval !== null;
}
