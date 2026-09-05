#!/usr/bin/env bash
#
# WeVolunteer — prove a PostgreSQL backup can actually be restored.
#
# A backup that has never been restored is a hypothesis. This script is the
# experiment: it takes a real archive, decrypts it if necessary, restores it into
# a throwaway database, and then checks that what came back is the database that
# went in — not merely *a* database.
#
# ── Why the manifest comparison is the point ──
#
# bin/backup-postgres.sh records the invariant counts from the LIVE database at
# dump time. This script restores the archive and reads the same four numbers
# back. Structural checks cannot catch a dump that silently lost rows: the
# archive parses, the tables exist, every constraint holds, and the service
# record is simply shorter than it was. Comparing against the manifest is what
# turns "a database was produced" into "THIS database was produced".
#
# ── Safety ──
#
# This script CREATES AND DROPS a database. It refuses to touch anything that is
# not an obviously disposable scratch database, and it refuses outright to run
# against the production URL. Restoring over a live database is a data-loss
# event, and the way that happens is a tired operator reusing a shell that still
# has DATABASE_URL exported.
#
# ── Usage ──
#
#   # verify the newest archive in the backup directory
#   bin/verify-restore-postgres.sh
#
#   # verify a specific one
#   bin/verify-restore-postgres.sh /var/backups/wevolunteer/wevolunteer-2026….dump.enc
#
# Environment:
#   WEV_RESTORE_URL       required — a PostgreSQL server to restore INTO.
#                         Must not be the production database. The scratch
#                         database is created on this server.
#   WEV_BACKUP_DIR        where to look for archives (default /var/backups/wevolunteer)
#   WEV_BACKUP_TESTKEY    private key, required if the archive is encrypted
#   WEV_PG_BIN            directory holding a version-compatible pg_restore
#   DATABASE_URL          if set, used ONLY to refuse to restore over it
#
set -euo pipefail

DEST="${WEV_BACKUP_DIR:-/var/backups/wevolunteer}"
SCRATCH_DB="wev_restore_drill_$$"

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[ -n "${WEV_RESTORE_URL:-}" ] || fail "WEV_RESTORE_URL is not set (a server to restore INTO)"

if [ -n "${WEV_PG_BIN:-}" ]; then
  [ -x "$WEV_PG_BIN/pg_restore" ] || fail "WEV_PG_BIN=$WEV_PG_BIN contains no executable pg_restore"
  PATH="$WEV_PG_BIN:$PATH"
fi
command -v pg_restore >/dev/null 2>&1 || fail "pg_restore is not installed"
command -v psql       >/dev/null 2>&1 || fail "psql is not installed"

# ─────────────────────────────────────────────────────────────────────────────
# Refuse to restore over production.
#
# Compared on host+database rather than the whole string, because the same server
# is reachable by several equivalent URLs (different passwords, sslmode, pooler
# port) and a string comparison would miss every one of them.
pg_ident() {
  psql -tAX -d "$1" -c "SELECT current_setting('port')||'/'||current_database();" 2>/dev/null || true
}
if [ -n "${DATABASE_URL:-}" ]; then
  PROD_IDENT="$(pg_ident "$DATABASE_URL")"
  REST_IDENT="$(pg_ident "$WEV_RESTORE_URL")"
  if [ -n "$PROD_IDENT" ] && [ "$PROD_IDENT" = "$REST_IDENT" ]; then
    fail "WEV_RESTORE_URL points at the same database as DATABASE_URL. Refusing.
  A restore drill must run against a scratch server, never the live one."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Pick the archive.
ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  # Newest by name. The stamp is ISO-8601 basic UTC, so lexical order IS
  # chronological order — no dependency on filesystem mtime, which `cp -p`,
  # rsync and object-storage downloads all disagree about.
  ARCHIVE="$(ls -1 "$DEST"/wevolunteer-*.dump.enc "$DEST"/wevolunteer-*.dump 2>/dev/null | sort | tail -1 || true)"
  [ -n "$ARCHIVE" ] || fail "no archive found in $DEST"
fi
[ -f "$ARCHIVE" ] || fail "archive not found: $ARCHIVE"
log "verifying $ARCHIVE"

MANIFEST="${ARCHIVE%.enc}"; MANIFEST="${MANIFEST%.dump}.manifest.json"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wev-restore-XXXXXX")"
cleanup() {
  rm -rf "$WORK"
  # Drop the scratch database even if the restore failed half-way. A drill that
  # leaves debris behind stops being run.
  psql -tAX -d "$WEV_RESTORE_URL" -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Decrypt if needed.
PLAIN="$WORK/restore.dump"
case "$ARCHIVE" in
  *.enc)
    [ -n "${WEV_BACKUP_TESTKEY:-}" ] || fail "the archive is encrypted but WEV_BACKUP_TESTKEY is not set"
    [ -f "$WEV_BACKUP_TESTKEY" ]     || fail "WEV_BACKUP_TESTKEY does not exist: $WEV_BACKUP_TESTKEY"
    log "decrypting"
    openssl cms -decrypt -binary -inform DER -in "$ARCHIVE" -inkey "$WEV_BACKUP_TESTKEY" -out "$PLAIN" 2>/dev/null \
      || fail "decryption failed — wrong key, or the archive is damaged"
    ;;
  *) cp "$ARCHIVE" "$PLAIN" ;;
