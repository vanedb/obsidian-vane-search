# Vane Search

Semantic search for Obsidian. Notes are embedded by a provider you choose and
indexed in-process by VaneDB's WebAssembly HNSW index — no server, no daemon.

Commands:

- **Search vault semantically**
- **Find notes similar to selection**
- **Open related notes panel**
- **Index new and changed notes** / **Rebuild index from scratch**

Edits, renames and deletions are indexed automatically.

## Install

Requires Obsidian 1.11.4+. Not in the community plugin directory.

**BRAT:** install [BRAT](https://github.com/TfTHacker/obsidian42-brat), run
**BRAT: Add a beta plugin** with `vanedb/obsidian-vane-search`, then enable
Vane Search.

**Manual:** download `main.js`, `manifest.json` and `LICENSE` from the
[0.2.0 release](https://github.com/vanedb/obsidian-vane-search/releases/tag/0.2.0)
into `<vault>/.obsidian/plugins/vane-search/`, reload Obsidian, and enable
Vane Search.

## Providers

Any OpenAI-compatible `/v1/embeddings` endpoint works. Choose one under
**Settings → Vane Search** and click **Test connection** before indexing.

| Preset | Model | Notes |
| --- | --- | --- |
| OpenAI (default) | `text-embedding-3-small`, 1536 dims | Needs an API key. Note text leaves your device; you are asked once per host. |
| Ollama | `nomic-embed-text`, 768 dims | Local and free. Run `ollama pull nomic-embed-text`. |
| Ollama multilingual | `bge-m3`, 1024 dims | Local and free. |
| Custom | any | Set base URL, model and dimension. |

API keys are stored in Obsidian's SecretStorage, never in `data.json`.
Changing provider builds a new index; search keeps using the old one until the
new one is ready.

The plugin never writes to your notes and has no telemetry.

## Mobile

The index is per device and is not synced. On a phone, use a cloud provider —
it cannot reach a desktop's `localhost` Ollama — and enter the API key on the
phone (keys don't sync).

## Try it

1. Copy the six [fixture notes](docs/releases/fixtures/0.2.0/) into an empty
   vault.
2. Select the Ollama preset, then run **Index new and changed notes**.
3. Search **How should I care for young vegetables?** — Weekend garden should
   rank first.

See the [0.2.0 acceptance record](docs/releases/0.2.0.md) for the full
walkthrough.

## Development

```bash
npm ci
npm run typecheck
npm test                 # unit + integration against the real wasm
npm run build            # main.js, wasm inlined
./scripts/install-dev.sh /path/to/vault
```

The engine is the exact-pinned `@vanedb/wasm` dev dependency, inlined into
`main.js` at build time.

## Releasing

1. Bump `manifest.json`, `versions.json` and `package.json`, then run
   `npm install --package-lock-only --ignore-scripts`.
2. `npm run check:release`, then merge once CI passes.
3. Run the desktop walkthrough on the merged build and record it in
   `docs/releases/`.
4. Tag the merged commit (no leading `v`) and push the tag:

   ```bash
   git tag -a 0.2.0 -m "Vane Search 0.2.0" <commit>
   git push origin refs/tags/0.2.0
   ```

The [release workflow](.github/workflows/release.yml) publishes `main.js`,
`manifest.json` and `LICENSE` as release assets.
