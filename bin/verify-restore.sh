#!/usr/bin/env bash
#
# WeVolunteer — restore rehearsal.
#
# Restores the newest backup archive into a THROWAWAY database, verifies it, and
# boots the application against it. Read-only with respect to everything that
# matters: it never touches the live database, the live export directory, or the
# backup archives themselves.
#
# ── Why this exists ──
#
# `bin/backup.sh` integrity-checks each archive before keeping it, which proves the
# file is structurally valid SQLite. It does not prove the thing you actually need
# on the worst day: that this archive can be turned back into a running WeVolunteer
# with the students' hours in it. The runbook says "rehearse a restore before real
# users exist" and then leaves the operator to improvise the procedure by hand,
# under exactly the conditions where improvising goes badly.
#
# A backup nobody has restored is a hypothesis.
#
# Usage:
#   bin/verify-restore.sh                      # newest archive in WEV_BACKUP_DIR
#   bin/verify-restore.sh path/to/backup.db.gz # a specific archive
#
# Exit codes:
#   0  the archive restored, verified, and the app booted against it
#   1  something failed — the message says which stage
#
set -euo pipefail

BACKUP_DIR="${WEV_BACKUP_DIR:-/var/backups/wevolunteer}"
ARCHIVE="${1:-}"

# Resolve the repository root from this script's own location, so the rehearsal
# works from any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

# A scratch directory that is always cleaned up, including on failure — a rehearsal
# that leaves a copy of every student's record lying in /tmp is its own incident.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wev-restore-rehearsal-XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is not installed"
command -v gunzip  >/dev/null 2>&1 || fail "gunzip is not installed"

# ── 1. Choose the archive ────────────────────────────────────────────────────
if [ -z "$ARCHIVE" ]; then
  [ -d "$BACKUP_DIR" ] || fail "backup directory not found: $BACKUP_DIR"
  # Newest by modification time. `ls -t` is avoided so filenames with spaces or
  # newlines cannot break the selection.
  ARCHIVE="$(find "$BACKUP_DIR" -name 'wevolunteer-*.db.gz' -type f -print0 \
    | xargs -0 stat -f '%m %N' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)"
  # GNU stat uses a different format string; fall back for Linux hosts.
  if [ -z "$ARCHIVE" ]; then
    ARCHIVE="$(find "$BACKUP_DIR" -name 'wevolunteer-*.db.gz' -type f -printf '%T@ %p\n' 2>/dev/null \
      | sort -rn | head -1 | cut -d' ' -f2-)"
  fi
  [ -n "$ARCHIVE" ] || fail "no wevolunteer-*.db.gz archives in $BACKUP_DIR"
fi

[ -f "$ARCHIVE" ] || fail "archive not found: $ARCHIVE"

log "rehearsing restore of: $ARCHIVE"
log "  archive age: $(( ( $(date +%s) - $(stat -f %m "$ARCHIVE" 2>/dev/null || stat -c %Y "$ARCHIVE") ) / 3600 )) hours"

# ── 2. Decompress into the scratch directory ─────────────────────────────────
RESTORED="$WORK/restored.db"
gunzip -c "$ARCHIVE" > "$RESTORED" || fail "gunzip failed — the archive is corrupt"
[ -s "$RESTORED" ] || fail "restored file is empty"
log "decompressed to a throwaway copy ($(du -h "$RESTORED" | cut -f1))"

# ── 3. Structural integrity ──────────────────────────────────────────────────
INTEGRITY="$(sqlite3 "$RESTORED" 'PRAGMA integrity_check;' 2>&1 || true)"
[ "$INTEGRITY" = "ok" ] || fail "integrity_check returned: $INTEGRITY"
log "integrity_check: ok"

FK="$(sqlite3 "$RESTORED" 'PRAGMA foreign_key_check;' 2>&1 || true)"
[ -z "$FK" ] || fail "foreign_key_check reported violations: $FK"
log "foreign_key_check: no violations"

