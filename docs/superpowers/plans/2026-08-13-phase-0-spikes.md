# Vane Search Phase 0 — Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the Vane Search design by running seven timeboxed spikes and recording measured answers to the spec's seven Open Questions.

**Architecture:** Spikes are throwaway experiments, not production code. Each spike lives under `spikes/<name>/`, is never imported by `src/`, and produces a findings document in `docs/superpowers/spikes/`. The final task folds all findings back into the spec (`docs/superpowers/specs/2026-08-07-vane-search-design-final.md`) — updated Budgets numbers, answered Open Questions, changed Decisions if any.

**Tech Stack:** Node ≥ 20 (has WebAssembly + BigInt), vanedb-wasm (built from `~/code/vanedb`), `@huggingface/transformers` (transformers.js v3), Obsidian desktop + one real mobile device, Rust via rustup (vanedb work only).

## Global Constraints

- Total timebox: 1 week. Per-spike timeboxes below are hard stops — write down what you learned and move on.
- Spike code is throwaway: everything under `spikes/` is excluded from vitest, esbuild, and CI. Never import it from `src/`.
- Every spike ends with a findings file `docs/superpowers/spikes/2026-08-DD-<name>.md` containing: what was run, raw numbers, the exit-criteria verdict, and the recommendation.
- Rust builds MUST use the rustup toolchain: prefix every cargo/wasm-pack command with `PATH="$HOME/.cargo/bin:$PATH"` (Homebrew rust shadows rustup on this machine and lacks the wasm32 target).
- vanedb source lives at `~/code/vanedb` (override with `VANEDB_DIR`). Its wasm constructor is `new WasmHnswIndex(dim, metric, capacity, m, ef_construction)`; `add(id: bigint, vector: Float32Array)`; `search(query, k)` returns a flat `Float32Array` `[id0, dist0, id1, dist1, ...]`; metric `'dot'` returns **negative dot product** (lower = more similar).
- Reference dimension is 384. All measurements at 384-dim unless the spike says otherwise.

---

### Task S1: Rebuild vanedb-wasm and measure scale/memory (Open Questions 2 & 6)

Timebox: 1 day. Answers: memory ceilings (steady + 2× rebuild peak) and HNSW build params (M, ef_construction, capacity policy).

**Files:**
- Create: `spikes/wasm-scale/run.mjs`
- Create: `docs/superpowers/spikes/2026-08-DD-wasm-scale.md` (findings)

**Interfaces:**
- Consumes: `~/code/vanedb/vanedb-wasm/pkg/` (rebuilt fresh in step 1)
- Produces: numbers for the spec's Budgets section; recommended `{m, efConstruction, capacityPolicy}` consumed by Phase 1 Task 7 defaults

- [ ] **Step 1: Rebuild the wasm pkg from current source** (the checked-in `pkg/` is stale)

```bash
cd ~/code/vanedb/vanedb-wasm
PATH="$HOME/.cargo/bin:$PATH" wasm-pack build --target web --release
```

Expected: `pkg/vanedb_wasm_bg.wasm` regenerated, no errors.

- [ ] **Step 2: Write the measurement harness**

