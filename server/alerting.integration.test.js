/**
 * The wiring, not the logic.
 *
 * `alerting.test.js` proves `sendErrorAlerts` picks the right groups and mails
 * the right (very little) content. That is a different claim from "the
 * application ever calls it", and only the second one means anybody gets told.
 * An alerter nobody invokes is indistinguishable from no alerting at all, with
 * every unit test green — the same gap `errorSweep.integration.test.js` exists
 * for, and the same one Guard 5 exists for in v1.2b.
 *
 * Also asserts the acceptance criterion literally: no new interval, no new
 * worker, nothing added to `shutdown.js`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8');

let srv, db, utils, email;

beforeAll(async () => {
  process.env.ALERT_EMAIL = 'ops@test.local';
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  utils = await import('./utils.js');
  email = await import('./email.js');
}, 60000);

afterAll(async () => {
  await srv?.close();
  delete process.env.ALERT_EMAIL;
});

beforeEach(() => {
  db.prepare('DELETE FROM error_events').run();
  db.prepare('DELETE FROM error_groups').run();
});

/** A brand-new, never-alerted problem of the given source. */
function newProblem(fingerprint, source = 'server') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO error_groups
      (fingerprint, source, kind, message, route, status, occurrences, users_seen,
       first_seen_at, last_seen_at, alerted_at)
    VALUES (?, ?, 'TypeError', 'a message that must not be mailed', '/api/events',
            'open', 4, 2, ?, ?, NULL)
  `).run(fingerprint, source, now, now);
}

const alertedAt = (fp) =>
  db.prepare('SELECT alerted_at FROM error_groups WHERE fingerprint = ?').get(fp)?.alerted_at;

/** Waits for the sweep's un-awaited alert promise to settle. */
const settle = () => new Promise(r => setImmediate(r));

describe('the maintenance sweep actually sends alerts', () => {
  it('mails a new server problem when runNotificationSweep runs', async () => {
    const sendMail = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true });
    newProblem('fp-alert-wiring');

    // The real entry point the 15-minute interval calls — not sendErrorAlerts.
    await utils.runNotificationSweep();
    await settle();

    expect(sendMail, 'runNotificationSweep never reached sendErrorAlerts').toHaveBeenCalled();
    expect(alertedAt('fp-alert-wiring')).not.toBeNull();
    sendMail.mockRestore();
  });

  /**
   * The privacy claim, asserted through the REAL path rather than through an
   * injected sender. The unit test could pass while the sweep passed a
   * different body; this reads what the mail layer was actually handed.
   */
  it('mails nothing personal, going through the real sweep', async () => {
    const sendMail = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true });
    newProblem('fp-alert-privacy');

    await utils.runNotificationSweep();
    await settle();

    const body = `${sendMail.mock.calls[0][0].subject}\n${sendMail.mock.calls[0][0].text}`;
    expect(body).not.toContain('a message that must not be mailed');
    expect(body).not.toContain('/api/events');
    expect(body).toContain('fp-alert-privacy');
    sendMail.mockRestore();
  });

  it('does not mail a client problem', async () => {
    const sendMail = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true });
    newProblem('fp-alert-client', 'client');

    await utils.runNotificationSweep();
    await settle();

    expect(sendMail).not.toHaveBeenCalled();
    expect(alertedAt('fp-alert-client')).toBeNull();
    sendMail.mockRestore();
  });

  /**
   * `runNotificationSweep` wraps its whole body in ONE try/catch, so a throw
   * from the alerter would silently abandon every task after it — including the
   * notification dispatch users depend on. `sendErrorAlerts` catches internally
   * instead, and the sweep does not await it, so even a rejecting mail layer
   * must leave the sweep's own return value intact.
   */
  it('a failing mail layer does not abort the rest of the maintenance sweep', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sendMail = vi.spyOn(email, 'sendMail').mockRejectedValue(new Error('SMTP is down'));
    newProblem('fp-alert-smtp-down');

    await expect(utils.runNotificationSweep()).resolves.toBeTypeOf('number');
    expect(typeof await utils.runNotificationSweep()).toBe('number');
    await settle();

    sendMail.mockRestore();
    consoleError.mockRestore();
  });
});

describe('alerting introduced no new scheduling machinery', () => {
  it('server.js still registers exactly the timers it did before', () => {
    const src = read('server.js');
    expect(
      [...src.matchAll(/setInterval\s*\(/g)].length,
      'a new setInterval appeared — alerting must reuse the existing sweep'
    ).toBe(1);
    expect(src).toContain('intervals: [sweepInterval, lockHeartbeat, autoSelectTimer]');
    expect(src, 'server.js should not need to know alerting exists').not.toContain('alerting');
  });

  it('shutdown.js gained nothing to drain', () => {
    const src = read('shutdown.js');
    expect(src).not.toContain('alerting');
    expect(src).not.toContain('sendErrorAlerts');
  });

  it('is invoked from utils.js beside the error sweep', () => {
    const src = read('utils.js');
    expect(src).toContain('sendErrorAlerts(db, {');
    expect(src).toContain("from './alerting.js'");
    expect(
      src.indexOf('sendErrorAlerts(db, {'),
      'alerting must run after the error sweep, in the same try block'
    ).toBeGreaterThan(src.indexOf('await sweepErrors(db, now)'));
  });

  /**
   * Not awaited, deliberately: `runNotificationSweep` is synchronous and its
   * callers do not await it, so awaiting an SMTP round trip would make the
   * 15-minute tick's timing depend on a mail server. Asserted in the source
   * because the consequence — a sweep that stalls behind a slow relay — is not
   * observable in a test with a fast mock.
   */
  it('does not await the send inside the synchronous sweep', () => {
    const src = read('utils.js');
    expect(src).not.toMatch(/await\s+sendErrorAlerts/);
    expect(src).toMatch(/sendErrorAlerts\(db, \{[\s\S]{0,200}?\}\)\s*\n?\s*\.then\(/);
  });

  /** `alerting.js` must stay importable by a test without booting anything. */
  it('imports nothing — db and the mail sender both arrive as arguments', () => {
    const src = read('alerting.js');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toContain("from './db.js'");
    expect(src).not.toContain("from './email.js'");
  });
});
