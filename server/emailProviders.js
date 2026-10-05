/**
 * The two ways a message can physically leave this server, behind one interface.
 *
 * ── The interface ──
 *
 *   provider.name                    -> 'resend' | 'smtp'
 *   provider.isConfigured()          -> boolean
 *   await provider.send(message)     -> { messageId }
 *
 * `message` is provider-neutral and is the SAME object for both:
 *
 *   { to, from, replyTo, subject, text, html, idempotencyKey, headers? }
 *
 * That sameness is the point. A recipient must not be able to tell which
 * provider delivered their mail — same From, same display name, same Reply-To,
 * same subject, same HTML, same text, same links. There is no `ResendTemplate`
 * and no `GmailTemplate`; there is one rendered message and two pieces of
 * plumbing that carry it.
 *
 * (To be precise about what "identical" can mean: the RAW headers necessarily
 * differ — a different DKIM signature, a different Message-ID domain, a
 * different Received chain. Nothing a mail client shows a human differs. That is
 * the honest version of the guarantee, and it is the one that matters.)
 *
 * ── Why Resend goes over `fetch` and not the SDK ──
 *
 * Node 24 has a stable global `fetch`, and this repo already talks to every
 * third party that way — Nominatim, Open-Meteo, OpenRouteService are all hand-
 * rolled `fetch` calls with their own timeouts and error handling. The Resend
 * REST API is one POST with a JSON body; the SDK wraps that and brings
 * `postal-mime` and `standardwebhooks` along for inbound parsing and webhook
 * verification, neither of which this platform does.
 *
 * The deciding reason is not dependency count, though: it is that the failure
 * classification below branches on HTTP status codes, and a raw status code is
 * a far more reliable thing to branch on than the shape of a wrapped error
 * object across SDK versions. `npm audit --omit=dev` reports zero
 * vulnerabilities today; a platform holding minors' data should not add
 * transitive supply-chain surface for a wrapper it would then have to unwrap.
 *
 * ── Secrets ──
 *
 * The API key is read from the environment at call time, is never logged, never
 * included in a thrown error, and never written to the queue. `describe()`
 * exists so diagnostics can say "resend is configured" without going anywhere
 * near the value.
 */

/**
 * Why a send failed, in the only vocabulary the retry policy understands.
 *
 * The distinction that matters most is the last one. A template that throws
 * while rendering is OUR bug, and dressing it up as a provider failure would
 * send it to the fallback, then to the queue, where it would fail identically
 * five more times and finally be reported as "email provider trouble" — sending
 * an operator to check a provider dashboard that shows everything healthy.
 */
export const FAILURE = {
  /** The provider or the network was briefly unavailable. Retry is reasonable. */
  TRANSIENT: 'transient',
  /** We are sending too fast. Retry, but later, and back off harder. */
  RATE_LIMIT: 'rate_limit',
  /** Credentials or configuration are wrong. Retrying cannot fix it. */
  AUTH_CONFIG: 'auth_config',
  /** The address is not deliverable. No provider will do better. */
  INVALID_RECIPIENT: 'invalid_recipient',
  /** The provider refused the message itself, permanently. */
  PERMANENT_REJECT: 'permanent_reject',
  /** We failed before any provider was involved. Not a delivery problem. */
  APPLICATION: 'application',
};

/** Categories for which trying again, ever, is pointless. */
export const TERMINAL = new Set([
  FAILURE.INVALID_RECIPIENT,
  FAILURE.PERMANENT_REJECT,
  FAILURE.APPLICATION,
]);

/** A send failure that has been classified. */
export class EmailSendError extends Error {
  constructor(message, { category, provider, status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EmailSendError';
    this.category = category;
    this.provider = provider;
    this.status = status;
  }
}

/**
 * Thrown when the message we were asked to send is not sendable — a missing
 * recipient, an empty subject, a template that produced nothing. Separate from
 * `EmailSendError` so it cannot be mistaken for a delivery problem.
 */
export class EmailApplicationError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EmailApplicationError';
    this.category = FAILURE.APPLICATION;
  }
}

/**
 * Everything a message needs before any provider sees it.
 *
 * Runs first, so a malformed message is an application error rather than a 422
 * from a provider that we would then have misread as a delivery failure.
 */