```js
// spikes/wasm-scale/run.mjs — Node ≥ 20. Usage: node run.mjs [sizes...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PKG = process.env.VANEDB_PKG ?? join(process.env.HOME, 'code/vanedb/vanedb-wasm/pkg');
const { initSync, WasmHnswIndex, WasmVectorStore } = await import(join(PKG, 'vanedb_wasm.js'));
const out = initSync({ module: readFileSync(join(PKG, 'vanedb_wasm_bg.wasm')) });

const DIM = 384;
// seeded PRNG so runs are comparable
let seed = 42;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
function unitVec() {
  const v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) { v[i] = rand() * 2 - 1; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const mb = (b) => (b / 1048576).toFixed(1);
const pct = (arr, p) => arr.sort((a, b) => a - b)[Math.floor(arr.length * p)];

function buildIndex(n, m, ef) {
  const idx = new WasmHnswIndex(DIM, 'dot', n, m, ef);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) idx.add(BigInt(i), vecs[i]);
  return { idx, buildMs: performance.now() - t0 };
}

const sizes = process.argv.slice(2).map(Number);
const runs = sizes.length ? sizes : [10_000, 50_000, 100_000];
const maxN = Math.max(...runs);
console.log(`generating ${maxN} vectors...`);
const vecs = Array.from({ length: maxN }, unitVec);
const queries = Array.from({ length: 200 }, unitVec);

for (const n of runs) {
  const before = out.memory.buffer.byteLength;
  const { idx, buildMs } = buildIndex(n, 16, 200);
  const lat = queries.map((q) => { const t = performance.now(); idx.search(q, 10); return performance.now() - t; });
  console.log(`n=${n} build=${(buildMs / 1000).toFixed(1)}s (${(n / (buildMs / 1000)).toFixed(0)}/s) ` +
    `search p50=${pct(lat, 0.5).toFixed(2)}ms p95=${pct(lat, 0.95).toFixed(2)}ms ` +
    `wasmMem=${mb(out.memory.buffer.byteLength - before)}MB rss=${mb(process.memoryUsage().rss)}MB`);
  // 2× rebuild peak: build a second index of the same size while the first is alive
  const { idx: idx2 } = buildIndex(n, 16, 200);
  console.log(`  rebuild-peak: wasmMemTotal=${mb(out.memory.buffer.byteLength)}MB rss=${mb(process.memoryUsage().rss)}MB`);
  idx2.free(); idx.free();
}

// param sweep at 10k: recall@10 vs brute force
const N = 10_000, K = 10;
const store = new WasmVectorStore(DIM, 'dot');
for (let i = 0; i < N; i++) store.add(BigInt(i), vecs[i]);
const truth = queries.map((q) => { const f = store.search(q, K); const s = new Set(); for (let i = 0; i < f.length; i += 2) s.add(f[i]); return s; });
for (const m of [8, 16, 32]) for (const ef of [100, 200, 400]) {
  const { idx, buildMs } = buildIndex(N, m, ef);
  let hit = 0;
  queries.forEach((q, qi) => { const f = idx.search(q, K); for (let i = 0; i < f.length; i += 2) if (truth[qi].has(f[i])) hit++; });
  const lat = queries.map((q) => { const t = performance.now(); idx.search(q, 10); return performance.now() - t; });
  console.log(`m=${m} ef=${ef} recall@10=${(hit / (queries.length * K)).toFixed(3)} build=${(buildMs / 1000).toFixed(1)}s p95=${pct(lat, 0.95).toFixed(2)}ms`);
  idx.free();
}
```

- [ ] **Step 3: Run it**

Run: `node spikes/wasm-scale/run.mjs`
Expected: one line per size 10k/50k/100k plus a 9-row m/ef sweep. Note: 100k insert at ~2–5 ms each may take ~5 min — that is itself a data point (full-rebuild wall-clock).

- [ ] **Step 4: Write findings + exit criteria verdict**

Create `docs/superpowers/spikes/2026-08-DD-wasm-scale.md` with the raw table and answer:
- Steady-state wasm memory at 10k/50k/100k (desktop ceiling recommendation).
- Rebuild peak vs steady ratio (spec assumes ≈2× — confirm or correct).
- Search p95 at 100k vs the < 10 ms budget: PASS/FAIL.
- Chosen defaults for Phase 1: `m`, `efConstruction`, capacity policy (e.g. `max(1024, 2 × expected chunks)`), citing the recall/build/latency trade-off rows.

- [ ] **Step 5: Commit**

```bash
git add spikes/wasm-scale docs/superpowers/spikes
git commit -m "spike: wasm scale/memory measurements (OQ2, OQ6)"
```

---

### Task S2: `to_bytes`/`from_bytes` prototype in vanedb (feeds vanedb work item 1)

Timebox: 0.5 day. Proves the byte-API refactor is a mechanical split of `persistence.rs`, and measures serialized size.

