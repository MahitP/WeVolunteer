/**
 * The one place that decides how a message actually gets delivered.
 *
 * ── The three layers ──
 *
 *   1. Resend, over HTTPS. The primary. Deliverability is its whole job.
 *   2. SMTP (the existing Gmail transport). The emergency fallback, used only
 *      when Resend could not take the message.
 *   3. The durable outbox. The safety net: if neither provider took it, the
 *      message is written to the database and retried by the worker until it
 *      goes or until it has demonstrably failed.
 *
 * Everything above this module — `sendVerificationEmail`, the notification
 * worker, the alerting digest — asks for a message to be sent and is told
 * whether it was. None of them knows which provider ran, and none of them
 * contains a branch on one. That is deliberate: the moment provider choice
 * leaks upward, a future edit adds "if Resend then …" to one call site and the
 * other eleven quietly keep the old behaviour.
 *
 * ── The fallback rules, exactly ──
 *
 *   Resend accepted it              -> done. SMTP is NOT tried. Nothing is queued.
 *   Rate limited / 5xx / timeout    -> try SMTP. If SMTP also fails, queue it.
 *   Resend auth or config is wrong  -> try SMTP once (its credentials are
 *                                      unrelated), then queue. Never retried in
 *                                      a loop against the same provider: a
 *                                      wrong key is not going to become right
 *                                      sixty seconds later, and hammering it is
 *                                      how an account gets suspended.
 *   Recipient address is invalid    -> permanent. No fallback, no queue. No
 *                                      provider is going to deliver to an
 *                                      address that does not exist, and a queue
 *                                      row for it is five retries of noise.
 *   Provider permanently refused it -> permanent. No fallback, no queue.
 *   Our own template threw          -> not a delivery failure at all. It is
 *                                      raised to the caller unchanged. See below.
 *
 * ── Why the template case gets its own path ──
 *
 * A rendering bug that reached the queue would be retried five times, fail
 * identically five times, and then be reported as an email delivery problem —
 * pointing whoever is on call at a provider dashboard that shows everything
 * green. `EmailApplicationError` never reaches a provider and never reaches the
 * queue.
 *
 * ── Idempotency ──
 *
 * Every message carries a key. It goes to Resend as `Idempotency-Key`, so a
 * retry that crosses a response we never received does not produce a second
 * copy in somebody's inbox, and it is UNIQUE in the outbox, so enqueueing the
 * same message twice is one row. Callers that do not supply one get a random
 * key, which is correct for genuinely one-off mail — two password resets
 * requested a minute apart are two messages, and deriving the key from the body
 * would silently collapse them into one.
 */
import crypto from 'node:crypto';
import {
  FAILURE,
  TERMINAL,
  EmailApplicationError,
  EmailSendError,
  ResendEmailProvider,
  SmtpEmailProvider,
  assertSendable,
} from './emailProviders.js';
import { identityFor } from './emailIdentity.js';

/** The outbox channel that carries an already-rendered message. */
export const MESSAGE_CHANNEL = 'email.message';

/**
 * The database handle, resolved on first use rather than imported at the top.
 *
 * A static `import { db } from './db.js'` here would put the entire database
 * module — migrations, seeding, the legal-document sync — into the import graph
 * of `email.js`, and `email.js` is imported by the boot guards, by a dozen
 * route modules and by tests that have no database at all. Importing a mail
 * helper should not open a SQLite file.
 *
 * `sendEmail` is already async, so deferring costs nothing, and the only path
 * that needs a database is the one that is about to write a queue row.
 */
let outboxHandle = null;

/** Lets `db.js` or a test hand the handle over without a dynamic import. */
export function setOutboxHandle(handle) {
  outboxHandle = handle;
}

async function outbox() {
  if (outboxHandle) return outboxHandle;
  const mod = await import('./db.js');
  outboxHandle = mod.db;
  return outboxHandle;
}

/** Retries a queued message gets before it is declared failed. */
export const QUEUE_MAX_ATTEMPTS = Number(process.env.MAIL_QUEUE_MAX_ATTEMPTS || 6);

