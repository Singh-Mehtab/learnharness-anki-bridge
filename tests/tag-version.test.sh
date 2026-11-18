#!/usr/bin/env bash
set -euo pipefail
script=$(cd "$(dirname "$0")/.." && pwd)/scripts/tag-version.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git init --bare -q "$tmp/remote.git"
git init -q "$tmp/repo"
cd "$tmp/repo"
git config user.name Test
git config user.email test@example.invalid
git remote add origin "$tmp/remote.git"
commit_version() {
  printf '{"version":"%s"}\n' "$1" > package.json
  git add package.json
  git commit -qm "$2"
}
commit_version 0.1.0 initial
echo first > other
git add other && git commit -qm unchanged
bash "$script"
[[ -z $(git ls-remote --tags origin) ]]
commit_version 0.2.0 bump
bash "$script"
[[ $(git cat-file -t v0.2.0) == tag ]]
[[ $(git ls-remote --tags origin 'refs/tags/v0.2.0^{}' | cut -f1) == $(git rev-parse HEAD) ]]
bash "$script" # retry is idempotent
echo second > other
git add other && git commit -qm 'unchanged after tag'
bash "$script" # an existing tag for an unchanged version is fine
commit_version 0.3.0 bump
# A conflicting remote tag must never be overwritten.
git tag -a v0.3.0 HEAD^ -m conflict
git push -q origin refs/tags/v0.3.0
if bash "$script"; then echo 'Expected conflicting tag failure' >&2; exit 1; fi
[[ $(git ls-remote --tags origin 'refs/tags/v0.3.0^{}' | cut -f1) == $(git rev-parse HEAD^) ]]
git checkout -qb version-branch
commit_version 0.4.0 'feature version bump'
git checkout -q -
git merge -q --no-ff version-branch -m 'merge version bump'
bash "$script"
[[ $(git ls-remote --tags origin 'refs/tags/v0.4.0^{}' | cut -f1) == $(git rev-parse HEAD) ]]
commit_version invalid invalid
if bash "$script"; then echo 'Expected invalid version failure' >&2; exit 1; fi
echo 'Version tag tests passed.'
