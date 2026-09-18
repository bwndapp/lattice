#!/bin/sh
# Mirror lattice — and only lattice — to GitHub.
#
# The repository this runs in is a whole incubator box: the app, but also the box's agent
# config, its MCP server, its boot scripts and its identity docs. GitHub is cold storage
# for the app, so the mirror is the same history with the box's own files filtered out of
# every commit.
#
# It keeps its work in .mirror/ (ignored) rather than touching this checkout, and the
# filter is deterministic, so each run produces the same commits and only the new ones are
# sent.
#
#     sh tools/mirror-to-github.sh
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
MIRROR="$ROOT/.mirror"
REMOTE=${GITHUB_REMOTE:-https://github.com/bwndapp/lattice.git}
# Not lattice, in any commit it ever appeared in:
#   the box's own files (its agent, MCP server, boot scripts, identity docs, instructions),
#   a branch's checkout that was tracked here by mistake, built bundles, and a one-off
#   script for moving a track between databases.
DROP="agent.ts mcp setup.sh requirements.txt .identity CLAUDE.md .claude multiplayer move-track-live.py"

if [ ! -d "$MIRROR/.git" ]; then
  echo "mirror: first run — cloning into .mirror/"
  git clone --no-hardlinks --quiet "file://$ROOT" "$MIRROR"
fi

cd "$MIRROR"
git remote remove github 2>/dev/null || true
git remote add github "$REMOTE"
# the token lives in the box's environment; the helper is the same one the main checkout uses
git config credential."https://github.com".helper '!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f'

git fetch --quiet --force --tags origin 'refs/heads/master:refs/heads/origin-master'
git checkout --quiet -B master origin-master

echo "mirror: filtering $(git rev-list --count master) commits"
rm -rf .git-rewrite
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --prune-empty \
  --index-filter "git rm -r --cached --ignore-unmatch $DROP >/dev/null" \
  --tag-name-filter cat -- master --tags >/dev/null

echo "mirror: what a fresh clone of the mirror would hold —"
git ls-tree --name-only master | sed 's/^/  /'

git push --force --quiet github master
git push --force --quiet github --tags
echo "mirror: pushed to $REMOTE"
