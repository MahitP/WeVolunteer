#!/usr/bin/env bash
#
# Provision an Oracle Always Free Ubuntu host to serve WeVolunteer.
#
# ── What this is ──
#
# One idempotent script instead of forty copy-pasted commands. Re-running it is
# safe and is the normal way to use it: every step checks the state it wants
# before changing anything, so a partial run can simply be run again.
#
#   sudo ./deploy/provision.sh audit      # read-only. Changes nothing. Start here.
#   sudo ./deploy/provision.sh packages   # Node 24, nginx, postgresql-client-17
#   sudo ./deploy/provision.sh host       # user, directories, firewall, unattended-upgrades
#   sudo ./deploy/provision.sh app        # build + install the checkout, systemd units
#   sudo ./deploy/provision.sh verify     # prove what is actually running
#   sudo ./deploy/provision.sh harden-ssh # LAST, and only after key auth is proven
#
#   sudo ./deploy/provision.sh cloudflare-firewall
#                                         # restrict 443 to Cloudflare's ranges and
#                                         # install the weekly refresh timer. Run it
#                                         # ONLY once DNS is proxied through Cloudflare
#                                         # and a real Origin CA cert is installed —
#                                         # earlier, it cuts the origin off from the
#                                         # only thing allowed to reach it.
#
# ── Two deployment forms, both supported ──
#
# `app` builds whatever source is at /srv/wevolunteer. It does not care how the
# code got there, and checks for package.json + package-lock.json rather than a
# .git directory:
#
#   release archive (what production uses) — ./deploy/make-release.sh ships a
#     committed tree over ssh and stamps .deployed-sha. No git remote, no deploy
#     key and no git binary is needed on the host.
#
#   git checkout (convenient for a staging box) — clone it there yourself. The
#     identity then comes from `git rev-parse` instead of the stamp.
#
# Nothing in the application reads git metadata at runtime; /health reports the
# version from server/package.json. A checkout on production would be a
# credential on a public-facing host that buys nothing.
#
# ── What it deliberately does NOT do ──
#
# Nothing outside this host. It cannot open a port in an OCI Security List, edit
# a route table, touch Cloudflare DNS or create an R2 bucket, and it does not
# pretend otherwise: `audit` reports what is reachable from here and names the
# OCI-side items it cannot see.
#
# It also never writes secrets. `/etc/wevolunteer/wevolunteer.env` is created
# from the template with 0640 root:wev and left for a human to fill in — a
# provisioning script that accepts a database password takes it from a shell
# history or a process list, which is how the password ends up somewhere it was
# never meant to be.
#
# ── The one genuinely dangerous step ──
#
# `harden-ssh` disables password authentication. It REFUSES unless it can first
# prove that key-based authentication already works for a non-root user, because
# the failure mode is being locked out of a host whose console you may not have.
# See the function for what it checks.

set -euo pipefail

APP_USER=wev

# ── Which directory does this operate on? ──
#
# The release THIS SCRIPT IS PART OF, because that is what the command line
# says. `sudo /srv/wevolunteer-next/deploy/provision.sh build` reads as "build
# the thing at /srv/wevolunteer-next", and it used to build /srv/wevolunteer
# instead — a hardcoded default that silently ignored the path the operator
# typed.
#
# That is not hypothetical. On 2026-09-28 a staged release was shipped to
# /srv/wevolunteer-next and built with exactly that command; the build landed in
# the LIVE tree, and the staging tree was left with no dist/ and no
# node_modules/. Swapping it in on the assumption it was built would have put an
# unbootable tree into production. It was caught by checking before the swap,
# which is not a control — it is luck with a good habit attached.
#
# WEV_APP_DIR still overrides, and the tests rely on that to point the logic at
# fixture directories. It is namespaced deliberately: a bare APP_DIR is common
# enough that an operator could have one exported for something else.
SELF_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=${WEV_APP_DIR:-$(dirname -- "$SELF_DIR")}
LIVE_DIR=/srv/wevolunteer
STAGE_DIR=${WEV_STAGE_DIR:-/srv/wevolunteer-next}
STATE_DIR=/var/lib/wevolunteer
BACKUP_DIR=/var/backups/wevolunteer
ENV_DIR=/etc/wevolunteer
ENV_FILE="$ENV_DIR/wevolunteer.env"
HEARTBEATS_FILE="$ENV_DIR/heartbeats.env"
APP_PORT=5050

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   [ ok ] %s\n' "$*"; }
warn() { printf '   [WARN] %s\n' "$*"; }
bad()  { printf '   [FAIL] %s\n' "$*"; }
die()  { printf '\n[FATAL] %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run with sudo"; }

# ─────────────────────────────────────────────────────────────────────────────
# Which build is deployed here?
#
# Production is NOT a git checkout and deliberately never will be. The runbook
# used to say `git clone <your-remote-url> /srv/wevolunteer`, which for a private
# repository means a deploy key or token sitting on the public-facing host — a
# credential that buys nothing at runtime, because nothing in the application
# reads git metadata. `/health` takes its version from server/package.json.
#
# So a release is shipped as an archive of a committed tree (see
# deploy/make-release.sh) and stamped with .deployed-sha. Git, when a checkout
# happens to be present, is a fallback rather than the primary source.
#
# Prints a short identity string; never fails.
deploy_identity() {
  local sha branch
  if [ -r "$APP_DIR/.deployed-sha" ]; then
    sha=$(tr -d ' \t\n\r' < "$APP_DIR/.deployed-sha")
    [ -n "$sha" ] && { printf 'release %s (archive)\n' "$sha"; return 0; }
  fi
  if [ -d "$APP_DIR/.git" ] && have git; then
    sha=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || true)
    branch=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    [ -n "$sha" ] && { printf 'checkout %s on %s\n' "$sha" "${branch:-detached}"; return 0; }
  fi
  printf 'unknown (no .deployed-sha, no usable git checkout)\n'
}

# The real precondition for building: npm ci needs both manifests. `.git` was
# never it — it was a proxy for "somebody actually put the code here", and it
# rejected the archive deployments that production actually uses.
app_dir_has_source() {
  [ -f "$APP_DIR/package.json" ] && [ -f "$APP_DIR/package-lock.json" ]
}

