#!/usr/bin/env bash
set -euo pipefail

# Create a dated devlog template; optional argument overrides today's date.
DATE="${1:-$(date +%F)}"
FILE="devlog/${DATE}.md"

if [[ -e "$FILE" ]]; then
  echo "Devlog already exists: $FILE"
  exit 1
fi

cat <<EOF2 > "$FILE"
# Devlog - $DATE

## What I did
- 

## Why
- 

## Problems / Fixes
- 

## Next
- 
EOF2

echo "Created $FILE"
