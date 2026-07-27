#!/usr/bin/env bash
#
# WeVolunteer — nightly database backup.
#
# Uses SQLite's online backup API (`.backup`), NOT `cp`. This matters more than
# it looks: the database runs in WAL mode, so recent commits live in the
# `-wal` sidecar rather than the main file. On a freshly initialised database
# the main file was 4 KB against a 519 KB WAL — a `cp` of the `.db` alone
# produces a file that opens without error and is missing almost everything.
# `.backup` handles the WAL and needs no downtime.
#
# Every backup is integrity-checked before it is kept. A backup that cannot be
# verified is deleted and the script exits non-zero, so a silently failing job
# shows up as a failing job rather than as a directory full of unusable files.
#
# Usage:
#   bin/backup.sh                      # uses the defaults below
#   WEV_DB_PATH=/path/to.db bin/backup.sh
#
# Cron (as the service user, 03:00 daily):
#   0 3 * * * /srv/wevolunteer/bin/backup.sh >> /var/log/wevolunteer-backup.log 2>&1
#
set -euo pipefail

DB="${WEV_DB_PATH:-/var/lib/wevolunteer/wevolunteer.db}"
DEST="${WEV_BACKUP_DIR:-/var/backups/wevolunteer}"
KEEP_DAYS="${WEV_BACKUP_KEEP_DAYS:-14}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is not installed"
[ -f "$DB" ] || fail "database not found at $DB"
mkdir -p "$DEST" || fail "cannot create $DEST"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/wevolunteer-$STAMP.db"

log "backing up $DB -> $OUT"
sqlite3 "$DB" ".backup '$OUT'" || fail "sqlite3 .backup returned non-zero"
[ -s "$OUT" ] || fail "backup file is empty"

# Verify BEFORE keeping it. An unverified backup is a hypothesis, not a backup.
INTEGRITY="$(sqlite3 "$OUT" 'PRAGMA integrity_check;' 2>&1 || true)"
if [ "$INTEGRITY" != "ok" ]; then
  rm -f "$OUT"
  fail "integrity_check on the backup returned: $INTEGRITY"
fi

# Sanity-check the thing the whole system exists to protect. A structurally
# valid backup that lost every credited hour is still a failed backup.
USERS="$(sqlite3 "$OUT" 'SELECT COUNT(*) FROM users;')"
HOURS="$(sqlite3 "$OUT" 'SELECT COALESCE(ROUND(SUM(hours_awarded),2),0) FROM attendance WHERE present = 1;')"
CERTS="$(sqlite3 "$OUT" 'SELECT COUNT(*) FROM certificates;')"
log "verified: users=$USERS credited_hours=$HOURS certificates=$CERTS"

# Fold anything the verification reads left in the copy's own WAL back into the
# single file, then drop the sidecars. Without this, `gzip` compresses only the
# main file and the `-wal`/`-shm` artifacts are left behind uncompressed next to
# it — clutter that also invites someone restoring later to wonder whether the
# .gz is complete. It is: this checkpoint guarantees it.
sqlite3 "$OUT" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
rm -f "$OUT-wal" "$OUT-shm"

gzip -9 "$OUT" || fail "gzip failed"
log "wrote $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Prune old backups only after a successful new one, so a run of failures can
# never age out the last good copy.
find "$DEST" -name 'wevolunteer-*.db.gz' -type f -mtime "+$KEEP_DAYS" -delete
log "pruned backups older than $KEEP_DAYS days"

log "OK"