/** How long a delivered row is kept so an operator can answer "did it go out?" */
export const SENT_RETENTION_MS = Number(process.env.MAIL_SENT_RETENTION_MS || 24 * 60 * 60 * 1000);

const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * In-process attempts against ONE provider before falling through to the next.
 *
 * These keep the names they had when they governed the old single-transport
 * retry loop, because they mean the same thing to an operator — "how hard do we
 * try before giving up on this hop" — and renaming a documented environment
 * variable to move it one layer down would be churn for its own sake.
 */
const MAX_PROVIDER_ATTEMPTS = Number(process.env.MAIL_MAX_ATTEMPTS) || 3;
const PROVIDER_RETRY_DELAY_MS = Number(process.env.MAIL_RETRY_DELAY_MS) || 500;

/**
 * Bounded exponential backoff with jitter.
 *
 * The jitter is not a nicety. Without it, a provider outage that fails two
 * hundred queued messages at once schedules all two hundred to retry in the
 * same millisecond, and the recovery attempt is itself the next outage. ±25%
 * spreads them.
 *
 * A rate limit starts a step further along, because the one thing that will not
 * fix "you are sending too fast" is sending again promptly.
 */
export function nextAttemptDelay(attempts, category = FAILURE.TRANSIENT) {
  const step = category === FAILURE.RATE_LIMIT ? attempts + 1 : attempts;
  const flat = Math.min(BASE_BACKOFF_MS * Math.pow(2, step), MAX_BACKOFF_MS);
  const jitter = flat * 0.25 * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(flat + jitter));
}

/* ───────────────────────────── providers ───────────────────────────── */

let smtpProvider = null;
let resendProvider = new ResendEmailProvider();

/**
 * `email.js` owns the nodemailer transport (it builds it, guards it at boot and
 * swaps it under test), so it hands the getter in rather than this module
 * reaching back for it — which would be a cycle.
 */
export function registerSmtpTransport(getTransport, isConfigured) {
  smtpProvider = new SmtpEmailProvider(getTransport, isConfigured);
}

/** Test seam for the failure matrix. Returns a restore function. */
export function setProvidersForTests({ resend, smtp } = {}) {
  const prev = { resend: resendProvider, smtp: smtpProvider };
  if (resend !== undefined) resendProvider = resend;
  if (smtp !== undefined) smtpProvider = smtp;
  return () => { resendProvider = prev.resend; smtpProvider = prev.smtp; };
}

/**
 * Primary first, fallback second. A provider that is not configured is skipped
 * rather than attempted-and-failed, so an install with no Resend key behaves
 * exactly as it did before this module existed.
 */
function providerChain() {
  const chain = [];
  if (resendProvider?.isConfigured()) chain.push(resendProvider);
  if (smtpProvider?.isConfigured()) chain.push(smtpProvider);
  /* Nothing configured at all: still return the SMTP provider so the caller
     gets its real error (in development that transport is the console mock,
     which always succeeds — the behaviour the repo already relies on). */
  if (chain.length === 0 && smtpProvider) chain.push(smtpProvider);
  return chain;
}

/** Safe to log and safe to serve from the admin status endpoint. */
export function describeProviders() {
  return {
    primary: resendProvider ? resendProvider.describe() : null,
    fallback: smtpProvider ? smtpProvider.describe() : null,
  };
}

/* ───────────────────────────── delivery ───────────────────────────── */

/**
 * Walk the provider chain once. Does not queue and does not retry a provider
 * that has already answered — the caller owns both of those decisions.
 *
 * @returns {{ok: true, provider, messageId, attempts}}
 *        | {ok: false, category, error, attempts}
 */
