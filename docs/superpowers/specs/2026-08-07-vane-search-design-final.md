# Vane Search — Obsidian Semantic Search Plugin (Final Design)

**Date:** 2026-08-11 · **Status:** Final spec for review, pre-implementation
**Repos:** this repo (new plugin), `~/code/vanedb` (core + WASM binding work)

## Purpose & positioning

An Obsidian plugin that semantically indexes the vault and finds notes for natural-language queries, powered by VaneDB's WASM HNSW index running in-process — no server, no daemon. Surfaces: search modal, related-notes sidebar, find-similar-to-selection command.

**The wedge (hypothesis, to be proven by benchmark):** free provider choice plus reproducibly faster large-vault retrieval on desktop; private by default on desktop (local embeddings). A reproducible benchmark vs Smart Connections on a 10k-note vault is a named v1 deliverable — it validates or kills the positioning claim.

## Decisions

| Topic | Decision |
|---|---|
| Vector store | `vanedb-wasm` `WasmHnswIndex`, in-process |
| Embeddings | Pluggable `EmbeddingProvider` interface |
| v1 providers | OpenAI-compatible API (Ollama/LM Studio/OpenRouter as base-URL presets); local transformers.js **desktop-only** |
| Default provider | Local model on desktop; guided remote-provider setup on mobile |
| Mobile | v1 = remote providers only (`isDesktopOnly: false`); local-on-mobile is v1.1, spike-gated |
| Threading | VaneDB in an **index worker**; graph rebuilds in a **replacement build worker**; transformers.js in an **embed worker** (desktop, lazy); main thread = Obsidian I/O + UI only |
| Index storage | **IndexedDB, namespaced per vault** (device-local → sync-proof, transactional); settings in `data.json`; API keys in Obsidian `SecretStorage` |
| Deletion | **Plugin-side tombstones**, persisted inside the generation record |
| Metric | `dot` on L2-normalized vectors (≡ cosine, ~3× cheaper on the scalar wasm path) |
| Consistency unit | **Generation record**: graph bytes + idMap + tombstones + nextVaneId + fingerprints + snapshotSeq, swapped atomically |

## Budgets

Reference vault: 2,000 notes / ~10,000 chunks at 384 dims. Stated at 384-dim; memory scales linearly with dimension (×2 at 768, ×4 at 1536). Enforced by tests where possible:

- Index-only search (worker round-trip, no embed): p95 < 10 ms at 100k chunks
- Modal search end-to-end, local provider, warm model: p95 < 150 ms
- Modal search end-to-end, remote provider: embed network time reported separately; non-network share < 50 ms p95
- Warm start (PersistentVaneIndex, byte API): load → fully searchable < 3 s. MemoryVaneIndex fallback: searchable immediately, progressively complete; full rebuild time surfaced in status bar
- Full cold index, remote provider, reference vault: < 10 min
- `main.js` < 3 MB (vanedb wasm is 82 KB base64; ORT wasm is NOT bundled)
- Memory: steady-state ceiling AND rebuild peak (old + building graph ≈ 2× steady) budgeted separately, desktop and mobile, measured in Phase 0
- Scale envelope at 384-dim: tested to 100k chunks desktop, 30k mobile; scale down proportionally for higher dims; beyond it the plugin warns and requires explicit opt-in rather than OOMing

## vanedb work (parallel track — never gates the plugin)

