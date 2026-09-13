#!/usr/bin/env bash
# WeVolunteer — report a scheduled job's outcome to a Better Stack heartbeat.
#
# ── Why this exists ──
#
# Every scheduled job on this host could fail, or simply stop being scheduled,
# without anybody finding out. systemd marks a unit failed and tells no one;
# the application's backup check reads a directory and cannot tell "the timer is
# disabled" from "it ran and failed"; and deploy/README.md said, correctly, that
# nothing alerted.
#
# A heartbeat is a dead man's switch, which is the only shape of check that
# catches the job that never runs: Better Stack raises an incident when the
# expected ping does not arrive within the period plus grace, and immediately
# when a job reports `fail`. Better Stack's free plan includes ten.
#
# ── Usage ──
#
#   wevolunteer-heartbeat.sh <NAME> ok
#   wevolunteer-heartbeat.sh <NAME> fail [message]
#   wevolunteer-heartbeat.sh --unit <systemd-unit-name> fail
#
# NAME selects HEARTBEAT_URL_<NAME> from the environment (the service's
# EnvironmentFile), e.g. HEARTBEAT_URL_BACKUP. `--unit` maps a unit name to its
# heartbeat, for the OnFailure= template, which only knows the unit.
#
# ── Rules ──
#
#   - Unset URL: says so and exits 0. An unmonitored job must still run.
#   - The URL carries the heartbeat's token. It is never printed.
#   - Only https://uptime.betterstack.com/api/v1/heartbeat/ is accepted, so a
#     typo or a pasted wrong value cannot send job output somewhere else.
#   - This script ALWAYS exits 0. It runs as ExecStartPost= and from OnFailure=;
#     a heartbeat that could fail its parent would turn a monitoring outage into
#     a failed backup, and a failed backup into a loop of failure reports.
set -uo pipefail

log() { printf 'heartbeat: %s\n' "$*"; }

name=""
if [ "${1:-}" = "--unit" ]; then
  case "${2:-}" in
    wevolunteer-backup.service)         name="BACKUP" ;;
    wevolunteer-cf-ip-refresh.service)  name="CF_REFRESH" ;;
    wevolunteer-host-check.service)     name="HOST" ;;
    *) log "no heartbeat is mapped to unit '${2:-}'"; exit 0 ;;
  esac
  shift 2
else
  name="${1:-}"
  shift || true
fi

outcome="${1:-}"
message="${2:-}"

case "$name" in
  ''|*[!A-Z0-9_]*) log "invalid heartbeat name '$name'"; exit 0 ;;
esac
case "$outcome" in
  ok|fail) ;;
  *) log "outcome must be ok or fail, not '$outcome'"; exit 0 ;;
esac

var="HEARTBEAT_URL_${name}"
url="${!var:-}"

if [ -z "$url" ]; then
  log "$var is not set — ${name} is not monitored"
  exit 0
fi

case "$url" in
  https://uptime.betterstack.com/api/v1/heartbeat/?*) ;;
  *) log "$var is not a Better Stack heartbeat URL — refusing to send to it"; exit 0 ;;
esac
case "$url" in
  */fail|*/) log "$var must be the heartbeat's base URL, without /fail or a trailing slash"; exit 0 ;;
esac

target="$url"
[ "$outcome" = "fail" ] && target="$url/fail"

args=(-fsS -o /dev/null -m 10 --retry 2 --retry-delay 5 --proto '=https' --tlsv1.2)
if [ -n "$message" ]; then
  # Bounded, and sent as the body rather than the URL, where it would be logged.
  args+=(--data-binary "${message:0:4000}")
fi

if curl "${args[@]}" "$target" 2>/dev/null; then
  log "${name}: reported $outcome"
else
  log "${name}: could not reach Better Stack to report $outcome (the job's own result is unaffected)"
fi
exit 0