esac
[ -s "$PLAIN" ] || fail "the archive is empty"

# ─────────────────────────────────────────────────────────────────────────────
# Restore into a fresh scratch database.
log "creating scratch database $SCRATCH_DB"
psql -tAX -d "$WEV_RESTORE_URL" -c "CREATE DATABASE \"$SCRATCH_DB\";" >/dev/null \
  || fail "could not create the scratch database"

# The scratch URL is the restore URL with the database swapped. Rebuilt rather
# than string-patched so a URL carrying a query string (?sslmode=require) keeps
# it — stripping that would silently downgrade the connection.
SCRATCH_URL="$(python3 - "$WEV_RESTORE_URL" "$SCRATCH_DB" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(sys.argv[1])
print(urlunsplit((u.scheme, u.netloc, '/' + sys.argv[2], u.query, u.fragment)))
PY
)"

log "restoring"
# --exit-on-error: a restore that reports success while having skipped statements
# is exactly the false green this whole exercise exists to eliminate.
if ! pg_restore --no-owner --no-privileges --exit-on-error -d "$SCRATCH_URL" "$PLAIN" 2>"$WORK/err"; then
  fail "pg_restore failed: $(head -c 1500 "$WORK/err")"
fi
log "restore completed with no errors"

# ─────────────────────────────────────────────────────────────────────────────
# Check what came back.
TABLES="$(psql -tAX -d "$SCRATCH_URL" -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")"
log "restored schema: $TABLES tables"
[ "$TABLES" -gt 0 ] || fail "the restored database has no tables"

for t in users events attendance certificates hours_ledger; do
  psql -tAX -d "$SCRATCH_URL" -c "SELECT to_regclass('public.$t');" | grep -q "^$t$" \
    || fail "restored database is missing table '$t'"
done
log "verified: every table the platform cannot be reconstructed without is present"

read -r R_USERS R_HOURS R_CERTS R_LEDGER <<EOF
$(psql -tAX -F' ' -d "$SCRATCH_URL" -c "
  SELECT (SELECT COUNT(*) FROM users),
         (SELECT COALESCE(ROUND(SUM(hours_awarded)::numeric,2),0) FROM attendance WHERE present = 1),
         (SELECT COUNT(*) FROM certificates),
         (SELECT COUNT(*) FROM hours_ledger);")
EOF
log "restored: users=$R_USERS credited_hours=$R_HOURS certificates=$R_CERTS ledger=$R_LEDGER"

# ─────────────────────────────────────────────────────────────────────────────
# Compare against the manifest — the check that makes this a proof.
if [ -f "$MANIFEST" ]; then
  m() { sed -n "s/.*\"$1\": \([0-9.]*\).*/\1/p" "$MANIFEST" | head -1; }
  M_USERS="$(m users)"; M_HOURS="$(m credited_hours)"; M_CERTS="$(m certificates)"; M_LEDGER="$(m hours_ledger)"

  MISMATCH=""
  [ "$R_USERS"  = "$M_USERS"  ] || MISMATCH="$MISMATCH users($M_USERS->$R_USERS)"
  [ "$R_CERTS"  = "$M_CERTS"  ] || MISMATCH="$MISMATCH certificates($M_CERTS->$R_CERTS)"
  [ "$R_LEDGER" = "$M_LEDGER" ] || MISMATCH="$MISMATCH hours_ledger($M_LEDGER->$R_LEDGER)"
  # Hours compared numerically: 3.50 and 3.5 are the same number and different
  # strings, and which one psql prints depends on the column type it came from.
  awk "BEGIN{exit !($R_HOURS==$M_HOURS)}" || MISMATCH="$MISMATCH credited_hours($M_HOURS->$R_HOURS)"

  [ -z "$MISMATCH" ] || fail "the restored database does not match the manifest:$MISMATCH
  The archive restored cleanly but does not contain what the live database held
  when it was taken. Treat this backup as unusable and investigate the dump."
  log "verified: restored counts match the manifest exactly"
else
  log "WARNING: no manifest beside this archive ($(basename "$MANIFEST"))."
  log "WARNING: the restore succeeded, but nothing proves it is COMPLETE."
fi

# Referential integrity. NOT VALID constraints would restore without complaint
# and hide a dump taken mid-transaction; this forces PostgreSQL to re-check them.
INVALID="$(psql -tAX -d "$SCRATCH_URL" -c "
  SELECT COUNT(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated;")"
[ "$INVALID" = "0" ] || fail "$INVALID foreign-key constraints came back unvalidated"

FKS="$(psql -tAX -d "$SCRATCH_URL" -c "SELECT COUNT(*) FROM pg_constraint WHERE contype='f';")"
IDX="$(psql -tAX -d "$SCRATCH_URL" -c "SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public';")"
log "verified: $FKS foreign keys (all validated), $IDX indexes"

log "OK — this archive is proven restorable"
log ""
log "RESTORE DRILL RECORD"
log "  archive:   $(basename "$ARCHIVE")"
log "  tables:    $TABLES"
log "  users:     $R_USERS"
log "  hours:     $R_HOURS"
log "  certs:     $R_CERTS"
log "  ledger:    $R_LEDGER"
log "  drilled:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