# ── 4. The data the whole system exists to protect ───────────────────────────
USERS="$(sqlite3 "$RESTORED" 'SELECT COUNT(*) FROM users;')"
HOURS="$(sqlite3 "$RESTORED" 'SELECT COALESCE(ROUND(SUM(hours_awarded),2),0) FROM attendance WHERE present = 1;')"
CERTS="$(sqlite3 "$RESTORED" 'SELECT COUNT(*) FROM certificates;')"
LEDGER="$(sqlite3 "$RESTORED" 'SELECT COUNT(*) FROM hours_ledger;')"
log "contents: users=$USERS credited_hours=$HOURS certificates=$CERTS ledger_rows=$LEDGER"

# An archive that restores cleanly but holds no accounts is a failed backup, not a
# successful restore. Structural validity is not the same as usefulness.
[ "$USERS" -gt 0 ] || fail "restored database contains no users — this archive is not usable"

# ── 5. Ledger parity, in the restored copy ───────────────────────────────────
# The application-level invariant: attendance and the append-only ledger must agree
# about every student's credited hours. verifyHours.js takes an explicit path, which
# is exactly what a rehearsal needs.
if [ -f "$REPO_ROOT/server/verifyHours.js" ]; then
  if node "$REPO_ROOT/server/verifyHours.js" "$RESTORED" >"$WORK/parity.log" 2>&1; then
    log "hours ledger parity: PASS"
  else
    sed 's/^/    /' "$WORK/parity.log" || true
    fail "hours ledger parity FAILED in the restored copy"
  fi
else
  log "hours ledger parity: SKIPPED (server/verifyHours.js not found)"
fi

# ── 6. Boot the application against the restored copy ────────────────────────
# The stage that distinguishes "valid SQLite" from "a working WeVolunteer". Runs on
# a high port against the throwaway database, with a throwaway export directory so
# nothing lands beside the real one.
PORT="${REHEARSAL_PORT:-5399}"
log "booting the application against the restored copy on port $PORT"

(
  cd "$REPO_ROOT/server"
  # NODE_ENV is left unset: this is a rehearsal, not a production boot, and the
  # production guards would demand real SMTP credentials to start.
  WEV_DB_PATH="$RESTORED" \
  WEV_EXPORT_DIR="$WORK/exports" \
  API_PORT="$PORT" \
  BIND_ADDRESS=127.0.0.1 \
  JWT_SECRET="rehearsal-only-$(head -c 24 /dev/urandom | base64 | tr -d '=/+')" \
  APP_URL="http://127.0.0.1:$PORT" \
  node server.js >"$WORK/boot.log" 2>&1 &
  echo $! > "$WORK/pid"
) || fail "could not start the application"

APP_PID="$(cat "$WORK/pid")"
# Make sure the child dies even if a later stage fails.
cleanup() { kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# Poll rather than sleeping a fixed interval, so a fast host is not penalised and a
# slow one is not failed prematurely.
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 0.5
done

if [ -z "$HEALTH" ]; then
  log "boot log:"
  sed 's/^/    /' "$WORK/boot.log" || true
  fail "the application did not become healthy against the restored database"
fi

log "health: $HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' || fail "/health did not report ok: $HEALTH"
# The write probe is what proves the restored file is usable, not merely readable.
echo "$HEALTH" | grep -q '"writable":true' || fail "restored database is not writable: $HEALTH"

log "shutting the rehearsal instance down"
kill -TERM "$APP_PID" 2>/dev/null || true
# Graceful shutdown should exit on its own; give it a moment before the trap forces it.
for _ in $(seq 1 20); do
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.5
done

log ""
log "RESTORE REHEARSAL PASSED"
log "  archive:        $ARCHIVE"
log "  users:          $USERS"
log "  credited hours: $HOURS"
log "  certificates:   $CERTS"
log ""
log "The live database was never touched. The restored copy has been deleted."
