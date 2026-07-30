#!/bin/sh
#
# Installs the repository's git hooks.
#
# Hooks live in bin/ and are symlinked into .git/hooks, so they are version
# controlled and reviewable — .git/hooks itself is not committed, which is why a
# hook alone cannot be relied on across a team without this step.
#
# Run once per clone:  ./bin/install-hooks.sh

set -eu

root=$(git rev-parse --show-toplevel)
hooks="$root/.git/hooks"
mkdir -p "$hooks"

ln -sf "../../bin/pre-commit-secret-scan.sh" "$hooks/pre-commit"
chmod +x "$root/bin/pre-commit-secret-scan.sh"

echo "Installed: pre-commit -> bin/pre-commit-secret-scan.sh"
echo
echo "Verify with:"
echo "  printf 'GOOGLE_CLIENT_SECRET=GOCSPX-aaaaaaaaaaaaaaaaaaaaaaaa\\n' > /tmp/leak.env"
echo "  cp /tmp/leak.env ./leak-test.env && git add -f leak-test.env && git commit -m test"
echo "  # expect: 'Commit refused'   then: git restore --staged leak-test.env && rm leak-test.env"