# ─────────────────────────────────────────────────────────────────────────────
# audit — read-only
# ─────────────────────────────────────────────────────────────────────────────
cmd_audit() {
  log "Host"
  echo "   os          : $(. /etc/os-release && echo "$PRETTY_NAME")"
  echo "   kernel      : $(uname -r)"
  echo "   arch        : $(uname -m)   (expect aarch64)"
  echo "   cpu         : $(nproc) vCPU — $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | xargs || echo 'n/a')"
  echo "   memory      : $(free -h | awk '/^Mem:/{print $2" total, "$7" available"}')"
  echo "   swap        : $(free -h | awk '/^Swap:/{print $2" total"}')"
  echo "   uptime      : $(uptime -p 2>/dev/null || true)"

  log "Storage"
  df -h / /var /srv 2>/dev/null | awk 'NR==1||/\//{printf "   %s\n",$0}' | sort -u

  log "Network"
  ip -brief addr 2>/dev/null | sed 's/^/   /'
  echo "   default route: $(awk 'NR==1' <<<"$(ip route show default 2>/dev/null)")"

  log "Listening sockets"
  if have ss; then
    ss -tulpnH 2>/dev/null | awk '{printf "   %-6s %-24s %s\n",$1,$5,$7}' | sort -u
  else warn "ss not present"; fi

  log "Host firewall"
  if have ufw; then echo "   ufw: $(awk 'NR==1' <<<"$(ufw status 2>/dev/null || true)")"; else echo "   ufw: not installed"; fi
  echo "   iptables INPUT policy: $(awk 'NR==1' <<<"$(iptables -S INPUT 2>/dev/null || echo 'n/a')")"
  echo "   iptables rules (INPUT): $(iptables -S INPUT 2>/dev/null | wc -l)"
  # Oracle's Ubuntu images ship iptables rules that drop everything except 22.
  # If nginx is listening and the port is open in OCI but nothing arrives, this
  # is usually why, and it is separate from ufw.
  if grep -qE 'REJECT|DROP' <<<"$(iptables -S INPUT 2>/dev/null || true)"; then
    warn "iptables has REJECT/DROP rules — Oracle images ship these; 80/443 must be allowed HERE (this host uses iptables directly, not ufw)"
  fi

  log "SSH configuration"
  # Capture ONCE, then query the text. `sshd -T | awk '...{print; exit}'` under
  # `set -o pipefail` is a trap: awk exits on the first match, sshd takes
  # SIGPIPE, pipefail promotes 141 to the pipeline status and `set -e` kills the
  # script. It killed `audit` two thirds of the way through on the production
  # host, silently — the output simply stopped. Same defect class as the one
  # that made every nightly backup fail.
  SSHD_CFG=$(sshd -T 2>/dev/null || true)
  for k in PermitRootLogin PasswordAuthentication PubkeyAuthentication KbdInteractiveAuthentication ChallengeResponseAuthentication; do
    v=$(awk -v k="$(echo "$k" | tr 'A-Z' 'a-z')" '$1==k{print $2; exit}' <<<"$SSHD_CFG")
    echo "   ${k}: ${v:-unset}"
  done

  log "Runtimes"
  echo "   node        : $(have node && node -v || echo 'absent')   (need >=24 <25)"
  echo "   npm         : $(have npm && npm -v || echo 'absent')"
  echo "   pg_dump     : $(have pg_dump && pg_dump --version | awk '{print $3}' || echo 'absent')   (need 17.x)"
  echo "   psql        : $(have psql && psql --version | awk '{print $3}' || echo 'absent')"
  echo "   nginx       : $(have nginx && nginx -v 2>&1 | awk -F/ '{print $2}' || echo 'absent')"
  echo "   git         : $(have git && git --version | awk '{print $3}' || echo 'absent')"
  echo "   docker      : $(have docker && docker --version || echo 'absent')"

  log "Services"
  for s in ssh nginx wevolunteer wevolunteer-backup.timer wevolunteer-cf-ip-refresh.timer unattended-upgrades snapd oracle-cloud-agent; do
    printf '   %-26s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo inactive)/$(systemctl is-enabled "$s" 2>/dev/null || echo disabled)"
  done

  log "Security posture"
  echo "   AppArmor    : $(have aa-status && aa-status --enabled >/dev/null 2>&1 && echo enabled || echo 'not enabled/absent')"
  echo "   timesync    : $(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo n/a) (timezone $(timedatectl show -p Timezone --value 2>/dev/null || echo n/a))"
  echo "   pending security updates: $(apt-get -s upgrade 2>/dev/null | grep -ci '^Inst.*security' || echo 0)"
  echo "   reboot required: $([ -f /var/run/reboot-required ] && echo YES || echo no)"

  log "Accounts"
  awk -F: '$3>=1000 && $3<65534 {printf "   %-16s uid=%s shell=%s\n",$1,$3,$7}' /etc/passwd
  echo "   passwordless sudo entries: $(grep -rhoE '^[^#]*NOPASSWD' /etc/sudoers /etc/sudoers.d/ 2>/dev/null | wc -l)"

  log "Existing deployment"
  for d in "$APP_DIR" "$STATE_DIR" "$BACKUP_DIR" "$ENV_DIR"; do
    if [ -e "$d" ]; then echo "   $d: present ($(stat -c '%U:%G %a' "$d"))"; else echo "   $d: absent"; fi
  done
  echo "   deployed     : $(deploy_identity)"
  if app_dir_has_source; then
    echo "   source       : package.json + package-lock.json present (buildable)"
  else
    echo "   source       : INCOMPLETE — no package.json/package-lock.json"
  fi
  if [ -d "$APP_DIR/.git" ] && have git; then
    echo "   working tree : $(git -C "$APP_DIR" status --porcelain 2>/dev/null | wc -l) uncommitted changes"
  fi
  if [ -f "$ENV_FILE" ]; then
    echo "   env file     : present ($(stat -c '%U:%G %a' "$ENV_FILE")), keys: $(grep -cE '^[A-Z_]+=' "$ENV_FILE" || echo 0)"
    # Names only. Never values.
    echo "   engine       : $(grep -E '^DATABASE_ENGINE=' "$ENV_FILE" | cut -d= -f2- || echo '(unset — would default to SQLITE)')"
    grep -qE '^DATABASE_URL=' "$ENV_FILE" && echo "   DATABASE_URL : set" || echo "   DATABASE_URL : MISSING"
  fi

  log "What this script cannot see"
  cat <<'EOF'
   OCI Security List / NSG ingress rules      -> Console or OCI CLI
   VCN route table and Internet Gateway       -> Console or OCI CLI
   Whether the public IP is ephemeral         -> Console or OCI CLI
   Oracle IAM, budgets, cost controls         -> Console or OCI CLI
   Cloudflare DNS / proxy / TLS mode          -> Cloudflare account
   If a port is open here in iptables but the service is still unreachable from
   the internet, the remaining explanation is almost always the OCI Security
   List, and it cannot be fixed from this host.
EOF
}

