#!/usr/bin/env bash
#
# Build a release archive from a committed tree, and optionally ship it.
#
# ── Why this exists ──
#
# The runbook used to say `git clone <your-remote-url> /srv/wevolunteer`. For a
# private repository that means a deploy key or an access token living on the
# public-facing host, and it buys nothing: nothing in the application reads git
# metadata at runtime — `/health` reports the version from server/package.json.
# A credential that is never used at runtime is a credential that exists only to
# be stolen.
#
# So production is an archive of a committed tree, stamped with the commit it
# came from. The host needs no git remote, no key, and no git binary.
#
# ── What it ships, and what it cannot ship ──
#
# `git archive` emits TRACKED files at a commit. Untracked and ignored files are
# structurally excluded, which is why `.env` cannot end up in a release even by
# accident — it is ignored, so there is nothing to exclude by hand and no list to
# keep up to date. The archive is checked for it anyway before anything is sent,
# because "structurally impossible" is a claim worth testing once per release.
#
# ── The dirty-tree refusal ──
#
# `git archive HEAD` ships what is COMMITTED. On 2026-07-30 seven ship-blocking
# defects were fixed and the fixes lived only in the working tree; the deploy
# procedure would have shipped the version that still had them. Shipping while
# the tree is dirty is therefore refused, not warned about. --allow-dirty exists
# for the case where you genuinely mean it, and says so loudly.
#
# Usage:
#   ./deploy/make-release.sh                                  # tarball of HEAD in ./
#   ./deploy/make-release.sh --ref v1.2.0                     # a tag instead
#   ./deploy/make-release.sh --to ubuntu@host                 # build and ship
#   ./deploy/make-release.sh --to ubuntu@host --dir /srv/app  # somewhere else
#   ./deploy/make-release.sh --to ubuntu@host -i ~/.ssh/key   # explicit identity
#
# Only ever reads from git: archive, rev-parse, status. It creates no commits,
# moves no refs, and touches no remote.

set -euo pipefail

REF=HEAD
OUT=""
TO=""
DEST=/srv/wevolunteer
SSH_KEY=""
ALLOW_DIRTY=0

die()  { printf '\n[FATAL] %s\n' "$*" >&2; exit 1; }
log()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   [ ok ] %s\n' "$*"; }
warn() { printf '   [WARN] %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)         REF=${2:?--ref needs a value}; shift 2 ;;
    --output|-o)   OUT=${2:?--output needs a value}; shift 2 ;;
    --to)          TO=${2:?--to needs a value}; shift 2 ;;
    --dir)         DEST=${2:?--dir needs a value}; shift 2 ;;
    --identity|-i) SSH_KEY=${2:?--identity needs a value}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help)     sed -n '1,45p' "$0"; exit 0 ;;
    *)             die "unknown argument: $1" ;;
  esac
done

command -v git >/dev/null 2>&1 || die "git is required to BUILD a release (the host never needs it)"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "run this from inside the repository"

SHA=$(git rev-parse --short "$REF") || die "cannot resolve ref: $REF"
FULL=$(git rev-parse "$REF") || die "cannot resolve ref: $REF"

log "Release $SHA (from $REF)"

# ── Refuse to ship a tree whose state is not what the operator is looking at ──
#
# The check keys on the RESOLVED COMMIT, not on the string "HEAD". Spelling the
# same commit as `--ref main`, `--ref HEAD` or `--ref <sha>` must not be a way to
# skip it: the operator is still looking at edits that will not be in the
# release. A ref that genuinely points elsewhere (an older tag) is a deliberate
# choice and is left alone.
if [ "$FULL" = "$(git rev-parse HEAD 2>/dev/null || echo none)" ]; then
  DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
  if [ "$DIRTY" -ne 0 ]; then
    git status --short | sed 's/^/     /'
    if [ "$ALLOW_DIRTY" -eq 1 ]; then
      warn "$DIRTY uncommitted change(s). --allow-dirty given, so shipping COMMITTED content anyway."
      warn "The changes listed above will NOT be in this release."
    else
      die "$DIRTY uncommitted change(s) in the working tree.
       git archive ships what is COMMITTED, so this release would not contain them.
       Commit them, or pass --allow-dirty if you really mean to ship without them."
    fi
  else
    ok "working tree clean — the archive matches what you can see"
  fi
else
  ok "$REF is not the current HEAD — shipping that commit as asked"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TAR="$TMP/release.tar"

# ── The stamp must be the only .deployed-sha in the archive ──
#
# If the file were ever tracked, the archive would carry two entries with the
# same name. Which one lands on disk then depends on tar's extraction order —
# "the last one wins" is conventional behaviour, not a guarantee — and reading
# the stamp back out of the archive returns both concatenated. Refuse rather
# than rely on it.
if grep -qx '.deployed-sha' <<<"$(git ls-tree -r --name-only "$FULL")"; then
  die ".deployed-sha is tracked at $SHA. It is generated at release time and must stay
       untracked (it is in .gitignore); a tracked copy would collide with the stamp."
