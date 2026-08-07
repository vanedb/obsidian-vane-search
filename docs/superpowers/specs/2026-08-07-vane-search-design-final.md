# Vane Search — Obsidian Semantic Search Plugin (Final Design)

**Date:** 2026-08-07 · **Status:** Final spec for review, pre-implementation
**Repos:** this repo (new plugin), `~/code/vanedb` (core + WASM binding work)

## Purpose & positioning

An Obsidian plugin that semantically indexes the vault and answers natural-language queries, powered by VaneDB's WASM HNSW index running in-process — no server, no daemon. Surfaces: search modal, related-notes sidebar, find-similar-to-selection command.

**The wedge:** existing plugins do flat-scan retrieval and paywall large-vault performance. Vane Search is *fast at scale, free, private by default*. A reproducible benchmark vs Smart Connections on a 10k-note vault is a named v1 deliverable.

## Decisions

| Topic | Decision |
|---|---|
| Vector store | `vanedb-wasm` `WasmHnswIndex`, in-process |
| Embeddings | Pluggable `EmbeddingProvider` interface |
| v1 providers | OpenAI-compatible API (Ollama/LM Studio/OpenRouter as base-URL presets); local transformers.js **desktop-only** |
| Default provider | Local model on desktop; guided remote-provider setup on mobile |
| Mobile | v1 = remote providers only (`isDesktopOnly: false`); local-on-mobile is v1.1, spike-gated |
| Threading | VaneDB in an **index worker**; transformers.js in an **embed worker** (desktop, lazy); main thread = Obsidian I/O + UI only |
| Index storage | **IndexedDB** (origin-private → sync-proof, transactional); settings in `data.json`; API keys in Obsidian `SecretStorage` |
| Deletion | **Plugin-side tombstones** (no deletion changes in vanedb v1) |
| Metric | `dot` on L2-normalized vectors (≡ cosine, ~3× cheaper on the scalar wasm path) |

## Budgets

Reference vault: 2,000 notes / ~10,000 chunks. Enforced by tests where possible:

- Modal search p95 < 150 ms warm (query embed + search + render)
- Plugin load → searchable < 3 s (reference vault, warm index)
- Full cold index, remote provider, reference vault: < 10 min
- `main.js` < 3 MB (vanedb wasm is 82 KB base64; ORT wasm is NOT bundled)
- Scale envelope: tested to 100k chunks desktop, 30k mobile; beyond it the plugin warns and requires explicit opt-in rather than OOMing

## vanedb work (parallel track — never gates the plugin)