**Files:**
- Modify (in `~/code/vanedb`, branch `spike/bytes-api`): `vanedb/src/hnsw/persistence.rs` (or wherever `save`/`load` live — locate with `grep -rn "pub fn save" vanedb/src/`)
- Create: `docs/superpowers/spikes/2026-08-DD-bytes-api.md` (findings, in THIS repo)

**Interfaces:**
- Produces: confidence + effort estimate for vanedb work item 1; serialized-bytes-per-vector number for the IndexedDB `generations.graphBytes` budget (Phase 4)

- [ ] **Step 1: Create a spike branch in vanedb**

```bash
cd ~/code/vanedb && git checkout -b spike/bytes-api
```

- [ ] **Step 2: Split file I/O from serialization**

Refactor pattern (adapt names to what `persistence.rs` actually contains — it is bincode-based, VERSION=2):

```rust
impl HnswIndex {
    pub fn to_bytes(&self) -> Result<Vec<u8>, VaneError> {
        let mut buf = Vec::new();
        self.write_into(&mut buf)?;   // body of today's save(), minus File::create
        Ok(buf)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, VaneError> {
        Self::read_from(&mut std::io::Cursor::new(bytes))  // body of today's load(), minus File::open
    }
    // save(path) / load(path) become thin wrappers over write_into / read_from
}
```

- [ ] **Step 3: Write the round-trip test**

```rust
#[test]
fn bytes_round_trip_preserves_search_results() {
    let idx = /* build a 1_000-vector index with the existing test helpers in hnsw_tests.rs */;
    let bytes = idx.to_bytes().unwrap();
    let loaded = HnswIndex::from_bytes(&bytes).unwrap();
    let q = /* any test vector */;
    assert_eq!(idx.search(&q, 10), loaded.search(&q, 10));
    println!("serialized: {} bytes for 1000 vectors", bytes.len());
}
```

- [ ] **Step 4: Run the test**

Run: `cd ~/code/vanedb && PATH="$HOME/.cargo/bin:$PATH" cargo test bytes_round_trip -- --nocapture`
Expected: PASS, with serialized size printed.

- [ ] **Step 5: Findings + leave the branch unmerged**

Record in `docs/superpowers/spikes/2026-08-DD-bytes-api.md`: diff size, bytes-per-vector, any surprises (e.g. save() writes multiple files, version header location). The real implementation happens later on the vanedb track with review + cross-binding exposure; do NOT merge the spike. Commit findings in this repo only.

---

### Task S3: Model eval — default local model + similarity floors (Open Questions 1 & 5)

Timebox: 1 day. **USER INPUT REQUIRED:** a real eval set beats a synthetic one. Ask the user for 20–40 `query → expected note` pairs from their dogfood vault plus permission to copy those notes into `spikes/model-eval/corpus/` (gitignored). If unavailable, proceed with a synthetic corpus and mark the model choice PROVISIONAL in findings.

**Files:**
- Create: `spikes/model-eval/run.mjs`, `spikes/model-eval/eval.json`, `spikes/model-eval/corpus/*.md` (gitignored), `spikes/model-eval/.gitignore` (`corpus/`, `node_modules/`)
- Create: `docs/superpowers/spikes/2026-08-DD-model-eval.md`

**Interfaces:**
- Produces: default local model id + query/doc prefixes (Phase 5), per-model similarity floor values (SearchService config), P@3/MRR baseline for the search-quality bar

- [ ] **Step 1: Set up the spike package**

```bash
mkdir -p spikes/model-eval && cd spikes/model-eval
npm init -y && npm i @huggingface/transformers@^3
printf 'corpus/\nnode_modules/\n' > .gitignore
```

- [ ] **Step 2: Create `eval.json`** — format:

```json
[
  { "query": "how do I rotate the API keys", "expected": "ops/key-rotation.md" },
  { "query": "notes from the pricing brainstorm", "expected": "meetings/2026-05-pricing.md" }
]
```

- [ ] **Step 3: Write the eval harness**

