/**
 * The small JSON files the backup jobs leave for the application to read.
 *
 * Three independent facts, three files, because they fail independently and the
 * Owner Center must never collapse them into one "backup OK":
 *
 *   status/offsite.json       written by bin/backup-offsite.mjs after each night
 *   status/restore-drill.json written by bin/restore-drill-postgres.sh weekly
 *
 * (The local archive's state is read from the archives themselves — see
 * server/backupStatus.js — so there is nothing to keep in sync for it.)
 *
 * Written atomically (temp file + rename) so a reader never sees half a file, and
 * containing no secret: object keys, byte counts, hashes and timestamps only.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

export function statusDir(env = process.env) {
  return env.WEV_BACKUP_STATUS_DIR || path.join(env.WEV_BACKUP_DIR || '/var/backups/wevolunteer', 'status');
}

export function readStatus(name, env = process.env) {
  try {
    return JSON.parse(readFileSync(path.join(statusDir(env), name), 'utf8'));
  } catch {
    return null;
  }
}

export function writeStatus(name, value, env = process.env) {
  const dir = statusDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  const target = path.join(dir, name);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  chmodSync(tmp, 0o640);
  renameSync(tmp, target);
  return target;
}
