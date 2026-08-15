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

# ─────────────────────────────────────────────────────────────────────────────
# Encryption.
#
# What is in this file: every student's name, email address, school, year group,
# service record, private messages, and every safety report ever filed. It is the
# highest-value object on the host and, unencrypted, a copy of it is a complete
# copy of the platform's personal data with none of the access control.
#
# ── Public key, not a passphrase ──
#
# `WEV_BACKUP_PUBKEY` is a CERTIFICATE holding a public key. The host can encrypt
# with it and cannot decrypt — the private key lives with the operator, offline.
# That is the property worth having: a passphrase stored next to the backups it
# protects is an inventory label, not a lock, and an attacker who reached the
# host to steal the archives has already reached the passphrase.
#
# It also means this script never handles a secret, so there is nothing here to
# leak into a log, a process list, or a systemd unit file.
#
# ── openssl cms, not gpg or age ──
#
# No new dependency. openssl is already on every host that can run this, gpg
# needs a keyring the service user does not have, and age needs installing. `cms`
# rather than the older `smime` because it streams rather than loading the whole
# archive into memory, which matters as the database grows.
#
# ── Failing loudly is the point ──
#
# If a key is configured and encryption fails, the run FAILS and the plaintext is
# deleted. Falling back to writing plaintext would be the worst outcome: the
# operator believes their backups are encrypted, the file name looks similar
# enough at a glance, and nothing says otherwise.
#
# With no key configured the backup still runs, because no backup is worse than
# an unencrypted one — but it says so on every run, and PRE-RELEASE.md gates
# launch on setting this.
if [ -n "${WEV_BACKUP_PUBKEY:-}" ]; then
  [ -f "$WEV_BACKUP_PUBKEY" ] || fail "WEV_BACKUP_PUBKEY is set but $WEV_BACKUP_PUBKEY does not exist"

  if ! openssl cms -encrypt -binary -aes-256-cbc -in "$OUT.gz" -out "$OUT.gz.enc" \
       -outform DER "$WEV_BACKUP_PUBKEY" 2>/dev/null; then
    rm -f "$OUT.gz" "$OUT.gz.enc"
    fail "encryption failed — refusing to leave an unencrypted backup behind"
  fi

  # Prove it decrypts to the same bytes before throwing the plaintext away.
  # An encrypted backup nobody has ever decrypted is a hypothesis, exactly as an
  # unverified one is — and the moment to find out is now, not during a restore.
  if [ -n "${WEV_BACKUP_TESTKEY:-}" ] && [ -f "$WEV_BACKUP_TESTKEY" ]; then
    if ! openssl cms -decrypt -binary -inform DER -in "$OUT.gz.enc" \
         -inkey "$WEV_BACKUP_TESTKEY" 2>/dev/null | cmp -s - "$OUT.gz"; then
      rm -f "$OUT.gz" "$OUT.gz.enc"
      fail "the encrypted backup did not decrypt back to the original"
    fi
    log "verified: the encrypted archive decrypts to the original bytes"
  fi

  rm -f "$OUT.gz"
  log "encrypted to $OUT.gz.enc ($(du -h "$OUT.gz.enc" | cut -f1))"
else
  log "WARNING: WEV_BACKUP_PUBKEY is not set — this backup is NOT encrypted."
  log "WARNING: it contains every student's personal data in readable form."
fi

# Prune old backups only after a successful new one, so a run of failures can
# never age out the last good copy. Both suffixes, so switching encryption on or
# off does not strand the previous generation for ever.
find "$DEST" \( -name 'wevolunteer-*.db.gz' -o -name 'wevolunteer-*.db.gz.enc' \) \
     -type f -mtime "+$KEEP_DAYS" -delete
log "pruned backups older than $KEEP_DAYS days"

log "OK"