export async function attemptDelivery(message) {
  const attempts = [];
  let last = null;

  for (const provider of providerChain()) {
    /**
     * A provider gets more than one go at a purely transient failure before we
     * fall through to the next one. A dropped connection is not a reason to
     * abandon the primary provider — the fallback is for an outage, not for a
     * hiccup, and every message that fails over is a message sent from a relay
     * whose reputation for this domain is thinner.
     *
     * Only TRANSIENT repeats. A rate limit needs a longer wait than an inline
     * sleep should ever take, and everything else is answered.
     */
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
      try {
        const result = await provider.send(message);
        attempts.push({ provider: provider.name, category: null, at: new Date().toISOString() });
        return { ok: true, provider: provider.name, messageId: result.messageId, attempts };
      } catch (err) {
        const category = err?.category || FAILURE.TRANSIENT;
        attempts.push({ provider: provider.name, category, at: new Date().toISOString() });
        last = err;

        if (category === FAILURE.TRANSIENT && attempt < MAX_PROVIDER_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, PROVIDER_RETRY_DELAY_MS * attempt));
          continue;
        }
        break;
      }
    }

    /* A bad address, or a message the provider refused outright, will be a bad
       address and a refused message at the next provider too. Stop. */
    if (TERMINAL.has(last?.category)) break;
  }

  return {
    ok: false,
    category: last?.category || FAILURE.TRANSIENT,
    error: last,
    attempts,
  };
}

/* ────────────────────────────── the queue ────────────────────────────── */

const now = () => new Date().toISOString();

/**
 * Write a message to the outbox.
 *
 * `INSERT OR IGNORE` against the UNIQUE idempotency key, so enqueueing the same
 * message twice — which is exactly what a retried request does — is one row and
 * one delivery rather than two of each.
 */
export async function enqueueMessage(message, { flow = 'unknown', handle = outboxHandle } = {}) {
  const key = message.idempotencyKey || crypto.randomUUID();
  const stamp = now();

  const payload = JSON.stringify({
    flow,
    from: message.from,
    replyTo: message.replyTo || null,
    subject: message.subject,
    text: message.text || null,
    html: message.html || null,
    headers: message.headers || null,
  });

  const info = await handle.prepare(`
    INSERT INTO notification_jobs
      (id, channel, payload, status, attempts, next_attempt_at, created_at, updated_at,
       idempotency_key, recipient, subject)
    VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  `).run(
    `mail-${crypto.randomUUID()}`,
    MESSAGE_CHANNEL,
    payload,
    stamp,
    stamp,
    stamp,
    key,
    message.to,
    message.subject
  );

  return { queued: info.changes > 0, idempotencyKey: key };
}

/**
 * Record the outcome of a queued attempt.
 *
 * The rendered body is cleared as soon as the row stops being retryable. A
 * queued password-reset body contains a live single-use link; there is no
 * reason for it to outlive the last attempt that might have used it.
 */
export async function recordQueueOutcome(jobId, outcome, { handle = outboxHandle } = {}) {
  const stamp = now();

  if (outcome.ok) {
    const row = await handle.prepare('SELECT payload FROM notification_jobs WHERE id = ?').get(jobId);
    let scrubbed = row?.payload || '{}';
    try {
      const parsed = JSON.parse(scrubbed);
      delete parsed.html;
      delete parsed.text;
      scrubbed = JSON.stringify(parsed);
    } catch { /* leave it; the sweep will remove the row regardless */ }

    await handle.prepare(`
      UPDATE notification_jobs
         SET status = 'sent', sent_at = ?, updated_at = ?, payload = ?,
             provider_message_id = ?, sent_by_provider = ?, provider_attempts = ?,
             last_error_category = NULL
       WHERE id = ?
    `).run(
      stamp, stamp, scrubbed,
      outcome.messageId || null, outcome.provider || null,
      JSON.stringify(outcome.attempts || []), jobId
    );
    return { status: 'sent' };
  }

  const attempts = Number(outcome.attemptCount || 0);
  const terminal = TERMINAL.has(outcome.category) || attempts >= QUEUE_MAX_ATTEMPTS;

  if (terminal) {
    const row = await handle.prepare('SELECT payload FROM notification_jobs WHERE id = ?').get(jobId);
    let scrubbed = row?.payload || '{}';
    try {
      const parsed = JSON.parse(scrubbed);
      delete parsed.html;
      delete parsed.text;
      scrubbed = JSON.stringify(parsed);
    } catch { /* as above */ }

    await handle.prepare(`
      UPDATE notification_jobs
         SET status = 'failed', attempts = ?, updated_at = ?, payload = ?,
             last_error_category = ?, error_log = ?, provider_attempts = ?
       WHERE id = ?
    `).run(
      attempts, stamp, scrubbed, outcome.category || null,
      String(outcome.error?.message || '').slice(0, 500),
      JSON.stringify(outcome.attempts || []), jobId
    );
    return { status: 'failed' };
  }

  const due = new Date(Date.now() + nextAttemptDelay(attempts, outcome.category)).toISOString();
  await handle.prepare(`
    UPDATE notification_jobs
       SET status = 'pending', attempts = ?, next_attempt_at = ?, updated_at = ?,
           last_error_category = ?, error_log = ?, provider_attempts = ?
     WHERE id = ?
  `).run(
    attempts, due, stamp, outcome.category || null,
    String(outcome.error?.message || '').slice(0, 500),
    JSON.stringify(outcome.attempts || []), jobId
  );
  return { status: 'pending', nextAttemptAt: due };
}