export function assertSendable(message) {
  const need = (field) => {
    const v = message?.[field];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new EmailApplicationError(
        `Cannot send: "${field}" is missing or empty. This is a rendering bug, `
        + 'not a delivery failure, and must not be retried against a provider.'
      );
    }
  };
  need('to');
  need('from');
  need('subject');
  if (!message.html && !message.text) {
    throw new EmailApplicationError(
      'Cannot send: the message has neither an HTML nor a text body.'
    );
  }
  return message;
}

/* ────────────────────────────── Resend ────────────────────────────── */

const RESEND_ENDPOINT = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = Number(process.env.RESEND_TIMEOUT_MS || 10_000);

/**
 * Reads the key at call time, not at import time, so a test can set it and a
 * deployment can rotate it without a restart racing module evaluation.
 */
function resendKey() {
  const key = process.env.RESEND_API_KEY;
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
}

/** HTTP status + Resend's error name → a category. */
export function classifyResendResponse(status, body) {
  const name = String(body?.name || body?.error?.name || '').toLowerCase();
  const detail = String(body?.message || body?.error?.message || '').toLowerCase();

  if (status === 429) return FAILURE.RATE_LIMIT;
  if (status >= 500) return FAILURE.TRANSIENT;
  if (status === 401 || status === 403) return FAILURE.AUTH_CONFIG;

  if (status === 422 || status === 400) {
    /* Resend reports a bad address as a validation error naming the recipient
       field. Anything else at 422 is the message being wrong, which is ours. */
    if (
      name.includes('invalid_to') || name.includes('invalid_recipient')
      || /\b(to|recipient)\b/.test(detail) && detail.includes('invalid')
    ) {
      return FAILURE.INVALID_RECIPIENT;
    }
    /* A `from` the account is not allowed to use is configuration, not a
       message defect — and it is the single most likely failure on the day the
       domain is switched over, so it must not be mistaken for a bad address. */
    if (name.includes('domain') || detail.includes('domain') || detail.includes('from')) {
      return FAILURE.AUTH_CONFIG;
    }
    return FAILURE.PERMANENT_REJECT;
  }

  if (status === 404 || status === 405) return FAILURE.AUTH_CONFIG;
  return FAILURE.PERMANENT_REJECT;
}

/** A thrown `fetch` error → a category. Network trouble is transient. */
export function classifyFetchError(err) {
  const code = String(err?.cause?.code || err?.code || '');
  const name = String(err?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') return FAILURE.TRANSIENT;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR/.test(code)) {
    return FAILURE.TRANSIENT;
  }
  return FAILURE.TRANSIENT;
}

export class ResendEmailProvider {
  constructor({ fetchImpl = null } = {}) {
    this.name = 'resend';
    /* Injectable so the failure matrix can be exercised without a network and
       without a key. Defaults to the global at call time. */
    this._fetch = fetchImpl;
  }

  isConfigured() {
    return resendKey() !== null;
  }

  /** Safe to log: says whether, never what. */
  describe() {
    return { provider: this.name, configured: this.isConfigured(), endpoint: RESEND_ENDPOINT };
  }

