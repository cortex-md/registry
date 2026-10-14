#!/usr/bin/env bash
set -euo pipefail

if git ls-remote --exit-code --heads origin data >/dev/null 2>&1; then
	git fetch --quiet origin data
	git show origin/data:stats.json > stats.json
	echo "restored stats.json from the data branch"
else
	echo "no data branch yet; starting from empty stats"
fi