1. **Core:** refactor `hnsw/persistence.rs` into `to_bytes()/from_bytes()`; `save`/`load` become thin fs wrappers. Byte API exposed in all bindings (wasm, py, capi) in one release.
2. **Core:** capacity growth (`reserve()`/amortized doubling); expose `capacity()`.
3. **wasm:** fix `search()` return type — `{ids: BigUint64Array, distances: Float32Array}`.
4. **wasm:** bind core `get_vector` under that name (API completeness; plugin doesn't depend on it).
5. **Repo:** CI builds and ships the `--target web` artifact (checked-in `pkg/` is stale today); written format-stability policy + v1/v2 fixture files with CI load test. Dev docs: build with the rustup toolchain (Homebrew rust shadows it and lacks the wasm target). getrandom 0.4's `wasm_js` feature suffices — no rustflags needed (verified). Later: publish to npm.
6. **NOT in v1:** remove/tombstones in HNSW, `tombstone_count()`, simd128 (feature request only).

Plugin consumes a **vendored** `pkg/` at `vendor/vanedb-wasm/` with a `PROVENANCE` file (vanedb git SHA + format VERSION) and sync script; plugin CI asserts the build needs no Rust toolchain.

## Architecture

- **Main thread:** Obsidian APIs only — vault events, file reads, chunking, UI, IndexedDB writes, network via `requestUrl`. Light `onload()`; init after `workspace.onLayoutReady`; events arriving during startup are queued and reconciled.
- **Index worker (always):** owns the active `WasmHnswIndex` + id map; serves searches and incremental inserts. Search is async via postMessage (~1 ms, irrelevant behind the 300 ms debounce).
- **Replacement build worker (transient):** full graph rebuilds run here, never in the serving worker (synchronous WASM inserts would block its event loop). Protocol: snapshot at sequence S → build generation N+1 in the fresh worker → old worker keeps serving → replay events after S into N+1 → atomic cutover (generation record swap) → terminate old worker. Peak memory ≈ 2× steady (budgeted above).
- **Embed worker (desktop, lazy):** transformers.js + ONNX runtime; created only when the local provider is active; disposed after 5 min idle. **Workers cannot touch Obsidian APIs** — all downloads, integrity checks, and cache reads/writes go through a main-thread RPC (worker requests bytes; main thread fetches via `requestUrl`, verifies SHA-256, transfers ArrayBuffers).

### VaneIndex seam

- **`MemoryVaneIndex` (v1 initial):** rebuilds the graph from stored vectors on load (replacement-worker path). Zero vanedb changes — early phases ship on this. Searchable immediately, progressively complete.
- **`PersistentVaneIndex` (when byte API lands):** `from_bytes(graph blob)` warm start; falls back to rebuild on mismatch/corruption.

Rebuild is ONE background job (cancellable, progress-reported) with one trigger set: tombstone ratio > 20%, capacity pressure, corruption/format change, embedding-identity change, manual Rebuild.

### Components

| Component | Context | Purpose |
|---|---|---|
| `VaneSearchPlugin` | main | Lifecycle, settings, commands, wiring |
| `Chunker` | main | Markdown → heading-based chunks. **Embedded text = `{note title} > {heading breadcrumb}\n\n{chunk}`** + one title chunk per note (title + first paragraph). Length measured with the model's tokenizer where available (local), conservative char heuristic + headroom otherwise; 64-bit hash of the **exact embedded input**; frontmatter skipped. Folder moves are free (title unchanged); basename renames re-embed that note's chunks (bounded, one note) |
| `Indexer` | main | Vault events (debounced ~2 s/file), file-level reconcile table, hash diffing, embed batching, exponential backoff |
| `EmbeddingProvider` | main | `embed(texts, kind: 'query'\|'doc')`, `dimension()`, `queryPrefix`/`docPrefix`, `maxBatch`. All vectors L2-normalized at this boundary. Responses validated: count matches, order preserved, dimension correct, finite, non-zero norm |
| `OpenAICompatProvider` | main | `requestUrl` POST `{base}/v1/embeddings`; presets: OpenAI, Ollama (`http://localhost:11434/v1`), LM Studio, OpenRouter |
| `LocalTransformersProvider` | main → embed worker | Desktop-only in v1; default model chosen by Phase-0 eval |
| `FakeEmbeddingProvider` | test | Deterministic vectors from content hash — keystone test artifact |
| `VaneIndex` (2 impls) | index worker | Ids are JS numbers internally (BigInt only at the wasm boundary); `nextVaneId` persisted in the generation record; ids reset to 0 on every rebuild |
| `SearchService` | main | Shared query path; per-model similarity floor |
| `SearchModal` | main | Request-token pattern (cached sync results + async update, stale responses discarded); dynamic `emptyStateText` ("index building — n/total") |
| `RelatedNotesView` | main | Centroid of the note's stored vectors, **re-normalized before search** (dot ranking is scale-invariant, but the similarity floor is absolute); floor with "No strongly related notes" empty state; daily-notes folder excluded from candidates by default (still searchable); unindexed note → chunked and embedded via the normal pipeline, not whole-note |
| Status bar, `SettingsTab` | main | Progress; provider indicator "Local (private)" / "Cloud" |

## Persistence (IndexedDB, per-vault namespace)

**Split precious from derived:** embeddings are expensive and irreplaceable; the graph is rebuildable. DB name includes the vault id — multiple vaults share the Electron origin and must not collide.

| Store | Key → value | Notes |
|---|---|---|
| `vectors` | (embeddingFingerprint, inputHash) → Float32Array | Durable artifact. Fingerprint in the key ⇒ two providers' embeddings coexist during switch; reverts free while old vectors retained. Identical inputs dedupe |
| `chunks` | occurrenceId → {inputHash, path, breadcrumb, offsets} | Rows, not one blob — O(changed) writes |
| `files` | path → {mtime, size, contentHash, generation} | Startup reconcile = in-memory diff vs `vault.getMarkdownFiles()` stat cache, no file reads |
| `generations` | generation → {graph bytes?, idMap (vaneId→occurrenceId), tombstones, nextVaneId, embeddingFingerprint, graphFingerprint, snapshotSeq, state: active\|building} | The atomic consistency unit; graph bytes only with PersistentVaneIndex. Active + building may coexist; swap is one transaction; previous generation kept until the new one verifies |
| `meta` | schema version, active fingerprint, backoff state keyed by provider profile | |

IndexedDB transactions give atomic commits. `navigator.storage.persist()` + `estimate()` at startup; degrade gracefully. Nothing large in the vault directory — index AND model assets are device-local; each device builds its own. `data.json` = non-secret settings only; API keys in `SecretStorage` (`minAppVersion` ≥ 1.11.4).

**Versioning, three axes:**

- *Embedding identity* (provider origin, model revision, dimension, query/doc prefixes, normalization, tokenization/truncation policy, input format incl. chunker version) — change ⇒ re-embed. Warned with cost/time estimate; old generation + old vectors + old provider config/secret reference retained and serving until cutover; queries during transition embedded by the old provider.
- *Graph identity* (metric, HNSW params, vanedb format VERSION + build SHA) — change ⇒ cheap local rebuild from `vectors`, never a re-embed.
- *Storage schema* — explicit migrations.

Backoff state persists in `meta`; the work queue is derived at startup by reconcile, never persisted.

## Data flow

**Incremental indexing:** vault event → debounce → read + chunk → hash-diff vs `chunks` → changed chunks → provider batches (halved on mobile) → vectors to IDB (transactional) → insert in index worker → superseded ids into the generation's tombstone set. Tombstones filtered at the result boundary with iterative-widening over-fetch.

**Startup:** `onLayoutReady` → load `meta` + active generation → check three axes → warm-start (graph bytes) or background rebuild from `vectors` → reconcile via `files` table (path-set diff catches creates/deletes; mtime/size mismatch → rehash only those) → queue drift, including events that arrived during startup. Search available immediately with "index building" states. Low-priority idle audit re-hashes a few hundred files per tick to catch mtime lies (Dropbox/iCloud restore mtimes); index panel shows "last verified".

**Search (modal):** query → `embed(kind:'query')` (debounced 300 ms) → index worker search → tombstone/excluded filter → similarity floor → group by note (score = max chunk; long-note bias checked in eval) → top 20 with snippet + heading; Enter opens the note at the matched heading. Cold-start of a disposed embed worker shows "waking up local model…". During a rebuild, the active generation serves.

**Related notes:** active-note change → re-normalized centroid of the note's vectors from IDB → search → exclude self + daily-notes scope → floor → top 10, or honest empty state.

## Provider & privacy UX

- First activation of a network provider: one-time consent modal naming the destination host, stating note text leaves the device; acknowledgment persisted per provider. Persistent Local/Cloud indicator in settings header + status bar.
- Provider/model switch: warning includes estimated cost & time; old generation serves until the new one completes; reverting is free while old vectors are retained.
- Excluded folders surfaced as a privacy control.
- README "Network use and your data" section, per-provider endpoints, explicit zero-telemetry statement. `THIRD_PARTY_NOTICES.md`; esbuild `--legal-comments=eof`.

## Local provider hardening (desktop v1; Phase-0 spike first)

- ORT wasm never fetched from a CDN at runtime: pinned version downloaded once by the **main thread** via `requestUrl`, SHA-256 verified against hashes committed in the repo, stored device-local (IDB), served to the embed worker over the RPC.
- Model weights: pinned immutable HF revision, downloaded once the same way, with progress UI. `env.customCache`/`env.customFetch` inside the worker are RPC proxies to the main thread.
- `numThreads = 1`, `proxy = false`; esbuild alias stubs for Node-only imports; worker inlined as a Blob-URL string literal (parsed only when the local provider activates).
- First-run flow: consent → download with progress + sizes → index with ETA → searchable while building.

## Error handling

- Provider failure: pause, one actionable Notice + persistent status-bar warning, exponential backoff (401 ⇒ stop + reauth prompt, no retry; 429 ⇒ backoff honoring Retry-After), queue re-derived on restart.
- Embedding-identity mismatch: modal — rebuild now / keep old generation read-only.
- Corrupt or oversized graph bytes: silent fallback to rebuild-from-vectors (logged). Corrupt vectors store: offer full re-embed. Plugin load never crashes.
- Worker crash: respawn, reload active generation, resume queue.
- IndexedDB eviction/quota failure: detected at startup (generation missing/invalid) → rebuild or re-embed path with clear message.
- Capacity pressure: compact/grow before `IndexFull`; headroom in the index panel.
- Scale envelope exceeded: warn + require opt-in, don't OOM.
- Vault notes are strictly read-only to the plugin.

## Search-quality bar

- Eval set: 20–40 query→expected-note pairs from a dogfood vault; precision@k / MRR; changes to model, chunker, or floor gate on it. Includes long-note cases to check max-chunk scoring bias.
- HNSW recall@k measured against brute-force ground truth (`WasmVectorStore`) on the fixture corpus.
- Default local model chosen by running the eval across candidates in Phase 0.
- Per-model similarity floor calibrated empirically.
- Chunker tests assert breadcrumb/title context changes *ranking*, and embedded text fits the model's token budget.

## Testing

- **vanedb (Rust):** byte round-trip identity; capacity growth; cross-target round-trip (wasm32 bytes read on x86_64); v1/v2 format fixtures load in CI.
- **Plugin unit (vitest):** chunker (splits, hash stability, empty note, giant paragraph, frontmatter, truncation, rename semantics); id/generation mapping; grouping/scoring/floor; provider request shaping + response validation + normalization — all against `FakeEmbeddingProvider` / mocked `requestUrl`.
- **Integration (vitest + real wasm via `initSync(readFileSync(...))`):** fixture corpus → known-similar in top-3; recall@k vs brute force; delete → absent; persist → reload → identical results.
- **Failure matrix:** restart with tombstones; provider cutover mid-index; vault mutation during rebuild (replay path); worker crash; IDB eviction/quota; corrupt/oversized graph bytes; 401/429.
- **Manual:** dev vault hot-reload; real-device pass on iOS AND Android (remote provider) before release.

## Delivery phases

- **Phase 0 (1 week, timeboxed):** spikes with written exit criteria — mobile platform probe (real device); transformers.js inside Obsidian desktop; wasm capacity/memory/rebuild measurements at 10k/50k/100k incl. 2× rebuild peak; `to_bytes` prototype; model eval; benchmark feasibility; dev-loop logistics.
- **Phase 1:** walking skeleton on durable ground — scaffold, IDB schema (all five stores) + generation protocol, `FakeEmbeddingProvider`, whole-file chunks, `MemoryVaneIndex` (vendored binding), `SearchService`, `SearchModal`, crash/restart tests. Exit: query → ranked results → Enter opens note; kill + restart loses nothing; CI green with no Rust toolchain.
- **Phase 2:** real pipeline, still fake embeddings — `Chunker`, `Indexer`, reconcile, tombstones, grouping, excluded folders, status bar, Rebuild command.
- **Phase 3:** `OpenAICompatProvider` + settings + consent + `SecretStorage` + full error story. Vectors are already durable — a restart never re-bills. **First viable v1 candidate.**
- **Phase 4:** vanedb byte API lands → `PersistentVaneIndex`, replacement-worker rebuild protocol, provider-switch cutover flow, warm-start budget enforced.
- **Phase 5:** local provider (desktop) — embed worker + RPC, ORT/model delivery, first-run flow, benchmark vs Smart Connections.
- **Phase 6:** `RelatedNotesView`, find-similar-to-selection, index panel, mobile hardening pass (iOS + Android), README/notices, release.

## Open questions (Phase 0 resolves)

1. Default local model — eval bge-small-en-v1.5 vs nomic-embed-text-v1.5 vs MiniLM-L6-v2 on the fixture corpus.
2. Memory ceilings (desktop and mobile, steady + rebuild peak) — measured, then recorded in Budgets before Phase 1.
3. ORT wasm delivery — validate the download-once-and-pin + RPC path inside Obsidian desktop.
4. Local-on-mobile go/no-go for v1.1 — real-device probe (worker/wasm behavior, peak memory indexing ~200 chunks).
5. Similarity floor values per model — calibrated from the eval set.
6. HNSW build params (M, ef_construction, capacity sizing policy) — from the 10k/50k/100k measurements.
7. Smart Connections benchmark protocol — verify the flat-scan hypothesis and define the comparison honestly.

## Out of scope for v1

Local model on mobile (v1.1, spike-gated); hybrid keyword+vector ranking; cross-vault search; exposing VaneDB to other plugins (v2 platform play); vanedb-side tombstones; simd128 (feature request only).

## Constraints verified from source (why the design looks this way)

- `persistence.rs` is `std::fs`-only → byte-API refactor required; no wasm persistence today.
- Core `HnswIndex` has no remove; soft-delete would force an on-disk format bump synced to the C++ port → plugin-side tombstones.
- Capacity is eagerly pre-allocated (~150 MB at the 100k default, 384-dim) with no growth path; `IndexFull` is a hard error → growth work + capacity-pressure compaction + ids reset on rebuild.
- `search()` narrows u64 ids to f32 (exact only to 2^24) → typed-return fix before the plugin depends on it.
- No SIMD path compiles for wasm (scalar distances, ~2–5 ms/insert) → bulk work in workers; serving worker never runs a tight rebuild loop.
- Synchronous WASM inserts block a worker's event loop → replacement-build-worker protocol with snapshot + event replay.
- `requestUrl` and the vault adapter are Obsidian APIs, unavailable in workers → main-thread RPC for downloads/cache.
- transformers.js: ORT fetches its wasm from a CDN at runtime and its Cache-API caching is broken in Obsidian's Electron → hardening section; prior art retreated from local-on-mobile → remote-only mobile v1.
- getrandom 0.4's `wasm_js` feature suffices for wasm32 builds — verified by clean `cargo check`; no rustflags config needed.
