#!/bin/bash
# Starts a project script with Node. launchd does not load nvm, so find node ourselves:
# the newest nvm install first, then Homebrew and system locations.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE=""
for candidate in $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V -r) /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  echo "$(date): node not found" >&2
  exit 1
fi
cd "$DIR" || exit 1
exec "$NODE" "$DIR/$1"
