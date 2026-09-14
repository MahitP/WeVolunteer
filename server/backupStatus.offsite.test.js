import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { backupStatus, offsiteStatus, restoreDrillStatus, overallBackupState } from './backupStatus.js';
import { isBackupAlertable, sendBackupAlert } from './alerting.js';

/**
 * The off-site copy and the restore drill, as facts the application can be wrong about.
 *
 * ── The failure these exist to prevent ──
 *
 * `backupStatus()` read one thing: the archive directory on this host. A night
 * where the dump, the verification, the encryption and the local archive all
 * succeeded and only the upload to Backblaze failed left that directory looking
 * perfect — so the Owner Center reported "Backups: Current" and the twice-daily
 * alert stayed quiet. The half of the system that protects against a bad
 * migration was working; the half that protects against losing the host was
 * broken; and the only surface that could have said so said the opposite.
 *
 * The states below are therefore written from the status files as the scripts
 * actually write them (`bin/lib/backup-status-file.mjs`), not from a mock of this
 * module — a test that stubs the reader cannot catch a reader that reads the
 * wrong file.
 */

let dir;
const original = { ...process.env };

const write = (name, value) => {
  fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'status', name), JSON.stringify(value));
};
const archive = (name = 'wevolunteer-20260913T030000Z.dump.enc', ageHours = 2) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'ciphertext');
  const when = new Date(Date.now() - ageHours * 3_600_000);
  fs.utimesSync(p, when, when);
};

const verified = (over = {}) => ({
  state: 'verified',
  at: new Date().toISOString(),
  archive: 'wevolunteer-20260913T030000Z.dump.enc',
  bytes: 204_800,
  sha256: 'a'.repeat(64),
  levels: { uploaded: true, headVerified: true, downloadVerified: true },
  warnings: [],
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wev-offsite-status-'));
  process.env.WEV_BACKUP_DIR = dir;
  delete process.env.WEV_BACKUP_STATUS_DIR;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...original };
});

describe('the off-site copy as its own fact', () => {
  it('is "never" when no run has recorded anything — not silently absent', () => {
    expect(offsiteStatus().state).toBe('never');
  });

  it('reports a verified copy, and the levels it actually reached', () => {
    write('offsite.json', verified());
    const s = offsiteStatus();
    expect(s.state).toBe('ok');
    /* Three separate claims. "Uploaded" and "downloaded back and hashed" are not
       the same evidence, and the runbook's advice differs between them. */
    expect(s.levels).toEqual({ uploaded: true, headVerified: true, downloadVerified: true });
  });

  it('goes stale when the last verified copy ages out, even though the file is present', () => {
    write('offsite.json', verified({ at: new Date(Date.now() - 72 * 3_600_000).toISOString() }));
    expect(offsiteStatus().state).toBe('stale');
  });

  it('keeps the last PROVEN copy on the record when tonight failed', () => {
    write('offsite.json', {
      state: 'failed', stage: 'upload', error: 'PUT refused: HTTP 403',
      at: new Date().toISOString(),
      lastVerified: { at: '2026-09-10T03:00:00Z', archive: 'wevolunteer-20260910T030000Z.dump.enc', bytes: 204_800 },
    });
    const s = offsiteStatus();
    expect(s.state).toBe('failed');
    expect(s.stage).toBe('upload');
    /* The question an operator actually has at 3am is "how much would we lose if
       the host died right now", and that is answered by the last copy that was
       proven, not by the last attempt. */
    expect(s.lastVerified.at).toBe('2026-09-10T03:00:00Z');
  });

  it('distinguishes "no destination configured" from "the destination failed"', () => {
    write('offsite.json', { state: 'unconfigured', at: new Date().toISOString() });
    expect(offsiteStatus().state).toBe('unconfigured');
  });

  it('surfaces a warning without pretending the copy failed', () => {
    write('offsite.json', verified({ warnings: ['lock-blocks-expiry: objects are locked for 30 days but retention is 28 days'] }));
    const s = offsiteStatus();
    expect(s.state).toBe('warn');
    expect(s.detail).toMatch(/lock-blocks-expiry/);
  });

  it('does not read a half-written or corrupt status file as healthy', () => {
    fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'status', 'offsite.json'), '{"state":"veri');
    expect(offsiteStatus().state).toBe('never');
  });
});

describe('the restore drill as its own fact', () => {
  it('is "never" until a restore has actually been demonstrated', () => {
    expect(restoreDrillStatus().state).toBe('never');
  });

  it('records WHICH copy was drilled — a local drill is not off-site evidence', () => {
    write('restore-drill.json', { state: 'passed', at: new Date().toISOString(), source: 'local' });
    const s = restoreDrillStatus();
    expect(s.state).toBe('ok');
    expect(s.source).toBe('local');
  });

  it('goes stale when the weekly drill quietly stops running', () => {
    write('restore-drill.json', { state: 'passed', at: new Date(Date.now() - 20 * 86_400_000).toISOString(), source: 'offsite' });
    expect(restoreDrillStatus().state).toBe('stale');
  });

  it('reports a failed drill with the stage it failed at', () => {
    write('restore-drill.json', { state: 'failed', stage: 'restore', error: 'pg_restore failed', at: new Date().toISOString(), source: 'offsite' });
    const s = restoreDrillStatus();
    expect(s.state).toBe('failed');
    expect(s.stage).toBe('restore');
  });
});

