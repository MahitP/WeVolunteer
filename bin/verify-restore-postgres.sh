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
#   WEV_OPENSSL           an OpenSSL 3 binary (default: `openssl` on PATH). Archives
#                         from 2026-09-13 on are AES-256-GCM, which LibreSSL (macOS
#                         /usr/bin/openssl) cannot read.
#   WEV_RESTORE_RESULT    optional path; a JSON record of this drill is written there
#   DATABASE_URL          if set, used ONLY to refuse to restore over it
#
set -euo pipefail

DEST="${WEV_BACKUP_DIR:-/var/backups/wevolunteer}"
SCRATCH_DB="wev_restore_drill_$$"
OPENSSL="${WEV_OPENSSL:-openssl}"
STARTED="$(date +%s)"

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

# ─────────────────────────────────────────────────────────────────────────────
# The bytes first. Manifests from 2026-09-13 on record the archive's SHA-256; a
# mismatch means the file is not the one that was taken, and nothing after this
# point could be trusted — so the drill stops here rather than reporting on it.
M_SHA=""
if [ -f "$MANIFEST" ]; then
  M_SHA="$(sed -n 's/.*"archive_sha256": "\([0-9a-f]\{64\}\)".*/\1/p' "$MANIFEST")"
fi
if [ -n "$M_SHA" ]; then
  A_SHA="$(sha256sum "$ARCHIVE" 2>/dev/null || shasum -a 256 "$ARCHIVE")"
  A_SHA="${A_SHA%% *}"
  [ "$A_SHA" = "$M_SHA" ] || fail "the archive's SHA-256 does not match its manifest — this is not the file that was backed up"
  log "verified: archive SHA-256 matches the manifest"
fi

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
    "$OPENSSL" cms -decrypt -binary -inform DER -in "$ARCHIVE" -inkey "$WEV_BACKUP_TESTKEY" -out "$PLAIN" 2>"$WORK/err" \
      || fail "decryption failed — wrong key, a damaged archive, or an OpenSSL that cannot read AES-256-GCM (set WEV_OPENSSL to OpenSSL 3): $(head -c 300 "$WORK/err")"
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

# Prepare the target to match the shape the archive expects.
#
# Two things, both discovered by an actual drill on 2026-09-12 rather than by
# reading the dump:
#
#   1. The archive begins `SELECT pg_catalog.set_config('search_path','',false)`
#      and then `CREATE SCHEMA public`. A freshly created database ALREADY has a
#      public schema, so the restore aborts with "schema public already exists".
#      Dropping it first is safe precisely because the database is new and empty
#      — this script created it moments ago and drops it again at the end.
#
#   2. With an empty search_path every object is fully qualified, and the four
#      trigram indexes are emitted as `extensions.gin_trgm_ops` — the schema the
#      provider installs pg_trgm into. So the target needs an `extensions` schema
#      holding pg_trgm, not merely pg_trgm somewhere.
#
# pg_trgm, pgcrypto and uuid-ossp are ordinary contrib extensions present in any
# standard PostgreSQL installation; none of this requires provider software.
# 3. Where the archive expects pg_trgm is a property of the SOURCE, not of this
#    script: Supabase installs it in `extensions`, a self-hosted PostgreSQL (the
#    local drill database, or any future non-Supabase host) in `public`. A drill
#    on 2026-09-13 restoring a self-hosted archive failed with `operator class
#    "public.gin_trgm_ops" does not exist`. So the archive is asked, and the
#    restore runs in sections, so an extension that must live in `public` can be
#    created after `public` itself is restored and before the indexes that use it.
TRGM_SCHEMAS="$(pg_restore -f - --section=post-data "$PLAIN" 2>/dev/null | grep -oE '[a-z_]+\.gin_trgm_ops' | sed 's/\.gin_trgm_ops$//' | sort -u || true)"
log "archive expects pg_trgm in: ${TRGM_SCHEMAS:-no schema (no trigram indexes)}"

log "preparing the scratch database (drop empty public, create extensions schema)"
psql -tAX -d "$SCRATCH_URL" -c "DROP SCHEMA IF EXISTS public CASCADE;" >/dev/null \
  || fail "could not drop the empty public schema on the scratch database"
