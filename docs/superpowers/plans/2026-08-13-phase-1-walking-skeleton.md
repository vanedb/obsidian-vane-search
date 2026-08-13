# Vane Search Phase 1 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Obsidian plugin: run "Index vault" → type a query in the search modal → ranked results → Enter opens the note; kill and restart Obsidian and nothing is lost; CI green with no Rust toolchain.

**Architecture:** Everything durable lives in IndexedDB (five stores; the generation record is the atomic consistency unit). The HNSW index (vanedb-wasm, vendored) lives in a Web Worker and is rebuilt from stored vectors on startup (`MemoryVaneIndex`). Embeddings come from `FakeEmbeddingProvider` (deterministic feature-hashing) — the real providers arrive in Phases 3/5 behind the same interface. Chunks are whole-file in this phase; the real `Chunker` arrives in Phase 2 behind the same row shape.

**Tech Stack:** TypeScript (strict), esbuild (single `main.js`, worker inlined as a string, wasm inlined as binary), vitest + fake-indexeddb for unit tests, real wasm via `initSync(readFileSync(...))` for integration tests, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-08-07-vane-search-design-final.md` — read "Persistence", "Data flow", and "Architecture" before starting.

## Global Constraints

- `manifest.json`: `minAppVersion: "1.11.4"`, `isDesktopOnly: false`, id `vane-search`.
- Single bundle: `main.js` < 3 MB (CI-enforced by `scripts/check-size.mjs`).
- Plugin CI never needs a Rust toolchain: `vendor/vanedb-wasm/` is committed; only `scripts/sync-vanedb.sh` (run manually on a dev machine) touches cargo.
- Metric is `'dot'` on L2-normalized vectors. vanedb returns **distance = −dot** ⇒ plugin-side `score = −distance`, higher is better, identical vectors score ≈ 1.0.
- Ids are JS `number` everywhere except the wasm boundary (`BigInt(vaneId)` on add; `search()` currently returns ids as f32 in a flat array — exact only to 2^24, fine for Phase 1).
- Main thread never touches wasm; workers never touch Obsidian APIs.
- Vault notes are strictly read-only; nothing is written to the vault directory except by the user's own Obsidian.
- IndexedDB database name is namespaced per vault: `vane-search/<vaultId>`.
- Write ordering rule: content-addressed rows (`vectors`, `chunks`) may commit early (orphans are harmless dedupe cache); a file counts as indexed ONLY when its `files` row and the updated generation record commit in the SAME transaction.
- TypeScript `strict: true`; `npm run typecheck` must pass at every commit.

---

### Task 1: Plugin scaffold and build pipeline

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `vitest.config.ts`, `manifest.json`, `versions.json`, `.gitignore`, `src/main.ts`, `src/index/index.worker.ts` (placeholder), `src/globals.d.ts`, `scripts/install-dev.sh`
- Test: `tests/unit/scaffold.test.ts`

**Interfaces:**
- Produces: `npm run build` → `main.js`; `npm test` → vitest; `__INDEX_WORKER_SOURCE__` compile-time global (worker source as string, used by Task 8); `*.wasm` imports resolve to `Uint8Array` (used by Task 8)

- [ ] **Step 1: Write the config files**

```json
// package.json
{
  "name": "vane-search",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "sync-vanedb": "bash scripts/sync-vanedb.sh"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "esbuild": "^0.24.0",
    "fake-indexeddb": "^6.0.0",
    "obsidian": "^1.8.7",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

```js
// esbuild.config.mjs
import esbuild from 'esbuild';

const prod = process.argv.includes('production');

// 1. Bundle the index worker to a self-contained IIFE string (wasm inlined as Uint8Array).
const worker = await esbuild.build({
  entryPoints: ['src/index/index.worker.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  write: false,
  minify: prod,
  loader: { '.wasm': 'binary' },
});

// 2. Bundle the plugin; the worker source is injected as a compile-time string constant.
const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  external: ['obsidian', 'electron'],
  outfile: 'main.js',
  minify: prod,
  logLevel: 'info',
  define: { __INDEX_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  // NOTE: watch mode does not re-bundle the worker; re-run `npm run dev` after editing src/index/**.
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
```

```json
// manifest.json
{
  "id": "vane-search",
  "name": "Vane Search",
  "version": "0.1.0",
  "minAppVersion": "1.11.4",
  "description": "Semantic search for your vault, powered by VaneDB (WASM HNSW index). Local-first.",
  "author": "Anton Tsvetkov",
  "authorUrl": "https://github.com/vanedb/obsidian",
  "isDesktopOnly": false
}
```

```json
// versions.json
{ "0.1.0": "1.11.4" }
```

```
# .gitignore
node_modules/
main.js
spikes/**/node_modules/
spikes/model-eval/corpus/
.DS_Store
```

```ts
// src/globals.d.ts
declare const __INDEX_WORKER_SOURCE__: string;
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}
```

```ts
// src/main.ts — placeholder, fully wired in Task 12
import { Plugin } from 'obsidian';

export default class VaneSearchPlugin extends Plugin {
  async onload() {
    console.log('vane-search: loaded');
  }
}
```

```ts
// src/index/index.worker.ts — placeholder, real body in Task 8
self.onmessage = () => {};
```

```bash
#!/usr/bin/env bash
# scripts/install-dev.sh <vault-path> — copy the built plugin into a dev vault
set -euo pipefail
VAULT="${1:?usage: install-dev.sh /path/to/vault}"
DEST="$VAULT/.obsidian/plugins/vane-search"
mkdir -p "$DEST"
cp main.js manifest.json "$DEST/"
touch "$DEST/.hotreload"
echo "installed to $DEST"
```

- [ ] **Step 2: Write the failing smoke test**

```ts
// tests/unit/scaffold.test.ts
import { describe, it, expect } from 'vitest';
import manifest from '../../manifest.json';
import pkg from '../../package.json';

describe('scaffold', () => {
  it('manifest agrees with package.json and the spec constraints', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.minAppVersion).toBe('1.11.4');
    expect(manifest.isDesktopOnly).toBe(false);
  });
});
```

- [ ] **Step 3: Install and run everything**

Run: `npm install && npm run typecheck && npm run build && npm test`
Expected: typecheck clean; `main.js` produced; 1 test passes.

- [ ] **Step 4: Commit**

```bash
chmod +x scripts/install-dev.sh
git add -A && git commit -m "feat: plugin scaffold with esbuild worker-inlining pipeline"
```

---

### Task 2: Vendor vanedb-wasm and pin the dot-metric contract

**Files:**
- Create: `scripts/sync-vanedb.sh`, `vendor/vanedb-wasm/` (5 files + `PROVENANCE`), `tests/helpers/wasm.ts`
- Test: `tests/integration/wasm-smoke.test.ts`

**Interfaces:**
- Consumes: `~/code/vanedb` checkout (env `VANEDB_DIR` overrides)
- Produces: `vendor/vanedb-wasm/vanedb_wasm.js` exporting `initSync`, `WasmHnswIndex` (`new (dim, metric, capacity, m, ef_construction)`, `add(id: bigint, vector: Float32Array)`, `search(q, k): Float32Array` flat `[id, dist, ...]`, `size()`, `free()`), `WasmVectorStore`; `tests/helpers/wasm.ts` exporting `initWasm(): void`

- [ ] **Step 1: Write the sync script**

```bash
#!/usr/bin/env bash
# scripts/sync-vanedb.sh — rebuild vanedb-wasm from source and vendor the pkg.
# Requires the rustup toolchain: Homebrew rust shadows it and lacks the wasm32 target.
set -euo pipefail
VANEDB="${VANEDB_DIR:-$HOME/code/vanedb}"
export PATH="$HOME/.cargo/bin:$PATH"
(cd "$VANEDB/vanedb-wasm" && wasm-pack build --target web --release)
mkdir -p vendor/vanedb-wasm
rm -f vendor/vanedb-wasm/*
for f in vanedb_wasm.js vanedb_wasm.d.ts vanedb_wasm_bg.wasm vanedb_wasm_bg.wasm.d.ts package.json; do
  cp "$VANEDB/vanedb-wasm/pkg/$f" vendor/vanedb-wasm/
done
cat > vendor/vanedb-wasm/PROVENANCE <<EOF
source: https://github.com/vanedb/vanedb
commit: $(git -C "$VANEDB" rev-parse HEAD)
built:  wasm-pack build --target web --release ($(date -u +%Y-%m-%dT%H:%M:%SZ))
note:   regenerate with scripts/sync-vanedb.sh — do not edit by hand
EOF
echo "vendored $(git -C "$VANEDB" rev-parse --short HEAD)"
```

- [ ] **Step 2: Run it and write the test helper**

Run: `chmod +x scripts/sync-vanedb.sh && npm run sync-vanedb`
Expected: `vendor/vanedb-wasm/` contains 6 files; `PROVENANCE` names the current vanedb commit.

```ts
// tests/helpers/wasm.ts — one-time wasm init for Node tests
import { readFileSync } from 'node:fs';
import { initSync } from '../../vendor/vanedb-wasm/vanedb_wasm.js';

let done = false;
export function initWasm(): void {
  if (done) return;
  initSync({ module: readFileSync(new URL('../../vendor/vanedb-wasm/vanedb_wasm_bg.wasm', import.meta.url)) });
  done = true;
}
```

- [ ] **Step 3: Write the failing contract test**

```ts
// tests/integration/wasm-smoke.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { initWasm } from '../helpers/wasm';
import { WasmHnswIndex } from '../../vendor/vanedb-wasm/vanedb_wasm.js';

// Pins the vanedb contract the whole plugin relies on. If vanedb changes
// semantics, THIS test fails — not a silently inverted ranking in the UI.
describe('vendored vanedb-wasm contract', () => {
  beforeAll(() => initWasm());

  const unit = (...xs: number[]) => {
    const v = new Float32Array(4);
    xs.forEach((x, i) => (v[i] = x));
    const n = Math.hypot(...v);
    return v.map((x) => x / n) as Float32Array;
  };

  it('dot metric returns distance = -dot; identical vector scores ~1.0', () => {
    const idx = new WasmHnswIndex(4, 'dot', 16, 16, 200);
    idx.add(0n, unit(1, 0, 0, 0));
    idx.add(1n, unit(0.6, 0.8, 0, 0)); // dot with e1 = 0.6
    idx.add(2n, unit(0, 0, 1, 0));     // dot with e1 = 0
    const flat = idx.search(unit(1, 0, 0, 0), 3);
    // flat = [id0, dist0, id1, dist1, id2, dist2], ascending distance
    expect(flat[0]).toBe(0);
    expect(-flat[1]).toBeCloseTo(1.0, 3);  // score = -distance
    expect(flat[2]).toBe(1);
    expect(-flat[3]).toBeCloseTo(0.6, 3);
    expect(flat[4]).toBe(2);
    idx.free();
  });

  it('size() and contains() behave', () => {
    const idx = new WasmHnswIndex(4, 'dot', 16, 16, 200);
    idx.add(7n, unit(1, 0, 0, 0));
    expect(idx.size()).toBe(1);
    expect(idx.contains(7n)).toBe(true);
    expect(idx.contains(8n)).toBe(false);
    idx.free();
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/integration/wasm-smoke.test.ts`
Expected: PASS. If the first assertion fails on sign, STOP — the dot-distance convention changed in vanedb; fix the constant in this plan's Global Constraints and tell the user before continuing.

- [ ] **Step 5: Commit** (vendor directory is committed on purpose — CI must not need Rust)

```bash
git add -A && git commit -m "feat: vendor vanedb-wasm with provenance; pin dot-metric contract"
```

---

### Task 3: Content hashing, EmbeddingProvider interface, FakeEmbeddingProvider

**Files:**
- Create: `src/hash.ts`, `src/providers/embedding-provider.ts`, `src/providers/fake.ts`
- Test: `tests/unit/hash.test.ts`, `tests/unit/fake-provider.test.ts`

**Interfaces:**
- Produces:
  - `hash64(text: string): string` — 16-hex-char FNV-1a 64-bit
  - `interface EmbeddingProvider { id: string; model: string; dimension(): number; maxBatch(): number; embed(texts: string[], kind: 'query' | 'doc'): Promise<Float32Array[]> }`
  - `embeddingFingerprint(p: EmbeddingProvider, chunkerVersion: number): string`
  - `l2Normalize(v: Float32Array): Float32Array` (throws on zero/non-finite)
  - `class FakeEmbeddingProvider implements EmbeddingProvider` (constructor `(dim = 64)`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/hash.test.ts
import { describe, it, expect } from 'vitest';
import { hash64 } from '../../src/hash';

describe('hash64', () => {
  it('is deterministic and 16 hex chars', () => {
    expect(hash64('hello')).toBe(hash64('hello'));
    expect(hash64('hello')).toMatch(/^[0-9a-f]{16}$/);
  });
  it('differs on different input, handles empty and unicode', () => {
    expect(hash64('hello')).not.toBe(hash64('hello ')); 
    expect(hash64('')).toMatch(/^[0-9a-f]{16}$/);
    expect(hash64('émoji 🌱')).toBe(hash64('émoji 🌱'));
  });
});
```

```ts
// tests/unit/fake-provider.test.ts
import { describe, it, expect } from 'vitest';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import { l2Normalize, embeddingFingerprint } from '../../src/providers/embedding-provider';

const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('FakeEmbeddingProvider', () => {
  const p = new FakeEmbeddingProvider(64);

  it('is deterministic and L2-normalized', async () => {
    const [a] = await p.embed(['alpha beta gamma'], 'doc');
    const [b] = await p.embed(['alpha beta gamma'], 'doc');
    expect([...a]).toEqual([...b]);
    expect(Math.hypot(...a)).toBeCloseTo(1, 5);
    expect(a.length).toBe(64);
  });

  it('gives overlapping texts higher similarity than disjoint ones', async () => {
    const [q, near, far] = await p.embed(
      ['alpha beta', 'alpha gamma delta', 'epsilon zeta eta'], 'doc');
    expect(dot(q, near)).toBeGreaterThan(dot(q, far));
  });

  it('handles empty text without a zero vector', async () => {
    const [v] = await p.embed([''], 'doc');
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });

  it('fingerprint encodes provider, model, dim and chunker version', () => {
    expect(embeddingFingerprint(p, 0)).toBe('fake:feature-hash-v1:64:c0');
  });
});

describe('l2Normalize', () => {
  it('throws on the zero vector', () => {
    expect(() => l2Normalize(new Float32Array(4))).toThrow();
  });
  it('throws on non-finite values', () => {
    expect(() => l2Normalize(Float32Array.from([1, NaN, 0, 0]))).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/hash.test.ts tests/unit/fake-provider.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/hash.ts — FNV-1a 64-bit over UTF-8 bytes; stable across sessions and platforms.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function hash64(text: string): string {
  let h = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}
```

```ts
// src/providers/embedding-provider.ts
export interface EmbeddingProvider {
  /** Stable short id, part of the embedding fingerprint (e.g. 'fake', 'openai-compat'). */
  readonly id: string;
  readonly model: string;
  dimension(): number;
  maxBatch(): number;
  /** Returns one L2-normalized vector per input text, in order. */
  embed(texts: string[], kind: 'query' | 'doc'): Promise<Float32Array[]>;
}

/** Embedding identity axis (spec "Versioning"): change ⇒ re-embed everything. */
export function embeddingFingerprint(p: EmbeddingProvider, chunkerVersion: number): string {
  return `${p.id}:${p.model}:${p.dimension()}:c${chunkerVersion}`;
}

export function l2Normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) throw new Error(`non-finite component at ${i}`);
    sq += v[i] * v[i];
  }
  const n = Math.sqrt(sq);
  if (n === 0) throw new Error('cannot normalize the zero vector');
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
```

```ts
// src/providers/fake.ts
import { hash64 } from '../hash';
import { l2Normalize, type EmbeddingProvider } from './embedding-provider';

/**
 * Deterministic feature-hashing embedder: token unigrams hashed into dim buckets.
 * Similar texts get similar vectors, so ranking tests are meaningful — the
 * keystone test artifact of the spec. Never ships to users as a real provider.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'feature-hash-v1';
  constructor(private dim = 64) {}
  dimension() { return this.dim; }
  maxBatch() { return 512; }

  async embed(texts: string[], _kind: 'query' | 'doc'): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const tok of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        v[Number(BigInt('0x' + hash64(tok)) % BigInt(this.dim))] += 1;
      }
      if (v.every((x) => x === 0)) v[0] = 1; // empty text → fixed unit vector
      return l2Normalize(v);
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/hash.test.ts tests/unit/fake-provider.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/hash.ts src/providers tests/unit/hash.test.ts tests/unit/fake-provider.test.ts
git commit -m "feat: hash64, EmbeddingProvider interface, FakeEmbeddingProvider"
```

---

### Task 4: Whole-file chunker

**Files:**
- Create: `src/chunker/whole-file.ts`
- Test: `tests/unit/chunker.test.ts`

**Interfaces:**
- Consumes: `hash64` (Task 3)
- Produces:
  - `CHUNKER_VERSION = 0` (whole-file placeholder; Phase 2's real Chunker bumps it — that is an embedding-identity change by design)
  - `interface ChunkRow { occurrenceId: string; inputHash: string; path: string; breadcrumb: string; offsets: [number, number] }` (the persisted shape — no text stored)
  - `chunkWholeFile(path: string, content: string): { row: ChunkRow; embeddedText: string }[]` — exactly one chunk in this phase; `occurrenceId = `${path}#0``; embedded text = `` `${title}\n\n${body}` `` (spec format with an empty breadcrumb collapses to this); YAML frontmatter excluded

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/chunker.test.ts
import { describe, it, expect } from 'vitest';
import { chunkWholeFile, CHUNKER_VERSION } from '../../src/chunker/whole-file';

describe('chunkWholeFile', () => {
  it('produces one chunk with title-prefixed embedded text', () => {
    const [c] = chunkWholeFile('notes/Coffee Brewing.md', 'Grind fine.\nUse 95C water.');
    expect(c.row.occurrenceId).toBe('notes/Coffee Brewing.md#0');
    expect(c.row.path).toBe('notes/Coffee Brewing.md');
    expect(c.row.breadcrumb).toBe('Coffee Brewing');
    expect(c.embeddedText).toBe('Coffee Brewing\n\nGrind fine.\nUse 95C water.');
    expect(c.row.inputHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hash is stable and changes with content OR title', () => {
    const a = chunkWholeFile('a.md', 'same')[0].row.inputHash;
    expect(chunkWholeFile('a.md', 'same')[0].row.inputHash).toBe(a);
    expect(chunkWholeFile('a.md', 'different')[0].row.inputHash).not.toBe(a);
    // title is part of the embedded text ⇒ basename rename re-embeds (spec)
    expect(chunkWholeFile('b.md', 'same')[0].row.inputHash).not.toBe(a);
    // folder move keeps title ⇒ same hash ⇒ re-embed is free (spec)
    expect(chunkWholeFile('other/folder/a.md', 'same')[0].row.inputHash).toBe(a);
  });

  it('skips YAML frontmatter', () => {
    const plain = chunkWholeFile('n.md', 'body text')[0];
    const fm = chunkWholeFile('n.md', '---\ntags: [x]\n---\nbody text')[0];
    expect(fm.embeddedText).toBe(plain.embeddedText);
    expect(fm.row.inputHash).toBe(plain.row.inputHash);
  });

  it('empty note still yields a title-only chunk', () => {
    const [c] = chunkWholeFile('Ideas.md', '');
    expect(c.embeddedText).toBe('Ideas');
    expect(c.row.offsets).toEqual([0, 0]);
  });

  it('offsets cover the body within the original content', () => {
    const content = '---\nk: v\n---\nBody here';
    const [c] = chunkWholeFile('n.md', content);
    expect(content.slice(c.row.offsets[0], c.row.offsets[1])).toBe('Body here');
  });

  it('exports CHUNKER_VERSION 0', () => {
    expect(CHUNKER_VERSION).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/chunker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/chunker/whole-file.ts
import { hash64 } from '../hash';

/** Bumping this is an embedding-identity change: every note re-embeds. */
export const CHUNKER_VERSION = 0;

export interface ChunkRow {
  occurrenceId: string;
  inputHash: string;
  path: string;
  breadcrumb: string;
  offsets: [number, number];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function chunkWholeFile(path: string, content: string): { row: ChunkRow; embeddedText: string }[] {
  const title = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
  const fmMatch = content.match(FRONTMATTER);
  const bodyStart = fmMatch ? fmMatch[0].length : 0;
  const body = content.slice(bodyStart).trim();
  const bodyOffset = bodyStart + content.slice(bodyStart).indexOf(body);
  const embeddedText = body ? `${title}\n\n${body}` : title;
  return [{
    row: {
      occurrenceId: `${path}#0`, // '#' cannot appear in Obsidian file names
      inputHash: hash64(embeddedText),
      path,
      breadcrumb: title,
      offsets: body ? [bodyOffset, bodyOffset + body.length] : [0, 0],
    },
    embeddedText,
  }];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/chunker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chunker tests/unit/chunker.test.ts
git commit -m "feat: whole-file chunker with title-prefixed embedded text"
```

---

### Task 5: IndexedDB schema and transaction helpers

**Files:**
- Create: `src/storage/vane-db.ts`
- Test: `tests/unit/vane-db.test.ts`

**Interfaces:**
- Produces:
  - `DB_VERSION = 1`, `dbName(vaultId: string): string`
  - `openVaneDb(vaultId: string): Promise<IDBDatabase>` — creates stores `vectors` (keyPath `['fingerprint','inputHash']`), `chunks` (`occurrenceId`), `files` (`path`), `generations` (`generation`), `meta` (`key`)
  - `reqAsPromise<T>(req: IDBRequest<T>): Promise<T>`, `txDone(tx: IDBTransaction): Promise<void>`
  - Row shapes: `VectorRow { fingerprint, inputHash, vector: Float32Array }`, `FileRow { path, mtime, size, contentHash, generation }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/vane-db.test.ts
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openVaneDb, reqAsPromise, txDone, dbName, type VectorRow } from '../../src/storage/vane-db';

describe('openVaneDb', () => {
  it('creates the five stores', async () => {
    const db = await openVaneDb('vault-a');
    expect([...db.objectStoreNames].sort()).toEqual(['chunks', 'files', 'generations', 'meta', 'vectors']);
    db.close();
  });

  it('namespaces per vault', async () => {
    expect(dbName('v1')).not.toBe(dbName('v2'));
  });

  it('round-trips a Float32Array vector under a compound key', async () => {
    const db = await openVaneDb('vault-b');
    const row: VectorRow = { fingerprint: 'fake:feature-hash-v1:64:c0', inputHash: 'abc123', vector: Float32Array.from([0.6, 0.8]) };
    const tx = db.transaction('vectors', 'readwrite');
    tx.objectStore('vectors').put(row);
    await txDone(tx);
    const got = await reqAsPromise<VectorRow | undefined>(
      db.transaction('vectors').objectStore('vectors').get(['fake:feature-hash-v1:64:c0', 'abc123']));
    expect(got?.vector).toBeInstanceOf(Float32Array);
    expect([...got!.vector]).toEqual([0.6000000238418579, 0.800000011920929]); // f32 precision
    db.close();
  });

  it('multi-store transaction commits atomically', async () => {
    const db = await openVaneDb('vault-c');
    const tx = db.transaction(['files', 'meta'], 'readwrite');
    tx.objectStore('files').put({ path: 'a.md', mtime: 1, size: 2, contentHash: 'h', generation: 1 });
    tx.objectStore('meta').put({ key: 'schemaVersion', value: 1 });
    await txDone(tx);
    expect(await reqAsPromise(db.transaction('files').objectStore('files').get('a.md'))).toBeTruthy();
    expect(await reqAsPromise(db.transaction('meta').objectStore('meta').get('schemaVersion'))).toBeTruthy();
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/vane-db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/storage/vane-db.ts
export const DB_VERSION = 1;

export interface VectorRow { fingerprint: string; inputHash: string; vector: Float32Array }
export interface FileRow { path: string; mtime: number; size: number; contentHash: string; generation: number }

/** Multiple vaults share one Electron origin — the vault id keeps them apart. */
export function dbName(vaultId: string): string {
  return `vane-search/${vaultId}`;
}

export function openVaneDb(vaultId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(vaultId), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('vectors', { keyPath: ['fingerprint', 'inputHash'] });
      db.createObjectStore('chunks', { keyPath: 'occurrenceId' });
      db.createObjectStore('files', { keyPath: 'path' });
      db.createObjectStore('generations', { keyPath: 'generation' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

export function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

/**
 * Resolves on transaction COMMIT (oncomplete), not on individual request success —
 * this is the durability point. Issue all writes synchronously before awaiting:
 * an `await` between puts lets the transaction auto-commit early.
 */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/vane-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/vane-db.ts tests/unit/vane-db.test.ts
git commit -m "feat: IndexedDB schema (five stores) and transaction helpers"
```

---

### Task 6: Generation store — the atomic consistency unit

**Files:**
- Create: `src/storage/generation-store.ts`
- Test: `tests/unit/generation-store.test.ts`

**Interfaces:**
- Consumes: `openVaneDb`, `reqAsPromise`, `txDone` (Task 5)
- Produces:
  - `interface GenerationRecord { generation: number; state: 'active' | 'building'; embeddingFingerprint: string; graphFingerprint: string; dim: number; idMap: Record<number, string>; tombstones: number[]; nextVaneId: number; snapshotSeq: number }`
  - `newGeneration(generation, opts: { embeddingFingerprint, graphFingerprint, dim }): GenerationRecord` (state `'building'`, empty maps)
  - `saveGeneration(db, rec): Promise<void>`
  - `loadActiveGeneration(db): Promise<GenerationRecord | null>` — highest-numbered `'active'`; `'building'` rows are ignored (they are crash debris or in-progress builds)
  - `activateGeneration(db, rec): Promise<void>` — ONE transaction: put `rec` as `'active'` and delete every other generation row. Mutates `rec.state` to `'active'` in memory — later `saveGeneration(rec)` calls during incremental indexing must NOT demote the persisted row back to `'building'` (a crash after that would lose the active generation)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/generation-store.test.ts
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openVaneDb } from '../../src/storage/vane-db';
import {
  newGeneration, saveGeneration, loadActiveGeneration, activateGeneration,
} from '../../src/storage/generation-store';

const OPTS = { embeddingFingerprint: 'fake:feature-hash-v1:64:c0', graphFingerprint: 'dot:m16:ef200', dim: 64 };
let n = 0;
const freshDb = () => openVaneDb(`gen-test-${n++}`);

describe('generation store', () => {
  it('no generations → loadActive returns null', async () => {
    expect(await loadActiveGeneration(await freshDb())).toBeNull();
  });

  it('activate swaps atomically and removes older generations', async () => {
    const db = await freshDb();
    const g1 = newGeneration(1, OPTS);
    g1.idMap[0] = 'a.md#0';
    await activateGeneration(db, g1);
    const g2 = newGeneration(2, OPTS);
    g2.idMap[0] = 'b.md#0';
    await saveGeneration(db, g2); // building
    await activateGeneration(db, g2);
    const active = await loadActiveGeneration(db);
    expect(active?.generation).toBe(2);
    expect(active?.state).toBe('active');
    // g1 is gone — activate deleted it in the same transaction
    const all = await new Promise<unknown[]>((res) => {
      const r = db.transaction('generations').objectStore('generations').getAll();
      r.onsuccess = () => res(r.result);
    });
    expect(all).toHaveLength(1);
  });

  it('CRASH before activate: building row is ignored, old active survives', async () => {
    const db = await freshDb();
    const g1 = newGeneration(1, OPTS);
    await activateGeneration(db, g1);
    const g2 = newGeneration(2, OPTS); // crash: saved as building, never activated
    await saveGeneration(db, g2);
    expect((await loadActiveGeneration(db))?.generation).toBe(1);
  });

  it('round-trips idMap, tombstones, nextVaneId', async () => {
    const db = await freshDb();
    const g = newGeneration(1, OPTS);
    g.idMap[0] = 'a.md#0';
    g.idMap[1] = 'b.md#0';
    g.tombstones.push(0);
    g.nextVaneId = 2;
    await activateGeneration(db, g);
    const back = await loadActiveGeneration(db);
    expect(back?.idMap).toEqual({ 0: 'a.md#0', 1: 'b.md#0' });
    expect(back?.tombstones).toEqual([0]);
    expect(back?.nextVaneId).toBe(2);
    expect(back?.dim).toBe(64);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/generation-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/storage/generation-store.ts
import { reqAsPromise, txDone } from './vane-db';

/**
 * The atomic consistency unit (spec "Persistence"): everything needed to
 * interpret the index — id mapping, tombstones, id counter, identity
 * fingerprints — commits together or not at all.
 */
export interface GenerationRecord {
  generation: number;
  state: 'active' | 'building';
  embeddingFingerprint: string;
  graphFingerprint: string;
  dim: number;
  idMap: Record<number, string>; // vaneId → occurrenceId
  tombstones: number[];
  nextVaneId: number;
  snapshotSeq: number; // replacement-build replay marker; unused until Phase 4
}

export function newGeneration(
  generation: number,
  opts: { embeddingFingerprint: string; graphFingerprint: string; dim: number },
): GenerationRecord {
  return {
    generation, state: 'building', ...opts,
    idMap: {}, tombstones: [], nextVaneId: 0, snapshotSeq: 0,
  };
}

export async function saveGeneration(db: IDBDatabase, rec: GenerationRecord): Promise<void> {
  const tx = db.transaction('generations', 'readwrite');
  tx.objectStore('generations').put(rec);
  await txDone(tx);
}

export async function loadActiveGeneration(db: IDBDatabase): Promise<GenerationRecord | null> {
  const all = await reqAsPromise<GenerationRecord[]>(
    db.transaction('generations').objectStore('generations').getAll());
  const actives = all.filter((g) => g.state === 'active');
  if (actives.length === 0) return null;
  return actives.reduce((a, b) => (b.generation > a.generation ? b : a));
}

/**
 * One transaction: the new record becomes active and every other row dies with it.
 * Mutates rec.state in memory on purpose: subsequent saveGeneration(rec) calls
 * (incremental indexing re-persists the record) must keep it 'active' — writing
 * a copy here would let them silently demote the row back to 'building'.
 */
export function activateGeneration(db: IDBDatabase, rec: GenerationRecord): Promise<void> {
  rec.state = 'active';
  return new Promise((resolve, reject) => {
    const tx = db.transaction('generations', 'readwrite');
    const store = tx.objectStore('generations');
    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      for (const key of keysReq.result) if (key !== rec.generation) store.delete(key);
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('activate failed'));
    tx.onabort = () => reject(tx.error ?? new Error('activate aborted'));
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/generation-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/generation-store.ts tests/unit/generation-store.test.ts
git commit -m "feat: generation store with atomic activate and crash semantics"
```

---

### Task 7: VaneIndex seam and MemoryVaneIndex

**Files:**
- Create: `src/index/vane-index.ts`, `src/index/memory-vane-index.ts`
- Test: `tests/integration/memory-vane-index.test.ts`

**Interfaces:**
- Consumes: vendored `WasmHnswIndex` (Task 2); caller must run `initSync` first (worker glue does it in prod, `tests/helpers/wasm.ts` in tests)
- Produces:
  - `interface IndexHit { vaneId: number; score: number }`
  - `interface VaneIndex { insert(vaneId: number, vector: Float32Array): void; search(query: Float32Array, k: number): IndexHit[]; size(): number; free(): void }`
  - `class MemoryVaneIndex implements VaneIndex` — constructor `({ dim, capacity, m = 16, efConstruction = 200 })`, metric hardwired `'dot'`, `score = -distance`
  - `capacityFor(expected: number): number` = `Math.max(1024, 2 * expected)` — lives in `vane-index.ts` so the main thread can import it WITHOUT pulling the wasm glue into the main bundle

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/memory-vane-index.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { initWasm } from '../helpers/wasm';
import { MemoryVaneIndex } from '../../src/index/memory-vane-index';
import { capacityFor } from '../../src/index/vane-index';
import { FakeEmbeddingProvider } from '../../src/providers/fake';

describe('MemoryVaneIndex', () => {
  beforeAll(() => initWasm());

  it('ranks an exact re-embedding of a doc first, score ~1', async () => {
    const p = new FakeEmbeddingProvider(64);
    const docs = ['coffee brewing with a v60', 'kubernetes cluster upgrades', 'sourdough starter feeding'];
    const vecs = await p.embed(docs, 'doc');
    const idx = new MemoryVaneIndex({ dim: 64, capacity: capacityFor(docs.length) });
    vecs.forEach((v, i) => idx.insert(i, v));
    const [q] = await p.embed(['coffee brewing with a v60'], 'query');
    const hits = idx.search(q, 3);
    expect(hits[0].vaneId).toBe(0);
    expect(hits[0].score).toBeCloseTo(1.0, 3);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    idx.free();
  });

  it('size() tracks inserts; ids round-trip as numbers', async () => {
    const idx = new MemoryVaneIndex({ dim: 4, capacity: 1024 });
    idx.insert(41, Float32Array.from([1, 0, 0, 0]));
    idx.insert(999, Float32Array.from([0, 1, 0, 0]));
    expect(idx.size()).toBe(2);
    expect(idx.search(Float32Array.from([0, 1, 0, 0]), 1)[0].vaneId).toBe(999);
    idx.free();
  });

  it('surfaces a clear error at capacity', () => {
    const idx = new MemoryVaneIndex({ dim: 4, capacity: 1 });
    idx.insert(0, Float32Array.from([1, 0, 0, 0]));
    expect(() => idx.insert(1, Float32Array.from([0, 1, 0, 0]))).toThrow(/capacity|full/i);
    idx.free();
  });

  it('capacityFor gives 2x with a floor', () => {
    expect(capacityFor(10)).toBe(1024);
    expect(capacityFor(10_000)).toBe(20_000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/memory-vane-index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/index/vane-index.ts
export interface IndexHit { vaneId: number; score: number }

/** Seam between MemoryVaneIndex (v1) and PersistentVaneIndex (Phase 4, byte API). */
export interface VaneIndex {
  insert(vaneId: number, vector: Float32Array): void;
  /** Hits sorted by descending score (score = -distance for the dot metric). */
  search(query: Float32Array, k: number): IndexHit[];
  size(): number;
  free(): void;
}

export interface VaneIndexOptions { dim: number; capacity: number; m?: number; efConstruction?: number }

/** vanedb pre-allocates capacity eagerly and IndexFull is a hard error — 2× headroom, floor 1024. */
export function capacityFor(expected: number): number {
  return Math.max(1024, 2 * expected);
}
```

```ts
// src/index/memory-vane-index.ts
import { WasmHnswIndex } from '../../vendor/vanedb-wasm/vanedb_wasm.js';
import type { IndexHit, VaneIndex, VaneIndexOptions } from './vane-index';

export class MemoryVaneIndex implements VaneIndex {
  private idx: WasmHnswIndex;

  constructor(opts: VaneIndexOptions) {
    this.idx = new WasmHnswIndex(opts.dim, 'dot', opts.capacity, opts.m ?? 16, opts.efConstruction ?? 200);
  }

  insert(vaneId: number, vector: Float32Array): void {
    try {
      this.idx.add(BigInt(vaneId), vector);
    } catch (e) {
      throw new Error(`index insert failed (capacity ${this.idx.size()} used?): ${String(e)}`);
    }
  }

  search(query: Float32Array, k: number): IndexHit[] {
    const flat = this.idx.search(query, k); // [id0, dist0, id1, dist1, ...] ascending distance
    const hits: IndexHit[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      hits.push({ vaneId: flat[i], score: -flat[i + 1] });
    }
    return hits;
  }

  size(): number { return this.idx.size(); }
  free(): void { this.idx.free(); }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/integration/memory-vane-index.test.ts`
Expected: PASS. (If the capacity test's error message doesn't match `/capacity|full/i`, adjust the wrapper message — the requirement is a clear, typed-at-the-boundary error, not vanedb's raw string.)

- [ ] **Step 5: Commit**

```bash
git add src/index/vane-index.ts src/index/memory-vane-index.ts tests/integration/memory-vane-index.test.ts
git commit -m "feat: VaneIndex seam and MemoryVaneIndex over wasm HNSW"
```

---

### Task 8: Index worker protocol — host, client, worker glue

**Files:**
- Create: `src/index/index-host.ts`, `src/index/index-client.ts`, `src/index/spawn-worker.ts`
- Modify: `src/index/index.worker.ts` (replace the Task 1 placeholder)
- Test: `tests/unit/index-host.test.ts`, `tests/helpers/loopback.ts`

**Interfaces:**
- Consumes: `VaneIndex`, `MemoryVaneIndex`, `VaneIndexOptions` (Task 7)
- Produces:
  - Message types: `IndexRequest = { id, type: 'init', dim, capacity } | { id, type: 'insert', entries: { vaneId, vector }[] } | { id, type: 'search', query, k } | { id, type: 'stats' }`; `IndexResponse = { id, ok: true, result?: unknown } | { id, ok: false, error: string }`
  - `createIndexHost(factory: (opts: VaneIndexOptions) => VaneIndex): (msg: IndexRequest) => IndexResponse` — pure dispatcher, no worker needed to test it
  - `interface Transport { post(msg: IndexRequest): void; onResponse(cb: (r: IndexResponse) => void): void }`
  - `class IndexClient` — `init(dim, capacity)`, `insert(entries): Promise<void>`, `search(query, k): Promise<IndexHit[]>`, `stats(): Promise<{ size: number; ready: boolean }>`
  - `loopbackTransport(handle)` (tests), `workerTransport(w: Worker)`, `spawnIndexWorker(): Worker` (Blob URL from `__INDEX_WORKER_SOURCE__`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/helpers/loopback.ts — client and host in one process, no Worker
import type { IndexRequest, IndexResponse, Transport } from '../../src/index/index-client';

export function loopbackTransport(handle: (msg: IndexRequest) => IndexResponse): Transport {
  let cb: (r: IndexResponse) => void = () => {};
  return {
    post: (msg) => queueMicrotask(() => cb(handle(msg))),
    onResponse: (c) => { cb = c; },
  };
}
```

```ts
// tests/unit/index-host.test.ts
import { describe, it, expect } from 'vitest';
import { createIndexHost } from '../../src/index/index-host';
import { IndexClient } from '../../src/index/index-client';
import { loopbackTransport } from '../helpers/loopback';
import type { IndexHit, VaneIndex, VaneIndexOptions } from '../../src/index/vane-index';

/** Deterministic stub index: score = 1 / (1 + |queryLen - vaneId|), no wasm involved. */
class StubIndex implements VaneIndex {
  ids: number[] = [];
  insert(vaneId: number) { this.ids.push(vaneId); }
  search(query: Float32Array, k: number): IndexHit[] {
    return this.ids
      .map((id) => ({ vaneId: id, score: 1 / (1 + Math.abs(query.length - id)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
  size() { return this.ids.length; }
  free() {}
}

describe('index host protocol', () => {
  const setup = () => {
    let stub: StubIndex | null = null;
    const handle = createIndexHost((opts: VaneIndexOptions) => (stub = new StubIndex()));
    return { client: new IndexClient(loopbackTransport(handle)), getStub: () => stub };
  };

  it('init → insert → search → stats round-trip', async () => {
    const { client } = setup();
    await client.init(64, 1024);
    await client.insert([{ vaneId: 3, vector: new Float32Array(64) }, { vaneId: 64, vector: new Float32Array(64) }]);
    const hits = await client.search(new Float32Array(64), 2);
    expect(hits[0].vaneId).toBe(64); // |64-64| = 0 → best
    expect(await client.stats()).toEqual({ size: 2, ready: true });
  });

  it('search before init rejects with a useful error', async () => {
    const { client } = setup();
    await expect(client.search(new Float32Array(4), 1)).rejects.toThrow(/not initialized/i);
  });

  it('errors are per-request: a failed call does not poison the next one', async () => {
    const { client } = setup();
    await expect(client.insert([{ vaneId: 0, vector: new Float32Array(4) }])).rejects.toThrow(/not initialized/i);
    await client.init(4, 16);
    await client.insert([{ vaneId: 0, vector: new Float32Array(4) }]);
    expect((await client.stats()).size).toBe(1);
  });

  it('interleaved requests resolve to their own responses', async () => {
    const { client } = setup();
    await client.init(4, 16);
    await client.insert([{ vaneId: 1, vector: new Float32Array(4) }]);
    const [a, b] = await Promise.all([client.stats(), client.search(new Float32Array(4), 1)]);
    expect(a).toEqual({ size: 1, ready: true });
    expect(b[0].vaneId).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/index-host.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/index/index-client.ts
import type { IndexHit } from './vane-index';

export type IndexRequest =
  | { id: number; type: 'init'; dim: number; capacity: number }
  | { id: number; type: 'insert'; entries: { vaneId: number; vector: Float32Array }[] }
  | { id: number; type: 'search'; query: Float32Array; k: number }
  | { id: number; type: 'stats' };

export type IndexResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

export interface Transport {
  post(msg: IndexRequest): void;
  onResponse(cb: (r: IndexResponse) => void): void;
}

export class IndexClient {
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;

  constructor(private transport: Transport) {
    transport.onResponse((r) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      r.ok ? p.resolve(r.result) : p.reject(new Error(r.error));
    });
  }

  private call(msg: Omit<IndexRequest, 'id'>): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.post({ ...msg, id } as IndexRequest);
    });
  }

  init(dim: number, capacity: number): Promise<void> {
    return this.call({ type: 'init', dim, capacity }) as Promise<void>;
  }
  insert(entries: { vaneId: number; vector: Float32Array }[]): Promise<void> {
    return this.call({ type: 'insert', entries }) as Promise<void>;
  }
  search(query: Float32Array, k: number): Promise<IndexHit[]> {
    return this.call({ type: 'search', query, k }) as Promise<IndexHit[]>;
  }
  stats(): Promise<{ size: number; ready: boolean }> {
    return this.call({ type: 'stats' }) as Promise<{ size: number; ready: boolean }>;
  }
}

export function workerTransport(w: Worker): Transport {
  return {
    post: (msg) => w.postMessage(msg),
    onResponse: (cb) => { w.onmessage = (e: MessageEvent) => cb(e.data as IndexResponse); },
  };
}
```

```ts
// src/index/index-host.ts
import type { VaneIndex, VaneIndexOptions } from './vane-index';
import type { IndexRequest, IndexResponse } from './index-client';

/** Pure request dispatcher — the worker glue is 3 lines, everything testable lives here. */
export function createIndexHost(
  factory: (opts: VaneIndexOptions) => VaneIndex,
): (msg: IndexRequest) => IndexResponse {
  let index: VaneIndex | null = null;
  return (msg) => {
    try {
      switch (msg.type) {
        case 'init':
          index?.free();
          index = factory({ dim: msg.dim, capacity: msg.capacity });
          return { id: msg.id, ok: true };
        case 'insert': {
          if (!index) throw new Error('index not initialized');
          for (const e of msg.entries) index.insert(e.vaneId, e.vector);
          return { id: msg.id, ok: true };
        }
        case 'search': {
          if (!index) throw new Error('index not initialized');
          return { id: msg.id, ok: true, result: index.search(msg.query, msg.k) };
        }
        case 'stats':
          return { id: msg.id, ok: true, result: { size: index?.size() ?? 0, ready: index !== null } };
      }
    } catch (e) {
      return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
```

```ts
// src/index/index.worker.ts — worker glue; bundled standalone by esbuild, wasm inlined
import { initSync } from '../../vendor/vanedb-wasm/vanedb_wasm.js';
import wasmBytes from '../../vendor/vanedb-wasm/vanedb_wasm_bg.wasm';
import { createIndexHost } from './index-host';
import { MemoryVaneIndex } from './memory-vane-index';
import type { IndexRequest } from './index-client';

initSync({ module: wasmBytes });
const handle = createIndexHost((opts) => new MemoryVaneIndex(opts));
const scope = self as unknown as { onmessage: unknown; postMessage(m: unknown): void };
scope.onmessage = (e: MessageEvent) => scope.postMessage(handle(e.data as IndexRequest));
```

```ts
// src/index/spawn-worker.ts — main-thread side; __INDEX_WORKER_SOURCE__ injected by esbuild
export function spawnIndexWorker(): Worker {
  const blob = new Blob([__INDEX_WORKER_SOURCE__], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

- [ ] **Step 4: Run tests and the full build**

Run: `npx vitest run tests/unit/index-host.test.ts && npm run build`
Expected: tests PASS; build succeeds (worker bundle now includes wasm — check `main.js` grew by roughly the 82 KB wasm ×1.4 base64 overhead, still far under 3 MB).

- [ ] **Step 5: Commit**

```bash
git add src/index tests/unit/index-host.test.ts tests/helpers/loopback.ts
git commit -m "feat: index worker protocol - pure host, promise client, blob-url spawn"
```

---

### Task 9: Full-vault indexing run

**Files:**
- Create: `src/indexer/full-index.ts`, `tests/helpers/memory-files.ts`
- Test: `tests/integration/index-and-search.test.ts` (first half; Task 10 adds the restart half)

**Interfaces:**
- Consumes: Tasks 3–8 (`chunkWholeFile`, `EmbeddingProvider`, db helpers, `GenerationRecord`, `IndexClient`)
- Produces:
  - `interface FileMeta { path: string; mtime: number; size: number }`
  - `interface FileSource { list(): FileMeta[]; read(path: string): Promise<string> }` (main.ts adapts Obsidian's Vault to this in Task 12; tests use an in-memory fake)
  - `runFullIndex(deps: { db, source, provider, client, gen, onProgress? }): Promise<{ indexed: number; skipped: number }>` — mutates and persists `gen` (idMap/tombstones/nextVaneId)

- [ ] **Step 1: Write the in-memory FileSource helper**

```ts
// tests/helpers/memory-files.ts
import type { FileMeta, FileSource } from '../../src/indexer/full-index';

export class MemoryFileSource implements FileSource {
  private files = new Map<string, { content: string; mtime: number }>();
  set(path: string, content: string, mtime = 1) { this.files.set(path, { content, mtime }); }
  delete(path: string) { this.files.delete(path); }
  list(): FileMeta[] {
    return [...this.files.entries()].map(([path, f]) => ({ path, mtime: f.mtime, size: f.content.length }));
  }
  async read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return f.content;
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/integration/index-and-search.test.ts
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { initWasm } from '../helpers/wasm';
import { loopbackTransport } from '../helpers/loopback';
import { MemoryFileSource } from '../helpers/memory-files';
import { openVaneDb, reqAsPromise } from '../../src/storage/vane-db';
import { newGeneration, saveGeneration, activateGeneration, loadActiveGeneration } from '../../src/storage/generation-store';
import { createIndexHost } from '../../src/index/index-host';
import { IndexClient } from '../../src/index/index-client';
import { MemoryVaneIndex } from '../../src/index/memory-vane-index';
import { capacityFor } from '../../src/index/vane-index';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';
import { CHUNKER_VERSION } from '../../src/chunker/whole-file';
import { runFullIndex } from '../../src/indexer/full-index';

beforeAll(() => initWasm());

const provider = new FakeEmbeddingProvider(64);
const FP = embeddingFingerprint(provider, CHUNKER_VERSION);
const GRAPH_FP = 'dot:m16:ef200';

function freshClient() {
  return new IndexClient(loopbackTransport(createIndexHost((o) => new MemoryVaneIndex(o))));
}

async function searchOccurrences(client: IndexClient, gen: { idMap: Record<number, string>; tombstones: number[] }, text: string) {
  const [q] = await provider.embed([text], 'query');
  const tomb = new Set(gen.tombstones);
  return (await client.search(q, 10))
    .filter((h) => !tomb.has(h.vaneId) && gen.idMap[h.vaneId])
    .map((h) => gen.idMap[h.vaneId]);
}

let n = 0;
async function setup() {
  const db = await openVaneDb(`pipeline-${n++}`);
  const source = new MemoryFileSource();
  source.set('coffee.md', 'v60 pourover brewing ratios and grind size');
  source.set('k8s.md', 'kubernetes cluster upgrade checklist and rollback');
  source.set('bread.md', 'sourdough starter feeding schedule');
  const client = freshClient();
  await client.init(64, capacityFor(100));
  const gen = newGeneration(1, { embeddingFingerprint: FP, graphFingerprint: GRAPH_FP, dim: 64 });
  await saveGeneration(db, gen);
  return { db, source, client, gen };
}

describe('runFullIndex', () => {
  it('indexes all files; a relevant query finds the right note', async () => {
    const { db, source, client, gen } = await setup();
    const res = await runFullIndex({ db, source, provider, client, gen });
    expect(res).toEqual({ indexed: 3, skipped: 0 });
    expect((await searchOccurrences(client, gen, 'sourdough feeding'))[0]).toBe('bread.md#0');
    // durable rows exist
    expect(await reqAsPromise(db.transaction('files').objectStore('files').get('coffee.md'))).toBeTruthy();
    expect(await reqAsPromise(db.transaction('chunks').objectStore('chunks').get('coffee.md#0'))).toBeTruthy();
  });

  it('second run over unchanged files is a no-op', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    const before = gen.nextVaneId;
    const res2 = await runFullIndex({ db, source, provider, client, gen });
    expect(res2).toEqual({ indexed: 0, skipped: 3 });
    expect(gen.nextVaneId).toBe(before);
  });

  it('a modified file gets a new vaneId and tombstones the old one', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    const oldId = Number(Object.entries(gen.idMap).find(([, occ]) => occ === 'bread.md#0')![0]);
    source.set('bread.md', 'completely different: rye flour hydration experiments', 2);
    const res = await runFullIndex({ db, source, provider, client, gen });
    expect(res.indexed).toBe(1);
    expect(gen.tombstones).toContain(oldId);
    expect(gen.idMap[oldId]).toBeUndefined();
    const occ = await searchOccurrences(client, gen, 'rye flour hydration');
    expect(occ[0]).toBe('bread.md#0');
    // the persisted generation matches the in-memory one
    const persisted = await loadActiveGeneration(db);
    expect(persisted).toBeNull(); // still 'building' — activation is the caller's move
  });

  it('identical embedded text embeds once (vector dedupe) but both occurrences are searchable', async () => {
    const { db, source, client, gen } = await setup();
    // same basename in different folders → same title + same body → same inputHash
    source.set('a/dup.md', 'duplicate content here');
    source.set('b/dup.md', 'duplicate content here');
    let embedCalls = 0;
    const counting = new Proxy(provider, {
      get(target, prop) {
        if (prop === 'embed') {
          return (texts: string[], kind: 'query' | 'doc') => { embedCalls += texts.length; return target.embed(texts, kind); };
        }
        return Reflect.get(target, prop);
      },
    });
    await runFullIndex({ db, source, provider: counting, client, gen });
    expect(embedCalls).toBe(4); // 3 setup files + ONE dup; the second dup hit the vectors store
    const occ = await searchOccurrences(client, gen, 'duplicate content here');
    expect(new Set(occ.slice(0, 2))).toEqual(new Set(['a/dup.md#0', 'b/dup.md#0']));
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/integration/index-and-search.test.ts`
Expected: FAIL — `runFullIndex` not found.

- [ ] **Step 4: Implement**

```ts
// src/indexer/full-index.ts
import { reqAsPromise, txDone, type FileRow, type VectorRow } from '../storage/vane-db';
import type { GenerationRecord } from '../storage/generation-store';
import type { EmbeddingProvider } from '../providers/embedding-provider';
import type { IndexClient } from '../index/index-client';
import { chunkWholeFile, type ChunkRow } from '../chunker/whole-file';
import { hash64 } from '../hash';

export interface FileMeta { path: string; mtime: number; size: number }
export interface FileSource { list(): FileMeta[]; read(path: string): Promise<string> }

/**
 * Write-ordering contract (spec "Data flow"):
 *   1. vectors + chunks rows commit first (content-addressed — orphans are harmless cache),
 *   2. the live index insert happens next (volatile — rebuilt from IDB on restart),
 *   3. the files row and generation record commit LAST, in one transaction.
 * A crash at any point leaves the store consistent: a file is "indexed" only if step 3 committed.
 */
export async function runFullIndex(deps: {
  db: IDBDatabase;
  source: FileSource;
  provider: EmbeddingProvider;
  client: IndexClient;
  gen: GenerationRecord;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ indexed: number; skipped: number }> {
  const { db, source, provider, client, gen } = deps;
  const files = source.list();
  const fileRows = new Map<string, FileRow>(
    (await reqAsPromise<FileRow[]>(db.transaction('files').objectStore('files').getAll())).map((r) => [r.path, r]),
  );
  const rev = new Map<string, number>(); // occurrenceId → vaneId
  for (const [vid, occ] of Object.entries(gen.idMap)) rev.set(occ, Number(vid));

  let indexed = 0, skipped = 0, done = 0;

  for (const f of files) {
    const prev = fileRows.get(f.path);
    if (prev && prev.mtime === f.mtime && prev.size === f.size) {
      skipped++; deps.onProgress?.(++done, files.length); continue;
    }

    const content = await source.read(f.path);
    const chunks = chunkWholeFile(f.path, content);

    // Which chunks actually changed? Compare against the persisted chunk rows.
    const changed: { row: ChunkRow; embeddedText: string }[] = [];
    for (const c of chunks) {
      const oldRow = await reqAsPromise<ChunkRow | undefined>(
        db.transaction('chunks').objectStore('chunks').get(c.row.occurrenceId));
      if (!oldRow || oldRow.inputHash !== c.row.inputHash || !rev.has(c.row.occurrenceId)) changed.push(c);
    }

    if (changed.length > 0) {
      // Step 1a: embed only what has no stored vector yet (dedupe by inputHash).
      const missing: typeof changed = [];
      for (const c of changed) {
        const have = await reqAsPromise<VectorRow | undefined>(
          db.transaction('vectors').objectStore('vectors').get([gen.embeddingFingerprint, c.row.inputHash]));
        if (!have) missing.push(c);
      }
      const embedded = missing.length ? await provider.embed(missing.map((c) => c.embeddedText), 'doc') : [];

      // Step 1b: vectors + chunks commit together, before anything references them.
      const tx1 = db.transaction(['vectors', 'chunks'], 'readwrite');
      missing.forEach((c, i) => tx1.objectStore('vectors').put(
        { fingerprint: gen.embeddingFingerprint, inputHash: c.row.inputHash, vector: embedded[i] } satisfies VectorRow));
      chunks.forEach((c) => tx1.objectStore('chunks').put(c.row));
      await txDone(tx1);

      // Step 2: insert into the live index; supersede old occurrences via tombstones.
      const entries: { vaneId: number; vector: Float32Array }[] = [];
      for (const c of changed) {
        const vecRow = await reqAsPromise<VectorRow>(
          db.transaction('vectors').objectStore('vectors').get([gen.embeddingFingerprint, c.row.inputHash]));
        const old = rev.get(c.row.occurrenceId);
        if (old !== undefined) {
          gen.tombstones.push(old);
          delete gen.idMap[old];
        }
        const vaneId = gen.nextVaneId++;
        gen.idMap[vaneId] = c.row.occurrenceId;
        rev.set(c.row.occurrenceId, vaneId);
        entries.push({ vaneId, vector: vecRow.vector });
      }
      await client.insert(entries);
      indexed++;
    } else {
      skipped++;
    }

    // Step 3: files row + generation record — the atomic "this file is indexed" commit.
    const tx2 = db.transaction(['files', 'generations'], 'readwrite');
    tx2.objectStore('files').put({
      path: f.path, mtime: f.mtime, size: f.size,
      contentHash: hash64(content), generation: gen.generation,
    } satisfies FileRow);
    tx2.objectStore('generations').put(gen);
    await txDone(tx2);

    deps.onProgress?.(++done, files.length);
  }
  return { indexed, skipped };
}
```

(Deleted-file reconciliation is deliberately absent — Phase 2's `Indexer` owns it. A file removed from the vault keeps serving until then; note this in the PR description.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/integration/index-and-search.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/indexer tests/helpers/memory-files.ts tests/integration/index-and-search.test.ts
git commit -m "feat: full-vault indexing run with durable write ordering and tombstones"
```

---

### Task 10: Startup load path — kill and restart loses nothing

**Files:**
- Create: `src/indexer/load-generation.ts`
- Test: extend `tests/integration/index-and-search.test.ts`

**Interfaces:**
- Consumes: Tasks 5–9
- Produces: `loadGenerationIntoIndex(deps: { db, client, gen, onProgress? }): Promise<{ loaded: number; missing: string[] }>` — rebuilds the worker index from stored vectors; `missing` lists occurrenceIds whose chunk/vector rows are gone (drift, surfaced not silently dropped)

- [ ] **Step 1: Write the failing tests** (append to `tests/integration/index-and-search.test.ts`)

```ts
import { loadGenerationIntoIndex } from '../../src/indexer/load-generation';

describe('restart: rebuild from IndexedDB', () => {
  it('kill + restart loses nothing — identical results, tombstones respected', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    // create a tombstone before "crashing"
    source.set('bread.md', 'rye flour hydration experiments', 2);
    await runFullIndex({ db, source, provider, client, gen });
    await activateGeneration(db, gen);
    const before = await searchOccurrences(client, gen, 'rye flour hydration');

    // ---- simulated restart: fresh worker, state only from IDB ----
    const client2 = freshClient();
    const gen2 = (await loadActiveGeneration(db))!;
    expect(gen2.generation).toBe(gen.generation);
    await client2.init(gen2.dim, capacityFor(Object.keys(gen2.idMap).length + gen2.tombstones.length));
    const { loaded, missing } = await loadGenerationIntoIndex({ db, client: client2, gen: gen2 });
    expect(missing).toEqual([]);
    expect(loaded).toBe(Object.keys(gen2.idMap).length);

    const after = await searchOccurrences(client2, gen2, 'rye flour hydration');
    expect(after).toEqual(before);
    const stale = await searchOccurrences(client2, gen2, 'sourdough starter feeding schedule');
    expect(stale[0]).not.toBe(undefined); // still answers…
    expect(gen2.tombstones.length).toBeGreaterThan(0); // …with the old id filtered by tombstones
  });

  it('missing vector rows are reported as drift, not crashed on', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    await activateGeneration(db, gen);
    // simulate partial IDB eviction: delete one vector row
    const chunk = await reqAsPromise<{ inputHash: string }>(db.transaction('chunks').objectStore('chunks').get('k8s.md#0'));
    const tx = db.transaction('vectors', 'readwrite');
    tx.objectStore('vectors').delete([FP, chunk.inputHash]);
    await txDone(tx);

    const client2 = freshClient();
    const gen2 = (await loadActiveGeneration(db))!;
    await client2.init(gen2.dim, 1024);
    const { missing } = await loadGenerationIntoIndex({ db, client: client2, gen: gen2 });
    expect(missing).toEqual(['k8s.md#0']);
  });
});
```

(Also add `txDone` to the vane-db import at the top of the file.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/index-and-search.test.ts`
Expected: new tests FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/indexer/load-generation.ts
import { reqAsPromise, type VectorRow } from '../storage/vane-db';
import type { GenerationRecord } from '../storage/generation-store';
import type { IndexClient } from '../index/index-client';
import type { ChunkRow } from '../chunker/whole-file';

const BATCH = 256;

/** Rebuild the volatile worker index from durable rows (MemoryVaneIndex startup path). */
export async function loadGenerationIntoIndex(deps: {
  db: IDBDatabase;
  client: IndexClient;
  gen: GenerationRecord;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ loaded: number; missing: string[] }> {
  const { db, client, gen } = deps;
  const entries = Object.entries(gen.idMap); // [vaneId(str), occurrenceId]
  const missing: string[] = [];
  let loaded = 0;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch: { vaneId: number; vector: Float32Array }[] = [];
    for (const [vid, occ] of entries.slice(i, i + BATCH)) {
      const chunk = await reqAsPromise<ChunkRow | undefined>(
        db.transaction('chunks').objectStore('chunks').get(occ));
      const vec = chunk && await reqAsPromise<VectorRow | undefined>(
        db.transaction('vectors').objectStore('vectors').get([gen.embeddingFingerprint, chunk.inputHash]));
      if (!chunk || !vec) { missing.push(occ); continue; }
      batch.push({ vaneId: Number(vid), vector: vec.vector });
    }
    if (batch.length) await client.insert(batch);
    loaded += batch.length;
    deps.onProgress?.(Math.min(i + BATCH, entries.length), entries.length);
  }
  return { loaded, missing };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/integration/index-and-search.test.ts`
Expected: PASS (6 tests). This is the spec's "persist → reload → identical results" and "restart with tombstones" failure-matrix coverage.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/load-generation.ts tests/integration/index-and-search.test.ts
git commit -m "feat: startup rebuild from IndexedDB with drift reporting"
```

---

### Task 11: SearchService — grouping, floor, tombstone widening

**Files:**
- Create: `src/search/search-service.ts`
- Test: `tests/unit/search-service.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider` (Task 3), `IndexClient` (Task 8), `GenerationRecord` (Task 6)
- Produces:
  - `interface ChunkMeta { path: string; breadcrumb: string }`
  - `interface NoteResult { path: string; breadcrumb: string; score: number }`
  - `class SearchService` — constructor `({ provider, client, resolve: (occurrenceId) => ChunkMeta | undefined, getGen: () => GenerationRecord | null, floor?: number })`; `search(query: string, limit = 20): Promise<NoteResult[]>` — grouped by note (score = max chunk), tombstones/unknown ids filtered, over-fetch widens (k×4, max twice) when filtering starves results, similarity floor applied per chunk

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/search-service.test.ts
import { describe, it, expect } from 'vitest';
import { SearchService } from '../../src/search/search-service';
import { IndexClient, type Transport, type IndexRequest, type IndexResponse } from '../../src/index/index-client';
import { newGeneration, type GenerationRecord } from '../../src/storage/generation-store';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import type { IndexHit } from '../../src/index/vane-index';

/** Scripted transport: returns canned hits, records requested k values. */
function cannedClient(hits: IndexHit[], size: number) {
  const ks: number[] = [];
  let cb: (r: IndexResponse) => void = () => {};
  const t: Transport = {
    post: (msg: IndexRequest) => queueMicrotask(() => {
      if (msg.type === 'search') { ks.push(msg.k); cb({ id: msg.id, ok: true, result: hits.slice(0, msg.k) }); }
      else if (msg.type === 'stats') cb({ id: msg.id, ok: true, result: { size, ready: true } });
      else cb({ id: msg.id, ok: true });
    }),
    onResponse: (c) => { cb = c; },
  };
  return { client: new IndexClient(t), ks };
}

function genWith(idMap: Record<number, string>, tombstones: number[] = []): GenerationRecord {
  const g = newGeneration(1, { embeddingFingerprint: 'f', graphFingerprint: 'g', dim: 64 });
  g.idMap = idMap; g.tombstones = tombstones;
  return g;
}

const provider = new FakeEmbeddingProvider(64);
const meta = (path: string) => ({ path, breadcrumb: path.replace('.md', '') });

describe('SearchService', () => {
  it('groups chunk hits by note, score = max chunk, sorted descending', async () => {
    const { client } = cannedClient([
      { vaneId: 0, score: 0.9 }, { vaneId: 1, score: 0.8 }, { vaneId: 2, score: 0.7 },
    ], 3);
    const gen = genWith({ 0: 'a.md#0', 1: 'a.md#1', 2: 'b.md#0' });
    const svc = new SearchService({ provider, client, resolve: (o) => meta(o.split('#')[0]), getGen: () => gen });
    const results = await svc.search('anything');
    expect(results).toEqual([
      { path: 'a.md', breadcrumb: 'a', score: 0.9 },
      { path: 'b.md', breadcrumb: 'b', score: 0.7 },
    ]);
  });

  it('filters tombstoned and unmapped ids, widening k when starved', async () => {
    // 60 of the first 64 hits are tombstoned → first pass yields 4 notes, widening kicks in
    const hits = Array.from({ length: 100 }, (_, i) => ({ vaneId: i, score: 1 - i / 100 }));
    const idMap: Record<number, string> = {};
    for (let i = 0; i < 100; i++) idMap[i] = `n${i}.md#0`;
    const tomb = Array.from({ length: 60 }, (_, i) => i);
    const { client, ks } = cannedClient(hits, 100);
    const svc = new SearchService({ provider, client, resolve: (o) => meta(o.split('#')[0]), getGen: () => genWith(idMap, tomb) });
    const results = await svc.search('anything', 20);
    expect(results).toHaveLength(20);
    expect(results[0].path).toBe('n60.md');
    expect(ks.length).toBeGreaterThan(1); // widened at least once
  });

  it('applies the similarity floor', async () => {
    const { client } = cannedClient([{ vaneId: 0, score: 0.9 }, { vaneId: 1, score: 0.1 }], 2);
    const gen = genWith({ 0: 'a.md#0', 1: 'b.md#0' });
    const svc = new SearchService({ provider, client, resolve: (o) => meta(o.split('#')[0]), getGen: () => gen, floor: 0.5 });
    expect((await svc.search('x')).map((r) => r.path)).toEqual(['a.md']);
  });

  it('returns [] when no generation is loaded', async () => {
    const { client } = cannedClient([], 0);
    const svc = new SearchService({ provider, client, resolve: () => undefined, getGen: () => null });
    expect(await svc.search('x')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/search-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/search/search-service.ts
import type { EmbeddingProvider } from '../providers/embedding-provider';
import type { IndexClient } from '../index/index-client';
import type { GenerationRecord } from '../storage/generation-store';

export interface ChunkMeta { path: string; breadcrumb: string }
export interface NoteResult { path: string; breadcrumb: string; score: number }

const FIRST_K = 64;
const WIDEN_FACTOR = 4;
const MAX_WIDENINGS = 2;

export class SearchService {
  constructor(private deps: {
    provider: EmbeddingProvider;
    client: IndexClient;
    resolve: (occurrenceId: string) => ChunkMeta | undefined;
    getGen: () => GenerationRecord | null;
    floor?: number;
  }) {}

  async search(query: string, limit = 20): Promise<NoteResult[]> {
    const gen = this.deps.getGen();
    if (!gen) return [];
    const [qv] = await this.deps.provider.embed([query], 'query');
    const tombstones = new Set(gen.tombstones);
    const floor = this.deps.floor ?? -Infinity;

    // Tombstones are filtered post-search, so a starved result set widens k (spec "Data flow").
    let k = FIRST_K;
    for (let attempt = 0; ; attempt++) {
      const hits = await this.deps.client.search(qv, k);
      const byNote = new Map<string, NoteResult>();
      for (const h of hits) {
        if (tombstones.has(h.vaneId) || h.score < floor) continue;
        const occ = gen.idMap[h.vaneId];
        if (!occ) continue;
        const meta = this.deps.resolve(occ);
        if (!meta) continue;
        const cur = byNote.get(meta.path);
        if (!cur || h.score > cur.score) {
          byNote.set(meta.path, { path: meta.path, breadcrumb: meta.breadcrumb, score: h.score });
        }
      }
      const notes = [...byNote.values()].sort((a, b) => b.score - a.score);
      const { size } = await this.deps.client.stats();
      if (notes.length >= limit || k >= size || attempt >= MAX_WIDENINGS) {
        return notes.slice(0, limit);
      }
      k = Math.min(k * WIDEN_FACTOR, Math.max(size, 1));
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/search-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search tests/unit/search-service.test.ts
git commit -m "feat: SearchService with note grouping, floor, tombstone widening"
```

---

### Task 12: SearchModal, RequestGate, and plugin wiring

**Files:**
- Create: `src/ui/request-gate.ts`, `src/ui/search-modal.ts`
- Modify: `src/main.ts` (replace the Task 1 placeholder)
- Test: `tests/unit/request-gate.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: the working plugin — commands `vane-search:index-vault` and `vane-search:open-search`

- [ ] **Step 1: Write the failing RequestGate test** (the modal itself is thin Obsidian glue, verified manually in Task 13; the token logic is the testable part)

```ts
// tests/unit/request-gate.test.ts
import { describe, it, expect } from 'vitest';
import { RequestGate } from '../../src/ui/request-gate';

describe('RequestGate', () => {
  it('only the newest token is current — stale async responses get discarded', () => {
    const gate = new RequestGate();
    const t1 = gate.issue();
    expect(gate.isCurrent(t1)).toBe(true);
    const t2 = gate.issue();
    expect(gate.isCurrent(t1)).toBe(false); // t1's in-flight response must be dropped
    expect(gate.isCurrent(t2)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement RequestGate**

Run: `npx vitest run tests/unit/request-gate.test.ts` — Expected: FAIL.

```ts
// src/ui/request-gate.ts
/** Monotonic token: an async result is only applied if its token is still the newest. */
export class RequestGate {
  private token = 0;
  issue(): number { return ++this.token; }
  isCurrent(t: number): boolean { return t === this.token; }
}
```

Run again — Expected: PASS.

- [ ] **Step 3: Implement the modal**

```ts
// src/ui/search-modal.ts
import { App, SuggestModal } from 'obsidian';
import type { SearchService, NoteResult } from '../search/search-service';
import { RequestGate } from './request-gate';

const DEBOUNCE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VaneSearchModal extends SuggestModal<NoteResult> {
  private gate = new RequestGate();
  private last: NoteResult[] = [];

  constructor(app: App, private svc: SearchService, private indexStatus: () => string) {
    super(app);
    this.setPlaceholder('Semantic search…');
  }

  async getSuggestions(query: string): Promise<NoteResult[]> {
    if (!query.trim()) return [];
    const token = this.gate.issue();
    await sleep(DEBOUNCE_MS); // debounce: newest keystroke wins
    if (!this.gate.isCurrent(token)) return this.last;
    const results = await this.svc.search(query);
    if (!this.gate.isCurrent(token)) return this.last;
    this.last = results;
    this.emptyStateText = results.length ? '' : `No results — ${this.indexStatus()}`;
    return results;
  }

  renderSuggestion(r: NoteResult, el: HTMLElement): void {
    el.createEl('div', { text: r.breadcrumb });
    el.createEl('small', { text: `${r.path} · ${r.score.toFixed(2)}` });
  }

  onChooseSuggestion(r: NoteResult): void {
    void this.app.workspace.openLinkText(r.path, '', false);
  }
}
```

- [ ] **Step 4: Wire the plugin**

```ts
// src/main.ts
import { Notice, Plugin, TFile } from 'obsidian';
import { openVaneDb } from './storage/vane-db';
import {
  newGeneration, saveGeneration, activateGeneration, loadActiveGeneration,
  type GenerationRecord,
} from './storage/generation-store';
import { IndexClient, workerTransport } from './index/index-client';
import { spawnIndexWorker } from './index/spawn-worker';
import { capacityFor } from './index/vane-index';
import { FakeEmbeddingProvider } from './providers/fake';
import { embeddingFingerprint } from './providers/embedding-provider';
import { CHUNKER_VERSION, type ChunkRow } from './chunker/whole-file';
import { runFullIndex, type FileSource } from './indexer/full-index';
import { loadGenerationIntoIndex } from './indexer/load-generation';
import { SearchService, type ChunkMeta } from './search/search-service';
import { VaneSearchModal } from './ui/search-modal';
import { reqAsPromise } from './storage/vane-db';

const GRAPH_FINGERPRINT = 'dot:m16:ef200'; // bump on metric/params/vanedb format change

export default class VaneSearchPlugin extends Plugin {
  private db: IDBDatabase | null = null;
  private worker: Worker | null = null;
  private client: IndexClient | null = null;
  private gen: GenerationRecord | null = null;
  private chunkMeta = new Map<string, ChunkMeta>();
  private provider = new FakeEmbeddingProvider(64); // Phase 3 replaces with configured provider
  private search: SearchService | null = null;
  private status = 'starting';
  private statusEl: HTMLElement | null = null;

  async onload() {
    // Light onload (spec): commands only; real init after layout is ready.
    this.addCommand({ id: 'open-search', name: 'Search vault semantically', callback: () => {
      if (!this.search) { new Notice('Vane Search is still starting'); return; }
      new VaneSearchModal(this.app, this.search, () => this.status).open();
    }});
    this.addCommand({ id: 'index-vault', name: 'Index vault', callback: () => void this.indexVault() });
    this.statusEl = this.addStatusBarItem();
    this.setStatus('starting');
    this.app.workspace.onLayoutReady(() => void this.initialize().catch((e) => {
      console.error('vane-search init failed', e);
      this.setStatus('error — see console');
    }));
  }

  onunload() {
    this.worker?.terminate();
    this.db?.close();
  }

  private setStatus(s: string) {
    this.status = s;
    this.statusEl?.setText(`Vane: ${s}`);
  }

  private vaultId(): string {
    return (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
  }

  private fileSource(): FileSource {
    return {
      list: () => this.app.vault.getMarkdownFiles()
        .map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })),
      read: async (path) => {
        const af = this.app.vault.getAbstractFileByPath(path);
        if (!(af instanceof TFile)) throw new Error(`not a file: ${path}`);
        return this.app.vault.cachedRead(af);
      },
    };
  }

  private async refreshChunkMeta() {
    if (!this.db) return;
    const rows = await reqAsPromise<ChunkRow[]>(
      this.db.transaction('chunks').objectStore('chunks').getAll());
    this.chunkMeta = new Map(rows.map((r) => [r.occurrenceId, { path: r.path, breadcrumb: r.breadcrumb }]));
  }

  private async initialize() {
    this.db = await openVaneDb(this.vaultId());
    void navigator.storage?.persist?.(); // spec: request durable storage, degrade gracefully
    void navigator.storage?.estimate?.().then((e) => console.debug('vane-search: storage estimate', e));
    this.worker = spawnIndexWorker();
    this.client = new IndexClient(workerTransport(this.worker));

    this.gen = await loadActiveGeneration(this.db);
    const fp = embeddingFingerprint(this.provider, CHUNKER_VERSION);
    if (this.gen && this.gen.embeddingFingerprint !== fp) {
      // Phase 3 turns this into a rebuild/keep-read-only modal; Phase 1 serves the old generation.
      new Notice('Vane Search: index was built with a different provider — run "Index vault" to rebuild.');
    }

    this.search = new SearchService({
      provider: this.provider,
      client: this.client,
      resolve: (occ) => this.chunkMeta.get(occ),
      getGen: () => this.gen,
    });

    if (this.gen) {
      const total = Object.keys(this.gen.idMap).length;
      await this.client.init(this.gen.dim, capacityFor(total + this.gen.tombstones.length));
      await this.refreshChunkMeta();
      const { missing } = await loadGenerationIntoIndex({
        db: this.db, client: this.client, gen: this.gen,
        onProgress: (done, t) => this.setStatus(`index building ${done}/${t}`),
      });
      if (missing.length) console.warn('vane-search: drift, missing rows for', missing);
      this.setStatus(`ready (${total - missing.length} chunks)`);
    } else {
      this.setStatus('no index — run "Index vault"');
    }
  }

  private async indexVault() {
    if (!this.db || !this.client) { new Notice('Vane Search is still starting'); return; }
    const fp = embeddingFingerprint(this.provider, CHUNKER_VERSION);
    if (!this.gen || this.gen.embeddingFingerprint !== fp) {
      this.gen = newGeneration((this.gen?.generation ?? 0) + 1,
        { embeddingFingerprint: fp, graphFingerprint: GRAPH_FINGERPRINT, dim: this.provider.dimension() });
      await saveGeneration(this.db, this.gen);
      await this.client.init(this.gen.dim, capacityFor(this.app.vault.getMarkdownFiles().length * 2));
    }
    const res = await runFullIndex({
      db: this.db, source: this.fileSource(), provider: this.provider,
      client: this.client, gen: this.gen,
      onProgress: (done, total) => this.setStatus(`indexing ${done}/${total}`),
    });
    await activateGeneration(this.db, this.gen);
    await this.refreshChunkMeta();
    this.setStatus(`ready (${Object.keys(this.gen.idMap).length} chunks)`);
    new Notice(`Vane Search: indexed ${res.indexed}, unchanged ${res.skipped}`);
  }
}
```

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean. Note the `main.js` size in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/ui tests/unit/request-gate.test.ts
git commit -m "feat: search modal, request gate, and full plugin wiring"
```

---

### Task 13: CI, size budget, and the manual E2E gate

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/check-size.mjs`
- Modify: `README.md` (add a Development section)

**Interfaces:**
- Consumes: the whole build; Produces: the Phase 1 exit gate

- [ ] **Step 1: Write the size check**

```js
// scripts/check-size.mjs — spec budget: main.js < 3 MB
import { statSync } from 'node:fs';
const LIMIT = 3 * 1024 * 1024;
const size = statSync('main.js').size;
console.log(`main.js: ${(size / 1024).toFixed(0)} KB (limit ${LIMIT / 1024} KB)`);
if (size >= LIMIT) { console.error('main.js exceeds the 3 MB budget'); process.exit(1); }
```

- [ ] **Step 2: Write the workflow** — no Rust setup step, by design: if the build ever grows a cargo dependency, this job fails and that is the vendoring contract doing its job.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
      - run: node scripts/check-size.mjs
```

- [ ] **Step 3: Add the Development section to README.md**

```markdown
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
```

- [ ] **Step 4: Manual E2E gate in the dev vault** (uses the Phase 0 S7 dev-loop setup)

Run: `npm run build && ./scripts/install-dev.sh ~/vaults/vane-dev`, enable the plugin in Obsidian, then walk this checklist and record each item in the commit message or PR:

1. Status bar shows `Vane: no index — run "Index vault"`.
2. Run "Vane Search: Index vault" → progress in status bar → Notice with counts.
3. Open "Search vault semantically", type a phrase from a known note → that note ranks top; typing fast never shows results for a stale prefix.
4. Enter opens the note.
5. Quit Obsidian completely (Cmd-Q). Relaunch. Status bar reaches `ready (…)` WITHOUT running Index vault; the same query returns the same results. **This is the "kill + restart loses nothing" exit criterion.**
6. Edit one note, run "Index vault" again → Notice shows `indexed 1, unchanged N-1`; new content is findable.
7. Empty query and nonsense query show the empty state, not errors.

- [ ] **Step 5: Push and verify CI**

```bash
git add .github scripts/check-size.mjs README.md
git commit -m "ci: typecheck, tests, build, size budget - no Rust toolchain"
git push -u origin HEAD
```

Expected: the GitHub Actions run is green. Phase 1 exit criteria are now all verifiably met: query → ranked results → Enter opens note (manual gate 3–4); kill + restart loses nothing (gate 5, plus the automated restart tests); CI green with no Rust toolchain (this run).

---

## Deferred to later phases (deliberate, do not "fix" in Phase 1)

- Deleted-file reconciliation, vault event watching, debounced incremental indexing → Phase 2 (`Indexer`).
- Real chunking by headings, token budgets → Phase 2 (`Chunker`, bumps `CHUNKER_VERSION`).
- Real providers, consent UX, `SecretStorage`, error backoff → Phase 3.
- Graph bytes in the generation record, replacement build worker, warm start → Phase 4.
- Snippets from `offsets`, similarity-floor calibration, related notes → Phases 5–6.
