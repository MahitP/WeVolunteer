/**
 * What became of a message after the provider accepted it.
 *
 * ── The gap this closes ──
 *
 * The outbox already records that Resend TOOK a message: `status = 'sent'`,
 * `sent_by_provider`, `provider_message_id`. That is the last thing the
 * application ever learns about it. Acceptance is not delivery — a message can
 * be accepted and then hard-bounce because the address does not exist, or be
 * marked as spam by the recipient, and today both look identical to success.
 *
 * On this platform that matters more than usual. The messages most likely to
 * bounce are the ones sent to an address somebody typed once at signup, and the
 * consequence of never learning it bounced is a student who cannot verify their
 * account and an operator with no way to see why.
 *
 * Resend can tell us, through a webhook. These columns are where the answer
 * lands.
 *
 * ── Why a separate events table ──
 *
 * Webhook delivery is at-least-once. The same event will arrive twice, and a
 * retry storm will deliver it many times. `resend_webhook_events` records every
 * event id that has been processed, so a replay is a no-op rather than a second
 * state transition — and its PRIMARY KEY is what enforces that, rather than a
 * SELECT-then-INSERT that two concurrent requests can both pass.
 *
 * It also stores the delivery outcome for messages the outbox no longer has: a
 * `sent` row is swept after a day, but a bounce can arrive later than that. The
 * event row survives so the bounce is still visible to an operator.
 *
 * ── What is deliberately NOT stored ──
 *
 * No message body, no subject, no headers, no payload blob. Just the event
 * type, the provider's message id, a coarse timestamp and the recipient DOMAIN.
 * The local part identifies a specific child and diagnoses nothing that the
 * domain does not — the same rule `recordFailure` in email.js already follows.
 */
export function up(db) {
  const columns = db.prepare('PRAGMA table_info(notification_jobs)').all();
  if (columns.length === 0) return;

  const have = new Set(columns.map((c) => c.name));
  const add = (name, ddl) => {
    if (!have.has(name)) db.exec(`ALTER TABLE notification_jobs ADD COLUMN ${name} ${ddl}`);
  };

  /* The provider's last word: delivered | bounced | complained | failed |
     delayed. NULL means nothing has come back yet, which is the normal state
     for a message sent seconds ago and the permanent state if no webhook is
     configured. */
  add('delivery_state', 'TEXT');
  add('delivery_detail', 'TEXT');
  add('delivery_updated_at', 'TEXT');

  /* Correlating an incoming event to a queue row is a lookup by the provider's
     id, on every event. Without this it is a table scan per webhook. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notification_jobs_provider_message
      ON notification_jobs(provider_message_id)
      WHERE provider_message_id IS NOT NULL
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS resend_webhook_events (
      /* The provider's own event id. PRIMARY KEY, so a replayed delivery is
         refused by the database rather than by a check that two concurrent
         requests can both pass. */
      event_id            TEXT PRIMARY KEY,
      event_type          TEXT NOT NULL,
      provider_message_id TEXT,
      /* The recipient's DOMAIN only — never the local part. */
      recipient_domain    TEXT,
      occurred_at         TEXT,
      received_at         TEXT NOT NULL,
      /* Which outbox row it was matched to, when one was found. A message sent
         before the outbox existed, or already swept, matches nothing — and that
         is not an error, so this is nullable and carries no foreign key. */
      job_id              TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_resend_events_recent
      ON resend_webhook_events(received_at)
  `);
}

export default {
  version: 50,
  name: 'delivery_events',
  up,
  fileUrl: import.meta.url,
};
