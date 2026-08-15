# Email delivery

How a message gets from a route handler to somebody's inbox, who it says it is
from, and what happens when that fails.

## The three layers

```
  sendVerificationEmail(…)          sendMail(…)            notificationService.dispatch(…)
  sendPasswordResetEmail(…)         (worker, alerts)       (queues a notification event)
            │                            │                            │
            └────────────┬───────────────┘                            │
                         ▼                                            │
                  emailService.sendEmail()                            │
                         │                                            │
        ┌────────────────┼────────────────┐                           │
        ▼                ▼                ▼                           ▼
   1. Resend  →   2. SMTP (Gmail)  →  3. the outbox  ←────────  notification_jobs
   (primary)      (emergency only)     (durable)                (same table)
```

1. **Resend** — the primary. `RESEND_API_KEY`.
2. **SMTP** — the emergency fallback, used only when Resend could not take the
   message. The pre-existing Gmail relay, unchanged.
3. **The outbox** — `notification_jobs`. If neither provider took it, the
   message is written down and the worker retries until it goes or has
   demonstrably failed.

**Provider choice is not visible above `emailService`.** No caller knows or
branches on which provider ran. There is one rendered message and two pieces of
plumbing that carry it — no `ResendTemplate`, no `GmailTemplate`.

What a recipient sees is identical either way: same From and display name, same
Reply-To, same subject, same HTML, same text, same links. The raw headers
necessarily differ (different DKIM signature, different Message-ID domain,
different Received chain) — nothing a mail client shows a human does.

## Files

| File | Owns |
|---|---|
| `server/emailIdentity.js` | The address book and the flow → sender matrix. |
| `server/emailProviders.js` | `ResendEmailProvider`, `SmtpEmailProvider`, failure classification. |
| `server/emailService.js` | Provider choice, fallback rules, the queue. |
| `server/email.js` | Templates, the SMTP transport, the boot guards, the health record. |
| `server/workers/notificationWorker.js` | Draining the outbox. |
| `server/migrations/047_email_outbox.js` | The columns the outbox needed. |

## Who a message is from

Every authentication message leaves from `noreply@wevolunteers.org`, displayed
as `WeVolunteer`, with **no Reply-To** — a reply to one of these carries a live
credential, and a Reply-To would deliver a login code or a single-use reset link
into a shared mailbox with a much longer life than the token was designed to
have. `identityFor()` throws if an auth flow ever resolves to another sender.

| Category | From | Reply-To |
|---|---|---|
| `auth` — verification, reset, email change, 2FA code, admin invite, recovery-code notice | `noreply@` | *(none)* |
| `notification` — applications, shifts, reminders, comments | `contact@` | `support@` |
| `enforcement` — suspensions, bans, removals, appeals, admin role changes | `admin@` | `admin@` |
| `legal` — policy and agreement changes | `legal@` | `legal@` |
| `privacy` — access, correction, deletion | `privacy@` | `privacy@` |
| `security` — safety and security reports | `security@` | `security@` |
| `support` | `support@` | `support@` |
| `platform` — operator alerts, never to a user | `platform@` | `platform@` |
| `owner` — genuinely from the named owner | `mahit@` | `mahit@` |

`MAIL_DOMAIN` sets the domain. There is no `EMAIL_FROM` any more; setting it
logs a warning at boot and changes nothing.

## What happens when a send fails

Failures are classified before anything decides what to do about them.

| Category | Meaning | Fallback? | Queued? |
|---|---|---|---|
| `transient` | network, timeout, 5xx | yes | yes |
| `rate_limit` | 429 | yes | yes, with a longer backoff |
| `auth_config` | bad key, unverified sending domain, SMTP 535 | yes, **once** | yes |
| `invalid_recipient` | the address is not deliverable | no | **no** |
| `permanent_reject` | the provider refused the message | no | **no** |
| `application` | we could not render it | no | **no** — raised to the caller |

Three of these matter more than the rest:

- **A success stops everything after it.** No fallback, no queue row. If it did
  not, every recipient would get two of everything.
- **A bad address is never queued.** One typo would otherwise become six retries
  over two hours and an exhaustion alert, against the sending domain's
  reputation.
