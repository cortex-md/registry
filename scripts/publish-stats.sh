#!/usr/bin/env bash
set -euo pipefail

message="${1:?commit message required}"
source_file="$(pwd)/stats.json"
worktree="$(mktemp -d)"

git config --global user.name "github-actions[bot]"
git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"

prepare_worktree() {
	rm -rf "$worktree"
	git worktree prune
	if git ls-remote --exit-code --heads origin data >/dev/null 2>&1; then
		git fetch --quiet origin data
		git worktree add --quiet -B data "$worktree" origin/data
	else
		git worktree add --quiet --detach "$worktree"
		git -C "$worktree" checkout --quiet --orphan data
		git -C "$worktree" rm -rfq .
	fi
}

for attempt in 1 2 3; do
	prepare_worktree
	cp "$source_file" "$worktree/stats.json"
	git -C "$worktree" add stats.json
	if git -C "$worktree" diff --cached --quiet; then
		echo "stats.json unchanged"
		exit 0
	fi
	git -C "$worktree" commit --quiet -m "$message"
	if git -C "$worktree" push --quiet origin data; then
		echo "published stats.json to the data branch"
		exit 0
	fi
	echo "push rejected, retrying ($attempt)"
done

exit 1
