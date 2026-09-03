#!/bin/bash
set -e

echo "=== 1. Fetching latest upstream (official gajae-code) ==="
git fetch upstream dev

echo "=== 2. Updating upstream-dev mirror branch ==="
git branch -f upstream-dev upstream/dev
git push origin upstream-dev:upstream-dev 2>/dev/null || true

echo "=== 3. Rebasing twoimo/custom onto latest upstream-dev ==="
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "twoimo/custom" ]; then
  git checkout twoimo/custom
fi

git rebase upstream-dev

echo ""
echo "=== Sync Complete! Push updated custom branch with: ==="
echo "git push origin twoimo/custom --force-with-lease"
