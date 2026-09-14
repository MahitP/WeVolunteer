#!/usr/bin/env bash
#
# WeVolunteer — the weekly restore drill: fetch, decrypt, restore, compare.
#
# ── What this proves that the nightly backup cannot ──
#
# The nightly job proves the archive parses before encryption and that B2 holds
# the same bytes. It never decrypts and never restores, because the host that
# takes backups should not need the decryption key to do so. This drill is the
# other half, run on a schedule so that "the backups restore" is a fact from
# this week rather than a memory from the day the system was built:
#
#   4. decrypted     the archive B2 holds decrypts with the recovery key (and,
#                    being AES-256-GCM, authenticates: a damaged byte fails)
#   5. restored      pg_restore --exit-on-error into an empty PostgreSQL 17
#   6. compared      tables, foreign keys, the four invariant counts and the
#                    schema migration version match what the live database held
#
# It restores from the OFF-SITE copy when one is configured — the copy that
# matters when this host is gone — and from the newest local archive otherwise,
# and records which one in the status file, so the Owner Center never presents
# a local drill as proof of the off-site copy.
#
# ── Safety ──
#
# The target is a throwaway PostgreSQL cluster created in a private temporary
# directory, listening on a unix socket only (no TCP port at all), and deleted
# at the end. It never reads DATABASE_URL: this script has no way to reach the
# production database, which is the strongest form of "never restore over
# production" there is. Decrypted data lives only inside that directory.
#
# ── Where this runs, and why NOT on the production host ──
#
# On the operator's own machine — the one the backup private key is already on —
# and not on the host that takes the backups. There is deliberately no systemd
# unit for it, and adding one would undo the reason the archives are encrypted at
# all.
#
# The drill has to decrypt, so it needs WEV_BACKUP_TESTKEY. The whole point of
# encrypting to a public key is that the host can encrypt and cannot decrypt: an
# attacker who reaches it reaches ciphertext. Installing the private key there to
# automate a weekly drill would hand that same attacker every archive, including
# the off-site ones, and would make the encryption decorative. The deployment gate
# recorded the same rule from the other direction — the private key is kept off
# the host, in the operator's password manager — and §4.5 of the readiness pass
# treats a copy found at /root/backup-keys/backup-key.pem as something to shred.
#
# Running it off the host is also the better drill. It fetches from B2 with
# bin/backup-fetch.mjs, so the path exercised every week is exactly the path a
# real disaster uses: a machine that is not the host, reaching the off-site copy,
# with a key from the password manager. A drill that ran on the host would prove
# the one recovery that does not need to work.
#
# ── Usage (weekly, on the operator's machine) ──
#
#   WEV_BACKUP_TESTKEY=~/keys/backup-key.pem \
#   B2_S3_ENDPOINT=... B2_BUCKET=... B2_KEY_ID=... B2_APPLICATION_KEY=... \
#   bin/restore-drill-postgres.sh
#
# It needs root only where initdb must drop privilege to WEV_DRILL_RUN_AS; on a
# personal machine it runs as the ordinary user and that step is skipped.
#
# Environment:
#   WEV_BACKUP_TESTKEY     private key that decrypts the archives (required)
#   WEV_BACKUP_DIR         local archives and status/ (default /var/backups/wevolunteer)
#   WEV_PG_BIN             directory with initdb, pg_ctl, pg_restore, psql of the
#                          server's major version (default: PATH)
#   WEV_OPENSSL            an OpenSSL 3 binary (default: openssl)
#   WEV_DRILL_SOURCE       auto (default) | offsite | local
#   WEV_DRILL_RUN_AS       unprivileged user to run the scratch PostgreSQL as when
#                          invoked as root (default wev) — initdb refuses root
#   WEV_DRILL_MAX_AGE_HOURS  fail if the newest archive is older (default 36)
#   B2_*                   as for bin/backup-fetch.mjs
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${WEV_BACKUP_DIR:-/var/backups/wevolunteer}"
STATUS_DIR="${WEV_BACKUP_STATUS_DIR:-$DEST/status}"
SOURCE_MODE="${WEV_DRILL_SOURCE:-auto}"
RUN_AS="${WEV_DRILL_RUN_AS:-wev}"
MAX_AGE_HOURS="${WEV_DRILL_MAX_AGE_HOURS:-36}"
STARTED="$(date +%s)"
STAGE="setup"
SOURCE="none"
ARCHIVE=""
FETCH_SECONDS=0
WORK=""

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# JSON string escaping for the few free-text fields (an error message, a file name).
json_str() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/ }"; printf '"%s"' "${s:0:400}"; }

