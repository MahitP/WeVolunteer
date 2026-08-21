/**
 * The alert path, driven against a throwaway in-memory database.
 *
 * `alerting.js` imports nothing — the database and the mail sender both arrive
 * as arguments — so a static import here reaches nothing and this file can
 * build the schema itself rather than booting a server. Same property, and same
 * reason, as `errorReporter.test.js`.
 *
 * Two claims carry the weight here, and neither is "an email was sent":
 *
 *   1. **The alert contains no personal data.** It leaves the application, into
 *      a mailbox that `error.read` does not protect. The redaction rules do not
 *      cover names, addresses or IPs (§6.10), so a redacted message is safe for
 *      the table and not safe for an inbox. Asserted by putting obvious PII in
 *      the columns the alert could have read and checking it is absent.
 *   2. **Nothing is silently dropped.** Eligibility is `alerted_at IS NULL`,
 *      not a time window, so a missed tick or a restart delays an alert rather
 *      than cancelling it. Asserted by skipping ticks and restarting mid-flow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  sendErrorAlerts, pendingAlerts, buildAlertBody,
  ALERTED_SOURCES, DEFAULT_MIN_INTERVAL_MS,
} from './alerting.js';

let db;

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  const { default: m4 } = await import('./migrations/004_error_events.js');
  const { default: m5 } = await import('./migrations/005_error_alerts.js');
  m4.up(db);
  m5.up(db);
  process.env.ALERT_EMAIL = 'ops@district.example';
  delete process.env.ALERT_MIN_INTERVAL_MS;
});

afterEach(() => {
  delete process.env.ALERT_EMAIL;
  delete process.env.ALERT_MIN_INTERVAL_MS;
});

/** A group, written directly so source, status and age are exactly as needed. */
function group(fingerprint, over = {}) {
  const o = {
    source: 'server', kind: 'TypeError', message: 'boom', route: '/api/events',
    status: 'open', occurrences: 1, alerted_at: null,
    seen: '2026-08-04T12:00:00.000Z', ...over,
  };
  db.prepare(`
    INSERT INTO error_groups
      (fingerprint, source, kind, message, route, status, occurrences, users_seen,
       first_seen_at, last_seen_at, alerted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?)
  `).run(fingerprint, o.source, o.kind, o.message, o.route, o.status,
    o.occurrences, o.seen, o.seen, o.alerted_at);
  return fingerprint;
}

const sender = () => vi.fn().mockResolvedValue({ ok: true });
const alertedAt = (fp) =>
  db.prepare('SELECT alerted_at FROM error_groups WHERE fingerprint = ?').get(fp).alerted_at;

/* ── What is sent, and to whom ──────────────────────────────────────────── */