```js
// spikes/model-eval/run.mjs
import { pipeline } from '@huggingface/transformers';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const MODELS = [
  { id: 'Xenova/bge-small-en-v1.5', q: 'Represent this sentence for searching relevant passages: ', d: '' },
  { id: 'nomic-ai/nomic-embed-text-v1.5', q: 'search_query: ', d: 'search_document: ' },
  { id: 'Xenova/all-MiniLM-L6-v2', q: '', d: '' },
];
const evalSet = JSON.parse(readFileSync('eval.json', 'utf8'));
const docs = readdirSync('corpus').filter((f) => f.endsWith('.md'))
  .map((f) => ({ path: f, text: `${basename(f, '.md')}\n\n${readFileSync(join('corpus', f), 'utf8')}`.slice(0, 2000) }));

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

for (const m of MODELS) {
  const embed = await pipeline('feature-extraction', m.id, { dtype: 'q8' });
  const opts = { pooling: 'mean', normalize: true };
  const docVecs = [];
  const t0 = performance.now();
  for (const doc of docs) docVecs.push((await embed(m.d + doc.text, opts)).data);
  const embedMs = (performance.now() - t0) / docs.length;
  let mrr = 0, p3 = 0; const topScores = [], noiseScores = [];
  for (const { query, expected } of evalSet) {
    const qv = (await embed(m.q + query, opts)).data;
    const ranked = docs.map((doc, i) => ({ path: doc.path, s: dot(qv, docVecs[i]) })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((r) => r.path === expected) + 1;
    if (rank) mrr += 1 / rank;
    if (rank && rank <= 3) p3++;
    topScores.push(ranked[0].s); noiseScores.push(ranked[ranked.length - 1].s);
  }
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  console.log(`${m.id}: P@3=${(p3 / evalSet.length).toFixed(2)} MRR=${(mrr / evalSet.length).toFixed(3)} ` +
    `embed=${embedMs.toFixed(0)}ms/doc topMed=${med(topScores).toFixed(3)} noiseMed=${med(noiseScores).toFixed(3)}`);
}
```

- [ ] **Step 4: Run** (first run downloads models — note sizes, they feed the Phase-5 download UI)

Run: `cd spikes/model-eval && node run.mjs`
Expected: one line per model. If `nomic-ai/nomic-embed-text-v1.5` lacks ONNX weights for transformers.js, note it and substitute `nomic-ai/nomic-embed-text-v1.5` → `Xenova/nomic-embed-text-v1` (or drop with a note).

- [ ] **Step 5: Findings**

Record: winner (quality vs speed vs download size), chosen per-model similarity floor = midpoint between `topMed` and `noiseMed` (sanity-check against a few known-negative queries), and whether the eval set was real or synthetic. Commit harness + findings (not corpus).

---

### Task S4: transformers.js inside Obsidian desktop + pinned ORT delivery (Open Question 3)

Timebox: 1.5 days. The riskiest Phase-5 assumption: ONNX Runtime web can run inside Obsidian's Electron with NO runtime CDN fetch, using bytes we downloaded, pinned, and served ourselves.

**Files:**
- Create: `spikes/obsidian-probe/` — throwaway plugin: `manifest.json`, `main.ts`, `esbuild.mjs`, `package.json`
- Create: `docs/superpowers/spikes/2026-08-DD-ort-in-obsidian.md`

**Interfaces:**
- Consumes: dev vault from Task S7 (do S7 first if not done)
- Produces: validated (or corrected) design for the spec's "Local provider hardening" section — the exact `env` settings and RPC shape Phase 5 implements

- [ ] **Step 1: Scaffold the throwaway plugin**

```json
// spikes/obsidian-probe/manifest.json
{ "id": "vane-probe", "name": "Vane Probe", "version": "0.0.1", "minAppVersion": "1.5.0",
  "description": "throwaway spike probe", "isDesktopOnly": false }
```

```js
// spikes/obsidian-probe/esbuild.mjs
import esbuild from 'esbuild';
await esbuild.build({ entryPoints: ['main.ts'], bundle: true, format: 'cjs', target: 'es2022',
  external: ['obsidian', 'electron'], outfile: 'main.js', logLevel: 'info' });
```

