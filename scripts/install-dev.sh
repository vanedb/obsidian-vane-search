#!/usr/bin/env bash
# scripts/install-dev.sh <vault-path> — copy the built plugin into a dev vault
set -euo pipefail
VAULT="${1:?usage: install-dev.sh /path/to/vault}"
DEST="$VAULT/.obsidian/plugins/vane-search"
mkdir -p "$DEST"
cp main.js manifest.json "$DEST/"
touch "$DEST/.hotreload"
echo "installed to $DEST"
