#!/usr/bin/env bash
# scripts/sync-vanedb.sh — rebuild vanedb-wasm from source and vendor the pkg.
# Requires the rustup toolchain: Homebrew rust shadows it and lacks the wasm32 target.
set -euo pipefail
VANEDB="${VANEDB_DIR:-$HOME/code/vanedb}"
export PATH="$HOME/.cargo/bin:$PATH"
(cd "$VANEDB/vanedb-wasm" && wasm-pack build --target web --release)
mkdir -p vendor/vanedb-wasm
rm -f vendor/vanedb-wasm/*
for f in vanedb_wasm.js vanedb_wasm.d.ts vanedb_wasm_bg.wasm vanedb_wasm_bg.wasm.d.ts package.json LICENSE README.md; do
  cp "$VANEDB/vanedb-wasm/pkg/$f" vendor/vanedb-wasm/
done
cat > vendor/vanedb-wasm/PROVENANCE <<EOF
source: https://github.com/vanedb/vanedb
commit: $(git -C "$VANEDB" rev-parse HEAD)
built:  wasm-pack build --target web --release ($(date -u +%Y-%m-%dT%H:%M:%SZ))
note:   regenerate with scripts/sync-vanedb.sh — do not edit by hand
EOF
echo "vendored $(git -C "$VANEDB" rev-parse --short HEAD)"
