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
 * Where `bin/backup-offsite.mjs` and `bin/restore-drill-postgres.sh` leave their
 * records. Must agree with `bin/lib/backup-status-file.mjs`, which writes them.
 */
export const statusDir = () => process.env.WEV_BACKUP_STATUS_DIR || path.join(backupDir(), 'status');

const readStatusFile = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(statusDir(), name), 'utf8'));
  } catch {
    return null;  /* absent, unreadable, or half-written — all "we do not know" */
  }
};

const hoursSince = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
};

/**
 * The off-site copy is a SEPARATE fact from the local archive, and collapsing the
 * two is the specific failure this exists to prevent.
 *
 * A nightly run that dumps, encrypts and writes a local archive perfectly, and
 * then cannot reach Backblaze, leaves a backup directory that looks flawless. The
 * Owner Center read only that directory and so reported "Backups: Current" — a
 * green tick for the half of the system that protects against losing the host,
 * while the half that protects against losing the host was broken. An operator
 * would have learned the off-site copies had stopped on the day they needed one.
 *
 * `unconfigured` is not a failure: a development machine, or a host whose owner
 * has deliberately not set B2 up, and `bin/backup-offsite.mjs` says so loudly in
 * its own log. It is reported as its own state so nobody reads it as healthy
 * either.
 */
export const offsiteStaleAfterHours = () => Number(process.env.BACKUP_OFFSITE_STALE_HOURS) || 26;

export function offsiteStatus() {
  const s = readStatusFile('offsite.json');
  if (!s) return { state: 'never', detail: 'No off-site run has ever recorded a result.' };
  if (s.state === 'unconfigured') {
    return { state: 'unconfigured', at: s.at ?? null, detail: 'No off-site destination is configured; backups exist only on this host.' };
  }
  if (s.state === 'failed') {
    return {
      state: 'failed',
      at: s.at ?? null,
      stage: s.stage ?? null,
      error: s.error ?? null,
      /* The last copy that WAS proven, so an operator can see how far back the
         last real off-site copy is rather than only that tonight went wrong. */
      lastVerified: s.lastVerified ?? null,
      detail: `The off-site copy failed at "${s.stage ?? 'unknown'}".`,
    };
  }
  if (s.state !== 'verified') return { state: 'unknown', at: s.at ?? null, detail: 'The off-site status file is not in a state this version understands.' };

  const ageHours = hoursSince(s.at);
  const limit = offsiteStaleAfterHours();
  const base = {
    at: s.at ?? null,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    archive: s.archive ?? null,
    bytes: s.bytes ?? null,
    /* Never one boolean: "uploaded" and "downloaded and hashed back" are
       different claims and the runbook's recovery advice differs between them. */
    levels: s.levels ?? null,
    lock: s.lock ?? null,
    audit: s.audit ?? null,
    policy: s.policy ?? null,
    warnings: Array.isArray(s.warnings) ? s.warnings : [],
    staleAfterHours: limit,
  };
  if (ageHours === null) return { ...base, state: 'unknown', detail: 'The recorded time could not be read.' };
  if (ageHours > limit) return { ...base, state: 'stale', detail: `The last verified off-site copy is ${base.ageHours} h old.` };
  if (base.warnings.length > 0) return { ...base, state: 'warn', detail: base.warnings[0] };
  return { ...base, state: 'ok', detail: `Verified ${base.ageHours} h ago.` };
}

/**
 * Whether a restore has actually been demonstrated lately — the only one of these
 * three facts that is evidence the backups are *usable* rather than merely present.
 *
 * The drill runs weekly, so 10 days allows a missed run plus the jitter without
 * reporting an incident, and still catches a drill that has silently stopped.
 */
export const drillStaleAfterDays = () => Number(process.env.BACKUP_DRILL_STALE_DAYS) || 10;

