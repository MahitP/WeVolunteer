import fs from 'fs';
import path from 'path';

/**
 * How fresh the newest backup is.
 *
 * ── Why this is its own module ──
 *
 * It lived inside `adminRoutes.js`, which was the right place while the only
 * consumer was the admin dashboard. It now has two: the dashboard, which answers
 * "is this healthy" for somebody who came to look, and `alerting.js`, which
 * answers it for somebody who did not.
 *
 * A second copy in the alerter would have been the more obvious change and the
 * worse one — two definitions of "stale" drift, and the failure mode is a
 * dashboard that says `ok` while the alerter emails, or the reverse, which
 * teaches an operator to disbelieve both.
 *
 * ── What it cannot tell you ──
 *
 * Reading a directory cannot distinguish "the timer is disabled" from "the timer
 * ran and failed": both present as a file that stopped appearing. That is a real
 * limitation and it is why the archive suffixes below matter more than they look
 * — a backup that succeeded but wrote a name this filter does not recognise is
 * indistinguishable, from here, from no backup at all.
 */

/**
 * The timer runs nightly at 03:00 with up to 5 minutes of jitter, so a healthy
 * system is never more than ~24h behind. 26 hours leaves room for the jitter and
 * a slow run while still catching a single missed night — the same threshold the
 * runbook's alerting table uses.
 *
 * Read per call rather than at import so a test can set it.
 */
export const staleAfterHours = () => Number(process.env.BACKUP_STALE_HOURS) || 26;

export const backupDir = () => process.env.WEV_BACKUP_DIR || '/var/backups/wevolunteer';

/**
 * `.db.gz` is a plaintext archive; `.db.gz.enc` is the same thing encrypted to
 * the operator's public key. Recognising only the first would mean that turning
 * encryption ON — the safer configuration — made every backup invisible to
 * monitoring and started paging about a system that was working perfectly.
 * A security improvement that silences your alerting is a security regression.
 *
 * Both scripts' archives: `bin/backup.sh` (SQLite, `.db.gz`) and
 * `bin/backup-postgres.sh` (PostgreSQL, `.dump`), each with its `.enc` form.
 *
 * This listed only the SQLite names, and production is PostgreSQL — so on the
 * live host a directory of good nightly `.dump.enc` archives read as "no
 * archives at all", the Owner Center reported no backups, and the backup alert
 * would have told operators every twelve hours that backups were not running.
 * Manifests (`.manifest.json`) are deliberately not archives: one is written
 * before encryption and upload, so a run that failed after writing it must not
 * count. `alerting.backup.test.js` covers each name.
 */
const ARCHIVE_SUFFIXES = ['.db.gz', '.db.gz.enc', '.dump', '.dump.enc'];

const isArchive = (name) => ARCHIVE_SUFFIXES.some(s => name.endsWith(s));

/**
 * @returns {{status: 'ok'|'stale'|'none'|'unconfigured'|'unknown',
 *            lastBackupAt: string|null, ageHours: number|null, count: number,
 *            staleAfterHours?: number, encrypted?: boolean}}
 */
export function backupStatus() {
  const dir = backupDir();
  const limit = staleAfterHours();
  try {
    if (!fs.existsSync(dir)) {
      /* Unconfigured is distinct from "ran and produced nothing", and an
         operator needs to be able to tell them apart. */
      return { status: 'unconfigured', lastBackupAt: null, ageHours: null, count: 0 };
    }

    const archives = fs.readdirSync(dir)
      .filter(isArchive)
      .map((f) => {
        try {
          return { name: f, mtime: fs.statSync(path.join(dir, f)).mtime };
        } catch {
          return null; // pruned between readdir and stat
        }
      })
      .filter(Boolean);

    if (archives.length === 0) {
      return { status: 'none', lastBackupAt: null, ageHours: null, count: 0 };
    }

    const newest = archives.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    const ageHours = (Date.now() - newest.mtime.getTime()) / 3_600_000;

    return {
      status: ageHours > limit ? 'stale' : 'ok',
      lastBackupAt: newest.mtime.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      count: archives.length,
      staleAfterHours: limit,
      /* Surfaced so an operator can see at a glance whether the thing sitting on
         disk is readable by anyone who reaches the disk. */
      encrypted: newest.name.endsWith('.enc'),
    };
  } catch (err) {
    console.error('[Backup] Could not read backup directory:', err);
    return { status: 'unknown', lastBackupAt: null, ageHours: null, count: 0 };
  }
}

/** The states that mean somebody should be told without being asked. */
export const NEEDS_ATTENTION = Object.freeze(['stale', 'none', 'unknown']);
