#!/usr/bin/env sh
# Install the hello-aflt docs-only seed into the current directory (must be empty
# or contain only files you intend to overwrite). Usage:
#   mkdir ~/my-dungeon && cd ~/my-dungeon
#   /path/to/aflt/examples/loops/hello-aflt/install.sh
# Then: git init && git add -A && git commit -m "Seed hello-aflt"
#       aflt loop validate .agentfleet/loop.json
#       aflt loop run .agentfleet/loop.json
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
SEED="$ROOT/seed"
if [ ! -d "$SEED/.agentfleet" ]; then
  echo "install: missing $SEED/.agentfleet" >&2
  exit 1
fi
cp -R "$SEED/." .
echo "install: copied hello-aflt seed into $(pwd)"
echo "next: git init && git add -A && git commit -m 'Seed hello-aflt'"
echo "      aflt loop validate .agentfleet/loop.json"
echo "      aflt loop run .agentfleet/loop.json"