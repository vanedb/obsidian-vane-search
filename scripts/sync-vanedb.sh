#!/usr/bin/env bash
# scripts/sync-vanedb.sh — vendor the vanedb wasm from the published npm package.
#
# Source of truth is the npm package @vanedb/wasm (web target). We vendor its
# files into vendor/vanedb-wasm/ so esbuild can inline the raw .wasm into the
# single main.js (the package's own exports map doesn't expose the raw .wasm for
# a bundler to import, and its default loader fetches at runtime — neither works
# for the plugin's inline, no-runtime-fetch, Blob-URL-worker architecture).
#
# No Rust toolchain required. Pin the version explicitly.
set -euo pipefail

PKG_VERSION="${VANEDB_WASM_VERSION:-0.1.0}"
DEST="vendor/vanedb-wasm"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "fetching @vanedb/wasm@$PKG_VERSION from npm..."
(cd "$WORK" && npm pack "@vanedb/wasm@$PKG_VERSION" >/dev/null 2>&1)
tar -xzf "$WORK"/*.tgz -C "$WORK"

# The web/ target is wasm-pack --target web: initSync + the ApproxIndex/
# FlatIndex/SearchResults classes + the raw _bg.wasm the plugin inlines.
mkdir -p "$DEST"
rm -f "$DEST"/*
cp "$WORK/package/web/vanedb_wasm.js"            "$DEST/"
cp "$WORK/package/web/vanedb_wasm.d.ts"          "$DEST/"
cp "$WORK/package/web/vanedb_wasm_bg.wasm"       "$DEST/"
cp "$WORK/package/web/vanedb_wasm_bg.wasm.d.ts"  "$DEST/"
cp "$WORK/package/LICENSE"                        "$DEST/" 2>/dev/null || true
cp "$WORK/package/README.md"                      "$DEST/" 2>/dev/null || true

cat > "$DEST/PROVENANCE" <<EOF
source:  npm @vanedb/wasm@$PKG_VERSION (web target)
built:   npm pack ($(date -u +%Y-%m-%dT%H:%M:%SZ))
note:    regenerate with scripts/sync-vanedb.sh — do not edit by hand.
         The plugin inlines vanedb_wasm_bg.wasm into main.js (esbuild binary
         loader), so it runs offline with no runtime fetch. No Rust toolchain
         needed; bump VANEDB_WASM_VERSION (or the default above) to update.
EOF
echo "vendored @vanedb/wasm@$PKG_VERSION"
