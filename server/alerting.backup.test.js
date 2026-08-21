import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { sendBackupAlert, BACKUP_ALERT_INTERVAL_MS, __resetBackupAlertThrottle } from './alerting.js';
import { backupStatus } from './backupStatus.js';

/**
 * Telling somebody the backups stopped.
 *
 * ── What this is guarding ──
 *
 * `deploy/README.md` said it plainly for two releases: "systemd will mark the
 * unit failed, but nothing tells a human." The admin dashboard has reported
 * backup freshness for a while, and a dashboard answers the question for
 * somebody who came to ask it. The failure this exists for is the one nobody
 * comes to ask about — a system that is otherwise completely healthy, whose
 * backups quietly stopped, discovered on the day they are needed.
 *
 * ── Why it cannot ride on the error digest ──
 *
 * `sendErrorAlerts` returns early on `nothing_new`, and a stale backup produces
 * no error rows at all. The cases below pin the two halves that matter: it fires
 * when nothing else would, and it stays quiet when there is nothing wrong.
 */

let dir;
const send = vi.fn();

const hoursAgo = (h) => {
  const t = new Date(Date.now() - h * 3_600_000);
  return t.getTime() / 1000;
};

/** Writes an archive and back-dates it, which is what "stale" actually means. */
function archive(name, ageHours) {
  const f = path.join(dir, name);
  writeFileSync(f, 'gz');
  utimesSync(f, hoursAgo(ageHours), hoursAgo(ageHours));
  return f;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-backup-alert-'));
  process.env.WEV_BACKUP_DIR = dir;
  process.env.ALERT_EMAIL = 'ops@example.org';
  send.mockReset();
  send.mockResolvedValue(undefined);
  __resetBackupAlertThrottle();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.WEV_BACKUP_DIR;
  delete process.env.ALERT_EMAIL;
  delete process.env.BACKUP_STALE_HOURS;
});

describe('when the backups are healthy', () => {
  it('says nothing', async () => {
    archive('wevolunteer-20260814T030000Z.db.gz', 2);
    const res = await sendBackupAlert({ send, status: backupStatus() });
    expect(res).toMatchObject({ sent: 0, reason: 'healthy' });
    expect(send).not.toHaveBeenCalled();
  });

  it('counts an ENCRYPTED archive as a backup', async () => {
    /**
     * The regression that would have made this whole feature backfire.
     *
     * `backupStatus` used to recognise only `.db.gz`. Turning encryption on —
     * the safer configuration — renames the output to `.db.gz.enc`, which would
     * have made every backup invisible and started paging about a system that
     * was working perfectly. A security improvement that silences your alerting
     * is a security regression.
     */
    archive('wevolunteer-20260814T030000Z.db.gz.enc', 2);
    const status = backupStatus();
    expect(status.status).toBe('ok');
    expect(status.encrypted).toBe(true);

    const res = await sendBackupAlert({ send, status: backupStatus() });
    expect(res.reason).toBe('healthy');
  });
});

