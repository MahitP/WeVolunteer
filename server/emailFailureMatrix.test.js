import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  sendEmail,
  enqueueMessage,
  recordQueueOutcome,
  sweepSentMessages,
  nextAttemptDelay,
  setProvidersForTests,
  setOutboxHandle,
  MESSAGE_CHANNEL,
  QUEUE_MAX_ATTEMPTS,
} from './emailService.js';
import {
  FAILURE,
  EmailSendError,
  classifyResendResponse,
  classifySmtpError,
  redactAddresses,
} from './emailProviders.js';
import up47 from './migrations/047_email_outbox.js';

/**
 * The failure matrix.
 *
 * ── What this file is for ──
 *
 * The three-layer send — Resend, then SMTP, then a durable queue — is a set of
 * rules about what happens when things go wrong, and every one of those rules is
 * invisible on a good day. The only way any of it is known to work is to make
 * each failure happen on purpose and watch which layer catches it.
 *
 * The properties that matter, and what breaks if each is wrong:
 *
 *   - A success must STOP. If a delivered message still reaches the fallback or
 *     the queue, every recipient gets it twice.
 *   - A transient failure must fall through and then be queued. If it is not, a
 *     four-second blip is a student who never receives a verification link, on a
 *     platform where verification gates the account.
 *   - A bad address must NOT be queued. Otherwise one typo becomes six retries
 *     over an hour and an exhaustion alert, against the sending domain's
 *     reputation.
 *   - A template bug must never look like a delivery failure, or the person on
 *     call is sent to a provider dashboard showing everything healthy.
 *
 * The providers are fakes rather than a mocked module: the contract is three
 * methods, and asserting against the real interface is what makes these cases
 * mean anything if the implementation is rewritten.
 */

/** A provider that does exactly what a case needs and records what it was given. */
function fakeProvider(name, behaviour) {
  const sent = [];
  return {
    name,
    sent,
    isConfigured: () => true,
    describe: () => ({ provider: name, configured: true }),
    async send(message) {
      sent.push(message);
      const result = typeof behaviour === 'function' ? behaviour(message, sent.length) : behaviour;
      if (result instanceof Error) throw result;
      return result || { messageId: `${name}-id-${sent.length}`, provider: name };
    },
  };
}

const failWith = (category, provider) =>
  new EmailSendError(`${provider} failed (${category})`, { category, provider });

const MESSAGE = {
  to: 'student@school.example.org',
  subject: 'Please verify your email',
  text: 'Verify at https://wevolunteers.org/?verify=abc',
  html: '<p>Verify</p>',
};

