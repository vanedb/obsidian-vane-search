# Vane Search Design — Six-Lens Review (Consolidated)

**Date:** 2026-07-29
**Reviewers:** entrepreneur, system architect, senior engineer, AI product manager, TPM, CTO (six independent agents, each grounded in the spec + actual vanedb sources)
**Spec reviewed:** `2026-07-29-vane-search-design.md`

## Overall verdict

Unanimous: the *logical* architecture is right (EmbeddingProvider seam, cost-based
thread split as a principle, hash-diffed incremental indexing, honest error
catalogue). Also unanimous: the spec's **foundation is assumed rather than
verified** — several claims about vanedb-wasm are contradicted by the source, the
persistence design has no memory/durability budget, and the local-embeddings-on-
mobile story is contradicted by prior art. Buildable, but not from this spec as
written.

## Consensus critical findings (independently found by 3+ reviewers)

### C1. The vanedb-wasm "prerequisite" is mis-scoped (architect, engineer, CTO, TPM)
- `persistence.rs` is `std::fs`-only (`save(path)`/`load(path)`); it **cannot** be
  "wired through wasm-bindgen." Real work: refactor core to
  `to_bytes()/from_bytes()`, reduce `save`/`load` to fs wrappers, expose the byte
  API in **all** bindings (wasm, py, capi) in one release.
