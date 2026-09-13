#!/usr/bin/env bash
# WeVolunteer — is this host quietly breaking? Reported to a heartbeat.
#
# ── Why this exists ──
#
# The external uptime monitors answer "does the site respond". They cannot see
# the slow failures that end with it not responding: a disk filling with logs
# and archives, memory pressure on a 6 GB box, a service restarting every few
# seconds that happens to be up when the probe arrives, an origin certificate
# nobody renewed, or a nightly backup that stopped. Each is visible on the host
# long before it is visible from outside.
#
# Every fifteen minutes (wevolunteer-host-check.timer) this checks each one and
# reports a single result to the HOST heartbeat: `ok`, or `fail` with the list of
# what is wrong. Better Stack alerts on a `fail` and on silence, so a disabled
# timer or a dead host is caught too.
#
# ── Deliberately quiet ──
#
# Thresholds are set where a human should act, not where a graph wiggles:
# 90% disk, 5% memory available, three restarts inside one check interval, a
# certificate inside 21 days, a backup older than 26 hours. An alert that fires
# for weather is an alert that gets muted.
#
# ── Testability ──
#
# Every system dependency is a variable with the production value as default,
# so the tests drive the real script with fake `systemctl`, `df`, `curl` and
# `openssl` on PATH. Nothing here is piped: a pipeline under pipefail whose
# reader exits early is how two previous scripts on this host failed silently.
set -uo pipefail

HEARTBEAT="${WEV_HC_HEARTBEAT:-/usr/local/sbin/wevolunteer-heartbeat.sh}"
DISK_PATHS="${WEV_HC_DISK_PATHS:-/ /var/backups/wevolunteer /var/lib/wevolunteer}"
DISK_MAX_PERCENT="${WEV_HC_DISK_MAX_PERCENT:-90}"
MEMINFO="${WEV_HC_MEMINFO:-/proc/meminfo}"
MEM_MIN_PERCENT="${WEV_HC_MEM_MIN_PERCENT:-5}"
STATE_DIR="${WEV_HC_STATE_DIR:-/var/lib/wevolunteer-host-check}"
READY_URL="${WEV_HC_READY_URL:-http://127.0.0.1:5050/ready}"
CERT="${WEV_HC_CERT:-/etc/ssl/cloudflare/origin.pem}"
CERT_MIN_DAYS="${WEV_HC_CERT_MIN_DAYS:-21}"
BACKUP_DIR="${WEV_HC_BACKUP_DIR:-/var/backups/wevolunteer}"
BACKUP_MAX_HOURS="${WEV_HC_BACKUP_MAX_HOURS:-26}"
RESTART_LIMIT="${WEV_HC_RESTART_LIMIT:-3}"

problems=()
note() { problems+=("$1"); }

# ── Disk ─────────────────────────────────────────────────────────────────────
for p in $DISK_PATHS; do
  [ -e "$p" ] || continue
  out="$(df -P "$p" 2>/dev/null)" || { note "disk: could not read usage of $p"; continue; }
  used=""
  line_no=0
  while read -r _fs _blocks _used _avail capacity _mount; do
    line_no=$((line_no + 1))
    [ "$line_no" -eq 2 ] && used="${capacity%\%}"
  done <<<"$out"
  case "$used" in
    ''|*[!0-9]*) note "disk: unreadable usage for $p" ;;
    *) [ "$used" -ge "$DISK_MAX_PERCENT" ] && note "disk: $p is ${used}% full" ;;
  esac
done

# ── Memory ───────────────────────────────────────────────────────────────────
if [ -r "$MEMINFO" ]; then
  total=""; avail=""
  while read -r key value _unit; do
    case "$key" in
      MemTotal:) total="$value" ;;
      MemAvailable:) avail="$value" ;;
    esac
  done <"$MEMINFO"
  if [ -n "$total" ] && [ -n "$avail" ] && [ "$total" -gt 0 ]; then
    pct=$(( avail * 100 / total ))
    [ "$pct" -lt "$MEM_MIN_PERCENT" ] && note "memory: only ${pct}% available"
  fi
fi

# ── The application, and nginx ──────────────────────────────────────────────
for unit in wevolunteer.service nginx.service; do
  state="$(systemctl is-active "$unit" 2>/dev/null)"
  [ "$state" = "active" ] || note "service: $unit is ${state:-unknown}"
done

# A restart loop can be "active" at every probe. Count restarts between checks.
restarts="$(systemctl show -p NRestarts --value wevolunteer.service 2>/dev/null)"
case "$restarts" in
  ''|*[!0-9]*) ;;
  *)
    if mkdir -p "$STATE_DIR" 2>/dev/null; then
      previous="$(cat "$STATE_DIR/nrestarts" 2>/dev/null)"
      printf '%s\n' "$restarts" >"$STATE_DIR/nrestarts" 2>/dev/null
      case "$previous" in
        ''|*[!0-9]*) ;;
        *)
          delta=$(( restarts - previous ))
          [ "$delta" -ge "$RESTART_LIMIT" ] && note "service: wevolunteer.service restarted $delta times since the last check"
          ;;
      esac
    fi
    ;;
esac

ready_code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$READY_URL" 2>/dev/null)"
[ "$ready_code" = "200" ] || note "application: $READY_URL answered ${ready_code:-nothing}"

# ── Origin certificate ───────────────────────────────────────────────────────
if [ -r "$CERT" ]; then
  if ! openssl x509 -checkend $(( CERT_MIN_DAYS * 86400 )) -noout -in "$CERT" >/dev/null 2>&1; then
    note "certificate: $CERT expires within $CERT_MIN_DAYS days (or cannot be parsed)"
  fi
else
  note "certificate: $CERT is missing or unreadable"
fi

# ── Backups ──────────────────────────────────────────────────────────────────
if [ -d "$BACKUP_DIR" ]; then
  fresh="$(find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'wevolunteer-*.dump.enc' -o -name 'wevolunteer-*.dump' -o -name 'wevolunteer-*.db.gz.enc' -o -name 'wevolunteer-*.db.gz' \) \
    -mmin "-$(( BACKUP_MAX_HOURS * 60 ))" 2>/dev/null)"
  [ -n "$fresh" ] || note "backup: no archive in $BACKUP_DIR newer than $BACKUP_MAX_HOURS hours"
else
  note "backup: $BACKUP_DIR does not exist"
fi

# ── Report ───────────────────────────────────────────────────────────────────
if [ "${#problems[@]}" -eq 0 ]; then
  echo "host-check: healthy"
  "$HEARTBEAT" HOST ok
else
  summary="$(printf '%s\n' "${problems[@]}")"
  printf 'host-check: %s\n' "${problems[@]}"
  "$HEARTBEAT" HOST fail "$(hostname 2>/dev/null): ${#problems[@]} problem(s)
$summary"
fi
exit 0