# ─────────────────────────────────────────────────────────────────────────────
# packages
# ─────────────────────────────────────────────────────────────────────────────
cmd_packages() {
  need_root
  export DEBIAN_FRONTEND=noninteractive
  . /etc/os-release
  log "apt update"
  apt-get update -qq

  log "Base packages"
  # iptables-persistent, NOT ufw. This changed after the first real deployment:
  # the Oracle Ubuntu image already ships iptables rules (including the
  # InstanceServices chain that Oracle Cloud Agent needs), and enabling ufw on
  # top installs a second, competing set of chains. Production has never had ufw
  # installed; provisioning a fresh host with it produced a box whose firewall
  # did not match the one that was actually tested. Preseed the two prompts so
  # the install stays non-interactive and does NOT overwrite existing rules.
  echo iptables-persistent iptables-persistent/autosave_v4 boolean false | debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean false | debconf-set-selections
  apt-get install -y -qq ca-certificates curl gnupg git nginx iptables-persistent unattended-upgrades lsb-release

  # Node. Ubuntu 26.04 ships Node 22; package.json needs >=24 <25. NodeSource's
  # nodistro suite is version-independent and publishes arm64. NOT nvm: the unit
  # runs `/usr/bin/env node` as `wev`, which cannot see a per-user install.
  local want_major=24
  local have_major=""
  have node && have_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$have_major" = "$want_major" ]; then
    ok "node $(node -v) already satisfies >=24 <25"
  else
    log "Installing Node ${want_major} from NodeSource (distro ships $( [ -n "$have_major" ] && echo "v$have_major" || echo 'none' ))"
    curl -fsSL "https://deb.nodesource.com/setup_${want_major}.x" | bash -
    apt-get install -y -qq nodejs
    node -v | grep -qE '^v24\.' || die "expected Node 24, got $(node -v)"
    ok "node $(node -v), npm $(npm -v)"
  fi

  # PostgreSQL client 17. pg_dump refuses a server NEWER than itself, exits
  # non-zero AND leaves a zero-byte file — so a mismatch here is a backup that
  # reports success and contains nothing. Supabase is 17.
  if have pg_dump && pg_dump --version | grep -qE ' 17\.'; then
    ok "pg_dump $(pg_dump --version | awk '{print $3}') already matches Supabase's major"
  else
    log "Installing postgresql-client-17 from PGDG (suite: ${VERSION_CODENAME}-pgdg)"
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
    apt-get install -y -qq postgresql-client-17
    pg_dump --version | grep -qE ' 17\.' || die "expected pg_dump 17, got $(pg_dump --version)"
    ok "pg_dump $(pg_dump --version | awk '{print $3}')"
  fi

  log "Unattended security upgrades"
  dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
  ok "$(systemctl is-active unattended-upgrades)/$(systemctl is-enabled unattended-upgrades)"
}

# ─────────────────────────────────────────────────────────────────────────────
# host — user, directories, firewall
# ─────────────────────────────────────────────────────────────────────────────
cmd_host() {
  need_root

  log "Service user"
  if id "$APP_USER" >/dev/null 2>&1; then ok "$APP_USER exists"
  else
    # No login shell, no home to speak of: this account exists to own files and
    # run one process, and should not be a way into the box.
    useradd --system --create-home --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$APP_USER"
    ok "created $APP_USER (system, nologin)"
  fi

  log "Directories"
  install -d -o root     -g "$APP_USER" -m 0750 "$ENV_DIR"
  install -d -o root     -g root        -m 0755 "$APP_DIR"
  # 0751 on the state directory and uploads/: nginx (www-data) serves /uploads
  # straight from disk, so it must be able to TRAVERSE both, and nothing more —
  # the trailing 1 is search without read, so neither can be listed. These were
  # 0750, which made every uploaded picture a 403 in production from the day the
  # host was provisioned; there were no uploads yet, so nobody saw it (found
  # 2026-09-13 during the rollout). exports/ stays 0750: nothing but the app
  # reads it, and the worker creates each export 0700 on top of that.
  install -d -o "$APP_USER" -g "$APP_USER" -m 0751 "$STATE_DIR" "$STATE_DIR/uploads"
  install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$STATE_DIR/exports"
  install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$BACKUP_DIR"
  for d in "$ENV_DIR" "$APP_DIR" "$STATE_DIR" "$BACKUP_DIR"; do
    printf '   %-28s %s\n' "$d" "$(stat -c '%U:%G %a' "$d")"
  done

  log "Environment file"
  if [ -f "$ENV_FILE" ]; then
    ok "$ENV_FILE exists — left untouched (it holds secrets)"
  else
    install -o root -g "$APP_USER" -m 0640 "$APP_DIR/deploy/wevolunteer.env.example" "$ENV_FILE" 2>/dev/null \
      || install -o root -g "$APP_USER" -m 0640 /dev/null "$ENV_FILE"
    warn "$ENV_FILE created FROM THE TEMPLATE and is not usable yet."
    warn "A human must fill in DATABASE_URL, JWT_SECRET, TFA_ENCRYPTION_KEY and the mail keys."
    warn "This script will not accept secrets on a command line."
  fi

  log "Host firewall (iptables + netfilter-persistent)"
  # ── Why not ufw ──
  #
  # The Oracle Ubuntu image arrives with a populated INPUT chain: ACCEPT for
  # ESTABLISHED/RELATED, icmp, loopback and port 22, then a terminal
  # `REJECT --reject-with icmp-host-prohibited`, plus an `InstanceServices`
  # chain that Oracle Cloud Agent depends on. ufw would install a parallel set
  # of chains and its own persistence, leaving two mechanisms disagreeing about
  # the same packets. Production has never run ufw. This edits the rules that
  # are already there.
  #
  # Nothing here flushes. Each rule is added only if absent, so re-running is a
  # no-op, and port 22 is never touched — the session running this script
  # survives.
  local reject_pos
  for port in 80 443; do
    if iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
      ok "tcp/$port already allowed"
    else
      # Insert ABOVE the terminal REJECT, or append if this host has none.
      reject_pos=$(awk '$2=="REJECT"{print $1; exit}' <<<"$(iptables -L INPUT -n --line-numbers)")
      if [ -n "$reject_pos" ]; then
        iptables -I INPUT "$reject_pos" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
      else
        iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT
      fi
      ok "allowed tcp/$port"
    fi
  done
  iptables -C INPUT -p tcp -m state --state NEW --dport 22 -j ACCEPT 2>/dev/null \
    || warn "tcp/22 has no explicit ACCEPT — NOT adding one blindly; check before you log out"
  netfilter-persistent save >/dev/null 2>&1 && ok "rules persisted to /etc/iptables/rules.v{4,6}" \
    || warn "netfilter-persistent save failed — rules are live but will not survive reboot"
  iptables -L INPUT -n --line-numbers | sed 's/^/   /'
  warn "This is the HOST firewall only. OCI's Security List is a separate filter in front of it."
  warn "Port 443 is still open to the whole internet here. Run '$0 cloudflare-firewall'"
  warn "to restrict it to Cloudflare once DNS is proxied and the origin cert is installed."

  log "Timezone / NTP"
  timedatectl set-timezone UTC 2>/dev/null || true
  timedatectl set-ntp true 2>/dev/null || true
  echo "   $(timedatectl show -p Timezone --value), NTP synchronized=$(timedatectl show -p NTPSynchronized --value)"
}