```bash
cd spikes/obsidian-probe && npm init -y && npm i -D esbuild obsidian typescript && npm i @huggingface/transformers@^3
```

- [ ] **Step 2: Probe A — does it run at all?** Main-thread pipeline, remote models allowed:

```ts
// spikes/obsidian-probe/main.ts
import { Plugin, Notice } from 'obsidian';
import { pipeline, env } from '@huggingface/transformers';

export default class Probe extends Plugin {
  async onload() {
    this.addCommand({ id: 'probe-a', name: 'Probe A: embed (remote allowed)', callback: () => void this.probeA() });
  }
  async probeA() {
    (env.backends.onnx.wasm as any).numThreads = 1;
    (env.backends.onnx.wasm as any).proxy = false;
    const t0 = performance.now();
    const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    const out = await embed('hello vault', { pooling: 'mean', normalize: true });
    new Notice(`dim=${out.data.length} in ${(performance.now() - t0).toFixed(0)}ms`);
  }
}
```

Build, copy `main.js`+`manifest.json` into the dev vault's `.obsidian/plugins/vane-probe/`, enable, run "Probe A". Open DevTools (Cmd-Opt-I) → Network tab first.
Expected: a Notice with `dim=384`, OR a specific failure (record it verbatim). In the Network tab, record EVERY remote URL fetched (jsDelivr ort-wasm, huggingface.co weights/tokenizer) — this is the exact pin list for Phase 5.

- [ ] **Step 3: Probe B — zero-CDN path.** Add a second command that (1) downloads each URL from the Probe-A pin list via Obsidian's `requestUrl`, computes SHA-256 (`crypto.subtle.digest`), stores bytes in IndexedDB; (2) configures transformers.js to consume ONLY those bytes:

```ts
import { requestUrl } from 'obsidian';
async probeB() {
  const cache = await openProbeCache(); // trivial IDB store: url → ArrayBuffer, written on first run
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  (env.backends.onnx.wasm as any).wasmBinary = await cache.get(ORT_WASM_URL); // pinned bytes, no CDN
  env.useBrowserCache = false;
  (env as any).customFetch = async (url: string) => new Response(await cache.get(url)); // serve weights from IDB
  const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
  const out = await embed('hello vault', { pooling: 'mean', normalize: true });
  new Notice(`offline dim=${out.data.length}`);
}
```

(Exact `env` hook names vary by transformers.js version — discovering the working combination IS the spike. Candidates: `env.customFetch`, `env.useCustomCache` + `env.customCache`, `ort.env.wasm.wasmBinary`.)
Expected: embedding produced with the Network tab showing ZERO requests after the initial cached download.

- [ ] **Step 4: Probe C — same thing from a Blob-URL worker.** Move the Probe-B body into a worker created from a Blob URL; proxy `cache.get` over postMessage (the worker cannot touch `requestUrl`/IDB-per-Obsidian). Confirm it still works and the main thread stays responsive during embedding (type in a note while it runs).

- [ ] **Step 5: Findings**

Record: Probe A/B/C verdicts, the pin list (URLs + SHA-256 + sizes), the exact working `env` configuration, main-thread jank observations. Exit criteria: Probe B (zero-CDN) and C (worker) both PASS ⇒ Phase 5 design validated. Either FAIL ⇒ write what the spec's hardening section must change to. Commit spike + findings.

---

### Task S5: Mobile platform probe on a real device (Open Question 4 + v1 mobile viability)

Timebox: 1 day. **USER INPUT REQUIRED:** a phone with Obsidian installed (iOS preferred — it is the stricter platform) and a way to install an unpacked plugin (same vault synced, or file transfer into `.obsidian/plugins/`). v1 ships `isDesktopOnly: false` with remote providers — wasm HNSW + IndexedDB + Blob-URL workers MUST work on mobile even in v1; that is what this probes. The local-model-on-mobile question (v1.1) is only go/no-go color.