/** Drop delivered rows once they are older than the retention window. */
export async function sweepSentMessages({ handle = outboxHandle, olderThanMs = SENT_RETENTION_MS } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { changes } = await handle.prepare(
    "DELETE FROM notification_jobs WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at < ?"
  ).run(cutoff);
  return changes;
}

/* ───────────────────────────── the entry point ───────────────────────────── */

/**
 * Send a message now, falling back and then queueing per the rules at the top.
 *
 * @param {object} message  { to, subject, text, html, ... } — `from`/`replyTo`
 *                          are filled from the identity matrix unless supplied.
 * @param {object} opts     { flow, idempotencyKey, event, queueOnFailure }
 * @returns {Promise<{delivered: boolean, provider?: string, messageId?: string,
 *                    queued: boolean, permanent: boolean, category?: string}>}
 * @throws {EmailApplicationError} if the message itself is not sendable.
 */
export async function sendEmail(message, opts = {}) {
  const { flow = 'notification', event = null, queueOnFailure = true } = opts;

  const identity = identityFor(flow, { event });
  const prepared = {
    ...message,
    from: message.from || identity.from,
    replyTo: message.replyTo === undefined ? identity.replyTo : message.replyTo,
    idempotencyKey: opts.idempotencyKey || message.idempotencyKey || crypto.randomUUID(),
  };

  /* Throws EmailApplicationError. Deliberately NOT caught here: a message we
     could not build is not a message a provider or the queue can help with. */
  assertSendable(prepared);

  const outcome = await attemptDelivery(prepared);

  if (outcome.ok) {
    return {
      delivered: true,
      queued: false,
      permanent: false,
      provider: outcome.provider,
      messageId: outcome.messageId,
      category: null,
    };
  }

  if (TERMINAL.has(outcome.category)) {
    return {
      delivered: false, queued: false, permanent: true,
      category: outcome.category, provider: null, error: outcome.error,
    };
  }

  if (!queueOnFailure) {
    return {
      delivered: false, queued: false, permanent: false,
      category: outcome.category, error: outcome.error,
    };
  }

  /**
   * The outbox is the safety net, and a safety net that can throw is not one.
   *
   * If the queue write fails — the table is missing, the disk is full, the
   * database is locked — the message is already undelivered and the caller
   * already has to cope with that. Turning it into an exception would convert a
   * failed email into a failed HTTP request, so a mail outage would take signup
   * down with it. The failure is logged loudly and reported honestly as
   * "not queued".
   */
  let queued = false;
  try {
    ({ queued } = await enqueueMessage(prepared, { flow, handle: await outbox() }));
  } catch (err) {
    console.error(
      `[Email] ${flow} failed to deliver (${outcome.category}) AND could not be queued: `
      + `${err.message}. This message is lost.`
    );
  }
  return {
    delivered: false, queued, permanent: false,
    category: outcome.category, error: outcome.error,
  };
}

export { FAILURE, TERMINAL, EmailApplicationError, EmailSendError };
