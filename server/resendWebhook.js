import crypto from 'node:crypto';
import { db } from './db.js';

/**
 * Resend delivery events: what happened to a message after it was accepted.
 *
 * ── Why this exists ──
 *
 * The outbox knows Resend TOOK a message. Acceptance is not delivery: a message
 * can be accepted and then hard-bounce because the address does not exist, or be
 * reported as spam. Without this, both look exactly like success, and the
 * message most likely to bounce is the verification email sent to an address a
 * student typed once at signup — so the failure mode is an account nobody can
 * get into and an operator with nothing to look at.
 *
 * ── Why the signature check is hand-rolled ──
 *
 * Resend signs webhooks with the Standard Webhooks scheme (the `svix-id`,
 * `svix-timestamp`, `svix-signature` headers). The scheme is deliberately
 * simple: HMAC-SHA256 over `id.timestamp.body` with a base64 secret. That is
 * fifteen lines of `node:crypto`, and the alternative is a dependency whose
 * only job is those fifteen lines, on a public unauthenticated endpoint. Fewer
 * moving parts on the one route an attacker can reach without a session.
 *
 * The comparison is `timingSafeEqual`, and the length guard before it is not
 * ceremony — `timingSafeEqual` THROWS on a length mismatch, so an attacker
 * sending a short signature would get a 500 instead of a 401, which is both a
 * crash and an oracle.
 *
 * ── What is trusted ──
 *
 * Nothing in the payload, until the signature verifies. After that, only the
 * fields named below, each re-validated for type. The endpoint never reads a
 * body field to decide who it is: the message id in the payload is looked up in
 * our own outbox, and an id we do not recognise is recorded and ignored rather
 * than being allowed to create anything.
 */

/** How far out of step a timestamp may be before the event is refused. */
export const REPLAY_WINDOW_MS = Number(process.env.RESEND_WEBHOOK_TOLERANCE_MS) || 5 * 60 * 1000;

/**
 * The events worth acting on.
 *
 * `opened` and `clicked` are deliberately absent. Resend can send them and the
 * domain has both trackers switched off, which is the right setting for a
 * platform whose recipients are minors: knowing whether a fourteen-year-old
 * opened an email is not operationally useful and is a behavioural record
 * nobody asked to have kept. Delivery, bounce and complaint are about whether
 * the mail system works, which is a different question.
 */
export const HANDLED_EVENTS = Object.freeze({
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
});

/** Outcomes that mean this address should not be mailed again without thought. */
export const TERMINAL_DELIVERY = Object.freeze(['bounced', 'complained']);