**Files:**
- Modify: `spikes/obsidian-probe/main.ts` (add the mobile probe command; reuses the S4 plugin)
- Create: `docs/superpowers/spikes/2026-08-DD-mobile-probe.md`

**Interfaces:**
- Consumes: S4's probe plugin scaffold; vanedb wasm pkg from S1 step 1
- Produces: mobile go/no-go for v1 architecture; measured numbers for the Budgets mobile envelope

- [ ] **Step 1: Add the wasm+IDB probe command**

Inline the wasm (esbuild `loader: { '.wasm': 'binary' }` and `import wasmBytes from './vanedb_wasm_bg.wasm'` after copying the pkg in):

```ts
import { initSync, WasmHnswIndex } from './vanedb_wasm.js';
import wasmBytes from './vanedb_wasm_bg.wasm';

async function probeMobile(): Promise<string> {
  const t0 = performance.now();
  initSync({ module: wasmBytes });
  const idx = new WasmHnswIndex(384, 'dot', 1000, 16, 200);
  const vec = () => Float32Array.from({ length: 384 }, () => Math.random() - 0.5);
  const vs: Float32Array[] = [];
  for (let i = 0; i < 200; i++) { const v = vec(); vs.push(v); idx.add(BigInt(i), v); }
  const flat = idx.search(vs[7], 5);
  const wasmOk = flat[0] === 7; // self-query returns itself
  // IDB round trip
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('vane-probe', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(vs[0], 'v0'); tx.oncomplete = res; tx.onerror = rej; });
  const back = await new Promise<Float32Array>((res, rej) => {
    const rq = db.transaction('kv').objectStore('kv').get('v0');
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const idbOk = back?.length === 384;
  // Blob-URL worker
  const w = new Worker(URL.createObjectURL(new Blob(['postMessage(21*2)'], { type: 'text/javascript' })));
  const workerOk = 42 === await new Promise((res) => { w.onmessage = (e) => res(e.data); setTimeout(() => res(-1), 3000); });
  return `wasm=${wasmOk} idb=${idbOk} worker=${workerOk} total=${(performance.now() - t0).toFixed(0)}ms`;
}
```

- [ ] **Step 2: Run on desktop first** (sanity check the probe itself). Expected Notice: `wasm=true idb=true worker=true`.

- [ ] **Step 3: Run on the real device(s).** Also: force-quit and reopen Obsidian, re-run a read-only variant to confirm the IDB row survived (eviction behavior). Record device model, OS version, all three booleans, timing.

- [ ] **Step 4: Findings.** Exit criteria: all three true on iOS ⇒ v1 mobile architecture confirmed. Any false ⇒ this is a spec-level problem — write exactly which Decision row breaks and the candidate fallback (e.g. worker=false ⇒ main-thread index on mobile with yielding inserts). Commit findings.

---

### Task S6: Smart Connections benchmark protocol (Open Question 7)

Timebox: 0.5 day. The wedge claim ("reproducibly faster large-vault retrieval") needs an honest, reproducible comparison — and first a check that the flat-scan hypothesis about Smart Connections is even true.

**Files:**
- Create: `spikes/benchmark/make-vault.mjs`, `docs/superpowers/spikes/2026-08-DD-benchmark-protocol.md`

**Interfaces:**
- Produces: the written benchmark protocol executed in Phase 5

- [ ] **Step 1: Read Smart Connections' retrieval code** (github.com/brianpetro/obsidian-smart-connections + its `smart-entities` dependency). Answer from source: at query time, does it score every embedded block/note (flat scan) or use an ANN structure? Record file/line evidence.

- [ ] **Step 2: Write the synthetic vault generator**