write_status() {  # <state> <error-or-empty> [result-json-file]
  mkdir -p "$STATUS_DIR" 2>/dev/null || true
  local tmp="$STATUS_DIR/.restore-drill.json.$$"
  local result="null"
  [ -n "${3:-}" ] && [ -s "$3" ] && result="$(cat "$3")"
  local age="null"
  [ -n "${ARCHIVE_AGE_HOURS:-}" ] && age="$ARCHIVE_AGE_HOURS"
  {
    printf '{\n  "state": "%s",\n  "at": "%s",\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "source": "%s",\n  "archive": %s,\n  "archiveAgeHours": %s,\n' "$SOURCE" "$(json_str "$(basename "${ARCHIVE:-none}")")" "$age"
    printf '  "stage": "%s",\n  "error": %s,\n' "$STAGE" "$( [ -n "$2" ] && json_str "$2" || echo null )"
    printf '  "fetchSeconds": %s,\n  "elapsedSeconds": %s,\n  "result": %s\n}\n' "$FETCH_SECONDS" "$(( $(date +%s) - STARTED ))" "$result"
  } > "$tmp" 2>/dev/null || { log "WARNING: could not write the drill status file"; return 0; }
  chmod 0640 "$tmp" 2>/dev/null || true
  if [ "$(id -u)" = "0" ] && id "$RUN_AS" >/dev/null 2>&1; then
    chown "$RUN_AS:$RUN_AS" "$tmp" 2>/dev/null || true
  fi
  mv -f "$tmp" "$STATUS_DIR/restore-drill.json" 2>/dev/null || log "WARNING: could not write the drill status file"
}

# A FAILED drill is the one the host most needs to hear about, so it is published
# on the same path as a pass. Guarded twice: `b2_configured` is defined further
# down and `fail` is reachable before it, and publishing must never be able to
# turn a reported failure into a silent one — hence `|| true`.
publish_drill() {
  [ "${WEV_DRILL_PUBLISH:-1}" = "1" ] || return 0
  declare -F b2_configured >/dev/null 2>&1 || return 0
  b2_configured || return 0
  [ -f "$STATUS_DIR/restore-drill.json" ] || return 0
  node "$HERE/backup-drill-publish.mjs" "$STATUS_DIR/restore-drill.json" >/dev/null 2>&1 \
    || log "WARNING: the drill result could not be published to B2"
  return 0
}

fail() { log "FAILED ($STAGE): $*"; write_status failed "$*"; publish_drill || true; exit 1; }

[ -n "${WEV_BACKUP_TESTKEY:-}" ] || fail "WEV_BACKUP_TESTKEY is not set — the drill cannot decrypt anything"
[ -r "$WEV_BACKUP_TESTKEY" ]     || fail "WEV_BACKUP_TESTKEY is not readable: $WEV_BACKUP_TESTKEY"
if [ -n "${WEV_PG_BIN:-}" ]; then
  [ -x "$WEV_PG_BIN/initdb" ] || fail "WEV_PG_BIN=$WEV_PG_BIN contains no initdb"
  PATH="$WEV_PG_BIN:$PATH"
fi
for tool in initdb pg_ctl pg_restore psql; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed (Debian/Ubuntu: apt install postgresql-17)"
done
unset DATABASE_URL   # never needed here; never reachable from here

# One drill at a time, and never beside a backup in progress on the same files.
mkdir -p "$DEST"
if command -v flock >/dev/null 2>&1; then
  exec 8>"$DEST/.restore-drill.lock"
  flock -n 8 || fail "another restore drill is already running"
fi

# ─────────────────────────────────────────────────────────────────────────────
# A private working area. Two parts with different owners:
#   private/  root-only: the fetched archive and, briefly, the decrypted dump
#   pg/       the unprivileged user's: the scratch cluster and its socket
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wev-drill-XXXXXX")"
chmod 0711 "$WORK"
mkdir -m 0700 "$WORK/private"
mkdir -m 0700 "$WORK/pg"

AS_USER=()
if [ "$(id -u)" = "0" ]; then
  id "$RUN_AS" >/dev/null 2>&1 || fail "WEV_DRILL_RUN_AS user '$RUN_AS' does not exist"
  chown "$RUN_AS:$RUN_AS" "$WORK/pg"
  # setpriv rather than su/runuser: no PAM session, which a sandboxed unit may not
  # allow, and it only ever drops privilege.
  AS_USER=(setpriv "--reuid=$RUN_AS" "--regid=$RUN_AS" --init-groups --)
fi

PGDATA_DIR="$WORK/pg/data"
SOCK="$WORK/pg/sock"
PORT=5499
cleanup() {
  if [ -f "$PGDATA_DIR/postmaster.pid" ]; then
    ${AS_USER[@]+"${AS_USER[@]}"} pg_ctl -D "$PGDATA_DIR" -m immediate stop >/dev/null 2>&1 || true
  fi
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Choose and obtain the archive.
STAGE="fetch"
b2_configured() { [ -n "${B2_S3_ENDPOINT:-}${B2_BUCKET:-}${B2_KEY_ID:-}${B2_APPLICATION_KEY:-}" ]; }
case "$SOURCE_MODE" in
  auto) if b2_configured; then SOURCE="offsite"; else SOURCE="local"; fi ;;
  offsite) b2_configured || fail "WEV_DRILL_SOURCE=offsite but B2_* is not configured"; SOURCE="offsite" ;;
  local) SOURCE="local" ;;
  *) fail "WEV_DRILL_SOURCE must be auto, offsite or local" ;;
esac