# ─────────────────────────────────────────────────────────────────────────────
# app — build and install
# ─────────────────────────────────────────────────────────────────────────────
# Waits up to 60s for the application to answer /ready with 200.
wait_for_ready() {
  local i code
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$APP_PORT/ready" 2>/dev/null || true)
    [ "$code" = "200" ] && { ok "ready after ~$((i * 2))s"; return 0; }
    sleep 2
  done
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# build — produce a runnable tree at APP_DIR. Touches nothing outside it.
#
# Split out of `app` so a release can be built BEFORE it goes live. `app` used
# to build in place, which meant the service was down for the whole npm ci and
# vite build — about two minutes — when the only step that genuinely requires
# downtime is the restart. Build the staged tree, then swap, and the outage is
# the restart alone.
#
# Nothing here reads $ENV_FILE, so the output does not depend on which directory
# it was produced in. That is what makes building somewhere else and moving it
# afterwards safe rather than merely convenient.
cmd_build() {
  need_root
  app_dir_has_source \
    || die "no application source at $APP_DIR (need package.json and package-lock.json).
       Ship a release with deploy/make-release.sh, or clone a checkout there."
  [ -f "$ENV_FILE" ]     || die "$ENV_FILE missing — run 'host' and fill it in"

  grep -qE '^DATABASE_ENGINE=postgres' "$ENV_FILE" \
    || die "$ENV_FILE does not set DATABASE_ENGINE=postgres. Unset means SQLITE, which would put production on this VM's disk."
  grep -qE '^DATABASE_URL=.+' "$ENV_FILE" \
    || die "$ENV_FILE does not set DATABASE_URL."

  log "Building $(deploy_identity)"
  chown -R root:root "$APP_DIR"

  # FULL install, including devDependencies: `vite` and `@vitejs/plugin-react`
  # are devDependencies and `npm run build` is `vite build`, so `--omit=dev`
  # here produces "vite: not found" and no dist/. The runtime does not need
  # them — but the build does, and the build happens on this host.
  npm --prefix "$APP_DIR" ci --no-audit --no-fund

  # ── Build-time configuration ──
  #
  # Vite INLINES import.meta.env.VITE_* at build time. A variable that is unset
  # when the bundle is built is not a lookup that fails later — it is the literal
  # `undefined` in the shipped file, and there is no way to set it afterwards
  # short of rebuilding.
  #
  # This step used to run `npm run build` with none of them, so every VITE_*
  # variable in $ENV_FILE was silently ignored. src/utils/analytics.js predicted
  # the consequence in its own header — "a deploy that forgot the variable looks
  # identical to a deploy with analytics deliberately switched off" — and that is
  # precisely what production was: VITE_AMPLITUDE_API_KEY had been configured on
  # the host since the analytics work, and the key was in no bundle ever built.
  # Nothing reported it, because nothing could.
  #
  # ONLY the VITE_-prefixed keys are passed, never the whole file. Vite would
  # ignore the rest anyway, but $ENV_FILE also holds DATABASE_URL and the SMTP
  # password, and `set -a; source "$ENV_FILE"` would put both in the environment
  # of every build plugin for the sake of convenience. The narrow thing is as
  # easy to write and does not have to be re-audited when a plugin is added.
  local vite_vars=() vite_names=""
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line; do
      # Strip one layer of surrounding quotes from the VALUE: `KEY="v"` in the
      # env file must reach the build as `v`, not as `"v"` — which would be
      # inlined complete with quotation marks and match nothing.
      local k=${line%%=*} v=${line#*=}
      v=${v%\"}; v=${v#\"}
      v=${v%\'}; v=${v#\'}
      vite_vars+=("$k=$v")
      vite_names="$vite_names $k"
    done < <(grep -E '^VITE_[A-Za-z0-9_]+=' "$ENV_FILE" || true)
  fi

  if [ ${#vite_vars[@]} -gt 0 ]; then
    # NAMES only. The values are compiled into a public bundle, so they are not
    # secrets — but a deploy log is read over shoulders and copied into tickets,
    # and there is no reason to put them there.
    ok "build-time variables:${vite_names}"
    env "${vite_vars[@]}" npm --prefix "$APP_DIR" run build
  else
    warn "no VITE_* variables in $ENV_FILE — the bundle is built with defaults"
    npm --prefix "$APP_DIR" run build
  fi

  [ -f "$APP_DIR/dist/index.html" ] || die "build produced no dist/index.html"
  ok "dist built ($(du -sh "$APP_DIR/dist" | cut -f1))"

  # Proof, not assumption. Inlining is silent when it does not happen, so every
  # variable that was passed is checked for in the output. A value that is
  # legitimately absent — an empty string, or a flag whose default already
  # matched — warns rather than fails; one that vanished entirely is worth
  # somebody looking at before it becomes another year of missing analytics.
  local missing=""
  local pair name value
  for pair in "${vite_vars[@]:-}"; do
    [ -n "$pair" ] || continue
    name=${pair%%=*}; value=${pair#*=}
    [ -n "$value" ] || continue
    grep -rqF -- "$value" "$APP_DIR/dist" 2>/dev/null || missing="$missing $name"
  done
  if [ -n "$missing" ]; then
    warn "set in $ENV_FILE but not found in the bundle:$missing"
    warn "if one of those is meant to change behaviour, the build did not receive it."
  elif [ ${#vite_vars[@]} -gt 0 ]; then
    ok "every build-time variable reached the bundle"
  fi

  # Now drop the build-only tree. The service runs `server/server.js`, which
  # needs production dependencies only, and leaving ~400 dev packages on a
  # public-facing host is avoidable attack surface on a 6 GB box.
  npm --prefix "$APP_DIR" prune --omit=dev --no-audit --no-fund
  ok "pruned to production dependencies"

  # The app must be able to write uploads/exports, and must NOT be able to
  # write its own code.
  chown -R "$APP_USER:$APP_USER" "$STATE_DIR"
  # And nginx must be able to reach uploads/ (see cmd_host). Re-asserted here so a
  # host provisioned before that fix is corrected by the next release.
  chmod o+x "$STATE_DIR" "$STATE_DIR/uploads"
}

# ─────────────────────────────────────────────────────────────────────────────
# activate — install units, restart the service, reload nginx.
#
# Always operates on the LIVE tree. Activating a staged directory would point
# systemd at a path that is about to be renamed, so this deliberately ignores
# APP_DIR: `swap` moves the tree into place first, and this is what makes it
# run.
cmd_activate() {
  need_root
  APP_DIR="$LIVE_DIR"

  # The guard that would have caught the 2026-09-28 near-miss. A tree with no
  # dist/ starts, serves no client, and reports itself healthy — the server
  # answers /health whether or not the front end was ever built.
  [ -f "$APP_DIR/dist/index.html" ] \
    || die "no dist/index.html at $APP_DIR — this tree was never built.
       Run 'build' against it first, or 'app' to do both."
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing — run 'host' and fill it in"

  log "systemd units"
  install -m 0644 "$APP_DIR/deploy/wevolunteer.service"        /etc/systemd/system/
  install -m 0644 "$APP_DIR/deploy/wevolunteer-backup.service" /etc/systemd/system/
  install -m 0644 "$APP_DIR/deploy/wevolunteer-backup.timer"   /etc/systemd/system/

  # Monitoring: the heartbeat reporter, the failure template the monitored units
  # name in OnFailure=, and the fifteen-minute host check. Installed before the
  # daemon-reload so a unit never references a template systemd has not seen.
  install -o root -g root -m 0755 "$APP_DIR/deploy/wevolunteer-heartbeat.sh"  /usr/local/sbin/wevolunteer-heartbeat.sh
  install -o root -g root -m 0755 "$APP_DIR/deploy/wevolunteer-host-check.sh" /usr/local/sbin/wevolunteer-host-check.sh
  install -m 0644 "$APP_DIR/deploy/wevolunteer-heartbeat-fail@.service" /etc/systemd/system/
  install -m 0644 "$APP_DIR/deploy/wevolunteer-host-check.service"      /etc/systemd/system/
  install -m 0644 "$APP_DIR/deploy/wevolunteer-host-check.timer"        /etc/systemd/system/
  if [ -f "$HEARTBEATS_FILE" ]; then
    ok "$HEARTBEATS_FILE exists — left untouched (it holds heartbeat tokens)"
  else
    install -o root -g "$APP_USER" -m 0640 "$APP_DIR/deploy/heartbeats.env.example" "$HEARTBEATS_FILE"
    warn "$HEARTBEATS_FILE created from the template with every heartbeat unset."
    warn "Until a human fills it in, backups, the firewall refresh and host health are NOT alerted."
  fi
  # The Cloudflare refresh unit is installed by `cloudflare-firewall`, which also
  # mutates the firewall. When that step has already run on this host, keep its
  # unit file current here (it gained failure reporting) without touching any
  # rule. A host that never ran it gets nothing.
  if [ -f /etc/systemd/system/wevolunteer-cf-ip-refresh.service ]; then
    install -o root -g root -m 0644 "$APP_DIR/deploy/wevolunteer-cf-ip-refresh.service" /etc/systemd/system/
    ok "refreshed wevolunteer-cf-ip-refresh.service (unit file only; firewall untouched)"
  fi
  systemctl daemon-reload
  # RESTART, not `enable --now`. `--now` starts a unit that is stopped and does
  # nothing to one that is running — so on a live host every previous run of this
  # step rebuilt the tree and left the old process serving the old code, with
  # .deployed-sha claiming otherwise. Observed on production 2026-09-13: the
  # process predated the stamp by ten hours. `restart` also starts a stopped unit.
  systemctl enable wevolunteer.service
  systemctl restart wevolunteer.service
  wait_for_ready || die "wevolunteer did not become ready after restart — see: journalctl -u wevolunteer -n 80"
  systemctl enable --now wevolunteer-backup.timer
  systemctl enable --now wevolunteer-host-check.timer
  ok "wevolunteer: $(systemctl is-active wevolunteer)/$(systemctl is-enabled wevolunteer)"
  ok "backup timer: $(systemctl is-active wevolunteer-backup.timer)/$(systemctl is-enabled wevolunteer-backup.timer)"

  log "nginx"
  # The security-header snippet first: the site config includes it, and
  # `nginx -t` below rejects a config whose include is missing.
  install -d -m 0755 /etc/nginx/snippets
  install -m 0644 "$APP_DIR/deploy/nginx/wevolunteers-security-headers.conf" /etc/nginx/snippets/wevolunteers-security-headers.conf
  install -m 0644 "$APP_DIR/deploy/nginx/wevolunteers.conf" /etc/nginx/sites-available/wevolunteers.conf
  ln -sfn /etc/nginx/sites-available/wevolunteers.conf /etc/nginx/sites-enabled/wevolunteers.conf
  rm -f /etc/nginx/sites-enabled/default
  nginx -t || die "nginx config rejected — not reloading"
  systemctl reload nginx
  ok "nginx reloaded"
}

# ─────────────────────────────────────────────────────────────────────────────
# app — build here, then activate. The original behaviour, unchanged.
#
# Correct for a host being provisioned for the first time, and for any occasion
# where a couple of minutes of downtime does not matter. When it does, use
# build → swap instead.
cmd_app() {
  cmd_build
  cmd_activate
}

# ─────────────────────────────────────────────────────────────────────────────
# swap — put a built staged release live, keeping the old one for rollback.
#
# The outage is the mv plus the restart: both trees are on the same filesystem,
# so the rename is instant. Compare with `app` on a live host, which is down for
# the whole npm ci and vite build.
#
# It refuses an unbuilt staging tree. That is the whole point: the manual
# version of this sequence is four commands typed at speed, and the one that
# goes wrong is moving a tree nobody built.
cmd_swap() {
  need_root
  [ -d "$STAGE_DIR" ] || die "no staged release at $STAGE_DIR — ship one with deploy/make-release.sh --dir $STAGE_DIR"
  [ -f "$STAGE_DIR/dist/index.html" ] \
    || die "$STAGE_DIR has no dist/index.html — it was never built.
       Run: sudo WEV_APP_DIR=$STAGE_DIR $STAGE_DIR/deploy/provision.sh build"
  [ -d "$STAGE_DIR/node_modules" ] \
    || die "$STAGE_DIR has no node_modules — it was never built."
  [ -d "$LIVE_DIR" ] || die "no live release at $LIVE_DIR to replace"

  local new_sha old_sha ts prev
  new_sha=$(cat "$STAGE_DIR/.deployed-sha" 2>/dev/null || echo unknown)
  old_sha=$(cat "$LIVE_DIR/.deployed-sha" 2>/dev/null || echo unknown)
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  prev="$LIVE_DIR-prev-$old_sha-$ts"

  log "Swapping $old_sha -> $new_sha"
  systemctl stop wevolunteer.service
  mv "$LIVE_DIR" "$prev"
  mv "$STAGE_DIR" "$LIVE_DIR"
  # Written before activate, so a failure during activate still leaves a pointer
  # home. `rollback` reads this and nothing else.
  printf '%s\n' "$prev" > /srv/.last-rollback
  ok "previous release kept at $prev"

  cmd_activate
  ok "live: $(cat "$LIVE_DIR/.deployed-sha" 2>/dev/null)"
  echo "   Roll back with: sudo $LIVE_DIR/deploy/provision.sh rollback"
}

# ─────────────────────────────────────────────────────────────────────────────
# rollback — put the previous release back.
#
# Exists because the moment you need it is the moment you should not be
# composing mv commands from memory. Reads /srv/.last-rollback, which `swap`
# writes before it does anything that can fail.
cmd_rollback() {
  need_root
  local prev current ts
  [ -f /srv/.last-rollback ] || die "no /srv/.last-rollback — nothing recorded to roll back to"
  prev=$(cat /srv/.last-rollback)
  [ -d "$prev" ] || die "recorded rollback target $prev does not exist"
  [ -f "$prev/dist/index.html" ] || die "$prev has no dist/ — it is not bootable, refusing"

  current=$(cat "$LIVE_DIR/.deployed-sha" 2>/dev/null || echo unknown)
  ts=$(date -u +%Y%m%dT%H%M%SZ)

  log "Rolling back $current -> $(cat "$prev/.deployed-sha" 2>/dev/null || echo unknown)"
  systemctl stop wevolunteer.service
  # The failed release is KEPT, not deleted. You will want to look at it, and
  # deleting the evidence of a bad deploy during the bad deploy is how nobody
  # ever finds out what happened.
  mv "$LIVE_DIR" "$LIVE_DIR-failed-$current-$ts"
  mv "$prev" "$LIVE_DIR"
  rm -f /srv/.last-rollback
  ok "the release that was rolled back is kept at $LIVE_DIR-failed-$current-$ts"

  cmd_activate
  ok "live: $(cat "$LIVE_DIR/.deployed-sha" 2>/dev/null)"
}

# ─────────────────────────────────────────────────────────────────────────────
# prune-releases — keep the most recent few, delete the rest.
#
# Retained releases are the rollback path, so this keeps several rather than
# one: the release you need may not be the one you just replaced. Default 3,
# override with WEV_KEEP_RELEASES.
#
# It will not delete the target /srv/.last-rollback names, whatever its age —
# that is the one directory whose whole job is to still be there.
cmd_prune_releases() {
  need_root
  local keep protected
  keep=${WEV_KEEP_RELEASES:-3}
  protected=$(cat /srv/.last-rollback 2>/dev/null || echo "")

  # Globbed into an array and sorted in one pass, deliberately WITHOUT a
  # `| head` to take the oldest. Under `set -o pipefail` an early-exiting reader
  # SIGPIPEs its producer, 141 becomes the pipeline's status and `set -e` turns a
  # successful check into a fatal error. That bug has cost this project twice —
  # it deleted good backups once and killed `audit` at exit 141 on production —
  # and server/deploy.provisioning.test.js forbids the construct outright. `sort`
  # consumes all of its input, so it is safe; the slicing is done in bash.
  local found=() dirs=()
  shopt -s nullglob
  found=("$LIVE_DIR"-prev-* "$LIVE_DIR"-failed-*)
  shopt -u nullglob

  local total=${#found[@]}
  log "Retained releases: $total (keeping $keep)"
  if [ "$total" -le "$keep" ]; then
    ok "nothing to prune"
    return 0
  fi

  # Field 4 is the UTC timestamp: /srv/wevolunteer-prev-<sha>-<ts>. Sorting on
  # the whole name would order by commit sha, which is not chronological.
  mapfile -t dirs < <(printf '%s\n' "${found[@]}" | sort -t- -k4,4)

  local i removed=0
  for (( i = 0; i < total - keep; i++ )); do
    local d=${dirs[$i]}
    if [ "$d" = "$protected" ]; then
      ok "kept $(basename "$d") — it is the current rollback target"
      continue
    fi
    rm -rf "$d"
    ok "removed $(basename "$d")"
    removed=$(( removed + 1 ))
  done
  ok "removed $removed, kept $(( total - removed ))"
  ok "disk free on /srv: $(df -h /srv | awk 'NR==2{print $4}')"
}

# ─────────────────────────────────────────────────────────────────────────────
# cloudflare-firewall — restrict 443 to Cloudflare, and keep it current
#
# Run this ONLY once DNS is proxied through Cloudflare and a real Origin CA
# certificate is installed. Run it earlier and you cut the origin off from the
# only thing allowed to reach it.
#
# The lockdown itself is performed by wevolunteer-cf-ip-refresh.sh rather than
# duplicated here. That script is the one with fetch validation, atomic chain
# replacement, a health check and rollback; a second implementation living in
# the provisioner would be the one nobody tests. All this function does is
# create the chain/jump *structure* the script expects — permissively, so
# behaviour is unchanged — and then let the script perform the actual
# restriction and prove it.
# ─────────────────────────────────────────────────────────────────────────────

# Ensures `<chain>` exists and INPUT jumps to it for tcp/443, without changing
# what is currently allowed. The placeholder chain is a bare ACCEPT: exactly
# equivalent to the blanket rule it replaces, so there is no window in which
# 443 is more open OR more closed than it was a moment ago.
ensure_cf_chain() {
  local cmd=$1 chain=$2 pos shadowed
  if $cmd -S "$chain" >/dev/null 2>&1; then
    ok "$chain exists"
  else
    $cmd -N "$chain"
    $cmd -A "$chain" -j ACCEPT
    ok "created $chain (permissive placeholder — the refresh script fills it in)"
  fi

  if $cmd -C INPUT -p tcp -m state --state NEW --dport 443 -j "$chain" 2>/dev/null; then
    ok "INPUT already jumps to $chain for tcp/443"
    return 0
  fi

  # The jump must sit ABOVE every rule that would accept tcp/443 on its own: the
  # Cloudflare chain ends in DROP, so anything below the jump is unreachable,
  # but anything above it lets the whole internet reach the origin past
  # Cloudflare. This used to look only for the exact `state NEW tcp dpt:443`
  # rendering, so a hand-added rule written `--dport 443 -m conntrack`, or a
  # multiport list containing 443, was not recognised — and the jump could land
  # below it. Any tcp ACCEPT naming port 443 now counts. Only the canonical
  # blanket rule is deleted afterwards; other spellings are left in place, below
  # the jump, where they can match nothing.
  pos=$(awk '$2=="ACCEPT" && ($3=="tcp" || $3=="6") && (/dpt:443([^0-9]|$)/ || /dports ([0-9]+[,:])*443([^0-9]|$)/) {print $1; exit}' <<<"$($cmd -L INPUT -n --line-numbers)")
  if [ -n "$pos" ]; then
    $cmd -I INPUT "$pos" -p tcp -m state --state NEW --dport 443 -j "$chain"
    shadowed=$(awk '/state NEW tcp dpt:443/ && $2=="ACCEPT" {print $1; exit}' <<<"$($cmd -L INPUT -n --line-numbers)")
    [ -n "$shadowed" ] && $cmd -D INPUT "$shadowed"
    ok "jump inserted at INPUT $pos, blanket ACCEPT removed"
  else
    pos=$(awk '$2=="REJECT" || $2=="DROP" {print $1; exit}' <<<"$($cmd -L INPUT -n --line-numbers)")
    if [ -n "$pos" ]; then
      $cmd -I INPUT "$pos" -p tcp -m state --state NEW --dport 443 -j "$chain"
    else
      $cmd -A INPUT -p tcp -m state --state NEW --dport 443 -j "$chain"
    fi
    ok "jump added (no blanket 443 rule was present)"
  fi
}

cmd_cloudflare_firewall() {
  need_root
  [ -f "$APP_DIR/deploy/wevolunteer-cf-ip-refresh.sh" ] \
    || die "$APP_DIR/deploy/wevolunteer-cf-ip-refresh.sh missing — ship a release that contains it first"

  log "Refresh script and units"
  # /usr/local/sbin, not $APP_DIR/bin: this runs as root every week, and
  # $APP_DIR is replaced wholesale on every release. Keeping a root-executed
  # script out of the tree the application is redeployed into removes an obvious
  # escalation path, and stops the weekly job vanishing mid-deploy.
  install -o root -g root -m 0755 \
    "$APP_DIR/deploy/wevolunteer-cf-ip-refresh.sh" /usr/local/sbin/wevolunteer-cf-ip-refresh.sh
  install -o root -g root -m 0644 \
    "$APP_DIR/deploy/wevolunteer-cf-ip-refresh.service" /etc/systemd/system/
  install -o root -g root -m 0644 \
    "$APP_DIR/deploy/wevolunteer-cf-ip-refresh.timer" /etc/systemd/system/
  # The refresh unit reports success and failure to its heartbeat; install the
  # reporter and the failure template here too, so this subcommand does not
  # depend on `app` having run first.
  install -o root -g root -m 0755 \
    "$APP_DIR/deploy/wevolunteer-heartbeat.sh" /usr/local/sbin/wevolunteer-heartbeat.sh
  install -o root -g root -m 0644 \
    "$APP_DIR/deploy/wevolunteer-heartbeat-fail@.service" /etc/systemd/system/
  systemctl daemon-reload
  ok "installed /usr/local/sbin/wevolunteer-cf-ip-refresh.sh (root:root 0755)"

  log "Chain structure"
  ensure_cf_chain iptables  CF-HTTPS
  ensure_cf_chain ip6tables CF-HTTPS6

  log "Applying the Cloudflare allowlist (via the refresh script)"
  # If this fails it has already rolled itself back, and 443 is left exactly as
  # it was. Failing the provisioning run is correct: a half-restricted origin is
  # worse than an unrestricted one, because it looks finished.
  /usr/local/sbin/wevolunteer-cf-ip-refresh.sh \
    || die "the allowlist was not applied — 443 is unchanged; read the output above"

  log "Weekly timer"
  systemctl enable --now wevolunteer-cf-ip-refresh.timer
  ok "timer: $(systemctl is-active wevolunteer-cf-ip-refresh.timer)/$(systemctl is-enabled wevolunteer-cf-ip-refresh.timer)"
  systemctl list-timers wevolunteer-cf-ip-refresh.timer --no-pager | sed 's/^/   /'
}

# ─────────────────────────────────────────────────────────────────────────────
# verify — prove it, do not assert it
# ─────────────────────────────────────────────────────────────────────────────
cmd_verify() {
  local fails=0
  log "Service state"
  for s in wevolunteer nginx wevolunteer-backup.timer; do
    if systemctl is-active --quiet "$s"; then ok "$s active, enabled=$(systemctl is-enabled "$s" 2>/dev/null)"
    else bad "$s NOT active"; fails=$((fails+1)); fi
  done

  log "Application port binding"
  local bind; bind=$(awk 'NR==1{print $4}' <<<"$(ss -tlnH "sport = :$APP_PORT" 2>/dev/null)")
  if [ -z "$bind" ]; then bad "nothing listening on $APP_PORT"; fails=$((fails+1))
  elif echo "$bind" | grep -qE '^(127\.0\.0\.1|\[::1\]):'; then ok "app bound to loopback only ($bind)"
  else bad "app bound to $bind — reachable outside the proxy. Set BIND_ADDRESS=127.0.0.1"; fails=$((fails+1)); fi

  # ── Why these probes are not plain HTTP ──
  #
  # This block used to fetch `http://127.0.0.1/health` and require 200. On this
  # origin nginx answers port 80 with a 301 to https, which is the posture we
  # want — so the check reported FAIL on a correctly configured host, every run,
  # for both /health and the socket.io handshake below. Observed on production
  # 2026-09-24. A gate that cannot pass is a gate operators learn to skip, which
  # is worse than no gate.
  #
  # So: port 80 passes on 200 OR on a redirect to https (that redirect IS the
  # requirement), and the real check is made over https against the hostname the
  # application is configured to serve, resolved to the loopback so it never
  # leaves the box. `-k` is deliberate — the origin certificate is issued by
  # Cloudflare's origin CA, which the system trust store does not carry and is
  # not meant to; this probe is testing that our own nginx and app answer, not
  # the chain a browser sees.
  local public_host; public_host=$(grep -m1 -E '^APP_URL=' "$ENV_FILE" 2>/dev/null \
    | cut -d= -f2- | sed -E 's#^https?://##; s#/.*##')

  log "Health endpoints (port 80 posture, through nginx over https, then direct)"
  local code80 loc80
  code80=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1/health" || echo 000)
  loc80=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 10 "http://127.0.0.1/health" || echo "")
  case "$code80" in
    200) ok "http://127.0.0.1/health -> 200 (no https redirect configured)" ;;
    301|302|307|308)
      case "$loc80" in
        https://*) ok "http://127.0.0.1/health -> $code80 to https (http is redirected, as intended)" ;;
        *) bad "http://127.0.0.1/health -> $code80 to '${loc80:-nowhere}' (expected an https target)"; fails=$((fails+1)) ;;
      esac ;;
    *) bad "http://127.0.0.1/health -> $code80"; fails=$((fails+1)) ;;
  esac

  local probes=("http://127.0.0.1:$APP_PORT/health")
  if [ -n "$public_host" ]; then
    probes=("https://$public_host/health" "${probes[@]}")
  else
    warn "APP_URL is not set in $ENV_FILE — cannot probe nginx over https"
  fi
  for u in "${probes[@]}"; do
    local code args=(-s -o /tmp/_h -w '%{http_code}' --max-time 10)
    case "$u" in https://*) args+=(-k --resolve "$public_host:443:127.0.0.1") ;; esac
    code=$(curl "${args[@]}" "$u" || echo 000)
    if [ "$code" = "200" ]; then ok "$u -> 200 $(head -c 120 /tmp/_h)"
    else bad "$u -> $code"; fails=$((fails+1)); fi
  done
  rm -f /tmp/_h

  log "Database target (names only, no credentials)"
  local eng; eng=$(grep -E '^DATABASE_ENGINE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  [ "$eng" = "postgres" ] && ok "DATABASE_ENGINE=postgres" || { bad "DATABASE_ENGINE=${eng:-unset} (unset means SQLITE)"; fails=$((fails+1)); }
  if grep -qE '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null; then
    local host; host=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | sed -E 's#.*@([^:/]+).*#\1#')
    ok "DATABASE_URL host: $host"
    echo "$host" | grep -q 'supabase' && ok "points at Supabase" || warn "does not look like Supabase"
  else bad "DATABASE_URL missing"; fails=$((fails+1)); fi

  # Over https for the same reason as the health probes above: on port 80 this
  # handshake gets the 301 and never reaches the upgrade path it is testing.
  log "Socket.IO upgrade through nginx"
  local sio
  if [ -n "$public_host" ]; then
    sio=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -k \
      --resolve "$public_host:443:127.0.0.1" \
      "https://$public_host/socket.io/?EIO=4&transport=polling" || echo 000)
  else
    sio=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      "http://127.0.0.1/socket.io/?EIO=4&transport=polling" || echo 000)
  fi
  [ "$sio" = "200" ] && ok "socket.io handshake -> 200" || { bad "socket.io handshake -> $sio"; fails=$((fails+1)); }

  log "Externally reachable ports (from this host's own view)"
  ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\])' | sort -u | sed 's/^/   public-bound: /'
  echo "   (anything above other than :80 and :443 should be justified)"

  log "Firewall"
  iptables -L INPUT -n --line-numbers 2>/dev/null | sed 's/^/   /'
  iptables -C INPUT -p tcp -m state --state NEW --dport 22 -j ACCEPT 2>/dev/null \
    && ok "tcp/22 allowed" || { bad "tcp/22 has no ACCEPT rule"; fails=$((fails+1)); }
  if systemctl is-enabled netfilter-persistent >/dev/null 2>&1; then
    ok "netfilter-persistent enabled (rules survive reboot)"
  else
    bad "netfilter-persistent not enabled — firewall is lost on reboot"; fails=$((fails+1))
  fi

  log "Cloudflare origin allowlist (optional — only after DNS is proxied)"
  if iptables -S CF-HTTPS >/dev/null 2>&1; then
    local cf_n cf_last
    cf_n=$(iptables -S CF-HTTPS | grep -c ' -s ')
    cf_last=$(iptables -S CF-HTTPS | tail -1 | awk '{print $NF}')
    if [ "$cf_last" = "DROP" ] && [ "$cf_n" -ge 8 ]; then
      ok "CF-HTTPS: $cf_n ranges, terminal DROP"
    else
      bad "CF-HTTPS present but looks wrong ($cf_n ranges, terminal $cf_last)"; fails=$((fails+1))
    fi
    iptables -C INPUT -p tcp -m state --state NEW --dport 443 -j CF-HTTPS 2>/dev/null \
      && ok "INPUT jumps to CF-HTTPS for tcp/443" \
      || { bad "CF-HTTPS exists but INPUT does not jump to it — 443 is NOT restricted"; fails=$((fails+1)); }
    if grep -q -- '--dport 443 -j ACCEPT' <<<"$(iptables -S INPUT)"; then
      bad "a blanket 443 ACCEPT still exists — the allowlist is bypassed"; fails=$((fails+1))
    else
      ok "no blanket 443 ACCEPT"
    fi
    local tstate; tstate=$(systemctl is-enabled wevolunteer-cf-ip-refresh.timer 2>/dev/null || echo missing)
    [ "$tstate" = "enabled" ] && ok "weekly refresh timer enabled" \
      || { bad "refresh timer is $tstate — the allowlist will go stale and cause 522s"; fails=$((fails+1)); }
  else
    warn "CF-HTTPS chain absent — 443 is open to the internet."
    warn "That is expected before Cloudflare is in front. Run '$0 cloudflare-firewall' after."
  fi

  log "Recent application log"
  journalctl -u wevolunteer -n 15 --no-pager 2>/dev/null | sed 's/^/   /'

  echo
  if [ "$fails" -eq 0 ]; then ok "VERIFY PASSED"; else bad "VERIFY FAILED: $fails check(s)"; return 1; fi
}

# ─────────────────────────────────────────────────────────────────────────────
# harden-ssh — the step that can lock you out
# ─────────────────────────────────────────────────────────────────────────────
cmd_harden_ssh() {
  need_root
  log "Pre-flight: refusing to disable passwords unless keys already work"

  # The check that matters. If no non-root account has an authorized key, then
  # disabling password auth removes the only way in — and on a cloud host whose
  # serial console you may not have set up, that is unrecoverable.
  local found=0
  while IFS=: read -r u _ uid _ _ home _; do
    [ "$uid" -ge 1000 ] && [ "$uid" -lt 65534 ] || continue
    if [ -s "$home/.ssh/authorized_keys" ]; then
      ok "$u has $(grep -cvE '^\s*(#|$)' "$home/.ssh/authorized_keys") authorized key(s)"
      found=$((found+1))
    fi
  done < /etc/passwd
  [ "$found" -gt 0 ] || die "no non-root user has an authorized_keys entry. Refusing: this would lock you out."

  [ -n "${SSH_CONNECTION:-}" ] && ok "you are on an SSH session right now ($(echo "$SSH_CONNECTION" | awk '{print $1}')) — key auth is demonstrably working"

  log "Applying"
  install -d -m 0755 /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/10-wevolunteer.conf <<'EOF'
# Managed by deploy/provision.sh. Keys only, no root, no interactive fallbacks.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
MaxAuthTries 4
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
  sshd -t || { rm -f /etc/ssh/sshd_config.d/10-wevolunteer.conf; die "sshd rejected the config; reverted, nothing changed"; }

  # Reload, not restart: existing sessions survive, so a mistake still leaves
  # you connected and able to undo it.
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  ok "reloaded. Effective settings:"
  sshd -T | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication)' | sed 's/^/     /'
  warn "Open a SECOND ssh session now and confirm it works before closing this one."
}

