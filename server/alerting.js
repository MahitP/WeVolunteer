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

/**
 * Backups get their own, much longer interval.
 *
 * A stale backup is a standing condition, not a stream of new events: once it
 * is true it stays true until somebody fixes it, so the hourly cadence that
 * suits errors would produce twenty-four identical emails a day and get the
 * channel muted. Twelve hours is often enough that it cannot be forgotten and
 * rare enough that it still reads as important.
 */
export const BACKUP_ALERT_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * The backup states that mean somebody should be told without being asked.
 *
 * Declared here rather than imported from `backupStatus.js`, and that is not an
 * accident: `alerting.integration.test.js` asserts this module imports NOTHING —
 * not the database, not the mailer, not anything. That constraint is what keeps
 * a monitoring failure from being able to take down the sweep it runs inside, so
 * the status is passed in as an argument like everything else.
 *
 * `unconfigured` is deliberately absent. That is a development machine with no
 * backup directory, not an incident.
 */
export const BACKUP_ALERT_STATES = Object.freeze(['stale', 'none', 'unknown']);

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
export async function pendingAlerts(db) {
  const placeholders = ALERTED_SOURCES.map(() => '?').join(', ');
  return await db.prepare(`
    SELECT fingerprint, kind, source, occurrences, first_seen_at
      FROM error_groups
     WHERE alerted_at IS NULL
       AND status = 'open'
       AND source IN (${placeholders})
     ORDER BY first_seen_at ASC
  `).all(...ALERTED_SOURCES);
}