- Core `HnswIndex` has **no remove/tombstone at all** (grep: zero hits). Soft
  delete in vanedb = beam-search changes + serde struct change + on-disk format
  v3 + matching C++ port work. **Consensus: make plugin-side tombstones the
  PRIMARY design (the spec's own fallback), ship zero deletion changes in vanedb v1.**
- `get(id)` should be `get_vector` (matches core/py naming); core already has it.
- New: `tombstone_count()` should not exist in vanedb if tombstones are plugin-side.

### C2. Fixed, eagerly pre-allocated capacity = guaranteed failure (architect, engineer, CTO, TPM)
- `build()` does `vec![0.0; capacity * dim]` up front. Default capacity 100k ×
  384 dims ≈ **150 MB of wasm memory at plugin load, before any vector**.
- `add()` hard-fails with `IndexFull` at capacity; **no growth path exists**.
- Monotonic-fresh-id-per-edit means capacity is consumed by *edit volume*, not
  vault size — every vault walks to a hard failure.
- Fix: add capacity growth (or `reserve()`) to core (~30 lines); plugin sizes
  capacity from measured chunk count; compaction triggers on **capacity
  pressure**, not just tombstone ratio; expose `capacity()`.

### C3. `search()` returns u64 ids as f32 (architect, engineer, CTO, TPM)
- `flat.push(r.id as f32)` — ids exact only to 2^24; beyond that, **silent wrong-
  note results**. Also forecloses hash-derived ids.
- Fix in vanedb-wasm NOW (one known consumer): return `{ids: BigUint64Array,
  distances: Float32Array}`.
- Related day-1 bug: spec's `meta.json` doesn't persist the id counter → restart
  → `DuplicateId` on every insert. (Better: derive `nextId = max(id)+1` on load;
  reset ids on rebuild; key chunks by content hash.)

### C4. The transformers.js story is wrong as written (5 of 6 reviewers)
- onnxruntime-web fetches its **13–27 MB .wasm from jsDelivr at runtime** —
  unpinned third-party code in the vault process; collides with Obsidian policy
  and the offline claim. Spec only accounted for vanedb's wasm (82 KB — trivial).
- transformers.js Cache-API caching is **known broken in Obsidian's Electron**
  (huggingface/transformers.js#1238; hit by obsidian-similar-notes) and evictable
  on iOS.
- Blob-URL worker breaks ORT's `import.meta.url` path resolution; threading needs
  SharedArrayBuffer (unavailable → force `numThreads=1, proxy=false`); Node-only
  imports need esbuild stubs; model download from a worker can't use `requestUrl`.
- Prior art: Smart Connections and Similar Notes both retreated from
  local-model-on-mobile (documented crashes/warnings).
- Fix: **week-1 spike on real devices before any plugin code**; bundle or
  hash-verified-download the ORT wasm (never CDN-at-runtime); model weights
  downloaded once via `requestUrl`, SHA-256 pinned to an immutable HF revision,
  stored via vault adapter (`env.customCache`); `env.customFetch` → `requestUrl`.

### C5. Persistence has no durability or memory budget (architect, engineer, TPM)
- Three independent file writes, no commit point; `adapter.writeBinary` is not
  atomic; crash/OS-kill mid-write ⇒ "rebuild" = full re-embed (minutes/money).
- Serialize deep-clones: **~500 MB wasm peak at 100k chunks**, every 30s-quiet
  persist; wasm memory never shrinks; jetsam on iOS.
- `chunks.json` as one document: 15–20 MB full rewrite per persist, multi-second
  parse on mobile; `JSON.stringify` **throws on BigInt**.
- Sync clients (iCloud/Dropbox/Syncthing/Obsidian Sync) watch `.obsidian/plugins/`:
  index clobbering, conflicted copies, quota burn.
- **Keystone consensus fix: split precious from derived.** Persist an
  append-only, hash-keyed `vectors.bin` (the expensive artifact) and treat the
  HNSW graph as a rebuildable cache. Corruption/format-break/compaction all
  become a cheap local rebuild, never a re-embed. Commit via
  generation-manifest (tmp + `adapter.rename`), or store index artifacts in
  IndexedDB (origin-private → never synced, transactional).

### C6. Move VaneDB into a worker (architect, engineer)
- The spec's justification for main-thread VaneDB ("persistence needs the vault
  adapter") doesn't hold — a worker returns transferable bytes; main thread writes.
- wasm build has **no SIMD path** (avx2/neon are cfg'd out; no simd128): inserts
  are 2–5 ms, not 1 ms. Bulk index/compaction/deserialize = seconds-to-minutes of
  synchronous UI freeze if kept on main.
- Fix: VaneDB + embedder in the worker; search is async behind an existing 300 ms
  debounce (~1 ms overhead). Ask vanedb for a `simd128` feature. L2-normalize at
  the provider boundary and use `dot` instead of `cosine` (≈3× cheaper, identical
  ranking on unit vectors).

## Major product findings (AI PM, entrepreneur)

- **P1. Relevance floor:** fixed top-k guarantees embarrassing related-notes.
  Add per-model-calibrated minimum-similarity threshold + "No strongly related
  notes" empty state.
- **P2. Embed the context, not just store it:** heading breadcrumb + note title
  must be *prepended to the embedded text*; add a per-note title chunk (titles
  carry huge signal in personal vaults). Test that context changes *ranking*.
- **P3. Default model is stale:** all-MiniLM-L6-v2 (2021) caps quality forever
  (default = what everyone keeps). Eval bge-small-en-v1.5 / nomic-embed-text-v1.5
  on a fixture corpus before locking. Provider interface needs `queryPrefix`/
  `docPrefix` (bge/e5 require them) — interface change if bolted on later.
- **P4. Chunk size vs token ceiling:** ~1000 chars + breadcrumb prefix ≈ or >
  MiniLM's 256-token limit → silent truncation. Size with headroom; test it.
- **P5. Retrieval eval:** 20–40 query→expected-note pairs, precision@k/MRR; gate
  model/chunking/threshold changes on it.
- **P6. Cost/time estimate before paid-provider re-embed** (chunk count × price);
  keep old index until new one completes.
- **P7. Cold-start UX:** consent → download-with-progress → searchable-while-
  building. First five minutes decide reviews.
- **P8. Positioning:** state the wedge (HNSW performance at scale, free, private)
  and produce benchmark artifacts vs Smart Connections as a v1 deliverable.
- **P9. Cheap wins:** "find similar to selection" command (reuses related-notes
  fallback path); daily-notes exclusion scoped to related-notes only.
- **P10. Ollama provider is redundant** (Ollama serves OpenAI-compatible
  `/v1/embeddings`): fold into OpenAICompatProvider as a preset. (entrepreneur +
  TPM, independently)

## Security & compliance (CTO)

- **S1. API keys → Obsidian `SecretStorage`** (shipped 1.11, Dec 2025; OS
  keychain; desktop+mobile). Never in `data.json` (vault-synced, git-committed,
  readable by every plugin). Set `minAppVersion` ≥ 1.11.4.
- **S2. Consent gate** on first activation of any network provider (named host,
  persistent "Local (private)"/"Cloud" indicator); README "Network use and your
  data" section; explicit zero-telemetry commitment.
- **S3. Supply chain:** no runtime CDN code (see C4); pin transformers.js exactly;
  Renovate/Dependabot; model revision hash committed.
- **S4. Licensing:** MIT + Apache-2.0 compatible; esbuild `--legal-comments=eof`;
  `THIRD_PARTY_NOTICES.md` incl. model card.
- **S5. Format-stability contract** for `index.bin` published in vanedb repo
  (checked-in v1/v2 fixture files + CI load test) *before* files exist in the wild.

## Delivery (TPM)

- **D1. The vanedb dependency doesn't actually gate the plugin.** `VaneIndex`
  seam with two impls: `MemoryVaneIndex` (rebuild-on-load, zero vanedb changes)
  now, `PersistentVaneIndex` when the byte API lands. vanedb becomes a parallel
  track.
- **D2. `FakeEmbeddingProvider`** (deterministic vectors from content hash) is
  the keystone test artifact — decouples phases from network/model/worker.
- **D3. Reproducibility:** checked-in `pkg/` is stale (Apr 5), gitignored,
  unbuildable from clean clone (missing `.cargo/config.toml` with
  `getrandom_backend="wasm_js"` rustflag). Vendor `pkg/` into the plugin repo
  with a PROVENANCE file (vanedb SHA + format version) + sync script; CI asserts
  plugin builds with no Rust toolchain. Longer-term: publish vanedb-wasm to npm
  via CI (also serves the VaneDB-showcase goal).
- **D4. Budgets before code:** reference vault (e.g. 2k notes / 10k chunks);
  modal search p95 < 150 ms warm; load→searchable < 3 s; `main.js` < 3 MB;
  explicit memory ceilings, desktop and mobile separately. Publish a tested
  scale envelope and enforce it (guard + message, not OOM).
- **D5. Phase plan:** Phase 0 = one-week timeboxed spikes (mobile platform probe,
  transformers.js-in-Obsidian desktop + real device, wasm capacity/memory/rebuild
  measurements, to_bytes prototype). Phase 1 = walking skeleton (fake provider +
  MemoryVaneIndex + modal). Phase 2 = real pipeline, still fake embeddings.
  Phase 3 = OpenAI-compat provider + settings (**first viable v1 candidate**).
  Phase 4 = persistence + vanedb track lands. Phase 5 = local provider (gated on
  Phase 0). Phase 6 = mobile hardening + related notes + release.
- **D6. Testing gotcha:** `pkg/` is `--target web`; Node's fetch can't load
  `file://` — vitest must use `initSync(readFileSync(...))`. CI currently tests a
  *different* artifact (`--node` target) than the one shipped.

## The one genuine disagreement: mobile scope for v1

- **Entrepreneur:** mobile = search-only over a desktop-built, vault-synced index
  (note: conflicts with C5's don't-sync-the-index finding unless explicitly
  export/import).
- **CTO:** cut mobile from v1 entirely (`isDesktopOnly: true`), or ship mobile
  with network providers only; local model desktop-only.
- **TPM:** keep mobile, gate *local-on-mobile* on the Phase-0 device spike;
  default mobile to remote providers.
- **Engineer/architect:** whatever is chosen, spike the mobile embedding path in
  week 1 and set a separate, lower, tested mobile scale ceiling.

Convergence: **nobody defends local-model-on-mobile as a v1 assumption.** The
decision (full mobile / remote-only mobile / desktop-only) is the user's call.

## Second decision point: index storage backend

- **Architect:** IndexedDB for index artifacts (origin-private → sync-proof,
  transactional writes ≈ free commit protocol); only settings in `data.json`.
  Device-local is semantically correct since each device rebuilds its own index.
- **Engineer:** plugin dir with tmp+`adapter.rename`, WAL via `adapter.append`,
  reduced persist cadence, documented sync exclusions.
- Both agree on `vectors.bin`-as-source-of-truth regardless.
