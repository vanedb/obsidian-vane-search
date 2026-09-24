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

## Try it on a real vault

Use Obsidian 1.11.4 or later on desktop, with a separate test vault or a copy
of your notes. On September 23, 2026, this walkthrough passed in the real
Obsidian desktop app using six synthetic notes and local Ollama. The query
**How should I care for young vegetables?** returned **Weekend garden** first
(displayed score 68%), and selecting it opened the intended note. The same
results survived quitting and relaunching Obsidian; edits and deletion were
also reflected in search. See the [acceptance record](docs/releases/0.2.0-desktop-acceptance.md)
for the exact build, model, full results, and limits. Official publication is
still tracked separately in [the 0.2.0 checklist](docs/releases/0.2.0.md).

1. Install Vane Search using BRAT or the manual instructions above. For a
   source build, run `npm ci && npm run build`, then
   `./scripts/install-dev.sh /path/to/test-vault` and enable the plugin.
2. Start Ollama on the same machine, then run `ollama pull nomic-embed-text`.
3. Under **Settings → Vane Search**, choose **Ollama · nomic-embed-text
   (English)** (`http://localhost:11434/v1`, 768 dimensions). Click **Test
   connection** and confirm it succeeds before indexing.
4. Copy the six [synthetic fixture notes](docs/releases/fixtures/0.2.0/) into
   the test vault. `Weekend garden.md` describes caring for tomato seedlings;
   the other notes cover unrelated subjects.
5. Open the command palette and run **Vane Search: Index new and changed
   notes**. Wait for indexing to finish, then run **Vane Search: Search vault
   semantically** and enter **How should I care for young vegetables?**
6. Select `Weekend garden.md` to verify the correct note opens. In the recorded
   six-note run it ranked first, followed by Cycling maintenance and Piano
   practice. Ranking and displayed scores can change with the model or vault
   contents; the observed result is not a guarantee for other vaults.

With the local Ollama preset, note text is sent only to the service on your
machine. A connection failure usually means Ollama is stopped, the model has
not been pulled, or the endpoint is wrong. The default provider is OpenAI, so
select Ollama before indexing if you want this local walkthrough.

## Releasing (maintainers)

Releases are cut by pushing a git tag that exactly matches `manifest.json`'s
`version` (no leading `v`). Update `manifest.json`, `versions.json`, and
`package.json`; run `npm install --package-lock-only --ignore-scripts` to update
both root versions in `package-lock.json`. Validate the release:

```bash
npm ci
npm run check:release
npm run typecheck
npm test
npm run build
node scripts/check-size.mjs
```

Merge the release PR only after CI and independent review pass. Complete the
[manual walkthrough checklist](docs/releases/0.2.0.md), then create an annotated
tag on that merged commit and push that tag explicitly (replace `1.2.3` with
the manifest version):

```bash
git tag -a 1.2.3 -m "Vane Search 1.2.3" <reviewed-merged-commit>
git push origin refs/tags/1.2.3
```

Pushing this tag publishes a release. A local build or staging artifact is
not the official demo release.

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
npm ci
npm run check:release
npm run typecheck
npm test              # vitest (unit + integration against real wasm)
npm run build         # produces main.js
./scripts/install-dev.sh /path/to/dev-vault
```

The [vanedb](https://github.com/vanedb/vanedb) WASM comes from the
[`@vanedb/wasm`](https://www.npmjs.com/package/@vanedb/wasm) npm package, an
exact-pinned `devDependency` (build-time only — no Rust toolchain needed).
esbuild imports its raw `.wasm` export directly and inlines the bytes into
`main.js` at build time, so the plugin runs offline with no runtime fetch. To
update, bump the pinned version in `package.json` and regenerate the lockfile.

Demo **0.2.0** currently embeds published **`@vanedb/wasm` 0.1.1**. The demo
and engine version numbers are independent; this does not claim engine 0.2.0
integration. A future engine update requires a published package, a regenerated
lockfile, and the same tests/build/walkthrough checks before release.
