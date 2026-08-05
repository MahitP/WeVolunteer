/**
 * Tells somebody when the server breaks. The smallest thing that reliably does
 * that, and nothing else.
 *
 * ── The gap this closes ──
 *
 * v1.2c built an excellent instrument for answering "what is broken" — and
 * nothing that causes anyone to look at it. The backup unit's own comment is
 * blunt about the same failure one layer down: it once claimed `OnFailure=`
 * made failures visible, and there was no `OnFailure=` directive in the file.
 * A dashboard nobody opens and a backup nobody checks fail the same way, which
 * is silently.
 *
 * ── Why email, and why on the existing sweep ──
 *
 * SMTP is already a hard production boot requirement, so this adds no service
 * to run, no credential to rotate, and no new outbound dependency. A webhook
 * would be more flexible and would introduce exactly those three things for a
 * district that may not have anywhere to point it.
 *
 * It runs inside `runNotificationSweep`, beside `sweepErrors`, for the reason
 * that function already gives: no new interval, no new worker, and nothing more
 * for `shutdown.js` to drain. Like `sweepErrors` it catches internally and
 * returns a result rather than throwing, so a failure here cannot abandon the
 * sweep tasks registered after it.
 *
 * ── What an alert may contain, and why it is so little ──
 *
 * An alert leaves the application. It lands in a mailbox this app does not
 * control, is not covered by `error.read`, and will be forwarded. So it carries
 * **no error message, no stack trace, no route, no user hash, and no counts of
 * affected people** — only how many problems appeared, their `kind`, their
 * fingerprint, and a link to the dashboard, which requires super_admin.
 *
 * That is deliberate and it is informed by this release's own security review,
 * which established that redaction does NOT cover names, street addresses, IP
 * addresses or dates of birth (ENGINEERING_GUIDE §6.10). A redacted message is
 * safe enough for a table behind a SUPER_ONLY capability. It is not safe enough
 * to mail to a distribution list. The alert says *that* something broke and
 * where to look; the looking is access-controlled.
 *
 * `kind` is the one string included, and only for `server` and `worker`
 * sources, where it is `err.constructor.name` from our own code — a class name,
 * never user input. Client reports are excluded from alerting entirely: their
 * `kind` IS attacker-supplied, and a browser extension throwing on someone's
 * laptop is not an incident.
 */