export function restoreDrillStatus() {
  const s = readStatusFile('restore-drill.json');
  if (!s) return { state: 'never', detail: 'No restore has ever been drilled on this host.' };
  const ageHours = hoursSince(s.at);
  const ageDays = ageHours === null ? null : Math.round((ageHours / 24) * 10) / 10;
  const base = {
    at: s.at ?? null,
    ageDays,
    /* `local` or `offsite`: a drill of the local archive is NOT evidence the
       off-site copy restores, and the Owner Center must not present it as such. */
    source: s.source ?? null,
    archive: s.archive ?? null,
    result: s.result ?? null,
    staleAfterDays: drillStaleAfterDays(),
  };
  if (s.state === 'failed') {
    return { ...base, state: 'failed', stage: s.stage ?? null, error: s.error ?? null, detail: `The restore drill failed at "${s.stage ?? 'unknown'}".` };
  }
  if (s.state !== 'passed') return { ...base, state: 'unknown', detail: 'The drill status file is not in a state this version understands.' };
  if (ageDays === null) return { ...base, state: 'unknown', detail: 'The recorded time could not be read.' };
  if (ageDays > base.staleAfterDays) return { ...base, state: 'stale', detail: `The last successful drill was ${ageDays} days ago.` };
  return { ...base, state: 'ok', detail: `Restored from the ${base.source ?? 'unknown'} copy ${ageDays} days ago.` };
}

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
         operator needs to be able to tell them apart.

         The companions are still read: on a host whose backup directory is gone,
         "and B2 holds a copy verified four hours ago" is the difference between an
         incident and a catastrophe, and it is exactly the moment somebody needs to
         know which one they are in. */
      return { status: 'unconfigured', lastBackupAt: null, ageHours: null, count: 0, ...companions() };
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
      return { status: 'none', lastBackupAt: null, ageHours: null, count: 0, ...companions() };
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
      ...companions(),
    };
  } catch (err) {
    console.error('[Backup] Could not read backup directory:', err);
    return { status: 'unknown', lastBackupAt: null, ageHours: null, count: 0, ...companions() };
  }
}

/**
 * The two facts that live beside the archive directory rather than in it.
 *
 * Read even when the local reading failed: "the disk is unreadable but B2 holds a
 * copy verified four hours ago" is a materially different morning from "the disk
 * is unreadable and nothing is off-site", and an operator needs to be able to tell
 * them apart before deciding what to do.
 *
 * `status` keeps meaning the LOCAL archive, unchanged, because `alerting.js`
 * composes its message from it and that message must stay true. `overall` is the
 * separate, worst-of judgement for a caller that wants one word.
 */
function companions() {
  const offsite = offsiteStatus();
  const drill = restoreDrillStatus();
  return { offsite, drill };
}

/** The states of a companion fact that mean somebody should be told. */
const COMPANION_NEEDS_ATTENTION = Object.freeze(['failed', 'stale', 'never', 'unknown']);

/**
 * One word for the whole backup system, worst-first.
 *
 * Deliberately NOT a boolean and deliberately not derived inside the view: two
 * surfaces that each decide what "healthy" means drift, and the failure mode is a
 * dashboard that is green while the alerter emails.
 *
 * `never` for the off-site copy is only an incident once something is configured.
 * On a host with no B2 at all the honest word is "local only", which is a choice
 * the operator made, not a fault — but it is never "ok".
 */
export function overallBackupState(s) {
  const local = s?.status;
  const offsite = s?.offsite?.state;
  const drill = s?.drill?.state;
  if (NEEDS_ATTENTION.includes(local)) return 'failed';
  if (local === 'unconfigured') return 'unconfigured';
  if (offsite === 'failed' || drill === 'failed') return 'failed';
  if (offsite === 'unconfigured') return 'local-only';
  if (COMPANION_NEEDS_ATTENTION.includes(offsite) || COMPANION_NEEDS_ATTENTION.includes(drill)) return 'degraded';
  if (offsite === 'warn') return 'degraded';
  return 'ok';
}

/** The states that mean somebody should be told without being asked. */
export const NEEDS_ATTENTION = Object.freeze(['stale', 'none', 'unknown']);