let db;
let restore = null;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE notification_jobs (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      error_log TEXT,
      created_at TEXT NOT NULL
    )
  `);
  /* The real migration, not a hand-written copy of what it is believed to do —
     otherwise these cases pass against a schema production does not have. */
  up47.up(db);
  setOutboxHandle(db);
});

afterEach(() => {
  if (restore) { restore(); restore = null; }
  setOutboxHandle(null);
  db.close();
});

const rows = () => db.prepare('SELECT * FROM notification_jobs').all();

/* ─────────────────────── the fallback rules ─────────────────────── */

describe('a success stops everything after it', () => {
  it('does not touch the fallback and does not queue', async () => {
    const resend = fakeProvider('resend', { messageId: 're_123' });
    const smtp = fakeProvider('smtp', {});
    restore = setProvidersForTests({ resend, smtp });

    const r = await sendEmail(MESSAGE, { flow: 'verification' });

    expect(r.delivered).toBe(true);
    expect(r.provider).toBe('resend');
    expect(r.messageId).toBe('re_123');
    expect(r.queued).toBe(false);
    /* The duplicate-delivery guard. If this ever fires, every recipient on the
       platform is getting two of everything. */
    expect(smtp.sent, 'the fallback was used after a success').toHaveLength(0);
    expect(rows(), 'a delivered message was queued').toHaveLength(0);
  });
});

describe('a transient failure falls through, then queues', () => {
  it('uses the fallback when the primary is rate limited', async () => {
    const resend = fakeProvider('resend', () => failWith(FAILURE.RATE_LIMIT, 'resend'));
    const smtp = fakeProvider('smtp', { messageId: 'smtp-1' });
    restore = setProvidersForTests({ resend, smtp });

    const r = await sendEmail(MESSAGE, { flow: 'password-reset' });

    expect(r.delivered).toBe(true);
    expect(r.provider).toBe('smtp');
    expect(smtp.sent).toHaveLength(1);
    expect(rows(), 'a message the fallback delivered was also queued').toHaveLength(0);
  });

  it('queues when BOTH providers fail', async () => {
    const resend = fakeProvider('resend', () => failWith(FAILURE.TRANSIENT, 'resend'));
    const smtp = fakeProvider('smtp', () => failWith(FAILURE.TRANSIENT, 'smtp'));
    restore = setProvidersForTests({ resend, smtp });

    const r = await sendEmail(MESSAGE, { flow: 'verification' });

    expect(r.delivered).toBe(false);
    expect(r.queued).toBe(true);
    expect(r.permanent).toBe(false);

    const [row] = rows();
    expect(row.channel).toBe(MESSAGE_CHANNEL);
    expect(row.status).toBe('pending');
    expect(row.recipient).toBe(MESSAGE.to);
    expect(row.subject).toBe(MESSAGE.subject);
    expect(row.idempotency_key).toBeTruthy();
    /* The body has to survive, or the retry sends a different email than the one
       that was composed. */
    expect(JSON.parse(row.payload).html).toBe(MESSAGE.html);
  });

  it('retries the SAME provider before falling through', async () => {
    /* The fallback is for an outage, not a hiccup. Every message that fails over
       is sent from a relay with a thinner reputation for this domain. */
    let calls = 0;
    const resend = fakeProvider('resend', () => {
      calls++;
      return calls < 2 ? failWith(FAILURE.TRANSIENT, 'resend') : { messageId: 're_ok' };
    });
    const smtp = fakeProvider('smtp', { messageId: 'smtp-1' });
    restore = setProvidersForTests({ resend, smtp });

    const r = await sendEmail(MESSAGE, { flow: 'verification' });

    expect(r.provider).toBe('resend');
    expect(calls).toBe(2);
    expect(smtp.sent, 'fell through on a single transient blip').toHaveLength(0);
  });
});

describe('a bad address is permanent and is never queued', () => {
  it('does not try the fallback and does not write a row', async () => {
    const resend = fakeProvider('resend', () => failWith(FAILURE.INVALID_RECIPIENT, 'resend'));
    const smtp = fakeProvider('smtp', { messageId: 'smtp-1' });
    restore = setProvidersForTests({ resend, smtp });

    const r = await sendEmail(MESSAGE, { flow: 'verification' });

    expect(r.delivered).toBe(false);
    expect(r.permanent).toBe(true);
    expect(r.category).toBe(FAILURE.INVALID_RECIPIENT);
    expect(smtp.sent, 'a second provider was asked to deliver to a bad address').toHaveLength(0);
    expect(rows(), 'an undeliverable address was queued for retry').toHaveLength(0);
  });

  it('treats an outright refusal the same way', async () => {
    const resend = fakeProvider('resend', () => failWith(FAILURE.PERMANENT_REJECT, 'resend'));
    const smtp = fakeProvider('smtp', { messageId: 'smtp-1' });
    restore = setProvidersForTests({ resend, smtp });

    const r = await sendEmail(MESSAGE, { flow: 'verification' });
    expect(r.permanent).toBe(true);
    expect(smtp.sent).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });
});

describe('a misconfigured primary falls through but is not hammered', () => {
  it('tries the fallback once and does not loop on the auth failure', async () => {
    const resend = fakeProvider('resend', () => failWith(FAILURE.AUTH_CONFIG, 'resend'));
    const smtp = fakeProvider('smtp', { messageId: 'smtp-1' });
    restore = setProvidersForTests({ resend, smtp });

    const r = await sendEmail(MESSAGE, { flow: 'verification' });

    expect(r.delivered).toBe(true);
    expect(r.provider).toBe('smtp');
    /* A wrong key will not be right in 500ms, and repeatedly presenting a bad
       one is how an account gets suspended. */
    expect(resend.sent, 'a bad key was retried in a loop').toHaveLength(1);
  });
});

describe('a template bug is not a delivery failure', () => {
  it('throws, touches no provider and queues nothing', async () => {
    const resend = fakeProvider('resend', { messageId: 're_1' });
    const smtp = fakeProvider('smtp', { messageId: 'smtp-1' });
    restore = setProvidersForTests({ resend, smtp });

    await expect(
      sendEmail({ ...MESSAGE, subject: '' }, { flow: 'verification' })
    ).rejects.toThrow(/rendering bug/i);

    expect(resend.sent, 'an unsendable message reached a provider').toHaveLength(0);
    expect(smtp.sent).toHaveLength(0);
    expect(rows(), 'a rendering bug was queued as if retrying could fix it').toHaveLength(0);
  });

  it('refuses a message with no body at all', async () => {
    restore = setProvidersForTests({
      resend: fakeProvider('resend', { messageId: 're_1' }),
      smtp: fakeProvider('smtp', {}),
    });
    await expect(
      sendEmail({ to: 'a@b.example', subject: 'Hi', text: '', html: '' }, { flow: 'verification' })
    ).rejects.toThrow(/neither an HTML nor a text body/i);
  });
});

/* ─────────────────────── provider transparency ─────────────────────── */

describe('the recipient cannot tell which provider delivered', () => {
  it('hands both providers a byte-identical message', async () => {
    const resend = fakeProvider('resend', () => failWith(FAILURE.TRANSIENT, 'resend'));
    const smtp = fakeProvider('smtp', { messageId: 'smtp-1' });
    restore = setProvidersForTests({ resend, smtp });

    await sendEmail(MESSAGE, { flow: 'verification' });

    const viaResend = resend.sent[0];
    const viaSmtp = smtp.sent[0];

    /* Everything a mail client shows a human. If any of these can differ, the
       fallback is observable and "which provider sent this" becomes a question a
       recipient can answer — and a support question nobody can. */
    for (const field of ['to', 'from', 'replyTo', 'subject', 'text', 'html']) {
      expect(viaSmtp[field], `${field} differed between providers`).toEqual(viaResend[field]);
    }
    expect(viaSmtp.idempotencyKey).toEqual(viaResend.idempotencyKey);
  });
});

/* ─────────────────────── idempotency and the queue ─────────────────────── */

describe('idempotency', () => {
  it('collapses a repeated enqueue of the same message to one row', async () => {
    const key = 'verification:user-42:attempt-1';
    await enqueueMessage({ ...MESSAGE, idempotencyKey: key }, { flow: 'verification', handle: db });
    await enqueueMessage({ ...MESSAGE, idempotencyKey: key }, { flow: 'verification', handle: db });

    expect(rows(), 'the same message was queued twice').toHaveLength(1);
  });

  it('keeps two genuinely different messages apart', async () => {
    await enqueueMessage({ ...MESSAGE, idempotencyKey: 'a' }, { flow: 'password-reset', handle: db });
    await enqueueMessage({ ...MESSAGE, idempotencyKey: 'b' }, { flow: 'password-reset', handle: db });
    /* Two resets a minute apart are two messages. A key derived from the body
       would have silently collapsed them and sent only the first. */
    expect(rows()).toHaveLength(2);
  });

  it('carries the key to the provider so a lost response cannot duplicate', async () => {
    const resend = fakeProvider('resend', { messageId: 're_1' });
    restore = setProvidersForTests({ resend, smtp: fakeProvider('smtp', {}) });

    await sendEmail(MESSAGE, { flow: 'verification', idempotencyKey: 'key-xyz' });
    expect(resend.sent[0].idempotencyKey).toBe('key-xyz');
  });
});

describe('queue bookkeeping', () => {
  const seed = async () => {
    await enqueueMessage({ ...MESSAGE, idempotencyKey: 'k1' }, { flow: 'verification', handle: db });
    return rows()[0];
  };

  it('records the provider and message id on success, and drops the body', async () => {
    const job = await seed();
    await recordQueueOutcome(job.id, {
      ok: true, provider: 'resend', messageId: 're_final',
      attempts: [{ provider: 'resend', category: null, at: 'now' }],
    }, { handle: db });

    const [row] = rows();
    expect(row.status).toBe('sent');
    expect(row.provider_message_id).toBe('re_final');
    expect(row.sent_by_provider).toBe('resend');
    expect(row.sent_at).toBeTruthy();
    /* A queued password-reset body carries a live single-use link. Once nothing
       will re-send it, there is no reason for that copy to outlive the attempt. */
    const payload = JSON.parse(row.payload);
    expect(payload.html, 'the rendered body outlived its last attempt').toBeUndefined();
    expect(payload.text).toBeUndefined();
  });

  it('schedules a retry with a category and a later attempt time', async () => {
    const job = await seed();
    await recordQueueOutcome(job.id, {
      ok: false, category: FAILURE.TRANSIENT, attemptCount: 1,
      error: new Error('relay hiccup'), attempts: [],
    }, { handle: db });

    const [row] = rows();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error_category).toBe(FAILURE.TRANSIENT);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    /* The body must SURVIVE a retryable failure — it is what the retry sends. */
    expect(JSON.parse(row.payload).html).toBe(MESSAGE.html);
  });

  it('gives up at the attempt ceiling and clears the body', async () => {
    const job = await seed();
    await recordQueueOutcome(job.id, {
      ok: false, category: FAILURE.TRANSIENT, attemptCount: QUEUE_MAX_ATTEMPTS,
      error: new Error('still down'), attempts: [],
    }, { handle: db });

    const [row] = rows();
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.payload).html).toBeUndefined();
  });

  it('sweeps delivered rows once they are older than the window', async () => {
    const job = await seed();
    await recordQueueOutcome(job.id, { ok: true, provider: 'smtp', messageId: 'x', attempts: [] }, { handle: db });

    expect(await sweepSentMessages({ handle: db, olderThanMs: 60_000 }), 'swept a fresh row').toBe(0);
    expect(rows()).toHaveLength(1);

    expect(await sweepSentMessages({ handle: db, olderThanMs: -1 })).toBe(1);
    expect(rows()).toHaveLength(0);
  });

  it('never sweeps a row that has not been delivered', async () => {
    await seed();
    expect(await sweepSentMessages({ handle: db, olderThanMs: -1 })).toBe(0);
    expect(rows(), 'an undelivered message was swept away').toHaveLength(1);
  });
});

describe('backoff', () => {
  it('grows, stays bounded, and is jittered', () => {
    const at = (n) => nextAttemptDelay(n, FAILURE.TRANSIENT);
    expect(at(0)).toBeLessThan(at(3));
    expect(at(20)).toBeLessThanOrEqual(60 * 60 * 1000 * 1.25);

    /* Without jitter, an outage that fails two hundred messages schedules all
       two hundred to retry in the same millisecond, and the recovery attempt is
       the next outage. */
    const samples = new Set(Array.from({ length: 20 }, () => at(3)));
    expect(samples.size, 'the backoff is not jittered').toBeGreaterThan(1);
  });

  it('backs off harder for a rate limit than for a blip', () => {
    const transient = Array.from({ length: 40 }, () => nextAttemptDelay(2, FAILURE.TRANSIENT));
    const limited = Array.from({ length: 40 }, () => nextAttemptDelay(2, FAILURE.RATE_LIMIT));
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(limited)).toBeGreaterThan(mean(transient));
  });

  it('never schedules a retry in the past', () => {
    for (let n = 0; n < 12; n++) expect(nextAttemptDelay(n)).toBeGreaterThan(0);
  });
});

/* ─────────────────────── classification ─────────────────────── */

describe('failure classification', () => {
  it('reads Resend status codes the way the retry policy needs', () => {
    expect(classifyResendResponse(429, {})).toBe(FAILURE.RATE_LIMIT);
    expect(classifyResendResponse(500, {})).toBe(FAILURE.TRANSIENT);
    expect(classifyResendResponse(503, {})).toBe(FAILURE.TRANSIENT);
    expect(classifyResendResponse(401, {})).toBe(FAILURE.AUTH_CONFIG);
    expect(classifyResendResponse(403, {})).toBe(FAILURE.AUTH_CONFIG);
    expect(classifyResendResponse(422, { name: 'invalid_to' })).toBe(FAILURE.INVALID_RECIPIENT);
  });

  it('calls an unverified sending domain configuration, not a bad address', () => {
    /* The single most likely failure on the day the domain is switched over. If
       it were read as a bad recipient it would be marked permanent and dropped —
       every message, silently, with no queue row to find afterwards. */
    const c = classifyResendResponse(403, { name: 'validation_error', message: 'The domain is not verified' });
    expect(c).toBe(FAILURE.AUTH_CONFIG);
    const c2 = classifyResendResponse(422, { name: 'validation_error', message: 'from address is not verified' });
    expect(c2).toBe(FAILURE.AUTH_CONFIG);
  });

  it('reads SMTP codes', () => {
    expect(classifySmtpError({ code: 'EAUTH' })).toBe(FAILURE.AUTH_CONFIG);
    expect(classifySmtpError({ code: 'EENVELOPE' })).toBe(FAILURE.INVALID_RECIPIENT);
    expect(classifySmtpError({ code: 'ECONNREFUSED' })).toBe(FAILURE.TRANSIENT);
    expect(classifySmtpError({ responseCode: 421 })).toBe(FAILURE.TRANSIENT);
    expect(classifySmtpError({ responseCode: 550 })).toBe(FAILURE.INVALID_RECIPIENT);
    expect(classifySmtpError({ responseCode: 554 })).toBe(FAILURE.PERMANENT_REJECT);
  });

  it('treats an unrecognised failure as transient', () => {
    /* Retrying something permanent costs a few attempts. Discarding something
       transient costs a student their verification email. */
    expect(classifySmtpError({})).toBe(FAILURE.TRANSIENT);
  });
});

describe('provider errors do not carry the recipient', () => {
  it('keeps the domain and drops the local part', () => {
    const redacted = redactAddresses('550 5.1.1 <jane.doe@school.example.org> user unknown');
    expect(redacted).not.toContain('jane.doe');
    /* The domain is what diagnoses a relay or SPF problem; the local part
       identifies a specific child and diagnoses nothing. */
    expect(redacted).toContain('school.example.org');
  });
});