/** Where alerts go. Unset disables alerting entirely — off is the safe default. */
const recipients = () =>
  String(process.env.ALERT_EMAIL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

/**
 * The floor between two alerts, in milliseconds.
 *
 * A cascade produces many distinct fingerprints in seconds. Without a floor
 * that is one email each, which buries the first — the one that mattered — and
 * teaches the recipient to filter the whole channel. Waiting groups them into
 * the next send instead; nothing is dropped, because eligibility is
 * `alerted_at IS NULL` and not a time window.
 */
export const DEFAULT_MIN_INTERVAL_MS = 60 * 60 * 1000;

const minIntervalMs = () =>
  Number(process.env.ALERT_MIN_INTERVAL_MS) || DEFAULT_MIN_INTERVAL_MS;

/** Named in one place so the query, the email and the tests cannot disagree. */
export const ALERTED_SOURCES = Object.freeze(['server', 'worker']);

/** Kept small: the email is a nudge to open the dashboard, not a report. */
const MAX_LISTED = 10;

/**
 * Problems that have never been alerted on, oldest first.
 *
 * `status = 'open'` so a problem somebody already triaged and resolved does not
 * generate an alert if it was resolved before the next tick — which is the
 * ordinary case for something noticed and fixed quickly.
 */
export function pendingAlerts(db) {
  const placeholders = ALERTED_SOURCES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT fingerprint, kind, source, occurrences, first_seen_at
      FROM error_groups
     WHERE alerted_at IS NULL
       AND status = 'open'
       AND source IN (${placeholders})
     ORDER BY first_seen_at ASC
  `).all(...ALERTED_SOURCES);
}

/** The most recent alert we sent, or null if we never have. */
function lastAlertAt(db) {
  const row = db.prepare(
    'SELECT MAX(alerted_at) AS at FROM error_groups WHERE alerted_at IS NOT NULL'
  ).get();
  return row?.at ? Date.parse(row.at) : null;
}

/**
 * The alert body. Plain text, because the recipient may be reading it on a
 * phone at the wrong hour and there is nothing here that benefits from markup.
 *
 * Exported so its contents can be asserted directly — the PII claim above is
 * the whole point of this module, and a test that only checked "an email was
 * sent" would not notice a message field being added to it later.
 */
export function buildAlertBody(groups, appUrl) {
  const n = groups.length;
  const lines = [
    n === 1
      ? 'A new problem was recorded on WeVolunteer.'
      : `${n} new problems were recorded on WeVolunteer.`,
    '',
  ];

  for (const g of groups.slice(0, MAX_LISTED)) {
    lines.push(`  ${g.source}  ${g.kind}  (${g.occurrences} occurrence${g.occurrences === 1 ? '' : 's'})`);
    lines.push(`    ${g.fingerprint}`);
  }
  if (n > MAX_LISTED) lines.push(`  … and ${n - MAX_LISTED} more.`);

  lines.push(
    '',
    /* The reason there is nothing else in this email, stated in the email. A
       recipient who wants detail must be told where to get it, or they will
       reasonably ask for it to be included here. */
    /* Worded to avoid naming a role. `role` is one of the columns this email
       must never disclose, and its own test forbids every role name appearing
       anywhere in the body — prose that said "about students" would collide
       with that check and the honest fix would be to weaken the assertion. */
    'Details — messages, stack traces and how many people were affected — are',
    'deliberately not included in this email. They are personal data about real',
    'people, and this message is not access-controlled. Open the dashboard:',
    '',
    `  ${String(appUrl || '').replace(/\/+$/, '')}/errors`,
    '',
    'Sign-in as the platform owner is required.',
  );

  return lines.join('\n');
}

/**
 * Sends one digest if there is anything to send. Never throws.
 *
 * Returns a result describing what happened and why, rather than a boolean:
 * "no alert was sent" has five distinct causes and an operator debugging a
 * silent channel needs to know which one. `reason` is what the sweep logs.
 *
 * `send` is injected rather than imported so this module stays testable without
 * a mail server, and so the sweep can pass the real sender. Same shape as
 * `sendMail` in email.js.
 */
export async function sendErrorAlerts(db, { send, now = new Date(), appUrl } = {}) {
  try {
    if (!db || typeof db.prepare !== 'function') return { sent: 0, reason: 'no_db' };

    const to = recipients();
    if (to.length === 0) return { sent: 0, reason: 'not_configured' };
    if (typeof send !== 'function') return { sent: 0, reason: 'no_sender' };

    const groups = pendingAlerts(db);
    if (groups.length === 0) return { sent: 0, reason: 'nothing_new' };

    /**
     * The throttle is checked AFTER establishing there is something to send, so
     * a quiet hour never starts the clock. Checking it first would mean an
     * alert that arrives one minute after an unrelated one waits a full hour
     * for no reason.
     */
    const last = lastAlertAt(db);
    if (last !== null && now.getTime() - last < minIntervalMs()) {
      return { sent: 0, reason: 'throttled', pending: groups.length };
    }

    const stamp = now.toISOString();

    /**
     * Marked BEFORE the send, not after.
     *
     * The two failure modes are not symmetrical. Marking after means a mail
     * server that accepts slowly, or a process that restarts mid-send, re-sends
     * the same digest on the next tick — and a transport that fails repeatedly
     * produces an alert loop against the same problems for ever. Marking first
     * risks losing ONE digest to a failed send, and the underlying problems are
     * still sitting in the dashboard where the next genuinely-new one will point
     * the reader anyway.
     *
     * A lost notification is recoverable by looking. An alert loop is how a
     * channel gets muted, and a muted channel loses every future alert.
     */
    const mark = db.prepare('UPDATE error_groups SET alerted_at = ? WHERE fingerprint = ?');
    for (const g of groups) mark.run(stamp, g.fingerprint);

    const subject = groups.length === 1
      ? `[WeVolunteer] New ${groups[0].source} error: ${groups[0].kind}`
      : `[WeVolunteer] ${groups.length} new errors`;

    await send({ to: to.join(', '), subject, text: buildAlertBody(groups, appUrl) });

    return { sent: groups.length, reason: 'sent', recipients: to.length };
  } catch (err) {
    // Same rule as recordError and sweepErrors: monitoring that can take down
    // the thing it monitors is worse than no monitoring.
    try { console.error('[alerting] failed to send an error alert:', err?.message ?? err); } catch { /* nothing left */ }
    return { sent: 0, reason: 'failed' };
  }
}
