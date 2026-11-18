#!/usr/bin/env bash
set -euo pipefail

# Compare the first parent so a merge tags the commit that lands on main.
version_at() {
  git show "$1:package.json" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const version = JSON.parse(input).version;
      if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error("package.json version must be a stable x.y.z version");
      }
      process.stdout.write(version);
    });'
}

current=$(version_at HEAD)
previous=$(version_at HEAD^1)
if [[ "$current" == "$previous" ]]; then
  echo "Version unchanged ($current); no tag needed."
  exit 0
fi

tag="v$current"
commit=$(git rev-parse HEAD)
# Check the remote, rather than trusting a possibly stale local tag.
remote=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")
if [[ -n "$remote" ]]; then
  object=$(printf '%s\n' "$remote" | awk -v ref="refs/tags/$tag" '$2 == ref {print $1}')
  peeled=$(printf '%s\n' "$remote" | awk -v ref="refs/tags/$tag^{}" '$2 == ref {print $1}')
  if [[ -n "$object" && "$peeled" == "$commit" ]]; then
    echo "$tag already points to $commit."
    exit 0
  fi
  echo "Refusing to overwrite existing remote tag $tag." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Refusing to overwrite existing local tag $tag." >&2
  exit 1
fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git tag -a "$tag" "$commit" -m "Anki Bridge $current"
git push origin "refs/tags/$tag"
