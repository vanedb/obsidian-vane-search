# Vane Search — Obsidian Semantic Search Plugin (Design)

**Date:** 2026-07-29
**Status:** Approved design, pre-implementation
**Repos touched:** this repo (new plugin), `~/code/vanedb` (WASM binding extensions)

## Purpose

An Obsidian plugin that semantically indexes the vault and answers natural-language
queries, powered by VaneDB's WASM HNSW index running in-process. Two UI surfaces:
a search modal and a related-notes sidebar. Works on desktop **and mobile** from v1.

## Decisions (agreed in brainstorming)

| Topic | Decision |
|---|---|
| Vector store | `vanedb-wasm` `WasmHnswIndex`, in-process (no server) |
| Embeddings | Pluggable `EmbeddingProvider` interface |
| v1 providers | Local transformers.js (default), OpenAI-compatible API, Ollama |
| UI | Search modal + related-notes sidebar |
| Scale target | Design for growth → HNSW from day one |
| vanedb changes | In scope: extend `vanedb-wasm` binding |
| Mobile | Supported from v1 (`isDesktopOnly: false`) |
| Threading | Embeddings in a Web Worker; VaneDB + everything else on main thread |

## Prerequisite: vanedb-wasm extensions

Work in `~/code/vanedb/vanedb-wasm`, exposing existing core capability plus small additions:

1. `WasmHnswIndex.serialize(): Uint8Array` and static `deserialize(bytes): WasmHnswIndex`
   — wire `vanedb/src/hnsw/persistence.rs` through wasm-bindgen.
2. `WasmHnswIndex.remove(id: bigint)` — **soft delete** (tombstone inside the index,
   filtered from search results). True HNSW deletion is out of scope; compaction is
   the plugin's job via rebuild-from-live-vectors.
3. `WasmHnswIndex.get(id: bigint): Float32Array` — accessor for stored vectors
   (powers related-notes and compaction without re-embedding).
4. `tombstone_count(): number` — lets the plugin decide when to compact.

Fallback: if soft-delete inside vanedb proves awkward, the plugin keeps a
plugin-side tombstone set and filters results; interfaces are designed so this
swap is invisible to callers.

## Architecture