/** The signing secret, read at call time so a rotation does not need a restart. */
function signingSecret() {
  const raw = process.env.RESEND_WEBHOOK_SECRET;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * Verifies a Standard Webhooks signature.
 *
 * @param {Buffer|string} rawBody  the bytes as received — NOT a re-serialised object
 * @param {object} headers
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifySignature(rawBody, headers) {
  const secret = signingSecret();
  if (!secret) return { ok: false, reason: 'not_configured' };

  const id = headers['svix-id'] || headers['webhook-id'];
  const timestamp = headers['svix-timestamp'] || headers['webhook-timestamp'];
  const signature = headers['svix-signature'] || headers['webhook-signature'];
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  /**
   * The replay window.
   *
   * The signature alone proves the sender knew the secret at some point; it
   * says nothing about WHEN. Without this, a captured request stays valid
   * forever, and "email.bounced for this message" replayed later would mark a
   * perfectly good address as undeliverable.
   */
  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(Date.now() - sentAt) > REPLAY_WINDOW_MS) return { ok: false, reason: 'stale' };

  /* The secret is `whsec_` followed by base64. The prefix is not part of it. */
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signed = `${id}.${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)}`;
  const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');

  /* The header carries a space-separated list of `v1,<sig>` — more than one
     while a secret is being rotated. Any match is a match. */
  for (const part of String(signature).split(' ')) {
    const value = part.startsWith('v1,') ? part.slice(3) : part;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    /* Length first: timingSafeEqual THROWS on a mismatch, so a short signature
       would be a 500 and an oracle rather than a clean refusal. */
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

/** Keeps the domain, drops the local part. The rule recordFailure already follows. */
const domainOf = (address) => {
  const at = String(address || '').split('@')[1];
  return at ? at.toLowerCase() : null;
};

/**
 * Applies a verified event.
 *
 * Idempotent by construction: the insert into `resend_webhook_events` is what
 * claims the event, and its PRIMARY KEY refuses a duplicate. A replay therefore
 * loses the race with the original rather than being caught by a check two
 * concurrent requests could both pass.
 *
 * @returns {{applied: boolean, reason?: string, state?: string}}
 */
export function applyEvent(payload, { handle = db } = {}) {
  const type = String(payload?.type || '');
  const state = HANDLED_EVENTS[type];

  const eventId = typeof payload?.data?.email_id === 'string' ? payload.data.email_id : null;
  const messageId = eventId;

  /* The provider's own id for this DELIVERY of this event. Falls back to a
     digest of the event's identifying fields when absent, so dedupe still works
     rather than silently degrading to "process everything twice". */
  const deliveryId = typeof payload?.data?.id === 'string' ? payload.data.id
    : crypto.createHash('sha256').update(`${type}|${messageId}|${payload?.created_at ?? ''}`).digest('hex');

  if (!state) return { applied: false, reason: 'unhandled_event' };

  const to = Array.isArray(payload?.data?.to) ? payload.data.to[0] : payload?.data?.to;
  const now = new Date().toISOString();

  /* Claim it. `INSERT OR IGNORE` + `changes` is the whole dedupe. */
  const claimed = handle.prepare(`
    INSERT OR IGNORE INTO resend_webhook_events
      (event_id, event_type, provider_message_id, recipient_domain, occurred_at, received_at, job_id)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(deliveryId, type, messageId, domainOf(to), payload?.created_at ?? null, now);

  if (claimed.changes === 0) return { applied: false, reason: 'duplicate', state };

  if (!messageId) return { applied: true, state, reason: 'no_message_id' };

  /**
   * Match it to an outbox row.
   *
   * A message sent before the outbox existed, or one whose `sent` row has
   * already been swept, matches nothing. That is not an error — the event row
   * above still records the outcome, which is what an operator reads.
   */
  const job = handle.prepare(
    'SELECT id FROM notification_jobs WHERE provider_message_id = ? LIMIT 1'
  ).get(messageId);

  if (!job) return { applied: true, state, reason: 'no_matching_job' };

  handle.prepare(
    'UPDATE resend_webhook_events SET job_id = ? WHERE event_id = ?'
  ).run(job.id, deliveryId);

  /**
   * `delivered` never overwrites a bounce or a complaint.
   *
   * Events are not ordered. Resend may deliver `email.delivered` after
   * `email.bounced` for a message that bounced at a second recipient, and the
   * later-arriving good news would erase the bad. The terminal outcome is the
   * one an operator needs, so it wins regardless of arrival order.
   */
  const existing = handle.prepare(
    'SELECT delivery_state FROM notification_jobs WHERE id = ?'
  ).get(job.id);

  if (TERMINAL_DELIVERY.includes(existing?.delivery_state) && !TERMINAL_DELIVERY.includes(state)) {
    return { applied: true, state, reason: 'terminal_state_kept' };
  }

  handle.prepare(`
    UPDATE notification_jobs
       SET delivery_state = ?, delivery_detail = ?, delivery_updated_at = ?
     WHERE id = ?
  `).run(
    state,
    /* A short reason, never the body. Resend puts the bounce class here. */
    String(payload?.data?.bounce?.type || payload?.data?.reason || '').slice(0, 200) || null,
    now,
    job.id
  );

  return { applied: true, state, jobId: job.id };
}

/** Counts for the admin health view. Safe to serve: no addresses, no bodies. */
export function deliveryHealth({ handle = db, sinceMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  try {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const rows = handle.prepare(
      'SELECT event_type, COUNT(*) AS c FROM resend_webhook_events WHERE received_at > ? GROUP BY event_type'
    ).all(since);
    const byType = Object.fromEntries(rows.map(r => [r.event_type, r.c]));
    return {
      configured: Boolean(signingSecret()),
      windowDays: Math.round(sinceMs / 86_400_000),
      delivered: byType['email.delivered'] || 0,
      bounced: byType['email.bounced'] || 0,
      complained: byType['email.complained'] || 0,
      failed: byType['email.failed'] || 0,
      delayed: byType['email.delivery_delayed'] || 0,
    };
  } catch {
    /* The table arrives with migration 050; a health view must not be the thing
       that breaks a boot which has not run it yet. */
    return { configured: Boolean(signingSecret()), unavailable: true };
  }
}
