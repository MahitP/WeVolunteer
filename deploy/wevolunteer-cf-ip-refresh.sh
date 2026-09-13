#!/usr/bin/env bash
#
# WeVolunteer — refresh the Cloudflare origin allowlist on ports 443.
#
# WHY THIS EXISTS
#
# The host firewall only lets Cloudflare's published ranges reach nginx on 443,
# so the origin cannot be hit directly. Cloudflare adds ranges from time to
# time. A range we do not know about is silently DROPped, which surfaces to
# visitors as an intermittent Cloudflare 522 — a timeout that looks like origin
# trouble and sends you debugging the application. This job keeps the allowlist
# current so that never happens.
#
# WHAT IT WILL NOT DO
#
#   * It never flushes the firewall. The only chains it touches are its own
#     (CF-HTTPS / CF-HTTPS6) plus the single INPUT rule that jumps to them.
#     SSH, loopback, ESTABLISHED/RELATED, ICMP, port 80, Oracle's
#     InstanceServices chain and every unrelated rule are untouched by
#     construction — nothing here addresses them.
#   * It never removes the working rules until the replacement has been built
#     AND proven to carry live traffic. The old chain stays resident until the
#     health check passes; rollback is a single jump swap back onto it, not a
#     restore.
#   * It changes nothing at all if Cloudflare's endpoint is unreachable or
#     returns something that fails validation. A stale-but-working allowlist
#     beats a broken one.
#
# Exit non-zero on any failure so `systemctl --failed` shows it. A job that
# quietly exits 0 for six months while the allowlist rots is the failure mode
# this is meant to prevent.

set -euo pipefail

V4_URL="https://www.cloudflare.com/ips-v4"
V6_URL="https://www.cloudflare.com/ips-v6"
HEALTH_URL="${WEV_HEALTH_URL:-https://app.wevolunteers.org/health}"

CHAIN4="CF-HTTPS";  NEW4="CF-HTTPS-new"
CHAIN6="CF-HTTPS6"; NEW6="CF-HTTPS6-new"

BACKUP_DIR="/root/fw-backup"
KEEP_BACKUPS=10
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log()  { printf '%s  %s\n' "$(date -Is)" "$*"; }
fail() { printf '%s  ERROR: %s\n' "$(date -Is)" "$*" >&2; exit 1; }

# ── 1. Fetch ────────────────────────────────────────────────────────────────
# Retries absorb a transient blip. Persistent failure changes nothing.
fetch() {
  local url=$1 out=$2 n
  for n in 1 2 3; do
    if curl -fsS --tlsv1.2 --proto '=https' --max-time 20 "$url" -o "$out"; then
      return 0
    fi
    log "  fetch attempt $n/3 failed for $url"
    [ "$n" -lt 3 ] && sleep 10
  done
  return 1
}

log "fetching Cloudflare ranges"
fetch "$V4_URL" "$WORK/v4.raw" || fail "could not fetch $V4_URL — firewall left unchanged"
fetch "$V6_URL" "$WORK/v6.raw" || fail "could not fetch $V6_URL — firewall left unchanged"

# ── 2. Validate ─────────────────────────────────────────────────────────────
# Every entry must be a well-formed network of the right family, the set must
# be a plausible size, and no entry may be broad enough to be meaningless as an
# allowlist. A truncated or hijacked response fails here, before the firewall
# is touched.
validate() {
  local raw=$1 fam=$2 min=$3 minpfx=$4 out=$5
  python3 - "$raw" "$fam" "$min" "$minpfx" "$out" <<'PY'
import ipaddress, sys
raw, fam, minimum, minpfx, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
nets = []
for lineno, line in enumerate(open(raw), 1):
    s = line.strip()
    if not s:
        continue
    try:
        n = ipaddress.ip_network(s, strict=True)
    except ValueError as e:
        sys.exit(f"line {lineno}: {s!r} is not a valid CIDR ({e})")
    if n.version != fam:
        sys.exit(f"line {lineno}: {s} is not IPv{fam}")
    if n.prefixlen < minpfx:
        sys.exit(f"line {lineno}: {s} is broader than /{minpfx} — refusing")
    nets.append(n)
if len(nets) < minimum:
    sys.exit(f"only {len(nets)} IPv{fam} ranges (expected at least {minimum}) — refusing")
if len(nets) > 500:
    sys.exit(f"{len(nets)} IPv{fam} ranges is implausible — refusing")
seen, uniq = set(), []
for n in nets:
    if str(n) not in seen:
        seen.add(str(n)); uniq.append(str(n))
open(out, "w").write("\n".join(uniq) + "\n")
print(len(uniq))
PY
}