psql -tAX -d "$SCRATCH_URL" -c "CREATE SCHEMA IF NOT EXISTS extensions;" >/dev/null \
  || fail "could not create the extensions schema on the scratch database"
for ext in pg_trgm pgcrypto "uuid-ossp"; do
  [ "$ext" = "pg_trgm" ] && grep -qx public <<<"$TRGM_SCHEMAS" && continue
  psql -tAX -d "$SCRATCH_URL" -c "CREATE EXTENSION IF NOT EXISTS \"$ext\" WITH SCHEMA extensions;" >/dev/null 2>&1 \
    || log "  note: $ext unavailable on this target (only pg_trgm is load-bearing)"
done

log "restoring"
# --exit-on-error: a restore that reports success while having skipped statements
# is exactly the false green this whole exercise exists to eliminate.
restore_section() {
  pg_restore --no-owner --no-privileges --exit-on-error --section="$1" -d "$SCRATCH_URL" "$PLAIN" 2>"$WORK/err" \
    || fail "pg_restore ($1) failed: $(head -c 1500 "$WORK/err")"
}
restore_section pre-data
if grep -qx public <<<"$TRGM_SCHEMAS"; then
  psql -tAX -d "$SCRATCH_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;" >/dev/null \
    || fail "the archive's indexes need pg_trgm in public, and it could not be created"
fi
restore_section data
restore_section post-data
log "restore completed with no errors"

# ─────────────────────────────────────────────────────────────────────────────
# Check what came back.
TABLES="$(psql -tAX -d "$SCRATCH_URL" -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")"
log "restored schema: $TABLES tables"
[ "$TABLES" -gt 0 ] || fail "the restored database has no tables"

for t in users events attendance certificates hours_ledger; do
  # Here-string for the reason recorded in bin/backup-postgres.sh: a pipeline
  # into `grep -q` can take SIGPIPE on the writer, and `pipefail` then reports a
  # successful match as a failure.
  grep -q "^$t$" <<<"$(psql -tAX -d "$SCRATCH_URL" -c "SELECT to_regclass('public.$t');")" \
    || fail "restored database is missing table '$t'"
done
log "verified: every table the platform cannot be reconstructed without is present"

read -r R_USERS R_HOURS R_CERTS R_LEDGER R_MIGRATION <<EOF
$(psql -tAX -F' ' -d "$SCRATCH_URL" -c "
  SELECT (SELECT COUNT(*) FROM users),
         (SELECT COALESCE(ROUND(SUM(hours_awarded)::numeric,2),0) FROM attendance WHERE present = 1),
         (SELECT COUNT(*) FROM certificates),
         (SELECT COUNT(*) FROM hours_ledger),
         (SELECT COALESCE(MAX(version), 0) FROM schema_migrations);")
EOF
log "restored: users=$R_USERS credited_hours=$R_HOURS certificates=$R_CERTS ledger=$R_LEDGER migration=$R_MIGRATION"

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
  # The schema version: a restored database one migration behind the manifest is
  # a different database, however well its counts line up. Older manifests do
  # not record it, and are not failed for that.
  M_MIGRATION="$(m migration_version)"
  if [ -n "$M_MIGRATION" ]; then
    [ "$R_MIGRATION" = "$M_MIGRATION" ] || MISMATCH="$MISMATCH migration_version($M_MIGRATION->$R_MIGRATION)"
  fi

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
log "  migration: $R_MIGRATION"
log "  drilled:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# A machine-readable record for bin/restore-drill-postgres.sh and the Owner
# Center. Counts and names only — nothing that identifies a person.
if [ -n "${WEV_RESTORE_RESULT:-}" ]; then
  cat > "$WEV_RESTORE_RESULT" <<JSON
{
  "archive": "$(basename "$ARCHIVE")",
  "sha256_verified": $([ -n "$M_SHA" ] && echo true || echo false),
  "manifest_compared": $([ -f "$MANIFEST" ] && echo true || echo false),
  "tables": $TABLES,
  "foreign_keys": $FKS,
  "indexes": $IDX,
  "migration_version": ${R_MIGRATION:-0},
  "users": $R_USERS,
  "certificates": $R_CERTS,
  "hours_ledger": $R_LEDGER,
  "restore_seconds": $(( $(date +%s) - STARTED ))
}
JSON
fi
