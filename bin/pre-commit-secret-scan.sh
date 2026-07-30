#!/bin/sh
#
# Blocks a commit that would introduce a secret.
#
# Exists because `.env` — carrying a live GOOGLE_CLIENT_SECRET — was committed
# once already (audit finding C-3). `.gitignore` now covers it, but an ignore
# rule is only a default: `git add -f`, a renamed variant, or a key pasted
# straight into a source file all walk straight past it. This hook checks what is
# actually staged.
#
# Install with:  ./bin/install-hooks.sh
#
# Deliberately conservative — it only matches shapes that are unambiguously
# credentials, because a hook that cries wolf gets bypassed with --no-verify and
# then protects nothing.

set -eu

staged=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$staged" ] && exit 0

fail=0
note() { printf '  %s\n' "$1" >&2; }

# ── 1. Files that should never be committed at all ──────────────────────────
for f in $staged; do
  case "$f" in
    .env|.env.local|.env.*.local|.env.production|.env.staging|.env.pilot)
      note "BLOCKED  $f  — environment file with real values"
      fail=1 ;;
    *.p8|*.p12|*.pem|*.key|*.keystore|*.jks)
      note "BLOCKED  $f  — private key material"
      fail=1 ;;
    service-account*.json|gha-creds-*.json)
      note "BLOCKED  $f  — cloud service-account credentials"
      fail=1 ;;
  esac
done

# ── 2. Credential shapes inside staged content ──────────────────────────────
# Vendor-prefixed tokens are matched with their real length so a placeholder
# like `your-google-client-secret` does not trip the hook.
patterns='
GOCSPX-[A-Za-z0-9_-]{20,}
AKIA[0-9A-Z]{16}
ghp_[A-Za-z0-9]{36}
github_pat_[A-Za-z0-9_]{50,}
sk-[A-Za-z0-9]{32,}
xox[baprs]-[A-Za-z0-9-]{10,}
-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----
'

for f in $staged; do
  # The hook and its installer necessarily contain these patterns — the scanner
  # to match on, the installer to document how to test it. Listed explicitly by
  # name rather than by a `bin/*` glob, so a real key committed under bin/ is
  # still caught.
  case "$f" in
    bin/pre-commit-secret-scan.sh|bin/install-hooks.sh) continue ;;
  esac
  git show ":$f" 2>/dev/null | grep -Iq . 2>/dev/null || continue

  echo "$patterns" | while IFS= read -r p; do
    [ -z "$p" ] && continue
    # `--` terminates option parsing: the PRIVATE KEY pattern begins with a
    # dash, which grep would otherwise read as a flag — silently disabling that
    # pattern, which is exactly the one guarding Apple's .p8 and any PEM key.
    if git show ":$f" 2>/dev/null | grep -nEq -- "$p"; then
      note "BLOCKED  $f  — content matches a credential pattern: $p"
      echo 1 > "${TMPDIR:-/tmp}/.wev-secret-hit"
    fi
  done
done

if [ -f "${TMPDIR:-/tmp}/.wev-secret-hit" ]; then
  rm -f "${TMPDIR:-/tmp}/.wev-secret-hit"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'EOF'

Commit refused: staged changes appear to contain a secret.

  • If it is a real credential: unstage it (git restore --staged <file>),
    keep it in .env, and reference it through process.env.
  • If this is a false positive, rerun with --no-verify and say so in the
    commit message so the next reader knows it was a deliberate call.

EOF
  exit 1
fi

exit 0