V4_COUNT=$(validate "$WORK/v4.raw" 4 8 8  "$WORK/v4.txt") || fail "IPv4 validation failed — firewall left unchanged"
V6_COUNT=$(validate "$WORK/v6.raw" 6 3 19 "$WORK/v6.txt") || fail "IPv6 validation failed — firewall left unchanged"
log "validated: $V4_COUNT IPv4 ranges, $V6_COUNT IPv6 ranges"

# ── 3. Diff against what is live ────────────────────────────────────────────
current_of() { iptables_cmd=$1 chain=$2; $iptables_cmd -S "$chain" 2>/dev/null | awk '/ -s /{for(i=1;i<=NF;i++) if($i=="-s") print $(i+1)}'; }

current_of iptables  "$CHAIN4" | sort -u > "$WORK/cur4.txt" || true
current_of ip6tables "$CHAIN6" | sort -u > "$WORK/cur6.txt" || true
sort -u "$WORK/v4.txt" > "$WORK/new4.sorted"
sort -u "$WORK/v6.txt" > "$WORK/new6.sorted"

CUR4=$(wc -l < "$WORK/cur4.txt" | tr -d ' ')
CUR6=$(wc -l < "$WORK/cur6.txt" | tr -d ' ')
log "IPv4: $CUR4 live -> $V4_COUNT fetched"
log "IPv6: $CUR6 live -> $V6_COUNT fetched"

ADDED4=$(comm -13 "$WORK/cur4.txt" "$WORK/new4.sorted" | tr '\n' ' ')
GONE4=$( comm -23 "$WORK/cur4.txt" "$WORK/new4.sorted" | tr '\n' ' ')
ADDED6=$(comm -13 "$WORK/cur6.txt" "$WORK/new6.sorted" | tr '\n' ' ')
GONE6=$( comm -23 "$WORK/cur6.txt" "$WORK/new6.sorted" | tr '\n' ' ')
[ -n "${ADDED4// }" ] && log "  IPv4 added:   $ADDED4" || true
[ -n "${GONE4// }"  ] && log "  IPv4 removed: $GONE4"  || true
[ -n "${ADDED6// }" ] && log "  IPv6 added:   $ADDED6" || true
[ -n "${GONE6// }"  ] && log "  IPv6 removed: $GONE6"  || true

if [ -z "${ADDED4// }${GONE4// }${ADDED6// }${GONE6// }" ]; then
  log "no change — firewall already current, nothing to do"
  exit 0
fi

# ── 4. Snapshot ─────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
iptables-save  > "$BACKUP_DIR/rules.v4.$STAMP"
ip6tables-save > "$BACKUP_DIR/rules.v6.$STAMP"
log "rollback snapshot: $BACKUP_DIR/rules.v{4,6}.$STAMP"
ls -1t "$BACKUP_DIR"/rules.v4.* 2>/dev/null | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/rules.v6.* 2>/dev/null | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -f

# ── 5. Build the replacement chains, complete, before anything is switched ──
# A half-built chain is never reachable: the jump still points at the old one.
build() {
  local cmd=$1 chain=$2 list=$3
  $cmd -F "$chain" 2>/dev/null || $cmd -N "$chain"
  while IFS= read -r cidr || [ -n "$cidr" ]; do
    [ -n "$cidr" ] || continue
    $cmd -A "$chain" -s "$cidr" -j ACCEPT
  done < "$list"
  $cmd -A "$chain" -j DROP
}
build iptables  "$NEW4" "$WORK/v4.txt"
build ip6tables "$NEW6" "$WORK/v6.txt"
log "built $NEW4 ($V4_COUNT allows + DROP) and $NEW6 ($V6_COUNT allows + DROP)"

# Structural check before the swap.
[ "$(iptables  -S "$NEW4" | grep -c ' -s ')" -eq "$V4_COUNT" ] || fail "$NEW4 rule count mismatch — not switching"
[ "$(ip6tables -S "$NEW6" | grep -c ' -s ')" -eq "$V6_COUNT" ] || fail "$NEW6 rule count mismatch — not switching"
iptables  -S "$NEW4" | tail -1 | grep -q -- '-j DROP' || fail "$NEW4 has no terminal DROP — not switching"
ip6tables -S "$NEW6" | tail -1 | grep -q -- '-j DROP' || fail "$NEW6 has no terminal DROP — not switching"