describe('the composed verdict', () => {
  /**
   * The regression this whole file exists for.
   */
  it('is NOT ok when the local archive is perfect and the off-site copy failed', () => {
    archive();
    write('offsite.json', { state: 'failed', stage: 'upload', error: 'boom', at: new Date().toISOString() });
    write('restore-drill.json', { state: 'passed', at: new Date().toISOString(), source: 'offsite' });

    const s = backupStatus();
    expect(s.status).toBe('ok');            // the local archive really is fine
    expect(s.offsite.state).toBe('failed'); // and this really is not
    expect(overallBackupState(s)).toBe('failed');
  });

  it('is ok only when all three are ok', () => {
    archive();
    write('offsite.json', verified());
    write('restore-drill.json', { state: 'passed', at: new Date().toISOString(), source: 'offsite' });
    expect(overallBackupState(backupStatus())).toBe('ok');
  });

  it('calls a deliberate local-only deployment what it is, rather than healthy or broken', () => {
    archive();
    write('offsite.json', { state: 'unconfigured', at: new Date().toISOString() });
    write('restore-drill.json', { state: 'passed', at: new Date().toISOString(), source: 'local' });
    expect(overallBackupState(backupStatus())).toBe('local-only');
  });

  it('still reads the off-site record when the local directory cannot be read', () => {
    /* "The disk is unreadable but B2 holds a copy verified four hours ago" is a
       different morning from "the disk is unreadable and nothing is off-site". */
    write('offsite.json', verified());
    process.env.WEV_BACKUP_STATUS_DIR = path.join(dir, 'status');
    process.env.WEV_BACKUP_DIR = path.join(dir, 'does-not-exist');
    const s = backupStatus();
    expect(s.status).toBe('unconfigured');
    expect(s.offsite.state).toBe('ok');
  });
});

describe('alerting on the copies that are not on this host', () => {
  const alert = () => {
    const send = (() => { const f = (...a) => { f.calls.push(a); return Promise.resolve(); }; f.calls = []; return f; })();
    return { send };
  };

  it('wakes somebody when the off-site copy fails, even though the nightly archive is fine', async () => {
    archive();
    write('offsite.json', { state: 'failed', stage: 'upload', error: 'PUT refused', at: new Date().toISOString() });
    process.env.ALERT_EMAIL = 'ops@example.org';

    const status = backupStatus();
    expect(isBackupAlertable(status, { NODE_ENV: 'production' })).toBe(true);

    const { send } = alert();
    /* `sendBackupAlert` throttles to one email per 12 hours on module state, so
       each case here has to name a time far enough from the last. */
    const res = await sendBackupAlert({ send, status, now: new Date(Date.now() + 30 * 86_400_000) });
    expect(res.sent).toBe(1);

    /* And it must not claim the backups stopped. An operator who reads "Backups
       are not running", checks the timer, and finds it running perfectly learns
       that this alert is noise — which is how the next real one gets ignored. */
    const msg = send.calls[0][0];
    expect(msg.subject).not.toMatch(/Backups are not running/);
    expect(msg.subject).toMatch(/off-site copy or restore drill/i);
    expect(msg.text).toMatch(/Off-site copy \(Backblaze B2\): FAILED/);
  });

  it('stays quiet about a deliberate local-only deployment', () => {
    archive();
    write('offsite.json', { state: 'unconfigured', at: new Date().toISOString() });
    write('restore-drill.json', { state: 'passed', at: new Date().toISOString(), source: 'local' });
    expect(isBackupAlertable(backupStatus(), { NODE_ENV: 'production' })).toBe(false);
  });

  it('does not nag a laptop about a drill it was never going to run', () => {
    archive();
    write('offsite.json', { state: 'unconfigured', at: new Date().toISOString() });
    /* No drill file at all: "never" — an incident in production, ordinary here. */
    expect(isBackupAlertable(backupStatus(), { NODE_ENV: 'development' })).toBe(false);
    expect(isBackupAlertable(backupStatus(), { NODE_ENV: 'production' })).toBe(true);
  });

  it('still sends the original message when the local archive is the thing that broke', async () => {
    archive('wevolunteer-old.dump.enc', 90);
    write('offsite.json', verified());
    process.env.ALERT_EMAIL = 'ops@example.org';

    const { send } = alert();
    const res = await sendBackupAlert({ send, status: backupStatus(), now: new Date(Date.now() + 60 * 86_400_000) });
    expect(res).toMatchObject({ sent: 1, status: 'stale' });
    expect(send.calls[0][0].subject).toMatch(/Backups are not running/);
  });
});
