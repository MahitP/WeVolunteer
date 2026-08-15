import { db } from '../db.js';
import { recordError } from '../errorReporter.js';
import { sendMail, buildHtmlTemplate, escapeHtml } from '../email.js';
import { getInAppContent } from '../services/notificationContent.js';
import {
  MESSAGE_CHANNEL,
  QUEUE_MAX_ATTEMPTS,
  attemptDelivery,
  recordQueueOutcome,
  sweepSentMessages,
} from '../emailService.js';
import { TERMINAL, EmailApplicationError } from '../emailProviders.js';

/**
 * The notification kinds whose email may carry the shift's date, time,
 * location and organizer.
 *
 * Every one of these is a message to somebody who is GOING, or was going: the
 * details are the useful part, and the recipient already has them from the
 * event page. A kind that is absent from this set gets the plain body and the
 * link, and nothing else.
 *
 * `FRIEND_SIGNED_UP` is the reason this set exists. It is a message ABOUT
 * another student, it carries an `eventId` only so the in-app row can link
 * somewhere, and its in-app copy is written to name no time and no place. An
 * email that appended a street address and an hour under a named minor's name
 * undid all of that, into an inbox that may be shared, forwarded, or retained
 * indefinitely.
 *
 * Add to this set deliberately. The default for anything new is no card.
 */
const EVENT_CARD_EVENTS = new Set([
  'APPLICATION_ACCEPTED',
  'APPLICATION_WAITLISTED',
  'WAITLIST_PROMOTED',
  'EVENT_REMINDER_24H',
  'EVENT_REMINDER_2H',
  'EVENT_DEADLINE_APPROACHING',
  'EVENT_CANCELLED',
  'EVENT_UPDATED',
  'EVENT_LOCATION_CHANGED',
  'EVENT_TIME_CHANGED',
  'HOURS_APPROVED',
  'HOURS_ADJUSTED',
  'CERTIFICATE_AVAILABLE',
  'REMOVED_FROM_EVENT',
  'SCHEDULE_CONFLICT_WARNING',
]);


const APP_NAME = process.env.APP_NAME || 'WeVolunteer';
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? null : 'http://localhost:5173');

/** Attempts before a job is abandoned. Unchanged from the original behaviour. */
const MAX_ATTEMPTS = 5;