1. **Core:** refactor `hnsw/persistence.rs` into `to_bytes()/from_bytes()`; `save`/`load` become thin fs wrappers. Byte API exposed in all bindings (wasm, py, capi) in one release.
2. **Core:** capacity growth (`reserve()`/amortized doubling); expose `capacity()`.
3. **wasm:** fix `search()` return type — `{ids: BigUint64Array, distances: Float32Array}`.
4. **wasm:** bind core `get_vector` under that name (API completeness; plugin doesn't depend on it).
5. **Repo:** commit `.cargo/config.toml` with `getrandom_backend="wasm_js"` rustflag; CI builds the shipped `--target web` artifact; written format-stability policy + v1/v2 fixture files with CI load test. Later: publish to npm.
6. **NOT in v1:** remove/tombstones in HNSW, `tombstone_count()`, simd128 (feature request only).

Plugin consumes a **vendored** `pkg/` at `vendor/vanedb-wasm/` with a `PROVENANCE` file (vanedb git SHA + format VERSION) and sync script; plugin CI asserts the build needs no Rust toolchain.

## Architecture

- **Main thread:** Obsidian APIs only — vault events, file reads, chunking, UI, IndexedDB writes, network providers via `requestUrl`.
- **Index worker (always):** owns `WasmHnswIndex` + id map; bulk inserts, searches, graph (re)builds, serialize/deserialize. Search is async via postMessage (~1 ms, irrelevant behind the 300 ms debounce). Returns transferable bytes for persistence.
- **Embed worker (desktop, lazy):** transformers.js + ONNX runtime; created only when the local provider is active; disposed after 5 min idle.

### VaneIndex seam

- **`MemoryVaneIndex` (v1 initial):** rebuilds the HNSW graph in the index worker from plugin-owned vectors on load. Zero vanedb changes — Phases 1–3 ship on this.
- **`PersistentVaneIndex` (when byte API lands):** `from_bytes(graph blob)` warm start; falls back to rebuild on mismatch/corruption.

Graph rebuild is ONE background job (cancellable, progress-reported, in the index worker) with one trigger set: tombstone ratio > 20%, capacity pressure, corruption/format change, manual Rebuild. Never inline in a persist. Old graph serves searches until the new one swaps in.

### Components

| Component | Context | Purpose |
|---|---|---|
| `VaneSearchPlugin` | main | Lifecycle, settings, commands, wiring |
| `Chunker` | main | Markdown → heading-based chunks. **Embedded text = `{note title} > {heading breadcrumb}\n\n{chunk}`** + one title chunk per note (title + first paragraph). ~1000-char target with headroom under the model token limit; 64-bit content hash; frontmatter skipped |
| `Indexer` | main | Vault events (debounced ~2 s/file), file-level reconcile table, hash diffing, embed batching, exponential backoff |
| `EmbeddingProvider` | main | `embed(texts, kind: 'query'\|'doc')`, `dimension()`, `queryPrefix`/`docPrefix`, `maxBatch`. All vectors L2-normalized at this boundary; per-provider test asserts `‖v‖ ≈ 1` |
| `OpenAICompatProvider` | main | `requestUrl` POST `{base}/v1/embeddings`; presets: OpenAI, Ollama (`http://localhost:11434/v1`), LM Studio, OpenRouter |
| `LocalTransformersProvider` | main → embed worker | Desktop-only in v1; default model chosen by Phase-0 eval |
| `FakeEmbeddingProvider` | test | Deterministic vectors from content hash — keystone test artifact |
| `VaneIndex` (2 impls) | index worker | Ids are JS numbers internally (BigInt only at the wasm boundary); `nextId = max(id)+1` derived on load; ids reset to 0 on every rebuild |
| `SearchService` | main | Shared query path; per-model similarity floor |
| `SearchModal` | main | Request-token pattern (cached sync results + async update, stale responses discarded); dynamic `emptyStateText` ("index building — n/total") |
| `RelatedNotesView` | main | Centroid of the note's stored vectors; similarity floor with "No strongly related notes" empty state; daily-notes folder excluded from candidates by default (still searchable); unindexed note → embed its text |
| Status bar, `SettingsTab` | main | Progress; provider indicator "Local (private)" / "Cloud" |

## Persistence (IndexedDB)

**Split precious from derived:** embeddings are expensive and irreplaceable; the graph is rebuildable.

| Store | Contents | Notes |
|---|---|---|
| `vectors` | content-hash → Float32Array | Durable artifact. Hash-keyed: renames/moves/reverts cost zero embeddings; identical chunks dedupe |
| `chunks` | chunk id → {contentHash, path, breadcrumb, offsets} | Rows, not one blob — O(changed) writes |
| `files` | path → {mtime, size, contentHash, generation} | Startup reconcile = in-memory diff vs `vault.getMarkdownFiles()` stat cache, no file reads |
| `graph` | serialized HNSW bytes + generation | Disposable cache (PersistentVaneIndex only) |
| `meta` | versions, fingerprints, backoff state | |

IndexedDB transactions give atomic commits. `navigator.storage.persist()` + `estimate()` at startup; degrade gracefully. Nothing large in the vault directory → sync clients can't clobber or replicate the index; each device builds its own. `data.json` = non-secret settings only; API keys in `SecretStorage` (`minAppVersion` ≥ 1.11.4).

**Versioning, two axes:** *vector fingerprint* (provider + model revision + dimension + normalized flag) — mismatch ⇒ re-embed (warned, estimated, old index serves until done); *derived-artifact version* (chunker version, schema, hash algo, HNSW params, vanedb format VERSION + build SHA) — mismatch ⇒ cheap local rebuild from `vectors`, never a re-embed.

Backoff state (`consecutiveFailures`, `nextAttemptAt`, `lastError`) persists in `meta`; the work queue is derived at startup by reconcile, never persisted.

## Data flow

**Incremental indexing:** vault event → debounce → read + chunk → hash-diff vs `chunks` → changed chunks → provider batches (halved on mobile) → vectors to IDB (transactional) → insert in index worker → superseded ids to tombstone set. Tombstones filtered at the result boundary with iterative-widening over-fetch (not fixed k×3).

**Startup:** load `meta` → check both version axes → warm-start or background rebuild from `vectors` → reconcile via `files` table (path-set diff catches creates/deletes; mtime/size mismatch → rehash only those) → queue drift. Search available immediately with "index building" states. Low-priority idle audit re-hashes a few hundred files per tick to catch mtime lies (Dropbox/iCloud restore mtimes); index panel shows "last verified".

**Search (modal):** query → `embed(kind:'query')` (debounced 300 ms) → index worker search → tombstone/excluded filter → similarity floor → group by note (score = max chunk) → top 20 with snippet + heading; Enter opens the note at the matched heading. Cold-start of a disposed embed worker shows "waking up local model…".

**Related notes:** active-note change → centroid of the note's vectors from IDB → search → exclude self + daily-notes scope → floor → top 10, or honest empty state.

## Provider & privacy UX

- First activation of a network provider: one-time consent modal naming the destination host, stating note text leaves the device; acknowledgment persisted per provider. Persistent Local/Cloud indicator in settings header + status bar.
- Provider/model switch: warning includes estimated cost & time; old index serves until the new one completes; reverting is free.
- Excluded folders surfaced as a privacy control.
- README "Network use and your data" section, per-provider endpoints, explicit zero-telemetry statement. `THIRD_PARTY_NOTICES.md`; esbuild `--legal-comments=eof`.

## Local provider hardening (desktop v1; Phase-0 spike first)

- ORT wasm never fetched from a CDN at runtime: pinned version downloaded once via `requestUrl`, SHA-256 verified against hashes committed in the repo, stored via vault adapter; `wasmPaths` pointed at it.
- Model weights: pinned immutable HF revision, downloaded once via `requestUrl` with progress UI, SHA-256 verified, stored via `env.customCache` backed by the vault adapter.
- `env.customFetch` → `requestUrl`; `numThreads = 1`, `proxy = false`; esbuild alias stubs for Node-only imports; worker inlined as a Blob-URL string literal (parsed only when the local provider activates).
- First-run flow: consent → download with progress + sizes → index with ETA → searchable while building.

## Error handling

- Provider failure: pause, one actionable Notice + persistent status-bar warning, exponential backoff, queue re-derived on restart.
- Fingerprint mismatch: modal — rebuild now / keep old index read-only.
- Corrupt graph blob: silent fallback to rebuild-from-vectors (logged). Corrupt vectors store: offer full re-embed. Plugin load never crashes.
- Capacity pressure: compact/grow before `IndexFull`; headroom in the index panel.
- Scale envelope exceeded: warn + require opt-in, don't OOM.
- Vault notes are strictly read-only to the plugin.

## Search-quality bar

- Eval set: 20–40 query→expected-note pairs from a dogfood vault; precision@k / MRR; changes to model, chunker, or floor gate on it.
- Default local model chosen by running this eval across candidates in Phase 0.
- Per-model similarity floor calibrated empirically.
- Chunker tests assert breadcrumb/title context changes *ranking*, and embedded text fits the model's token budget.

## Testing

- **vanedb (Rust):** byte round-trip identity; capacity growth; cross-target round-trip (wasm32 bytes read on x86_64); v1/v2 format fixtures load in CI.
- **Plugin unit (vitest):** chunker (splits, hash stability, empty note, giant paragraph, frontmatter, truncation); id mapping; grouping/scoring/floor; provider request shaping + normalization — all against `FakeEmbeddingProvider` / mocked `requestUrl`.
- **Integration (vitest + real wasm via `initSync(readFileSync(...))`):** fixture corpus → known-similar in top-3; delete → absent; persist → reload → identical results.
- **Manual:** dev vault hot-reload; real-device mobile pass (remote provider) before release.

## Delivery phases

- **Phase 0 (1 week, timeboxed):** spikes — mobile platform probe (real device); transformers.js inside Obsidian desktop; wasm capacity/memory/rebuild measurements at 10k/50k/100k; `to_bytes` prototype; model eval; dev-loop logistics.
- **Phase 1:** walking skeleton — scaffold, `FakeEmbeddingProvider`, whole-file chunks, `MemoryVaneIndex` over today's binding (vendored), `SearchService`, `SearchModal`. Exit: type query → ranked results → Enter opens note; CI green with no Rust toolchain.
- **Phase 2:** real pipeline, still fake embeddings — `Chunker`, `Indexer`, reconcile, tombstones, grouping, excluded folders, status bar, Rebuild.
- **Phase 3:** `OpenAICompatProvider` + settings + consent + `SecretStorage` + full error story. **First viable v1 candidate.**
- **Phase 4:** persistence — IDB stores, versioning axes; vanedb byte API lands → `PersistentVaneIndex`, compaction/growth job.
- **Phase 5:** local provider (desktop) — embed worker, ORT/model delivery, first-run flow, benchmark vs Smart Connections.
- **Phase 6:** `RelatedNotesView`, find-similar-to-selection, index panel, mobile hardening pass, README/notices, release.

## Open questions (Phase 0 resolves)

1. Default local model — eval bge-small-en-v1.5 vs nomic-embed-text-v1.5 vs MiniLM-L6-v2 on the fixture corpus.
2. Memory ceilings (desktop and mobile separately) — measured, then recorded in Budgets before Phase 1.
3. ORT wasm delivery — validate the download-once-and-pin path inside Obsidian desktop.
4. Local-on-mobile go/no-go for v1.1 — real-device probe (Cache/worker/wasm behavior, peak memory indexing ~200 chunks).
5. Similarity floor values per model — calibrated from the eval set.
6. HNSW build params (M, ef_construction, capacity sizing policy) — from the 10k/50k/100k measurements.

## Out of scope for v1

Local model on mobile (v1.1, spike-gated); hybrid keyword+vector ranking; cross-vault search; exposing VaneDB to other plugins (v2 platform play); vanedb-side tombstones; simd128 (feature request only).

## Constraints verified from vanedb source (why the design looks this way)

- `persistence.rs` is `std::fs`-only → byte-API refactor required; no wasm persistence today.
- Core `HnswIndex` has no remove; soft-delete would force an on-disk format bump synced to the C++ port → plugin-side tombstones.
- Capacity is eagerly pre-allocated (`vec![0.0; capacity*dim]`, ~150 MB at the 100k default) with no growth path; `IndexFull` is a hard error → growth work + capacity-pressure compaction + ids reset on rebuild.
- `search()` narrows u64 ids to f32 (exact only to 2^24) → typed-return fix before the plugin depends on it.
- No SIMD path compiles for wasm (scalar distances, ~2–5 ms/insert) → bulk work must live in a worker.
- transformers.js: ORT fetches its wasm from a CDN at runtime and its Cache-API caching is broken in Obsidian's Electron → hardening section; prior art retreated from local-on-mobile → remote-only mobile v1.