fi
printf '%s\n' "$SHA" > "$TMP/.deployed-sha"

log "Building archive"
# Archive the RESOLVED COMMIT, not the ref: a branch that moves between
# rev-parse and here would otherwise produce a tree the stamp does not describe.
#
# --add-file puts the stamp in with the archive's own consistent metadata
# (mode, uid/gid, mtime from the commit) rather than the builder's wall clock
# and user, which is what makes the artifact byte-reproducible.
git archive --format=tar --add-file="$TMP/.deployed-sha" "$FULL" -o "$TAR"
COUNT=$(tar -tf "$TAR" | grep -vc '/$' || true)
ok "$COUNT files from $SHA"
[ "$(tar -tf "$TAR" | grep -cx '.deployed-sha')" -eq 1 ] \
  || die "expected exactly one .deployed-sha in the archive"
ok "stamped .deployed-sha = $SHA"

# ── The secret check, run on the artifact rather than trusted in the abstract ──
#
# The listing is taken ONCE into a variable and every check reads it as a
# here-string. `tar -tf "$TAR" | grep -q ...` under `set -o pipefail` lets grep
# exit on its match while tar is still writing 1400 entries; tar takes SIGPIPE,
# 141 becomes the pipeline status, and a check that SUCCEEDED reads as a
# failure. The tracked-stamp guard above had the inverse problem: a SIGPIPE
# there would have made the guard silently pass.
log "Checking the archive carries no secrets"
TAR_LIST=$(tar -tf "$TAR")
LEAKED=$(grep -E '(^|/)\.env$|(^|/)\.env\.(local|production)$|\.pem$|(^|/)id_(rsa|ed25519)$' <<<"$TAR_LIST" || true)
if [ -n "$LEAKED" ]; then
  printf '%s\n' "$LEAKED" | sed 's/^/     /'
  die "refusing to ship: the archive contains files that look like secrets"
fi
ok "no .env, key or certificate files in the archive"
grep -q '^package-lock.json$' <<<"$TAR_LIST" || die "archive has no package-lock.json — 'provision.sh app' could not npm ci"
grep -q '^package.json$'      <<<"$TAR_LIST" || die "archive has no package.json"
ok "package.json and package-lock.json present"

if [ -n "$TO" ]; then
  log "Shipping to $TO:$DEST"
  SSH_OPTS=(-o ConnectTimeout=20)
  [ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")
  # The archive goes over the existing ssh session. No credential is created on
  # the host, and nothing is fetched from a remote by the host.
  gzip -nc "$TAR" | ssh "${SSH_OPTS[@]}" "$TO" \
    "sudo install -d -o root -g root -m 0755 '$DEST' && sudo tar -xzf - -C '$DEST'" \
    || die "ship failed — the host was not modified beyond whatever tar had already written"
  REMOTE_SHA=$(ssh "${SSH_OPTS[@]}" "$TO" "cat '$DEST/.deployed-sha' 2>/dev/null" | tr -d ' \t\n\r')
  [ "$REMOTE_SHA" = "$SHA" ] || die "shipped, but $DEST/.deployed-sha reads '$REMOTE_SHA', expected '$SHA'"
  ok "$DEST/.deployed-sha = $REMOTE_SHA"
  echo
  if [ "$DEST" = "/srv/wevolunteer" ]; then
    # Shipped straight over the live tree: there is nothing to stage, so the
    # service is down for the whole build. Correct for a first provision.
    echo "   Next, on the host:"
    echo "     sudo $DEST/deploy/provision.sh app"
    echo "     sudo $DEST/deploy/provision.sh verify"
  else
    # Staged. Build it where it stands, THEN swap — the outage is the restart
    # rather than the whole npm ci and vite build.
    #
    # WEV_APP_DIR is passed explicitly even though provision.sh now defaults to
    # its own release. Belt and braces, because getting this wrong is what put a
    # build into the live tree on 2026-09-28 while the staged tree stayed empty.
    echo "   Next, on the host — build the staged release, then swap it in:"
    echo "     sudo WEV_APP_DIR=$DEST $DEST/deploy/provision.sh build"
    echo "     sudo /srv/wevolunteer/deploy/provision.sh swap"
    echo "     sudo /srv/wevolunteer/deploy/provision.sh verify"
    echo
    echo "   If it goes wrong:"
    echo "     sudo /srv/wevolunteer/deploy/provision.sh rollback"
  fi
else
  OUT=${OUT:-"wevolunteer-$SHA.tar.gz"}
  gzip -nc "$TAR" > "$OUT"
  ok "wrote $OUT ($(du -h "$OUT" | cut -f1))"
  echo
  echo "   To deploy it:"
  echo "     scp $OUT <host>:/tmp/"
  echo "     ssh <host> \"sudo tar -xzf /tmp/$(basename "$OUT") -C $DEST && sudo $DEST/deploy/provision.sh app\""
fi

echo
printf '   full sha: %s\n' "$FULL"