/** Ticks since start, so the delivered-row sweep does not run every ten seconds. */
let sweepCounter = 0;

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
    reportWorkerError(err, 'reclaimStuckJobs');
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
    reportWorkerError(err, 'getQueueHealth');
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

    /**
     * Delivered rows are kept so the queue can answer "did it go out?", which
     * means something has to remove them or the table becomes a permanent record
     * of every address the platform has ever mailed. A day is long enough for a
     * same-morning support question and short enough that this is not a growing
     * pile of the email addresses of minors.
     *
     * Counted rather than run every tick: the tick is ten seconds and this is a
     * whole-table delete. Every hundredth tick is roughly every seventeen
     * minutes, which is far more often than a one-day window needs.
     */
    if (sweepCounter++ % 100 === 0) {
      try {
        const removed = sweepSentMessages({ handle: db });
        if (removed > 0) console.log(`[Worker] Swept ${removed} delivered mail rows.`);
      } catch (err) {
        /* Housekeeping must never stop delivery. */
        console.error('[Worker] Could not sweep delivered mail rows:', err.message);
      }
    }

    const pendingJobs = db.prepare(`
      SELECT * FROM notification_jobs
      WHERE status = 'pending' AND next_attempt_at <= ?
      LIMIT 10
    `).all(new Date().toISOString());

    for (const job of pendingJobs) {
      /**
       * The claim doubles as the staleness clock: reclaimStaleJobs compares
       * next_attempt_at against its cutoff, so stamping it now means a job
       * abandoned by a crash becomes reclaimable STALE_PROCESSING_MS later.
       *
       * `AND status = 'pending'` is the part that makes this a CLAIM rather than
       * a label. The select and the update are two statements, so between them
       * another worker — a second process, a stray `npm run dev` against the
       * same file, a restart overlapping its predecessor — can select the same
       * row. Guarding on the status the row was selected with means exactly one
       * of them wins and the loser skips, which is enforced here rather than
       * being a property of how the service happens to be deployed. Without it,
       * two workers both send, and the person gets the email twice.
       */
      const claim = db.prepare(
        "UPDATE notification_jobs SET status = 'processing', next_attempt_at = ?, updated_at = ? "
        + "WHERE id = ? AND status = 'pending'"
      ).run(new Date().toISOString(), new Date().toISOString(), job.id);
      if (claim.changes === 0) continue;

      try {
        if (job.channel === 'email') {
          await handleEmailJob(job);
          /* Delivered, or deliberately dropped. Either way it is finished and the
             row carries no provider result worth keeping — see the DROPPED
             return in handleEmailJob. */
          db.prepare("DELETE FROM notification_jobs WHERE id = ?").run(job.id);
        } else if (job.channel === MESSAGE_CHANNEL) {
          const outcome = await handleMessageJob(job);
          if (outcome.ok) {
            /* Kept, not deleted, and swept a day later. The one question an
               operator asks during a mail incident is "did that verification
               email actually go out", and a deleted row cannot answer it. */
            recordQueueOutcome(job.id, outcome, { handle: db });
          } else {
            recordQueueOutcome(job.id, {
              ...outcome,
              attemptCount: job.attempts + 1,
            }, { handle: db });

            if (TERMINAL.has(outcome.category) || job.attempts + 1 >= QUEUE_MAX_ATTEMPTS) {
              const err = new Error(`queued mail failed: ${outcome.category}`);
              console.error(
                `[Worker] Queued message ${job.id} FAILED permanently (${outcome.category}).`
              );
              reportWorkerError(err, 'notificationJobExhausted', { jobId: job.id });
            }
          }
        } else {
          throw new Error(`Unknown channel: ${job.channel}`);
        }
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
            /**
             * Reported HERE and not in the outer catch, deliberately.
             *
             * A single delivery failure is an expected operational condition —
             * SMTP is unreliable, which is why this queue has backoff and an
             * attempt ceiling at all — and reporting each retry would drown the
             * dashboard in the noise it exists to cut through. Exhaustion is
             * different: the comment above calls this "the one place a
             * permanently lost notification becomes visible", and a notification
             * nobody will ever receive is a defect, not weather.
             */
            reportWorkerError(err, 'notificationJobExhausted', { jobId: job.id });
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
          // Failing to WRITE the retry bookkeeping is a database problem, not a
          // delivery problem, and it silently strands the job.
          reportWorkerError(bookkeepingErr, 'notificationBookkeeping', { jobId: job.id });
        }
      }
    }
  } catch (err) {
    // Terminal for this tick only. The interval fires again in ten seconds.
    console.error('[Worker] Notification job loop failed for this tick:', err);
    reportWorkerError(err, 'notificationTick');
  }
}

/**
 * Records a background failure, or does nothing at all.
 *
 * A worker error is the worst kind to lose: nobody is watching a background job,
 * so an exception here is invisible until somebody notices the work stopped
 * happening. `recordError` never throws, so this adds no failure mode to a
 * catch block — the wrapper exists to keep the five call sites in this file
 * identical, not to add safety `recordError` already provides.
 *
 * `source: 'worker'` rather than 'server': these did not arrive on a request,
 * they have no route, and grouping them together is what makes "the notification
 * worker is broken" one line on a dashboard instead of five.
 */
function reportWorkerError(err, boundary, context = {}) {
  recordError(db, {
    source: 'worker',
    kind: err?.constructor?.name || 'Error',
    message: err?.message,
    stack: err?.stack,
    context: { component: 'notificationWorker', boundary, ...context }
  });
}