describe('when the backups have stopped', () => {
  it('emails about a stale archive', async () => {
    archive('wevolunteer-old.db.gz', 40);
    const res = await sendBackupAlert({ send, status: backupStatus() });

    expect(res).toMatchObject({ sent: 1, reason: 'sent', status: 'stale' });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe('ops@example.org');
    expect(msg.subject).toMatch(/Backups are not running/);
  });

  it('emails when the directory is empty', async () => {
    const res = await sendBackupAlert({ send, status: backupStatus() });
    expect(res).toMatchObject({ sent: 1, status: 'none' });
  });

  /**
   * A production host with no backup directory has no backups.
   *
   * `unconfigured` was deliberately silent because it meant "a laptop". That was
   * true while SQLite was production: the backup timer shipped with the
   * deployment, so the directory existed on every real host. On Supabase nothing
   * creates it — `bin/backup.sh` is a `sqlite3 .backup` and does not run against
   * PostgreSQL at all — so the state a production host lands in by default is
   * precisely the one that said nothing.
   */
  it('emails when a PRODUCTION host has no backup directory at all', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await sendBackupAlert({
        send,
        status: { status: 'unconfigured', lastBackupAt: null, ageHours: null, count: 0 },
      });
      expect(res).toMatchObject({ sent: 1, status: 'unconfigured' });
      /* The message has to say why it is not simply "turn the timer on", because
         on this deployment the timer is the wrong tool. */
      expect(send.mock.calls[0][0].text).toMatch(/sqlite3 \.backup|pg_dump/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('stays quiet about no backup directory outside production', async () => {
    /* Alerting on every developer's laptop is how an alert gets ignored on the
       day it is real. */
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const res = await sendBackupAlert({
        send,
        status: { status: 'unconfigured', lastBackupAt: null, ageHours: null, count: 0 },
      });
      expect(res).toMatchObject({ sent: 0, reason: 'healthy' });
      expect(send).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('admits it cannot tell a disabled timer from a failed run', async () => {
    /**
     * The honesty requirement. `backupStatus` reads a directory; both causes
     * present as a file that stopped appearing. An alert that asserted one of
     * them would send an operator to the wrong place at the wrong hour.
     */
    archive('wevolunteer-old.db.gz', 40);
    await sendBackupAlert({ send, status: backupStatus() });
    const body = send.mock.calls[0][0].text;

    expect(body).toMatch(/cannot tell you whether the timer is disabled or whether it ran and failed/i);
    /* And it names the commands that DO distinguish them. */
    expect(body).toContain('systemctl list-timers wevolunteer-backup.timer');
    expect(body).toContain('journalctl -u wevolunteer-backup.service');
  });

  it('carries no personal data', async () => {
    /**
     * The same rule the error digest follows, and for the same reason: this
     * lands in a mailbox the app does not control and will be forwarded. There
     * is nothing here that needs a name in it.
     */
    archive('wevolunteer-old.db.gz', 40);
    await sendBackupAlert({ send, status: backupStatus() });
    const body = send.mock.calls[0][0].text;

    /* The directory path is a filesystem detail and useful to anyone who reads
       a forwarded copy. `backupStatus` withholds it deliberately. */
    expect(body).not.toContain(dir);
    for (const term of ['password', 'token', 'student@', 'grade']) {
      expect(body.toLowerCase(), `the alert body contained "${term}"`).not.toContain(term);
    }
  });
});

describe('it does not become noise', () => {
  it('sends once and then holds off', async () => {
    archive('wevolunteer-old.db.gz', 40);

    expect((await sendBackupAlert({ send, status: backupStatus() })).sent).toBe(1);
    expect((await sendBackupAlert({ send, status: backupStatus() })).reason).toBe('throttled');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('speaks again after the interval', async () => {
    archive('wevolunteer-old.db.gz', 40);
    await sendBackupAlert({ send, status: backupStatus(), now: new Date(0) });

    const later = new Date(BACKUP_ALERT_INTERVAL_MS + 1000);
    expect((await sendBackupAlert({ send, status: backupStatus(), now: later })).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not start the clock during a quiet week', async () => {
    /**
     * The throttle is checked AFTER establishing there is something to say,
     * matching `sendErrorAlerts`. Checked first, a long healthy stretch would
     * leave the timer armed and swallow the first real alert.
     */
    archive('wevolunteer-fresh.db.gz', 1);
    await sendBackupAlert({ send, status: backupStatus() });          // healthy, says nothing

    rmSync(path.join(dir, 'wevolunteer-fresh.db.gz'));
    archive('wevolunteer-old.db.gz', 40);      // now broken
    expect((await sendBackupAlert({ send, status: backupStatus() })).sent).toBe(1);
  });
});

describe('when alerting is not configured', () => {
  it('stays silent rather than failing', async () => {
    delete process.env.ALERT_EMAIL;
    archive('wevolunteer-old.db.gz', 40);
    expect((await sendBackupAlert({ send, status: backupStatus() })).reason).toBe('not_configured');
  });

  it('never throws, whatever the mailer does', async () => {
    /* Monitoring that can take down the thing it monitors is worse than none. */
    archive('wevolunteer-old.db.gz', 40);
    send.mockRejectedValue(new Error('smtp gone'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendBackupAlert({ send, status: backupStatus() })).resolves.toMatchObject({ reason: 'failed' });
  });
});
