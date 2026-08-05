# Vane Search — Obsidian Semantic Search Plugin (Design)

**Date:** 2026-07-29 (rev 2 — post six-lens review; see `2026-07-29-vane-search-design-review.md`)
**Status:** Approved design, pre-implementation
**Repos touched:** this repo (new plugin), `~/code/vanedb` (core + WASM binding work)

## Purpose & positioning

An Obsidian plugin that semantically indexes the vault and answers natural-language
queries, powered by VaneDB's WASM HNSW index running in-process. Two UI surfaces:
a search modal and a related-notes sidebar.

**The wedge:** existing plugins (Smart Connections et al.) do flat-scan retrieval
and paywall large-vault performance. Vane Search's pitch is *fast at scale, free,
private by default* — HNSW search in single-digit milliseconds on vaults where
competitors crawl. A reproducible benchmark vs Smart Connections on a 10k-note
vault is a named v1 deliverable (doubles as VaneDB marketing).

## Decisions

| Topic | Decision |
|---|---|
| Vector store | `vanedb-wasm` `WasmHnswIndex`, in-process (no server) |
| Embeddings | Pluggable `EmbeddingProvider` interface |
| v1 providers | OpenAI-compatible API (with **Ollama as a base-URL preset**, not a separate provider); local transformers.js **desktop-only** |
| Default provider | Local model on desktop; on mobile, guided remote-provider setup |
| UI | Search modal + related-notes sidebar + "find similar to selection" command |
| Scale target | Budgeted envelope (see Budgets), HNSW from day one |
| vanedb changes | In scope, re-scoped after review (see below); **never gates the plugin** |
| Mobile | v1 = remote providers only (`isDesktopOnly: false`); local-on-mobile is v1.1, gated on a real-device spike |
| Threading | VaneDB in an **index worker**; transformers.js in an **embed worker** (desktop); main thread = Obsidian I/O + UI only |
| Index storage | **IndexedDB** (origin-private → sync-proof, transactional); settings in `data.json`; API keys in Obsidian `SecretStorage` |
| Deletion | **Plugin-side tombstones** (no deletion changes in vanedb v1) |

## Budgets (definition of "works")

Reference vault: 2,000 notes / ~10,000 chunks. Budgets, enforced by tests where
possible:

- Modal search p95 < 150 ms warm (query embed + search + render)
- Plugin load → searchable < 3 s (reference vault, warm index)
- Full cold index, remote provider, reference vault: < 10 min
- `main.js` < 3 MB (vanedb wasm is 82 KB base64 — trivial; ORT wasm is NOT bundled, see Local provider)
- Scale envelope: tested to 100k chunks desktop, 30k chunks mobile; beyond the
  envelope the plugin warns and requires explicit opt-in rather than OOMing
- Memory ceilings measured in Phase 0 and recorded here before Phase 1

## vanedb work (parallel track — plugin never blocks on it)

Re-scoped after source review. In `~/code/vanedb`:

1. **Core:** refactor `hnsw/persistence.rs` into `to_bytes()/from_bytes()`;
   `save`/`load` become thin fs wrappers (existing fsync/rename logic stays).
   Byte API exposed in **all** bindings (wasm, py, capi) in the same release.
2. **Core:** capacity growth (`reserve()`/amortized doubling); expose
   `capacity()` in bindings. Today capacity is eagerly allocated
   (`vec![0.0; capacity*dim]`) and `IndexFull` is a hard wall.
3. **wasm:** fix `search()` return type — `{ids: BigUint64Array, distances:
   Float32Array}` (today ids are narrowed to f32: silent corruption past 2^24).
