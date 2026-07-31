/**
 * `/api/admin/system/status` must tell an operator something they can act on.
 *
 * It returned exactly one field:
 *
 *     { smtpConfigured: !!(SMTP_HOST && SMTP_USER && SMTP_PASS) }
 *
 * which reports that three environment variables are set — not that mail is being
 * delivered. During an SMTP outage it stays `true` while every verification link
 * silently fails to arrive.
 *
 * Nothing surfaced, anywhere in the product: notification jobs stuck or
 * permanently failed, transactional mail failures, how old the newest backup is, or
 * whether the hours ledger still agrees with attendance. For a district signing off
 * on student service-hour records, backup freshness and ledger parity are the two
 * questions that actually matter, and neither had an answer short of an SSH session.
 *
 * Access control is asserted alongside the content: this endpoint now aggregates
 * operational detail, so an authorization slip here is worth more to an attacker
 * than it was before.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync, mkdirSync, utimesSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { startTestServer } from './testServer.js';

/**
 * One server for the whole file.
 *
 * `startTestServer` owns its own throwaway database and temp directory, so the
 * per-test isolation these cases need is only over the BACKUP directory — which is
 * read from the environment on each request rather than at import, so it can be
 * repointed between tests without rebuilding the app.
 */
let srv, admin, backupRoot;

beforeAll(async () => {
  srv = await startTestServer();
  // DEMO_MODE seeds this administrator; see db.js.
  admin = await srv.login('admin@example.gov');
}, 60000);

afterAll(async () => { await srv?.close(); });

beforeEach(() => {
  backupRoot = mkdtempSync(path.join(tmpdir(), 'wev-backups-'));
  process.env.WEV_BACKUP_DIR = backupRoot;
});

afterEach(() => {
  if (backupRoot) rmSync(backupRoot, { recursive: true, force: true });
  delete process.env.WEV_BACKUP_DIR;
});

const status = (cookie = admin) => srv.call('GET', '/api/admin/system/status', undefined, cookie);

describe('access control', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await srv.call('GET', '/api/admin/system/status');
    expect(res.status).toBe(401);
  });

  it('refuses a student', async () => {
    const student = await srv.login('leo.chen28@gmail.com');
    const res = await status(student);
    expect(res.status).toBe(403);
  });
});

describe('mail health is reported, not just configuration', () => {
  it('distinguishes "configured" from "working"', async () => {
    const res = await status();

    expect(res.status).toBe(200);
    // The old field is kept — it is still the right answer to "is SMTP set up".
    expect(res.body).toHaveProperty('smtpConfigured');
    // What was missing: whether it is actually delivering.
    expect(res.body.mail).toBeTruthy();
    expect(res.body.mail).toHaveProperty('failures');
    expect(res.body.mail).toHaveProperty('lastSuccessAt');
    expect(res.body.mail).toHaveProperty('lastError');
  });
});

describe('notification queue health is reported', () => {
  it('surfaces pending and failed job counts', async () => {
    const { db } = await import('./db.js');

    // A permanently failed job — previously invisible outside a manual SQL query.
    db.prepare(`
      INSERT INTO notification_jobs (id, channel, payload, status, attempts, next_attempt_at, created_at)
      VALUES ('j-dead', 'email', '{}', 'failed', 5, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    const res = await status();

    expect(res.body.notificationQueue).toBeTruthy();
    expect(res.body.notificationQueue.failed).toBe(1);
    expect(res.body.notificationQueue).toHaveProperty('pending');
    expect(res.body.notificationQueue).toHaveProperty('processing');
  });
});

describe('backup freshness is reported', () => {
  it('reports no backups when the directory is empty', async () => {
    const res = await status();

    expect(res.body.backup).toBeTruthy();
    expect(res.body.backup.lastBackupAt).toBeNull();
    // "None" must be distinguishable from "unknown" — an operator seeing null with
    // no explanation cannot tell whether backups are broken or unconfigured.
    expect(res.body.backup.status).toBe('none');
  });

  it('reports the age of the newest backup', async () => {
    writeFileSync(path.join(backupRoot, 'wevolunteer-20260731T030000Z.db.gz'), 'gz');

    const res = await status();

    expect(res.body.backup.lastBackupAt).toBeTruthy();
    expect(res.body.backup.ageHours).toBeGreaterThanOrEqual(0);
    expect(res.body.backup.status).toBe('ok');
  });

  it('flags a stale backup', async () => {
    const f = path.join(backupRoot, 'wevolunteer-old.db.gz');
    writeFileSync(f, 'gz');
    // Three days old. The nightly timer means anything past ~26h is a missed run,
    // which is the runbook's own alerting threshold.
    const old = new Date(Date.now() - 72 * 3600 * 1000);
    utimesSync(f, old, old);

    const res = await status();

    expect(res.body.backup.status).toBe('stale');
    expect(res.body.backup.ageHours).toBeGreaterThan(26);
  });

  it('does not expose the backup directory path', async () => {
    writeFileSync(path.join(backupRoot, 'wevolunteer-x.db.gz'), 'gz');

    const res = await status();
    const body = JSON.stringify(res.body);

    // Admins are school staff, not sysadmins. Filesystem layout is not theirs to
    // know and it is useful to an attacker who reaches an admin session.
    expect(body).not.toContain(backupRoot);
  });
});

describe('hours ledger parity is reported', () => {
  it('reports parity as healthy on a consistent database', async () => {
    const res = await status();

    expect(res.body.hoursLedger).toBeTruthy();
    expect(res.body.hoursLedger.inParity).toBe(true);
  });
});

describe('the endpoint is cheap enough to poll from a dashboard', () => {
  it('responds quickly', async () => {
    const started = Date.now();
    await status();
    const elapsed = Date.now() - started;

    expect(elapsed, `${elapsed}ms is too slow for a status panel`).toBeLessThan(1000);
  });
});