- **A template bug is not a delivery failure.** `EmailApplicationError` never
  reaches a provider and never reaches the queue. Queueing it would fail
  identically six times and then be reported as an email outage — sending
  whoever is on call to a provider dashboard showing everything healthy.

`auth_config` is worth its own note: an unverified sending domain is the single
most likely failure on the day the domain is switched over. It is classified as
configuration, not as a bad recipient, so those messages **queue** rather than
being silently dropped as permanent.

## The outbox

`notification_jobs` carries two channels:

- `email` — a notification EVENT. The worker looks up the user and renders it.
  Unchanged.
- `email.message` — an already-RENDERED message. What transactional mail falls
  into. Nothing is re-rendered on retry, so the message that arrives late is the
  message that was composed.

Per row: `idempotency_key` (UNIQUE), `recipient`, `subject`, the rendered body,
`provider_attempts`, `status`, `attempts`, `next_attempt_at`,
`last_error_category`, `provider_message_id`, `sent_by_provider`, and
timestamps.

- **Idempotency** — the key goes to Resend as `Idempotency-Key`, so a retry
  crossing a response we never saw does not produce a second copy, and it is
  UNIQUE in the table, so enqueueing twice is one row.
- **Claiming** — `UPDATE … WHERE id = ? AND status = 'pending'`, with `changes`
  checked. Pickup is a SELECT followed by a separate UPDATE, so two processes
  can both select the same row; the guard means exactly one of them sends it.
- **Backoff** — exponential, capped at one hour, jittered ±25%. Without jitter,
  an outage that fails two hundred messages schedules all two hundred to retry
  in the same millisecond, and the recovery attempt is the next outage.
- **Retention** — delivered rows are kept (`status = 'sent'`) so the queue can
  answer "did that verification email actually go out", then swept after a day.
  The rendered body is cleared as soon as a row stops being retryable: a queued
  password-reset body contains a live single-use link.

**A login code is never queued.** It is valid for ten minutes and is invalidated
the moment the person asks for another, so a late one arrives after they have
already requested a second — two messages, and the newer-looking one is dead.
The route returns 502 and they press the button again.

## Configuration

| Variable | |
|---|---|
| `RESEND_API_KEY` | **Secret.** Send permission only. Never in the repo, never in a `VITE_` variable, never logged. |
| `MAIL_DOMAIN` | The domain every platform address lives on. Must be verified with Resend and covered by SPF/DKIM. |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | The fallback relay. |
| `MAIL_MAX_ATTEMPTS`, `MAIL_RETRY_DELAY_MS` | How hard one provider is tried before the fallback. |
| `MAIL_QUEUE_MAX_ATTEMPTS` | Attempts a queued message gets. Default 6. |
| `MAIL_SENT_RETENTION_MS` | How long a delivered row is kept. Default one day. |
| `RESEND_TIMEOUT_MS` | Default 10s. |
| `VITE_MAIL_DOMAIN` | The client's copy, for the addresses it renders. |

Production refuses to boot with **neither** a Resend key nor SMTP credentials —
the alternative is the development console mock, which prints password-reset
tokens to the journal and delivers nothing. Configuring only one is allowed and
announced at boot; with Resend alone there is no fallback.

## Why Resend goes over `fetch` rather than the SDK

Node 24 has a stable global `fetch`, and this repo already talks to every third
party that way (Nominatim, Open-Meteo, OpenRouteService). The Resend send API is
one POST with a JSON body; the SDK wraps that and brings `postal-mime` and
`standardwebhooks` for inbound parsing and webhook verification, neither of
which this platform does.

The deciding reason is the failure classification: it branches on HTTP status
codes, and a raw status code is a far more reliable thing to branch on than the
shape of a wrapped error object across SDK versions.

## Tests

| File | |
|---|---|
| `server/emailFailureMatrix.test.js` | Every fallback rule, idempotency, backoff, classification, provider transparency. |
| `server/emailIdentity.test.js` | The sender matrix and the auth-sender guard. |
| `server/emailOutbox.worker.test.js` | A queued message driven end to end through the real worker. |
| `server/email.production.test.js` | The boot guards. |
| `server/email.reliability.test.js` | The health record, and that it never carries a recipient's local part. |