# Only dispatch when executed. Sourcing the script defines the functions without
# running anything, which is how the provisioning logic is tested against both
# deployment forms without a root shell or a real host.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-audit}" in
    audit)      cmd_audit ;;
    packages)   cmd_packages ;;
    host)       cmd_host ;;
    app)        cmd_app ;;
    build)      cmd_build ;;
    activate)   cmd_activate ;;
    swap)       cmd_swap ;;
    rollback)   cmd_rollback ;;
    prune-releases) cmd_prune_releases ;;
    verify)     cmd_verify ;;
    harden-ssh) cmd_harden_ssh ;;
    cloudflare-firewall) cmd_cloudflare_firewall ;;
    *) die "usage: $0 {audit|packages|host|app|build|activate|swap|rollback|prune-releases|verify|harden-ssh|cloudflare-firewall}

  Zero-downtime release (outage is the restart, not the build):
    deploy/make-release.sh --to <host> --dir /srv/wevolunteer-next
    sudo WEV_APP_DIR=/srv/wevolunteer-next /srv/wevolunteer-next/deploy/provision.sh build
    sudo /srv/wevolunteer/deploy/provision.sh swap
    sudo /srv/wevolunteer/deploy/provision.sh verify

  If it goes wrong:
    sudo /srv/wevolunteer/deploy/provision.sh rollback" ;;
  esac
fi