Single plugin process (Obsidian's renderer), one Web Worker for local embedding
inference. Split is **by cost**: transformers.js inference (10–100ms+/chunk) is the
only thing that leaves the UI thread. HNSW insert (~1ms) and search (sub-ms) stay
synchronous on the main thread, which also keeps persistence talking directly to
Obsidian's vault adapter (workers cannot touch Obsidian APIs).

### Components

| Component | Thread | Purpose |
|---|---|---|
| `VaneSearchPlugin` (`main.ts`) | main | Lifecycle, settings, commands, wiring |
| `Chunker` | main | Markdown → heading-based chunks; long sections split by paragraph to a ~1000-char target (≈256 tokens; chars are the unit — no tokenizer on the main thread); each chunk content-hashed; frontmatter skipped |
| `Indexer` | main | Vault event watcher (debounced ~2s/file), hash diffing, embed queue with retry/backoff, progress reporting |
| `EmbeddingProvider` (interface) | main | `embed(texts: string[]): Promise<Float32Array[]>`, `dimension()`, `id`, `maxBatch` |
| `LocalTransformersProvider` | main (proxy) | Speaks the worker protocol; model default `Xenova/all-MiniLM-L6-v2` (quantized) |
| `OpenAICompatProvider` | main | `requestUrl` POST `{base}/v1/embeddings`; covers OpenAI/Azure/OpenRouter/LM Studio |
| `OllamaProvider` | main | `requestUrl` POST `{base}/api/embed`; default base `http://localhost:11434` |
| Embedding worker | worker | transformers.js pipeline; messages `init` / `embed` / `dispose`; bundled inline as Blob URL |
| `VaneIndex` | main | Wraps `WasmHnswIndex`; chunkKey ↔ u64 id map (monotonic counter); persistence; compaction |
| `SearchService` | main | Query path shared by both UI surfaces |
| `SearchModal` | main | `SuggestModal`: debounced (~300ms) query embed → results with snippet/heading; Enter opens note at heading |
| `RelatedNotesView` | main | Right-sidebar `ItemView`; refreshes on active-note change |
| Status bar + `SettingsTab` | main | Progress, stats, configuration |

The Indexer depends only on the `EmbeddingProvider` interface — where vectors come
from (worker vs network) is invisible to it. Switching providers is a settings
change, not a code-path change.

### Bundling constraints (Obsidian requires a single `main.js`)

- Worker code inlined by esbuild and instantiated from a Blob URL.
- `vanedb_wasm_bg.wasm` embedded as base64, loaded with `initSync`.
- transformers.js downloads its model from the HF hub on first use and caches it
  via the browser Cache API — offline afterwards, identical behavior on mobile.

## Data flow

### Incremental indexing (steady state)

1. Vault event (`create`/`modify`/`rename`/`delete`) → per-file debounce ~2s
2. Read file → chunk → diff content-hashes against chunk store
3. Changed chunks → provider in batches (halved on `Platform.isMobile`)
4. Insert new vectors under fresh ids; `remove()` superseded ids
5. Index dirty → persist after ~30s quiet, and on plugin unload

### Persistence (plugin data dir, via vault adapter — mobile-safe)

| File | Contents |
|---|---|
| `index.bin` | Serialized HNSW (graph + vectors) |
| `chunks.json` | Per chunk: id, note path, heading breadcrumb, char offsets, content hash |
| `meta.json` | Schema version, provider id, model, dimension, tombstone count |

### Startup

1. Load `meta.json`; verify schema + provider/model/dimension against settings.
2. Match → `deserialize(index.bin)`, load `chunks.json`, then **reconcile**: diff
   stored hashes vs files changed while Obsidian was closed; queue only the drift.
3. Mismatch/corruption → modal: rebuild now, or keep old index read-only.
4. Compaction: when tombstones > ~20% of live vectors, next persist rebuilds the
   index from live vectors via `get(id)` — no re-embedding.

### Search

- **Modal:** query → embed → `search(k×3)` oversample → drop excluded-folder
  chunks (tombstones are filtered inside vanedb; the plugin filters them only in
  the fallback design) → group by note (note score = max chunk score) → top 20.
- **Related notes:** active note's chunk vectors via `get(id)` → centroid →
  search → exclude self → top 10. Falls back to embedding the note text if it
  isn't indexed yet. Zero embedding cost in the common case.

## Settings

- **Provider:** dropdown + per-provider fields (local: model id; OpenAI-compat:
  base URL/key/model; Ollama: base URL/model). Changing provider or model warns
  "requires full re-index" before applying.
- **Indexing:** excluded folders, chunk target size (default ~1000 chars),
  auto-index toggle.
- **Index panel:** stats (notes/chunks/tombstones/disk size), Rebuild button.

## Error handling

- **Provider failure** (bad key, Ollama down, model download interrupted):
  indexing pauses; one actionable Notice + persistent status-bar warning (no
  notice spam); queue retries with exponential backoff and survives restarts.
- **Mismatch at startup:** modal — rebuild now / keep read-only.
- **Corrupt persistence files:** caught on load → offer rebuild; plugin load
  never crashes.
- **Mobile memory:** model lazy-loads only when the local provider is selected;
  worker disposed after 5 min idle; batches halved.
- **Empty/absent index at query time:** modal shows "index building — n/total".
- Plugin writes only inside its own data dir; vault notes are read-only to it.

## Testing

- **vanedb-wasm (Rust, wasm-bindgen-test):** serialize→deserialize round-trip
  yields identical search results; soft-deleted ids never returned; `get()`
  round-trips; persistence-format version check.
- **Plugin unit (vitest):** chunker (heading splits, hash stability, empty note,
  giant paragraph, frontmatter); id mapping; note grouping/scoring; each
  provider's request/response shaping against mocked `requestUrl`.
- **Integration (vitest + real WASM in Node):** index fixture corpus → known-
  similar docs in top-3; delete → absent; persist → reload → identical results.
- **Manual:** dev vault with hot-reload; one real-device mobile pass before v1.

## Out of scope for v1

- Hybrid keyword+vector ranking, cross-vault search, embedding-model fine-tuning,
  mobile-specific UI beyond responsive defaults, exposing VaneDB to other plugins.