  async send(message) {
    const key = resendKey();
    if (!key) {
      throw new EmailSendError('RESEND_API_KEY is not set', {
        category: FAILURE.AUTH_CONFIG,
        provider: this.name,
      });
    }

    const payload = {
      from: message.from,
      to: [message.to],
      subject: message.subject,
    };
    if (message.html) payload.html = message.html;
    if (message.text) payload.text = message.text;
    if (message.replyTo) payload.reply_to = message.replyTo;
    if (message.headers) payload.headers = message.headers;

    const headers = {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
    /* Resend honours this, so a retry that crosses a response we never saw does
       not produce a second copy in the recipient's inbox. The queue's own
       idempotency key doubles as the provider's. */
    if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey;

    const doFetch = this._fetch || globalThis.fetch;

    let res;
    try {
      res = await doFetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch (err) {
      /* `err` can carry the request headers on some runtimes, so only the
         classified category and a fixed string cross this boundary. */
      throw new EmailSendError(`resend request failed (${err?.name || 'error'})`, {
        category: classifyFetchError(err),
        provider: this.name,
      });
    }

    let body = null;
    try { body = await res.json(); } catch { /* an empty or non-JSON body is fine */ }

    if (!res.ok) {
      throw new EmailSendError(
        `resend responded ${res.status}${body?.name ? ` (${body.name})` : ''}`
        + (body?.message ? `: ${redactAddresses(body.message).slice(0, 200)}` : ''),
        { category: classifyResendResponse(res.status, body), provider: this.name, status: res.status }
      );
    }

    return { messageId: body?.id || null, provider: this.name };
  }
}

/* ─────────────────────────────── SMTP ─────────────────────────────── */

/**
 * Strip email addresses out of a provider's error text, keeping the domain.
 *
 * Provider errors are genuinely useful — "connect ECONNREFUSED", "550 mailbox
 * unavailable" is what an operator greps for — and the old code kept them
 * verbatim. But nodemailer helpfully includes the envelope, so a bounce message
 * carries the recipient's address, and this text is surfaced on an admin
 * endpoint and written to the journal. The domain diagnoses a relay or SPF
 * problem; the local part identifies a specific child and diagnoses nothing.
 *
 * `recordFailure` in email.js already applies this rule to the recipient it is
 * handed. This closes the other door into the same record.
 */
export function redactAddresses(text) {
  return String(text || '').replace(
    /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    '•••@$1'
  );
}

/**
 * A nodemailer error → a category.
 *
 * nodemailer's `code` names the STEP that failed, not whether the failure is
 * permanent. EENVELOPE is any refusal at MAIL FROM, RCPT TO or DATA; EAUTH is any
 * refusal at AUTH. The reply code is the server's own answer to "will this work
 * later?", so it is read first. Branching on the step alone classified a
 * greylisting 451 as a bad address, which is terminal: a verification email
 * refused for "try again in five minutes" was dropped without a queue row.
 */
export function classifySmtpError(err) {
  const code = String(err?.code || '');
  const status = Number(err?.responseCode || 0);

  /* 4xx in SMTP is "try again later" by definition; 5xx is a refusal. */
  if (status >= 400 && status < 500) return FAILURE.TRANSIENT;

  if (code === 'EAUTH') return FAILURE.AUTH_CONFIG;
  /* No reply code: nodemailer refused the address itself before any server saw
     it. With one, the 5xx mapping below decides — a 554 at DATA refused the
     message, not the recipient. */
  if (code === 'EENVELOPE' && !status) return FAILURE.INVALID_RECIPIENT;
  if (/ECONNECTION|ESOCKET|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EDNS|ENOTFOUND|EAI_AGAIN/.test(code)) {
    return FAILURE.TRANSIENT;
  }

  if (status === 535 || status === 534 || status === 530) return FAILURE.AUTH_CONFIG;
  if (status === 550 || status === 551 || status === 553) return FAILURE.INVALID_RECIPIENT;
  if (status >= 500) return FAILURE.PERMANENT_REJECT;

  /* An unrecognised failure is treated as transient on purpose. The cost of
     retrying something permanent is a few wasted attempts and a queue row; the
     cost of discarding something transient is a person who never gets their
     verification email. */
  return FAILURE.TRANSIENT;
}

export class SmtpEmailProvider {
  /**
   * @param {() => object} getTransport  returns the live nodemailer transport.
   *   A getter rather than the transport itself, because `email.js` swaps the
   *   transport under tests and a captured reference would miss the swap.
   * @param {() => boolean} isConfigured
   */
  constructor(getTransport, isConfigured) {
    this.name = 'smtp';
    this._getTransport = getTransport;
    this._isConfigured = isConfigured;
  }

  isConfigured() {
    return Boolean(this._isConfigured?.());
  }

  describe() {
    return { provider: this.name, configured: this.isConfigured() };
  }

  async send(message) {
    const transport = this._getTransport();
    if (!transport) {
      throw new EmailSendError('no SMTP transport is available', {
        category: FAILURE.AUTH_CONFIG,
        provider: this.name,
      });
    }

    const mail = {
      from: message.from,
      to: message.to,
      subject: message.subject,
    };
    if (message.text) mail.text = message.text;
    if (message.html) mail.html = message.html;
    if (message.replyTo) mail.replyTo = message.replyTo;
    if (message.headers) mail.headers = message.headers;

    try {
      const info = await transport.sendMail(mail);
      return { messageId: info?.messageId || null, provider: this.name };
    } catch (err) {
      throw new EmailSendError(
        `smtp send failed (${err?.code || err?.responseCode || 'error'}): `
        + redactAddresses(err?.message).slice(0, 200),
        {
          category: classifySmtpError(err),
          provider: this.name,
          status: err?.responseCode || null,
        }
      );
    }
  }
}