```js
// spikes/benchmark/make-vault.mjs — Usage: node make-vault.mjs /path/to/bench-vault 10000
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, n] = [process.argv[2], Number(process.argv[3] ?? 10000)];
let seed = 7; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const TOPICS = ['kubernetes', 'sourdough', 'stoicism', 'typescript', 'gardening', 'jazz', 'astronomy', 'rowing'];
const WORDS = ['system', 'note', 'idea', 'plan', 'review', 'draft', 'question', 'insight', 'summary', 'link'];
for (let i = 0; i < n; i++) {
  const topic = TOPICS[i % TOPICS.length];
  const paras = Array.from({ length: 3 + Math.floor(rand() * 5) }, () =>
    Array.from({ length: 40 }, () => (rand() < 0.15 ? topic : WORDS[Math.floor(rand() * WORDS.length)])).join(' '));
  const folder = join(dir, topic); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${topic}-${i}.md`), `# ${topic} note ${i}\n\n${paras.join('\n\n')}\n`);
}
console.log(`wrote ${n} notes to ${dir}`);
```

- [ ] **Step 3: Write the protocol document** covering: vault sizes (2k / 10k), the measured quantity (query→results-rendered latency, cold and warm, via DevTools performance marks), same embedding model on both sides if configurable (else document the difference), n=20 queries × 5 repetitions, report medians, both plugins at default settings, versions pinned. Include the honest-comparison caveats (SC does more than search; measure only retrieval).

- [ ] **Step 4: Dry-run feasibility** — install Smart Connections in a 2k-note generated vault, confirm it indexes and answers queries, confirm the measurement points are observable. Record indexing time as a bonus data point.

- [ ] **Step 5: Findings + commit.** Exit criteria: flat-scan hypothesis confirmed/refuted with evidence; protocol executable in < 1 day when Phase 5 arrives.

---

### Task S7: Dev-loop logistics (do this FIRST — everything else uses it)

Timebox: 0.5 day. Edit → rebuild → see it in Obsidian in < 5 s.

**Files:**
- Create: `docs/superpowers/spikes/2026-08-DD-dev-loop.md`

- [ ] **Step 1: Create a dev vault** at `~/vaults/vane-dev` (Obsidian → Open another vault → Create). Add ~20 real-ish markdown notes (copy from anywhere non-sensitive).

- [ ] **Step 2: Install the hot-reload plugin** — clone `https://github.com/pjeby/hot-reload` into `~/vaults/vane-dev/.obsidian/plugins/hot-reload/` and enable it. It watches plugin folders containing a `.hotreload` marker file and reloads the plugin when `main.js` changes.

- [ ] **Step 3: Verify the loop** with the S4 probe plugin (or any hello-world): `touch .hotreload` in its plugin folder, rebuild with a visible change (bump a Notice string), confirm Obsidian reloads it without restart. Time the loop.

- [ ] **Step 4: Findings:** the exact commands, vault path, and measured loop time. This doc is consumed by Phase 1's manual test steps. Commit.

---

### Task S8: Fold findings back into the spec (closes Phase 0)

**Files:**
- Modify: `docs/superpowers/specs/2026-08-07-vane-search-design-final.md`

- [ ] **Step 1:** Update **Budgets** with measured numbers (memory ceilings steady + rebuild peak, search p95 at scale, model download sizes). Replace "measured in Phase 0" phrasing with the values.

- [ ] **Step 2:** Rewrite **Open questions (Phase 0 resolves)** into answers: default model + floors (S3), HNSW params + capacity policy (S1), ORT delivery verdict (S4), mobile verdict incl. local-on-mobile go/no-go (S5), benchmark protocol reference (S6). If any spike invalidated a Decision row, update the Decisions table and say why.

- [ ] **Step 3:** Commit:

```bash
git add docs/superpowers/specs/2026-08-07-vane-search-design-final.md
git commit -m "docs: record Phase 0 spike results in final spec"
```

---

## Execution notes

- **Order:** S7 first (dev loop), then S1 → S2 (local, no external deps), S3–S6 in any order. S4 before S5 (S5 reuses its plugin). S8 last.
- **Blocked-on-user:** S3 (eval set), S5 (device). Start them early so the user request is in flight while other spikes run.
- **A spike that fails its exit criteria is a SUCCESS** if the findings say precisely what the spec must change to. The only failed spike is an undocumented one.