/** The most recent alert we sent, or null if we never have. */
async function lastAlertAt(db) {
  const row = await db.prepare(
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
 * When the last backup warning went out, per process.
 *
 * Deliberately NOT a database column. Every other alert in this file throttles
 * off `error_groups.alerted_at`, which is right for a row that represents one
 * problem; a stale backup is a CONDITION rather than an event, so there is no
 * row to mark and adding a table for one timestamp is not worth a migration.
 *
 * The cost of keeping it in memory is that a restart re-arms the warning, and
 * that is the direction to fail in: a process that restarts nightly emails once
 * a night about a backup that is genuinely broken. The reverse — persisting it
 * and going quiet — is how this stops being noticed again.
 */
let lastBackupAlertAt = 0;

/** Test seam, for the same reason `__clearCache` exists in travelRoutes.js. */
export function __resetBackupAlertThrottle() { lastBackupAlertAt = 0; }

/**
 * Tells somebody the backups stopped.
 *
 * ── The gap ──
 *
 * `deploy/README.md` says it plainly: "systemd will mark the unit failed, but
 * nothing tells a human." The admin dashboard has reported backup freshness
 * since v1.2c, and a dashboard answers the question for somebody who came to
 * ask it. Nobody comes to ask it. The one failure where that matters most is
 * this one, because a backup that quietly stopped is only discovered on the day
 * it is needed — which is the worst day to discover it.
 *
 * ── Why it cannot be folded into the error digest ──
 *
 * `sendErrorAlerts` returns early on `nothing_new`, and a stale backup produces
 * no error rows at all. A system that is otherwise completely healthy is
 * exactly the system whose backups fail unnoticed, so the check has to run on a
 * path that a quiet error table does not short-circuit.
 *
 * ── What it deliberately does not do ──
 *
 * It does not distinguish "the timer is disabled" from "the timer ran and
 * failed" — `backupStatus` cannot, and the message says so rather than guessing.
 * It also stays quiet on `unconfigured`, which is a development machine with no
 * backup directory, not an incident.
 *
 * @param {{send: Function, now?: Date, appUrl?: string}} opts
 */
export async function sendBackupAlert({ send, now = new Date(), appUrl, status } = {}) {
  try {
    const to = recipients();
    if (to.length === 0) return { sent: 0, reason: 'not_configured' };
    if (typeof send !== 'function') return { sent: 0, reason: 'no_sender' };
    if (!status || !BACKUP_ALERT_STATES.includes(status.status)) return { sent: 0, reason: 'healthy' };

    /* Throttled AFTER establishing there is something to say, matching
       sendErrorAlerts: a quiet week must never start the clock. */
    if (lastBackupAlertAt && now.getTime() - lastBackupAlertAt < BACKUP_ALERT_INTERVAL_MS) {
      return { sent: 0, reason: 'throttled' };
    }
    lastBackupAlertAt = now.getTime();

    const detail = status.status === 'stale'
      ? `The newest backup is ${status.ageHours} hours old. Anything older than `
        + `${status.staleAfterHours} hours means at least one nightly run did not produce a file.`
      : status.status === 'none'
        ? 'The backup directory exists but contains no archives at all.'
        : 'The backup directory could not be read.';

    await send({
      to: to.join(', '),
      subject: '[WeVolunteer] Backups are not running',
      text: [
        detail,
        '',
        'This cannot tell you whether the timer is disabled or whether it ran and failed —',
        'both look the same from here. Check both:',
        '',
        '  systemctl list-timers wevolunteer-backup.timer',
        '  systemctl status wevolunteer-backup.service',
        '  journalctl -u wevolunteer-backup.service -n 50',
        '',
        'The database holds every student\'s service record. Until this is fixed there is no',
        'copy of it anywhere else.',
        appUrl ? `\n${appUrl}/admin` : '',
      ].join('\n'),
    });

    return { sent: 1, reason: 'sent', status: status.status };
  } catch (err) {
    /* Same rule as everything else here: monitoring that can take down the
       thing it monitors is worse than no monitoring. */
    try { console.error('[alerting] failed to send a backup alert:', err?.message ?? err); } catch { /* nothing left */ }
    return { sent: 0, reason: 'failed' };
  }
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

    let groups = await pendingAlerts(db);
    if (groups.length === 0) return { sent: 0, reason: 'nothing_new' };

    /**
     * The throttle is checked AFTER establishing there is something to send, so
     * a quiet hour never starts the clock. Checking it first would mean an
     * alert that arrives one minute after an unrelated one waits a full hour
     * for no reason.
     */
    const last = await lastAlertAt(db);
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
    /**
     * ── The groups are CLAIMED atomically, not marked one by one ──
     *
     * The read above and this write used to be separate, which was safe only
     * because `runNotificationSweep` calls this without awaiting it and the
     * marking was synchronous — so a second tick could not start before the
     * first had marked. That reasoning was true on SQLite and is false on
     * PostgreSQL, where every one of these statements is a round trip and the
     * caller is not waiting. Two overlapping sweeps would both read
     * `alerted_at IS NULL`, both mark, and both send the same digest.
     *
     * That is the exact failure the comment above refuses: an alert loop is how
     * a channel gets muted, and a muted channel loses every future alert.
     *
     * One conditional UPDATE … RETURNING closes it. `alerted_at IS NULL` in the
     * WHERE clause means only one caller can ever claim a given row, and the
     * rows it returns are precisely the ones it won — so a loser sends nothing
     * rather than sending a duplicate. Understood by both engines (SQLite has
     * RETURNING since 3.35; this runs 3.51).
     */
    const placeholders = ALERTED_SOURCES.map(() => '?').join(', ');
    const claimed = await db.prepare(`
      UPDATE error_groups SET alerted_at = ?
       WHERE alerted_at IS NULL
         AND status = 'open'
         AND source IN (${placeholders})
      RETURNING fingerprint, kind, source, occurrences, first_seen_at
    `).all(stamp, ...ALERTED_SOURCES);

    if (claimed.length === 0) return { sent: 0, reason: 'nothing_new' };
    /* Ordered here rather than in SQL: UPDATE … RETURNING has no ORDER BY, and
       the digest reads oldest-problem-first. */
    groups = claimed.sort((a, b) => String(a.first_seen_at).localeCompare(String(b.first_seen_at)));

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
