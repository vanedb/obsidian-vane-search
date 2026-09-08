# Vane Search

Semantic search for Obsidian vaults, powered by local embeddings and WebAssembly.

## Development

```bash
npm install
npm test              # vitest (unit + integration against real wasm)
npm run build         # produces main.js
./scripts/install-dev.sh /path/to/dev-vault
```

`vendor/vanedb-wasm/` is a committed build of [vanedb](https://github.com/vanedb/vanedb)
(see `vendor/vanedb-wasm/PROVENANCE`). Refresh it with `npm run sync-vanedb`
(needs the rustup toolchain + wasm-pack; CI never does).
