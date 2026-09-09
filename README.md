# Vane Search

Semantic search for Obsidian vaults. It indexes your notes into a vector index
that runs in-process via WebAssembly (VaneDB) and finds notes by meaning, not
just keywords. No server, no daemon.

## Installing

- **Community store** (once listed): Settings → Community plugins → Browse →
  search "Vane Search" → Install → Enable.
- **BRAT** (before it's listed, or to track a beta): install the
  [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then "Add beta
  plugin" with `vanedb/obsidian-vane-search`. BRAT keeps it updated from releases.
- **Manual**: download `main.js`, `manifest.json`, and `LICENSE` from a
  [release](https://github.com/vanedb/obsidian-vane-search/releases) into
  `<vault>/.obsidian/plugins/vane-search/`, then enable it under Community plugins.

After enabling, set an embedding provider (below) before your first index.

## Releasing (maintainers)

Releases are cut by pushing a git tag that exactly matches `manifest.json`'s
`version` (no leading `v`). Bump the version in `manifest.json`, `versions.json`,
and `package.json`, commit, then:

```bash
git tag 1.2.3 && git push --follow-tags
```

The [`release` workflow](.github/workflows/release.yml) builds and publishes a
GitHub Release with `main.js`, `manifest.json`, and `LICENSE` attached as
individual assets — the layout Obsidian's installer and BRAT expect.

## Choosing an embedding provider

Search quality comes from an embedding model. Vane Search talks to any
OpenAI-compatible `/v1/embeddings` endpoint, so you can use a cloud service or a
local model. Set this under **Settings → Vane Search**.

- **OpenAI (default).** Model `text-embedding-3-small` (1536 dimensions). Paste
  an API key from platform.openai.com into the settings. The key is stored in
  Obsidian's `SecretStorage` (the OS keychain), never in `data.json`, and never
  synced. The first time you index against a network provider, Vane Search shows
  a one-time notice: **your note text is sent to that service to compute
  embeddings, so it leaves your device.** Only proceed if you trust the service
  with your notes. Indexing has a small per-token cost.
- **Local Ollama (private, free, desktop).** Install [Ollama](https://ollama.com),
  run `ollama pull nomic-embed-text`, and switch the provider preset to Ollama
  (`http://localhost:11434/v1`, 768 dimensions). Nothing leaves your machine and
  no key is needed. Because it listens on `localhost`, this works on the machine
  running Ollama only.
- **Custom.** Any other OpenAI-compatible host (Mistral, Voyage, a self-hosted
  gateway): set the base URL, model, and dimension yourself. Use **Test
  connection** to confirm the endpoint and auto-fill the dimension.

Switching provider, model, or dimension re-embeds the vault into a fresh index;
your previous vectors are kept until the new index is ready, so a switch never
loses your working index and a switch back is free.

## Mobile and multiple devices

The search index is **per-device**: it lives in each device's local storage and
is not carried by Obsidian Sync. Each device builds its own index by embedding
the vault through whichever provider it can reach.

- On a phone, use a **cloud provider** (the OpenAI default). A phone cannot reach
  a desktop's `localhost` Ollama.
- To sync the plugin itself to mobile, use **Obsidian Sync** with **Installed
  community plugins** turned on (Settings → Sync). Then enable Vane Search on the
  phone and paste your API key there once (keys don't sync).
- Advanced: you can point a phone at a desktop's Ollama over your LAN or a
  private VPN (Tailscale) by launching Ollama with `OLLAMA_HOST=0.0.0.0` and
  setting the base URL to the desktop's address. Only do this on trusted
  networks.

Vane Search never writes to your notes and sends nothing anywhere except the
embedding endpoint you configure. There is no telemetry.

## Development

```bash
npm install
npm test              # vitest (unit + integration against real wasm)
npm run build         # produces main.js
./scripts/install-dev.sh /path/to/dev-vault
```

`vendor/vanedb-wasm/` is a committed build of [vanedb](https://github.com/vanedb/vanedb)
(see `vendor/vanedb-wasm/PROVENANCE`). Refresh it with `npm run sync-vanedb`,
which vendors the [`@vanedb/wasm`](https://www.npmjs.com/package/@vanedb/wasm)
npm package (web target) — no Rust toolchain needed. Bump `VANEDB_WASM_VERSION`
to update. The raw `.wasm` is inlined into `main.js` at build time, so the
plugin runs offline with no runtime fetch.
