/**
 * The durable outbox grows up: it can now carry a rendered message, not only a
 * notification event.
 *
 * ── What was actually wrong ──
 *
 * WeVolunteer had two email systems and only one of them could survive a
 * restart.
 *
 *   - NOTIFICATION mail went through `notification_jobs`: a real queue, with
 *     attempts, a next-attempt time and an error log.
 *
 *   - TRANSACTIONAL mail — verification, password reset, email change, the
 *     login 2FA code, the admin invitation — went straight out through
 *     nodemailer with three in-process retries 500ms apart. Nothing about it was
 *     ever written down. If the SMTP host was down for four seconds, or the
 *     process restarted mid-retry, the message was gone with no record that it
 *     had ever been attempted.
 *
 * That is exactly backwards. A missed "someone commented on your event" is a
 * shrug. A missed verification email is an account nobody can get into, and the
 * person it happened to cannot tell the difference between that and being
 * banned. The category with the worst failure was the category with no
 * durability.
 *
 * ── Why this extends `notification_jobs` instead of adding a table ──
 *
 * Because `notification_jobs` is already a durable email queue — that is
 * literally all it is. Its `channel` column has exactly one value in practice
 * (`'email'`, hard-coded at notificationService.js), the worker throws on
 * anything else, and the in-app half of a notification is written synchronously
 * and never queued at all. A second table would mean a second worker, a second
 * backoff policy, a second stale-row reclaim, a second set of health counters
 * and two places to look when mail stops moving.
 *
 * So the existing queue gains a second channel, `'email.message'`, carrying a
 * message that is already rendered. The existing `'email'` channel is untouched:
 * same payload, same worker branch, same content lookup.
 *
 * ── Why the new columns are nullable ──
 *
 * Every row already in the table belongs to the old channel and has no
 * idempotency key, recipient or subject of its own — those live inside its JSON
 * payload. Making the columns NOT NULL would mean a rebuild of a table that may
 * have live rows mid-flight during a deploy. Nullable columns let a running
 * queue drain across the upgrade.
 *
 * ── The idempotency index is partial, and that is the point ──
 *
 * `WHERE idempotency_key IS NOT NULL` — otherwise every legacy row (all of which
 * have NULL) would collide with every other one. SQLite treats NULLs as
 * distinct in a UNIQUE index, so a plain unique index would technically work;
 * the partial index states the intent and keeps the index small.
 *
 * ── `sent` replaces deletion ──
 *
 * The worker used to DELETE a row on success, which meant the queue could never
 * answer "did that verification email actually go out?" — the one question an
 * operator asks. Rows now reach `status = 'sent'` and carry the provider's
 * message id, and a sweep removes them after a day. A day is long enough for a
 * same-morning support question and short enough that the table is not a growing
 * pile of the email addresses of minors.
 *
 * The rendered body is cleared the moment a row stops being retryable, because
 * a queued password-reset body contains a live single-use link. (The token is
 * already stored in plaintext in `password_reset_tokens`, so this is not a new
 * class of exposure — but it is a second copy with a longer life, and there is
 * no reason to keep it once nothing will re-send it.)
 */
export function up(db) {
  const columns = db.prepare('PRAGMA table_info(notification_jobs)').all();
  if (columns.length === 0) return; // The table arrives with db.js's bootstrap.

  const have = new Set(columns.map((c) => c.name));
  const add = (name, ddl) => {
    if (!have.has(name)) db.exec(`ALTER TABLE notification_jobs ADD COLUMN ${name} ${ddl}`);
  };

  /* Set by the caller, so a retried enqueue of the same message is one row.
     Deliberately not derived from the body: two different verification emails to
     the same person minutes apart are two messages, and hashing the body would
     silently collapse them. */
  add('idempotency_key', 'TEXT');

  /* The recipient and subject are lifted out of the payload so an operator can
     answer "is anything stuck for this person" with a query rather than by
     parsing JSON in their head. */
  add('recipient', 'TEXT');
  add('subject', 'TEXT');

  /* Which providers were tried and what each said. A JSON array of
     {provider, category, at} — the shape the mail health endpoint reads. */
  add('provider_attempts', 'TEXT');

  /* The classified reason for the most recent failure: transient, rate_limit,
     auth_config, invalid_recipient, permanent_reject, application. Stored
     alongside the free-text `error_log` because the category is what the retry
     policy branches on and free text is not something to branch on. */
  add('last_error_category', 'TEXT');

  /* Whatever the winning provider called the message. The only handle that
     exists for asking a provider what became of it. */
  add('provider_message_id', 'TEXT');
  add('sent_by_provider', 'TEXT');

  add('updated_at', 'TEXT');
  add('sent_at', 'TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_jobs_idempotency
      ON notification_jobs(idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);

  /* The worker's claim query. Without it, every tick scans the whole table —
     including the `sent` rows this migration starts keeping. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notification_jobs_claim
      ON notification_jobs(status, next_attempt_at)
  `);
}

export default {
  version: 47,
  name: 'email_outbox',
  up,
  fileUrl: import.meta.url,
};