# ── 6. Atomic switch ────────────────────────────────────────────────────────
# `iptables -R` replaces one rule in place: there is no instant where 443 has
# no rule at all. The OLD chain is deliberately left resident so rollback is a
# second -R back onto it, with no restore and no flush.
jump_pos() { iptables -L INPUT -n --line-numbers | awk -v c="$1" '$2==c {print $1; exit}'; }
POS4=$(jump_pos "$CHAIN4"); [ -n "$POS4" ] || fail "no INPUT jump to $CHAIN4 found — not switching"
POS6=$(ip6tables -L INPUT -n --line-numbers | awk -v c="$CHAIN6" '$2==c {print $1; exit}')

iptables -R INPUT "$POS4" -p tcp -m state --state NEW --dport 443 -j "$NEW4"
log "IPv4 jump (INPUT $POS4) now targets $NEW4"
if [ -n "$POS6" ]; then
  ip6tables -R INPUT "$POS6" -p tcp -m state --state NEW --dport 443 -j "$NEW6"
  log "IPv6 jump (INPUT $POS6) now targets $NEW6"
fi

# ── 7. Prove it carries real traffic before committing ──────────────────────
rollback() {
  log "ROLLING BACK to $CHAIN4 (old chain never deleted)"
  iptables -R INPUT "$POS4" -p tcp -m state --state NEW --dport 443 -j "$CHAIN4" || true
  [ -n "$POS6" ] && { ip6tables -R INPUT "$POS6" -p tcp -m state --state NEW --dport 443 -j "$CHAIN6" || true; }
  iptables  -F "$NEW4" 2>/dev/null || true; iptables  -X "$NEW4" 2>/dev/null || true
  ip6tables -F "$NEW6" 2>/dev/null || true; ip6tables -X "$NEW6" 2>/dev/null || true
  log "rolled back; a full snapshot also remains at $BACKUP_DIR/rules.v4.$STAMP"
}

CODE=000
for n in 1 2 3; do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$HEALTH_URL" || echo 000)
  [ "$CODE" = "200" ] && break
  log "  health check attempt $n/3 returned $CODE"
  [ "$n" -lt 3 ] && sleep 5
done
if [ "$CODE" != "200" ]; then
  rollback
  fail "$HEALTH_URL returned $CODE through Cloudflare after the swap — rolled back, firewall unchanged"
fi
log "verified: $HEALTH_URL -> 200 through Cloudflare on the new ranges"

# ── 8. Commit: retire the old chains, adopt the canonical names ─────────────
# Renaming a referenced chain updates the jump automatically (verified on
# iptables-nft 1.8.11), so INPUT ends up pointing at CF-HTTPS again.
iptables -F "$CHAIN4"; iptables -X "$CHAIN4"; iptables -E "$NEW4" "$CHAIN4"
if [ -n "$POS6" ]; then
  ip6tables -F "$CHAIN6"; ip6tables -X "$CHAIN6"; ip6tables -E "$NEW6" "$CHAIN6"
fi
log "old chains retired; $CHAIN4/$CHAIN6 now hold the refreshed ranges"

# ── 9. Persist ──────────────────────────────────────────────────────────────
if ! netfilter-persistent save; then
  rollback
  fail "netfilter-persistent save failed — rolled back rather than leave boot config inconsistent"
fi
grep -q "^-A $CHAIN4 " /etc/iptables/rules.v4 || fail "persisted file lacks $CHAIN4 — investigate"
grep -q -- "--dport 22 -j ACCEPT" /etc/iptables/rules.v4 || fail "persisted file lost the SSH rule — investigate immediately"
log "persisted to /etc/iptables/rules.v{4,6}"

# Re-check after persistence: a save must not have disturbed the live path.
FINAL=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$HEALTH_URL" || echo 000)
[ "$FINAL" = "200" ] || fail "post-persist health check returned $FINAL — rules saved but verify manually"
log "SUCCESS: IPv4 $CUR4 -> $V4_COUNT, IPv6 $CUR6 -> $V6_COUNT, health 200"