describe('sending', () => {
  it('sends one digest covering every new problem, and marks them', async () => {
    group('fp-a');
    group('fp-b', { kind: 'RangeError', source: 'worker' });

    const send = sender();
    const result = await sendErrorAlerts(db, { send, appUrl: 'https://v.example' });

    expect(result).toMatchObject({ sent: 2, reason: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(alertedAt('fp-a')).not.toBeNull();
    expect(alertedAt('fp-b')).not.toBeNull();
  });

  it('does not send the same problem twice', async () => {
    group('fp-a');
    const send = sender();

    await sendErrorAlerts(db, { send });
    const second = await sendErrorAlerts(db, { send, now: new Date(Date.now() + 10 * 3600_000) });

    expect(second).toMatchObject({ sent: 0, reason: 'nothing_new' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('addresses every configured recipient', async () => {
    process.env.ALERT_EMAIL = 'ops@a.example, oncall@b.example ,  ';
    group('fp-a');
    const send = sender();

    await sendErrorAlerts(db, { send });

    expect(send.mock.calls[0][0].to).toBe('ops@a.example, oncall@b.example');
  });
});

/* ── What is NOT sent ───────────────────────────────────────────────────── */

describe('an alert carries no personal data', () => {
  /**
   * The columns an alert could plausibly have included are filled with obvious
   * PII, and the whole email is checked for it. A future change that adds
   * `message` to the body "so the alert is more useful" fails here, which is
   * the entire point of the test.
   */
  it('includes no message, route, or user information', async () => {
    group('fp-a', {
      message: 'Cannot read hours of jordan.ramirez@lincolnhigh.example',
      route: '/users/:id/profile',
      kind: 'TypeError',
    });
    db.prepare(`
      INSERT INTO error_events (id, fingerprint, occurred_at, stack, route, user_hash, role)
      VALUES ('e1', 'fp-a', '2026-08-04T12:00:00.000Z', 'at handler (server/x.js:1:1)',
              '/users/:id/profile', 'deadbeefdeadbeefdeadbeefdeadbeef', 'student')
    `).run();

    const send = sender();
    await sendErrorAlerts(db, { send, appUrl: 'https://v.example' });

    const mail = send.mock.calls[0][0];
    const whole = `${mail.subject}\n${mail.text}`;

    for (const forbidden of [
      'jordan.ramirez', 'lincolnhigh', 'Cannot read hours',
      '/users/:id/profile', 'deadbeef', 'at handler',
      // Every role name, so the `role` column cannot reappear in the body.
      ...['student', 'organizer', 'admin', 'super_admin', 'partner'],
    ]) {
      expect(whole, `the alert leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * The same claim, one step earlier and much harder to weaken by accident.
   *
   * Asserting only on the rendered body leaves the query free to fetch whatever
   * it likes, so the sensitive columns sit one property access away from
   * whoever next edits `buildAlertBody`. Pinning the SELECT means the data is
   * not in the process to leak: a change that adds `message` to the body alone
   * renders `undefined` and fails nothing, and this is what makes the pair of
   * changes needed to actually leak it impossible to make silently.
   */
  it('never even reads the sensitive columns out of the database', async () => {
    group('fp-a', { message: 'Cannot read hours of a named student', route: '/users/:id/profile' });

    const [row] = await pendingAlerts(db);

    expect(Object.keys(row).sort()).toEqual(
      ['fingerprint', 'first_seen_at', 'kind', 'occurrences', 'source']
    );
    for (const forbidden of ['message', 'route', 'users_seen', 'resolved_by']) {
      expect(row, `pendingAlerts selected ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it('carries only the kind, the fingerprint, a count and a link', async () => {
    const body = buildAlertBody(
      [{ source: 'server', kind: 'TypeError', occurrences: 4, fingerprint: 'abc123' }],
      'https://v.example/'
    );

    expect(body).toContain('TypeError');
    expect(body).toContain('abc123');
    expect(body).toContain('4 occurrences');
    // Trailing slash collapsed, so the link is never `…example//errors`.
    expect(body).toContain('https://v.example/errors');
    // And it explains its own emptiness, so nobody "fixes" it by adding detail.
    expect(body).toMatch(/deliberately not included/i);
  });

  /**
   * Client `kind` is attacker-supplied — the intake accepts any string and only
   * redacts it. Alerting on client reports would mail that string out, and a
   * browser extension throwing on a laptop is not an incident anyway.
   */
  it('never alerts on a client report', async () => {
    group('fp-client', { source: 'client', kind: 'AttackerChosenKind' });
    const send = sender();

    const result = await sendErrorAlerts(db, { send });

    expect(result).toMatchObject({ sent: 0, reason: 'nothing_new' });
    expect(send).not.toHaveBeenCalled();
    expect(ALERTED_SOURCES).not.toContain('client');
  });
});

/* ── Configuration ──────────────────────────────────────────────────────── */

describe('configuration', () => {
  it('is off, and silent, when ALERT_EMAIL is unset', async () => {
    delete process.env.ALERT_EMAIL;
    group('fp-a');
    const send = sender();

    const result = await sendErrorAlerts(db, { send });

    expect(result).toMatchObject({ sent: 0, reason: 'not_configured' });
    expect(send).not.toHaveBeenCalled();
    // Nothing marked: turning alerting ON later must not skip the backlog.
    expect(alertedAt('fp-a')).toBeNull();
  });

  it('treats a blank or comma-only ALERT_EMAIL as unset', async () => {
    for (const value of ['', '   ', ' , , ']) {
      process.env.ALERT_EMAIL = value;
      expect((await sendErrorAlerts(db, { send: sender() })).reason).toBe('not_configured');
    }
  });

  it('honours ALERT_MIN_INTERVAL_MS, and defaults to an hour', async () => {
    expect(DEFAULT_MIN_INTERVAL_MS).toBe(3600_000);

    process.env.ALERT_MIN_INTERVAL_MS = String(30 * 60_000);
    const base = new Date('2026-08-04T12:00:00.000Z');
    group('fp-a');
    const send = sender();
    await sendErrorAlerts(db, { send, now: base });

    group('fp-b');
    const tooSoon = await sendErrorAlerts(db, { send, now: new Date(base.getTime() + 10 * 60_000) });
    expect(tooSoon).toMatchObject({ sent: 0, reason: 'throttled', pending: 1 });

    const later = await sendErrorAlerts(db, { send, now: new Date(base.getTime() + 31 * 60_000) });
    expect(later).toMatchObject({ sent: 1, reason: 'sent' });
  });

  /**
   * A throttled problem must not be lost. This is the difference between
   * `alerted_at IS NULL` and a time window, and it is why the column exists.
   */
  it('sends a throttled problem in the next digest rather than dropping it', async () => {
    const base = new Date('2026-08-04T12:00:00.000Z');
    group('fp-a');
    const send = sender();
    await sendErrorAlerts(db, { send, now: base });

    group('fp-b');
    await sendErrorAlerts(db, { send, now: new Date(base.getTime() + 60_000) });   // throttled
    expect(alertedAt('fp-b')).toBeNull();

    await sendErrorAlerts(db, { send, now: new Date(base.getTime() + 2 * 3600_000) });
    expect(alertedAt('fp-b')).not.toBeNull();
    expect(send.mock.calls[1][0].text).toContain('fp-b');
  });
});

/* ── What it will not do ────────────────────────────────────────────────── */

describe('refusals and robustness', () => {
  it('ignores a problem that was already triaged', async () => {
    group('fp-resolved', { status: 'resolved' });
    group('fp-ignored', { status: 'ignored' });

    expect(await pendingAlerts(db)).toEqual([]);
    expect((await sendErrorAlerts(db, { send: sender() })).reason).toBe('nothing_new');
  });

  /**
   * Never throws, by the same rule as `recordError` and `sweepErrors`:
   * monitoring that can take down the thing it monitors is worse than no
   * monitoring. This runs inside `runNotificationSweep`'s single shared try
   * block, so a throw here would abandon every sweep task after it.
   */
  it('never throws — not on a broken db, a rejecting sender, or no sender', async () => {
    group('fp-a');

    expect(await sendErrorAlerts(null, { send: sender() })).toMatchObject({ reason: 'no_db' });
    expect(await sendErrorAlerts(db, {})).toMatchObject({ reason: 'no_sender' });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejecting = vi.fn().mockRejectedValue(new Error('SMTP is down'));
    expect(await sendErrorAlerts(db, { send: rejecting })).toMatchObject({ sent: 0, reason: 'failed' });
    consoleError.mockRestore();
  });

  /**
   * Groups are marked BEFORE the send. A transport that fails repeatedly must
   * not produce an alert loop against the same problems for ever — that is how
   * a channel gets muted, and a muted channel loses every future alert. Losing
   * one digest to a failed send is the cheaper error: the problems are still in
   * the dashboard.
   */
  it('does not re-send a digest whose delivery failed', async () => {
    group('fp-a');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendErrorAlerts(db, { send: vi.fn().mockRejectedValue(new Error('SMTP is down')) });
    consoleError.mockRestore();

    expect(alertedAt('fp-a')).not.toBeNull();

    const send = sender();
    const retry = await sendErrorAlerts(db, { send, now: new Date(Date.now() + 10 * 3600_000) });
    expect(retry).toMatchObject({ sent: 0, reason: 'nothing_new' });
  });

  it('sends nothing when there is nothing to say', async () => {
    const send = sender();
    expect(await sendErrorAlerts(db, { send })).toMatchObject({ sent: 0, reason: 'nothing_new' });
    expect(send).not.toHaveBeenCalled();
  });
});

/* ── The migration's own backfill ───────────────────────────────────────── */

describe('migration 005', () => {
  /**
   * Pre-existing groups are backfilled to "already alerted". Without it, the
   * first sweep after deploying this treats every historical problem as new and
   * sends one enormous alert nobody can act on — the classic way an alerting
   * channel is muted in its first hour.
   */
  it('does not alert on the backlog that existed before alerting did', async () => {
    const fresh = new DatabaseSync(':memory:');
    const { default: m4 } = await import('./migrations/004_error_events.js');
    m4.up(fresh);
    fresh.prepare(`
      INSERT INTO error_groups
        (fingerprint, source, kind, message, route, status, occurrences, users_seen,
         first_seen_at, last_seen_at)
      VALUES ('old', 'server', 'TypeError', 'm', NULL, 'open', 9, 0,
              '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')
    `).run();

    const { default: m5 } = await import('./migrations/005_error_alerts.js');
    m5.up(fresh);

    expect(
      fresh.prepare("SELECT alerted_at FROM error_groups WHERE fingerprint = 'old'").get().alerted_at,
      'a pre-existing group must not be treated as new'
    ).toBe('2026-07-02T00:00:00.000Z');
    expect(await pendingAlerts(fresh)).toEqual([]);
  });

  it('is idempotent — running it twice changes nothing', async () => {
    const { default: m5 } = await import('./migrations/005_error_alerts.js');
    group('fp-a');
    expect(() => { m5.up(db); m5.up(db); }).not.toThrow();
    expect(alertedAt('fp-a')).toBeNull();
  });
});