if [ "$SOURCE" = "offsite" ]; then
  log "fetching the newest archive from B2"
  T0="$(date +%s)"
  FETCH_OUT="$(node "$HERE/backup-fetch.mjs" --out "$WORK/private/fetched" --latest 2>"$WORK/private/fetch.err")" \
    || fail "could not fetch from B2: $(tail -c 400 "$WORK/private/fetch.err")"
  FETCH_SECONDS=$(( $(date +%s) - T0 ))
  ARCHIVE="$(tail -n 1 <<<"$FETCH_OUT")"
  cat "$WORK/private/fetch.err" >&2
else
  # Newest by name: the stamp is ISO-8601 basic UTC, so lexical order is time order.
  LIST="$(ls -1 "$DEST"/wevolunteer-*.dump.enc 2>/dev/null || true)"
  ARCHIVE="$(sort <<<"$LIST" | tail -n 1)"
  [ -n "$ARCHIVE" ] || fail "no encrypted archive in $DEST"
fi
[ -f "$ARCHIVE" ] || fail "archive not found after fetch: $ARCHIVE"
log "drilling $(basename "$ARCHIVE") (source: $SOURCE)"

# Freshness, from the UTC stamp in the name rather than any file time: a drill
# that keeps restoring an old archive because new ones stopped arriving would
# otherwise pass every week.
STAMP="$(basename "$ARCHIVE" | sed -n 's/^wevolunteer-\([0-9]\{8\}T[0-9]\{6\}Z\)\..*/\1/p')"
[ -n "$STAMP" ] || fail "cannot read the timestamp in $(basename "$ARCHIVE")"
ISO="${STAMP:0:4}-${STAMP:4:2}-${STAMP:6:2}T${STAMP:9:2}:${STAMP:11:2}:${STAMP:13:2}Z"
ARCHIVE_EPOCH="$(node -e 'const t=Date.parse(process.argv[1]); if(!Number.isFinite(t)) process.exit(1); console.log(Math.floor(t/1000))' "$ISO")" \
  || fail "invalid timestamp in $(basename "$ARCHIVE")"
ARCHIVE_AGE_HOURS=$(( ( $(date +%s) - ARCHIVE_EPOCH ) / 3600 ))
if [ "$ARCHIVE_AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  STAGE="freshness"
  fail "the newest $SOURCE archive is ${ARCHIVE_AGE_HOURS}h old (limit ${MAX_AGE_HOURS}h) — backups have stopped arriving"
fi

# ─────────────────────────────────────────────────────────────────────────────
# The scratch cluster: unix socket only, no durability (it is deleted in minutes).
# LC_ALL=C explicitly: a unit's environment carries no locale, and PostgreSQL
# refuses to start without a valid one ("postmaster became multithreaded during
# startup" on macOS). The C locale is also what makes the restore independent of
# whatever locale the rebuilt host happens to have.
STAGE="scratch-cluster"
log "creating a scratch PostgreSQL cluster ($(pg_ctl --version | head -n 1))"
${AS_USER[@]+"${AS_USER[@]}"} env LC_ALL=C initdb -D "$PGDATA_DIR" -U wevdrill --auth=trust --no-instructions -E UTF8 --locale=C >"$WORK/private/initdb.log" 2>&1 \
  || fail "initdb failed: $(tail -c 400 "$WORK/private/initdb.log")"
${AS_USER[@]+"${AS_USER[@]}"} mkdir -m 0755 "$SOCK"
${AS_USER[@]+"${AS_USER[@]}"} env LC_ALL=C pg_ctl -D "$PGDATA_DIR" -w -t 60 -l "$WORK/pg/server.log" \
  -o "-c listen_addresses='' -k $SOCK -p $PORT -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c shared_buffers=32MB -c max_connections=10" \
  start >/dev/null 2>&1 \
  || fail "the scratch cluster did not start: $(tail -c 400 "$WORK/pg/server.log" 2>/dev/null)"

# ─────────────────────────────────────────────────────────────────────────────
# Levels 4–6, by the same script an operator uses by hand.
STAGE="restore"
RESULT="$WORK/private/result.json"
if ! TMPDIR="$WORK/private" \
     WEV_RESTORE_URL="postgresql://wevdrill@/postgres?host=$SOCK&port=$PORT" \
     WEV_RESTORE_RESULT="$RESULT" \
     "$HERE/verify-restore-postgres.sh" "$ARCHIVE" 2>&1 | tee "$WORK/private/verify.log"; then
  fail "$(grep 'FAILED' "$WORK/private/verify.log" | tail -n 1 | sed 's/^[^ ]* FAILED: //')"
fi

STAGE="done"
write_status passed "" "$RESULT"

# ─────────────────────────────────────────────────────────────────────────────
# Tell the host. See bin/backup-drill-publish.mjs for why this has to travel
# through the bucket rather than being written where the Owner Center reads it.
#
# Never fatal: the drill either restored the database or it did not, and failing
# to announce a success must not turn it into a failure.
publish_drill

log "OK — restore drill passed from the $SOURCE copy in $(( $(date +%s) - STARTED ))s"