4. **wasm:** bind existing `get_vector` (that name, matching core/py).
5. **Repo:** commit `.cargo/config.toml` with `getrandom_backend="wasm_js"`
   rustflag (fresh clones currently can't build); CI builds the `--target web`
   artifact it ships; publish a written format-stability policy + checked-in
   v1/v2 fixture files with a CI load test. Later: publish `vanedb-wasm` to npm.
6. **Explicitly NOT in v1:** remove/tombstones in HNSW (plugin-side instead —
   avoids a format v3 + C++ port sync), `tombstone_count()`, simd128 (worth a
   feature-flag ask, not a dependency).

Plugin consumes a **vendored** `pkg/` at `vendor/vanedb-wasm/` with a
`PROVENANCE` file (vanedb git SHA + format VERSION) and a sync script; plugin CI
asserts it builds with no Rust toolchain.

## Architecture

Three contexts:

- **Main thread:** Obsidian APIs only — vault events, file reads, chunking, UI,
  IndexedDB writes, network providers via `requestUrl`.
- **Index worker (always):** owns the WASM `WasmHnswIndex` + id map. Bulk
  inserts, searches, graph (re)builds, serialize/deserialize all happen here —
  the wasm build has no SIMD (scalar path: 2–5 ms/insert), so bulk work would
  freeze the UI if on main. Search is async via postMessage (~1 ms, irrelevant
  behind a 300 ms debounce). Returns transferable bytes for persistence.
- **Embed worker (desktop, lazy):** transformers.js + ONNX runtime. Created only
  when the local provider is active; disposed after 5 min idle.

### The VaneIndex seam

`VaneIndex` interface with two implementations:

- **`MemoryVaneIndex` (v1 initial):** on load, rebuilds the HNSW graph in the
  index worker from plugin-owned vectors (see Persistence). Zero vanedb changes
  required — this is what Phases 1–3 ship on.
- **`PersistentVaneIndex` (when byte API lands):** `from_bytes(index blob)` for
  fast warm start; falls back to rebuild path on any mismatch/corruption.

Graph rebuild is ONE background job (cancellable, progress-reported, in the
index worker) with a single trigger set: tombstone ratio > 20%, capacity
pressure, corruption/format change, manual Rebuild. Never inline in a persist.
Searches keep serving from the old graph until the new one swaps in.

### Components

| Component | Context | Purpose |
|---|---|---|
| `VaneSearchPlugin` | main | Lifecycle, settings, commands, wiring |
| `Chunker` | main | Markdown → heading-based chunks. **Embedded text = `{note title} > {heading breadcrumb}\n\n{chunk}`** (context in the vector, not just display metadata) + one title chunk per note (title + first paragraph). ~1000-char target with explicit headroom under the model's token limit; 64-bit content hash; frontmatter skipped |
| `Indexer` | main | Vault events (debounced ~2 s/file), file-level reconcile table, hash diffing, embed batching, backoff |
| `EmbeddingProvider` | main | `embed(texts, kind: 'query'\|'doc')`, `dimension()`, `queryPrefix`/`docPrefix` (bge/e5 need them), `maxBatch`. **All vectors L2-normalized at this boundary; index uses `dot` metric** (≡ cosine on unit vectors, ~3× cheaper on the scalar wasm path) |
| `OpenAICompatProvider` | main | `requestUrl` POST `{base}/v1/embeddings`; presets: OpenAI, Ollama (`http://localhost:11434/v1`), LM Studio, OpenRouter |
| `LocalTransformersProvider` | main→embed worker | Desktop-only in v1; default model chosen by Phase-0 eval (candidates: bge-small-en-v1.5, nomic-embed-text-v1.5, MiniLM-L6-v2 baseline) |
| `FakeEmbeddingProvider` | test | Deterministic vectors from content hash — keystone test artifact |
| `VaneIndex` (2 impls) | index worker | As above; ids are JS numbers internally (BigInt only at the wasm boundary); `nextId = max(id)+1` derived on load; ids reset to 0 on every rebuild |
| `SearchService` | main | Shared query path; per-model similarity floor |
| `SearchModal` | main | Request-token pattern (cached sync results + async update via `updateSuggestions()` cast); dynamic `emptyStateText` ("index building — n/total") |
| `RelatedNotesView` | main | Centroid of note's stored vectors (plugin owns vectors — no `get_vector` dependency); similarity floor with "No strongly related notes" empty state; daily-notes folder excluded from candidates by default (still searchable) |
| Status bar, `SettingsTab` | main | Progress; provider indicator "Local (private)" / "Cloud" |

## Persistence (IndexedDB)

**Principle: split precious from derived.** Embeddings are expensive; the graph
is rebuildable. Object stores:

| Store | Contents | Notes |
|---|---|---|
| `vectors` | content-hash → Float32Array | The durable artifact. Hash-keyed: renames/moves/reverts cost zero embeddings; identical chunks dedupe |
| `chunks` | chunk id → {contentHash, path, breadcrumb, offsets} | Rows, not one blob — O(changed) writes |
| `files` | path → {mtime, size, contentHash, generation} | Startup reconcile is an in-memory diff vs `vault.getMarkdownFiles()` stat cache — no file reads |
| `graph` | serialized HNSW bytes + generation | Disposable cache (PersistentVaneIndex only) |
| `meta` | versions, fingerprints, backoff state | See versioning |

IndexedDB transactions give atomic commits; no manifest protocol needed. Call
`navigator.storage.persist()` + `estimate()` at startup; degrade gracefully.
Nothing large ever sits in the vault directory → sync clients can't clobber or
replicate the index. Each device builds its own index (semantically correct).
`data.json` holds only non-secret settings; API keys live in Obsidian
`SecretStorage` (`minAppVersion` ≥ 1.11.4).

**Versioning, two axes:** a *vector fingerprint* (provider + model revision +
dimension + normalized flag) — mismatch ⇒ re-embed; and a *derived-artifact
version* (chunker version, schema, hash algo, HNSW params, vanedb format
VERSION + build SHA) — mismatch ⇒ cheap local rebuild from `vectors`, never a
re-embed. Retry/backoff state (`consecutiveFailures`, `nextAttemptAt`,
`lastError`) persists in `meta`; the work queue itself is **derived** at startup
by reconcile, never persisted.

## Data flow

**Incremental indexing:** vault event → debounce → read + chunk → hash-diff vs
`chunks` → changed chunks → provider batches (halved on mobile) → vectors
written to IDB (transactional) → inserted in index worker → superseded ids
added to the plugin-side tombstone set. Tombstones filtered at the result
boundary with iterative-widening over-fetch (not fixed k×3, which breaks when
one folder/note dominates).

**Startup:** load `meta` → check both version axes → warm-start
(`PersistentVaneIndex`) or background rebuild from `vectors`
(`MemoryVaneIndex`) → reconcile via `files` table (path-set diff + mtime/size
mismatch → rehash only those) → queue drift. Search available immediately with
"index building" states. A low-priority idle audit re-hashes a few hundred
files/tick to catch mtime lies (Dropbox/iCloud restore mtimes); index panel
shows "last verified".

**Search (modal):** query → `embed(kind:'query')` (debounced 300 ms, stale
responses discarded by token) → index worker search → tombstone/excluded filter
→ floor → group by note (score = max chunk) → top 20 with snippet + heading.
Cold-start of a disposed embed worker shows "waking up local model…".

**Related notes:** centroid of the note's vectors from IDB → search → exclude
self + daily-notes scope → floor → top 10, or honest empty state. Unindexed
note → embed its text as fallback.

## Provider & privacy UX

- First activation of any network provider: one-time consent modal naming the
  destination host, noting that note text leaves the device and excluded
  folders stay local. Acknowledgment persisted per provider. Persistent
  Local/Cloud indicator in settings header + status bar.
- Provider/model switch: warning includes **estimated cost & time** (chunk count
  × pricing table, rate-based ETA). Old index (old fingerprint) keeps serving
  until the new one completes; revert is free.
- Excluded folders surfaced as a privacy control (applies to indexing; query
  text goes only to the active provider).
- README: "Network use and your data" section, per-provider endpoints, explicit
  zero-telemetry statement. `THIRD_PARTY_NOTICES.md`; esbuild
  `--legal-comments=eof`.

## Local provider hardening (desktop v1; Phase-0 spike first)

- ORT wasm is **never fetched from a CDN at runtime**: pinned version downloaded
  once via `requestUrl`, SHA-256 verified against hashes committed in the repo,
  stored via vault adapter; `env.backends.onnx.wasm.wasmPaths` pointed at it.
- Model weights: pinned immutable HF revision, downloaded once via `requestUrl`
  with progress UI, SHA-256 verified, stored via `env.customCache` backed by the
  vault adapter (transformers.js Cache API is known broken in Obsidian Electron).
- `env.customFetch` → `requestUrl`; `numThreads = 1`, `proxy = false` (no
  SharedArrayBuffer); esbuild alias stubs for transformers.js's Node-only
  imports; worker inlined as Blob URL (string literal — parsed only when the
  local provider activates).
- First-run flow: consent → download with progress + sizes → index with ETA →
  searchable while building.

## Error handling

- Provider failure: pause with one actionable Notice + status-bar warning;
  exponential backoff; queue re-derived on restart.
- Fingerprint mismatch: modal — rebuild now / keep old index read-only.
- Corrupt graph blob: silent fallback to rebuild-from-vectors (log it). Corrupt
  vectors store: offer full re-embed. Plugin load never crashes.
- Capacity pressure: compact/grow *before* `IndexFull`; surface headroom in the
  index panel.
- Scale envelope exceeded: warn + require opt-in, don't OOM.
- Mobile: remote-only; batches halved; 30k-chunk ceiling.
- Vault notes are strictly read-only to the plugin.

## Search-quality bar

- Eval set: 20–40 query→expected-note pairs from a dogfood vault; precision@k /
  MRR tracked; changes to model, chunker, or floor gate on it.
- Default local model chosen by running this eval across candidates in Phase 0.
- Per-model similarity floor calibrated empirically, stored with provider
  metadata.
- Chunker test asserts breadcrumb/title context changes *ranking*; truncation
  test asserts embedded text (prefix + chunk) fits the model's token budget.

## Testing

- **vanedb (Rust):** to_bytes/from_bytes round-trip identity; capacity growth;
  cross-target round-trip (wasm32-written bytes read on x86_64); format
  fixtures v1/v2 load in CI.
- **Plugin unit (vitest):** chunker (splits, hash stability, empty note, giant
  paragraph, frontmatter, truncation); id mapping; grouping/scoring/floor;
  provider request shaping + `‖v‖≈1` normalization per provider — all against
  `FakeEmbeddingProvider` / mocked `requestUrl`.
- **Integration (vitest + real wasm):** loaded via `initSync(readFileSync(...))`
  (the `--target web` pkg's default init cannot fetch `file://` in Node);
  fixture corpus → known-similar in top-3; delete → absent; persist → reload →
  identical results.
- **Manual:** dev vault hot-reload; real-device mobile pass (remote provider)
  before release.

## Delivery phases

- **Phase 0 (1 week, timeboxed):** spikes — mobile platform probe (real device);
  transformers.js inside Obsidian desktop; wasm capacity/memory/rebuild
  measurements at 10k/50k/100k; to_bytes prototype; model eval; dev-loop
  logistics. Exit: budgets ratified, local-on-mobile go/no-go for v1.1, ORT
  delivery validated.
- **Phase 1:** walking skeleton — scaffold, FakeEmbeddingProvider, whole-file
  chunks, MemoryVaneIndex over today's binding (vendored), SearchService,
  SearchModal. Exit: type query → ranked results → Enter opens note; CI green
  with no Rust toolchain.
- **Phase 2:** real pipeline, still fake embeddings — Chunker, Indexer,
  reconcile, tombstones, grouping, excluded folders, status bar, Rebuild.
- **Phase 3:** OpenAICompatProvider + settings + consent + SecretStorage +
  error story. **First viable v1 candidate.**
- **Phase 4:** persistence — IDB stores, versioning axes, vanedb byte API lands
  → PersistentVaneIndex, compaction/growth job.
- **Phase 5:** local provider (desktop) — embed worker, ORT/model delivery,
  first-run flow, benchmark vs Smart Connections.
- **Phase 6:** RelatedNotesView, find-similar-to-selection, index panel, mobile
  hardening pass, README/notices, release.

## Out of scope for v1

Local model on mobile (v1.1, spike-gated); hybrid keyword+vector ranking;
cross-vault search; exposing VaneDB to other plugins (recorded as the v2
platform play — shared vault-vector infra for the Obsidian AI ecosystem);
vanedb-side tombstones; simd128 (feature request only).