async function handleEmailJob(job) {
  const { event, payload, userId } = JSON.parse(job.payload);

  const user = db.prepare('SELECT email, name, account_status FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');

  /**
   * A deleted account is not a delivery failure. Drop the job.
   *
   * Deletion is a SOFT delete — accountRoutes.js anonymises the row and rewrites
   * the address to `deleted_<id>@system.local`, because certificates, attendance
   * and the hours ledger hang off that id and are kept indefinitely. It does not
   * clear `notification_jobs`, which has no `user_id` column to clear it by (the
   * id is inside the JSON payload).
   *
   * So anything already queued for that person used to be posted to the
   * placeholder. `.local` is reserved by RFC 6762 and resolves nowhere, so in
   * production that meant five attempts over ~62 minutes of backoff, then
   * `status = 'failed'`, then `notificationJobExhausted` — a dashboard row and an
   * alert email, for mail that was correctly undeliverable.
   *
   * The damage is to the alert channel, not the mail. A student exercising their
   * deletion right manufactured false alerts in the one place that is supposed to
   * mean "something is broken", and a hard bounce per attempt against the
   * district's sending domain. An alert channel that cries wolf gets filtered,
   * and then the next real outage is missed.
   *
   * Checked HERE rather than purged at deletion time on purpose: this also covers
   * a job enqueued by a request that lost the race with the deletion, needs no
   * `json_extract` scan inside the deletion transaction, and needs no schema
   * change.
   *
   * Deliberately narrow — `deleted` only, never "not active". A SUSPENDED account
   * is the one the platform most needs to reach: the suspension notice carries the
   * appeal link, and appeal outcome notices are mandatory. Widening this would cut
   * off the only channel a suspended student has.
   */
  if (user.account_status === 'deleted') {
    console.log(
      `[Worker] Dropping notification job ${job.id}: the recipient account has been deleted.`
    );
    return;
  }

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
      // `ctaText` lets a notice name its own action. "View Details" on the mail
      // telling a student their account is suspended is the least informative
      // label the product could put on its most consequential button.
      ctaText = content.ctaText || 'View Details';
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

  /**
   * The event-details card is opt-IN by notification kind, not "any payload
   * that happens to carry an eventId".
   *
   * The card renders the shift's date, time, LOCATION and organizer. That is
   * correct in an email to somebody who is going — an acceptance, a reminder, a
   * cancellation — and wrong in an email ABOUT somebody else. `FRIEND_SIGNED_UP`
   * carries an `eventId` purely so the in-app notification can link to the
   * event, and its content case in notificationContent.js is written carefully
   * to name no time and no place for exactly this reason. Keying the card off
   * the presence of `eventId` defeated that: the in-app row said "Ana signed up
   * for Beach Cleanup" and the email said it with a street address and an hour
   * underneath, to an inbox nobody controls.
   *
   * So: an allowlist. A new event-scoped notification gets no card until
   * somebody decides it should have one, which is the safe default for a
   * message about a child's whereabouts.
   */
  if (payload && payload.eventId && EVENT_CARD_EVENTS.has(event)) {
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

  /* `event` decides the sender. An enforcement notice, a legal-policy update and
     a shift reminder are three different kinds of message and no longer leave
     from one address; emailIdentity.js owns that mapping. */
  return sendMail({
    to: user.email,
    subject: `${subject} - ${APP_NAME}`,
    text,
    html,
    event
  });
}

/**
 * Deliver a job that is already a finished message.
 *
 * This is the channel transactional mail falls into when neither provider would
 * take it. There is no user lookup, no content builder and no template: the
 * message was rendered at the moment it was requested and the only thing left to
 * do is put it on a wire. Re-rendering here would be a second code path that
 * could disagree with the first — the recipient would get a different email on
 * the retry than they would have got on the first attempt.
 */
async function handleMessageJob(job) {
  let message;
  try {
    message = JSON.parse(job.payload);
  } catch (err) {
    throw new EmailApplicationError(`queued message payload is not readable: ${err.message}`);
  }

  const outcome = await attemptDelivery({
    to: job.recipient,
    from: message.from,
    replyTo: message.replyTo || null,
    subject: job.subject || message.subject,
    text: message.text || null,
    html: message.html || null,
    headers: message.headers || null,
    /* The same key the first attempt used, so a provider that already accepted
       this message the last time we could not hear the answer does not send a
       second copy. */
    idempotencyKey: job.idempotency_key || null,
  });

  return outcome;
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
