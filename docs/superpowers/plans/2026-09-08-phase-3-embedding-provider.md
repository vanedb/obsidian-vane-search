# Vane Search Phase 3 — Real Embedding Provider (cloud default) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase-1 `FakeEmbeddingProvider` with a real, configurable `OpenAICompatProvider` (default: OpenAI `text-embedding-3-small`, 1536-dim, so it works on mobile; local Ollama and custom hosts are one-click presets), so semantic search actually ranks by meaning; add a settings tab, a network-consent modal, `SecretStorage`-backed API keys, first-run key guidance, and provider error handling.

**Architecture:** One provider class speaks the OpenAI `/v1/embeddings` protocol, which OpenAI, Ollama (`http://localhost:11434/v1`), and other OpenAI-compatible clouds all serve, so providers differ only by base URL + key + model. The default is a cloud provider because the index is per-device and a phone cannot reach a desktop's `localhost` Ollama — cloud is the only provider a phone can use out of the box. The provider is pure and testable via an injected `httpPost` seam (production passes an Obsidian `requestUrl` adapter; tests pass a fake). Switching provider/model/dimension changes the embedding fingerprint, which the Phase-1 generation machinery already treats as a re-embed into a fresh generation — vectors persist, so a restart never re-bills. Everything durable still lives in IndexedDB; only non-secret settings live in `data.json`, and the API key lives in Obsidian `SecretStorage`. Because the default provider is remote, the first embed requires an API key and a one-time consent; with neither set the plugin shows guidance, never a silent failure or a crash.

**Tech Stack:** TypeScript (strict), Obsidian API (`requestUrl`, `PluginSettingTab`, `Setting`, `Modal`, `app.secretStorage`, `loadData`/`saveData`), vitest, the existing Phase-1 modules.

**Spec:** `docs/superpowers/specs/2026-08-07-vane-search-design-final.md` — sections "Provider & privacy UX", "Error handling", "Versioning", and the `EmbeddingProvider`/`OpenAICompatProvider` rows in "Components". This plan implements that spec's Phase 3.

## Global Constraints

- The `EmbeddingProvider` interface is unchanged (Phase 1, `src/providers/embedding-provider.ts`): `readonly id: string; readonly model: string; dimension(): number; maxBatch(): number; embed(texts: string[], kind: 'query' | 'doc'): Promise<Float32Array[]>`. `embeddingFingerprint(p, chunkerVersion)` returns `${p.id}:${p.model}:${p.dimension()}:c${chunkerVersion}`. Every returned vector MUST be L2-normalized (reuse `l2Normalize`).
- Metric stays `'dot'` on L2-normalized vectors; a fingerprint change (different `id`, `model`, or `dimension`) is an embedding-identity change ⇒ the plugin builds a NEW generation and re-embeds; old vectors/old generation are retained until the new one is activated (Phase-1 `runFullIndex` + `activateGeneration` already do this).
- Ids are JS `number` except at the wasm boundary. Main thread never touches wasm; workers never touch Obsidian APIs. Vault notes are strictly read-only.
- `requestUrl` and `SecretStorage` are Obsidian main-thread APIs — never referenced from a worker or from a pure module. The provider takes an injected `HttpPost` function so vitest can run it in Node without Obsidian.
- `app.secretStorage.setSecret(id, secret)` / `getSecret(id): string | null` are SYNCHRONOUS; `id` must be lowercase alphanumeric with dashes (use `vane-search-api-key`).
- Non-secret settings persist via `plugin.loadData()`/`saveData()` (`data.json`); the API key NEVER goes to `data.json`.
- `main.js` stays < 3 MB; `npm run typecheck` clean; test output pristine; nothing under `spikes/` is committed (use explicit `git add`).
- Commit trailer for every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01EzaxzB6P57RjkCbjTzTRvA
  ```

## File Structure

- `src/providers/http.ts` — the `HttpPost` seam type + a production `requestUrlPost` adapter over Obsidian `requestUrl`.
- `src/providers/openai-compat.ts` — `OpenAICompatProvider` + `classifyEmbeddingFailure` (pure error classifier).
- `src/settings/settings.ts` — `VaneSettings` interface, `DEFAULT_SETTINGS`, `PRESETS`, `isLocalHost`, `buildProvider(...)`, load/save helpers.
- `src/settings/settings-tab.ts` — `VaneSettingsTab` (Obsidian `PluginSettingTab`).
- `src/ui/consent-modal.ts` — `ConsentModal` (one-time network consent).
- `src/main.ts` — wire the configured provider in, add the Rebuild command, re-index on fingerprint change, surface provider errors.
- Tests under `tests/unit/` and one manual gate.

---

### Task 1: `OpenAICompatProvider` and the HTTP seam

**Files:**
- Create: `src/providers/http.ts`, `src/providers/openai-compat.ts`
- Test: `tests/unit/openai-compat.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider`, `l2Normalize` (`src/providers/embedding-provider.ts`).
- Produces:
  - `interface HttpPost { (url: string, init: { headers: Record<string,string>; body: string }): Promise<{ status: number; json: unknown; headers: Record<string,string> }> }`
  - `requestUrlPost(requestUrl): HttpPost` — adapter (in `http.ts`); NOT imported by any test.
  - `interface OpenAICompatConfig { id: string; model: string; dimension: number; baseUrl: string; apiKey?: string; queryPrefix?: string; docPrefix?: string; maxBatch?: number }`
  - `class OpenAICompatProvider implements EmbeddingProvider` — constructor `(cfg: OpenAICompatConfig, post: HttpPost)`.
  - `type EmbeddingFailure = { kind: 'auth' | 'rate-limit' | 'network' | 'bad-response' | 'http'; status?: number; retryAfterMs?: number; message: string }`
  - `classifyEmbeddingFailure(status: number, headers: Record<string,string>, bodyText: string): EmbeddingFailure`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/openai-compat.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatProvider, classifyEmbeddingFailure, type HttpPost } from '../../src/providers/openai-compat';

const dim = 3;
// a fake server: returns unit-ish vectors derived from input length, in OpenAI shape
const okPost = (): HttpPost => vi.fn(async (_url, init) => {
  const body = JSON.parse(init.body) as { input: string[] };
  return {
    status: 200,
    headers: {},
    json: {
      data: body.input.map((t, i) => ({ index: i, embedding: [t.length, 1, 0] })),
      model: 'm',
    },
  };
});

const cfg = { id: 'oai:localhost', model: 'nomic-embed-text', dimension: dim, baseUrl: 'http://localhost:11434/v1',
  queryPrefix: 'search_query: ', docPrefix: 'search_document: ', maxBatch: 2 };

describe('OpenAICompatProvider', () => {
  it('posts to {baseUrl}/embeddings with model+input and returns L2-normalized vectors in order', async () => {
    const post = okPost();
    const p = new OpenAICompatProvider(cfg, post);
    const out = await p.embed(['aa', 'bbbb'], 'doc');
    expect((post as any).mock.calls[0][0]).toBe('http://localhost:11434/v1/embeddings');
    const sent = JSON.parse((post as any).mock.calls[0][1].body);
    expect(sent.model).toBe('nomic-embed-text');
    expect(sent.input).toEqual(['search_document: aa', 'search_document: bbbb']); // doc prefix applied
    expect(out).toHaveLength(2);
    out.forEach((v) => expect(Math.hypot(...v)).toBeCloseTo(1, 5));
    expect(out[0].length).toBe(3);
  });

  it('applies the query prefix for kind=query', async () => {
    const post = okPost();
    await new OpenAICompatProvider(cfg, post).embed(['hi'], 'query');
    expect(JSON.parse((post as any).mock.calls[0][1].body).input).toEqual(['search_query: hi']);
  });

  it('splits into batches of maxBatch and preserves overall order', async () => {
    const post = okPost();
    const out = await new OpenAICompatProvider(cfg, post).embed(['a', 'bb', 'ccc'], 'doc');
    expect((post as any).mock.calls.length).toBe(2); // maxBatch 2 → [a,bb],[ccc]
    expect(out).toHaveLength(3);
  });

  it('reorders by response index (out-of-order server response is corrected)', async () => {
    const post: HttpPost = async (_u, init) => {
      const body = JSON.parse(init.body) as { input: string[] };
      // return reversed order but tagged with correct index
      const data = body.input.map((t, i) => ({ index: i, embedding: [t.length, 1, 0] })).reverse();
      return { status: 200, headers: {}, json: { data } };
    };
    const out = await new OpenAICompatProvider(cfg, post).embed(['a', 'bbb'], 'doc');
    // first vector must correspond to 'a' (length 1) after normalization
    const raw0 = [1, 1, 0]; const n0 = Math.hypot(...raw0);
    expect(out[0][0]).toBeCloseTo(1 / n0, 5);
  });

  it('sends Authorization when apiKey is set, omits it otherwise', async () => {
    const post = okPost();
    await new OpenAICompatProvider({ ...cfg, apiKey: 'sk-x' }, post).embed(['a'], 'doc');
    expect((post as any).mock.calls[0][1].headers.Authorization).toBe('Bearer sk-x');
    const post2 = okPost();
    await new OpenAICompatProvider(cfg, post2).embed(['a'], 'doc');
    expect((post2 as any).mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('throws a classified error on wrong dimension', async () => {
    const post: HttpPost = async () => ({ status: 200, headers: {}, json: { data: [{ index: 0, embedding: [1, 2] }] } });
    await expect(new OpenAICompatProvider(cfg, post).embed(['a'], 'doc')).rejects.toThrow(/dimension/i);
  });

  it('throws on count mismatch and on non-finite values', async () => {
    const short: HttpPost = async () => ({ status: 200, headers: {}, json: { data: [] } });
    await expect(new OpenAICompatProvider(cfg, short).embed(['a'], 'doc')).rejects.toThrow(/count|length/i);
    const nan: HttpPost = async () => ({ status: 200, headers: {}, json: { data: [{ index: 0, embedding: [NaN, 0, 0] }] } });
    await expect(new OpenAICompatProvider(cfg, nan).embed(['a'], 'doc')).rejects.toThrow(/finite|zero|normal/i);
  });

  it('maps HTTP status to a classified failure', async () => {
    const p401: HttpPost = async () => ({ status: 401, headers: {}, json: {}, });
    await expect(new OpenAICompatProvider(cfg, p401).embed(['a'], 'doc')).rejects.toThrow(/auth|key|401/i);
  });

  it('dimension() and maxBatch() reflect config', () => {
    const p = new OpenAICompatProvider(cfg, okPost());
    expect(p.dimension()).toBe(3);
    expect(p.maxBatch()).toBe(2);
    expect(p.id).toBe('oai:localhost');
    expect(p.model).toBe('nomic-embed-text');
  });
});

describe('classifyEmbeddingFailure', () => {
  it('401/403 → auth (no retry)', () => {
    expect(classifyEmbeddingFailure(401, {}, '').kind).toBe('auth');
    expect(classifyEmbeddingFailure(403, {}, '').kind).toBe('auth');
  });
  it('429 → rate-limit honoring Retry-After seconds', () => {
    const f = classifyEmbeddingFailure(429, { 'retry-after': '2' }, '');
    expect(f.kind).toBe('rate-limit');
    expect(f.retryAfterMs).toBe(2000);
  });
  it('5xx → http', () => { expect(classifyEmbeddingFailure(503, {}, 'x').kind).toBe('http'); });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/openai-compat.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the HTTP seam**

```ts
// src/providers/http.ts
export interface HttpPost {
  (url: string, init: { headers: Record<string, string>; body: string }):
    Promise<{ status: number; json: unknown; headers: Record<string, string> }>;
}

/**
 * Production adapter over Obsidian's requestUrl (main thread only). `throw: false`
 * so we classify status ourselves instead of letting requestUrl throw on 4xx/5xx.
 * Pass `requestUrl` in from main.ts; this module never imports 'obsidian' so the
 * pure provider stays unit-testable in Node.
 */
export function requestUrlPost(
  requestUrl: (p: { url: string; method: string; headers: Record<string, string>; body: string; throw: boolean }) =>
    Promise<{ status: number; json: unknown; headers: Record<string, string>; text: string }>,
): HttpPost {
  return async (url, init) => {
    const r = await requestUrl({ url, method: 'POST', headers: init.headers, body: init.body, throw: false });
    return { status: r.status, json: r.json, headers: r.headers ?? {} };
  };
}
```

- [ ] **Step 4: Implement the provider**

```ts
// src/providers/openai-compat.ts
import { l2Normalize, type EmbeddingProvider } from './embedding-provider';
import type { HttpPost } from './http';

export type { HttpPost } from './http';

export interface OpenAICompatConfig {
  id: string;
  model: string;
  dimension: number;
  baseUrl: string;
  apiKey?: string;
  queryPrefix?: string;
  docPrefix?: string;
  maxBatch?: number;
}

export type EmbeddingFailure = {
  kind: 'auth' | 'rate-limit' | 'network' | 'bad-response' | 'http';
  status?: number;
  retryAfterMs?: number;
  message: string;
};

export function classifyEmbeddingFailure(status: number, headers: Record<string, string>, bodyText: string): EmbeddingFailure {
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, message: `Authentication failed (HTTP ${status}). Check the API key.` };
  }
  if (status === 429) {
    const ra = headers['retry-after'] ?? headers['Retry-After'];
    const secs = ra ? Number(ra) : NaN;
    const retryAfterMs = Number.isFinite(secs) ? secs * 1000 : undefined;
    return { kind: 'rate-limit', status, retryAfterMs, message: 'Rate limited (HTTP 429).' };
  }
  return { kind: 'http', status, message: `Embedding request failed (HTTP ${status}): ${bodyText.slice(0, 200)}` };
}

class EmbeddingError extends Error {
  constructor(public failure: EmbeddingFailure) { super(failure.message); this.name = 'EmbeddingError'; }
}

export class OpenAICompatProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  private cfg: OpenAICompatConfig;
  private post: HttpPost;

  constructor(cfg: OpenAICompatConfig, post: HttpPost) {
    this.cfg = cfg;
    this.post = post;
    this.id = cfg.id;
    this.model = cfg.model;
  }

  dimension(): number { return this.cfg.dimension; }
  maxBatch(): number { return this.cfg.maxBatch ?? 32; }

  async embed(texts: string[], kind: 'query' | 'doc'): Promise<Float32Array[]> {
    const prefix = kind === 'query' ? (this.cfg.queryPrefix ?? '') : (this.cfg.docPrefix ?? '');
    const out: Float32Array[] = [];
    const size = this.maxBatch();
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size).map((t) => prefix + t);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(input: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/embeddings`;

    let res: { status: number; json: unknown; headers: Record<string, string> };
    try {
      res = await this.post(url, { headers, body: JSON.stringify({ model: this.cfg.model, input }) });
    } catch (e) {
      throw new EmbeddingError({ kind: 'network', message: `Cannot reach ${url}: ${String(e)}` });
    }
    if (res.status < 200 || res.status >= 300) {
      throw new EmbeddingError(classifyEmbeddingFailure(res.status, res.headers, typeof res.json === 'string' ? res.json : JSON.stringify(res.json)));
    }

    const data = (res.json as { data?: { index?: number; embedding?: number[] }[] }).data;
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new EmbeddingError({ kind: 'bad-response', message: `expected ${input.length} embeddings, got ${Array.isArray(data) ? data.length : 'none'} (count mismatch)` });
    }
    const ordered = data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((row, i) => {
      const emb = row.embedding;
      if (!Array.isArray(emb) || emb.length !== this.cfg.dimension) {
        throw new EmbeddingError({ kind: 'bad-response', message: `row ${i}: expected dimension ${this.cfg.dimension}, got ${Array.isArray(emb) ? emb.length : 'none'}` });
      }
      const v = new Float32Array(this.cfg.dimension);
      for (let j = 0; j < emb.length; j++) {
        if (!Number.isFinite(emb[j])) throw new EmbeddingError({ kind: 'bad-response', message: `row ${i}: non-finite value` });
        v[j] = emb[j];
      }
      return l2Normalize(v); // throws on the zero vector (no normal direction)
    });
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/unit/openai-compat.test.ts`
Expected: PASS. (If the zero/finite test message doesn't match `/finite|zero|normal/i`, adjust the thrown message, not the test intent.)

- [ ] **Step 6: Commit**

```bash
git add src/providers/http.ts src/providers/openai-compat.ts tests/unit/openai-compat.test.ts
git commit -m "feat: OpenAICompatProvider over an injectable HTTP seam with response validation"
```

---

### Task 2: Settings model, presets, and the provider factory

**Files:**
- Create: `src/settings/settings.ts`
- Test: `tests/unit/settings.test.ts`

**Interfaces:**
- Consumes: `OpenAICompatProvider`, `OpenAICompatConfig`, `HttpPost` (Task 1); `EmbeddingProvider` (Phase 1).
- Produces:
  - `interface VaneSettings { providerId: string; baseUrl: string; model: string; dimension: number; hasApiKey: boolean; queryPrefix: string; docPrefix: string; maxBatch: number; consentedHosts: string[] }`
  - `const DEFAULT_SETTINGS: VaneSettings` (Ollama + nomic-embed-text, 768-dim)
  - `interface Preset { label: string; baseUrl: string; model: string; dimension: number; queryPrefix: string; docPrefix: string; needsKey: boolean }`
  - `const PRESETS: Record<'ollama' | 'openai' | 'custom', Preset>`
  - `isLocalHost(baseUrl: string): boolean`
  - `providerIdFor(baseUrl: string): string` — `oai:` + `new URL(baseUrl).host`
  - `buildProvider(settings: VaneSettings, apiKey: string | null, post: HttpPost): EmbeddingProvider` — constructs an `OpenAICompatProvider` from settings

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/settings.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, PRESETS, isLocalHost, providerIdFor, buildProvider } from '../../src/settings/settings';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';

describe('settings', () => {
  it('defaults to OpenAI text-embedding-3-small at 1536 dims (works on mobile)', () => {
    expect(DEFAULT_SETTINGS.providerId).toBe('openai');
    expect(DEFAULT_SETTINGS.baseUrl).toBe('https://api.openai.com/v1');
    expect(DEFAULT_SETTINGS.model).toBe('text-embedding-3-small');
    expect(DEFAULT_SETTINGS.dimension).toBe(1536);
    expect(DEFAULT_SETTINGS.docPrefix).toBe('');
    expect(DEFAULT_SETTINGS.queryPrefix).toBe('');
    expect(DEFAULT_SETTINGS.hasApiKey).toBe(false);
  });

  it('the Ollama preset stays available for local use', () => {
    expect(PRESETS.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(PRESETS.ollama.model).toBe('nomic-embed-text');
    expect(PRESETS.ollama.dimension).toBe(768);
  });

  it('isLocalHost recognizes localhost and 127.0.0.1, rejects remote', () => {
    expect(isLocalHost('http://localhost:11434/v1')).toBe(true);
    expect(isLocalHost('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalHost('https://api.openai.com/v1')).toBe(false);
  });

  it('providerIdFor encodes the host so switching host/model re-embeds', () => {
    const local = providerIdFor('http://localhost:11434/v1');
    const remote = providerIdFor('https://api.openai.com/v1');
    expect(local).not.toBe(remote);
    // fingerprint differs across hosts and models
    const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;
    const a = buildProvider({ ...DEFAULT_SETTINGS }, 'k', post); // OpenAI default
    const b = buildProvider({ ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', dimension: 768 }, null, post);
    expect(embeddingFingerprint(a, 0)).not.toBe(embeddingFingerprint(b, 0));
  });

  it('buildProvider wires the apiKey and dimension through', () => {
    const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;
    const p = buildProvider({ ...DEFAULT_SETTINGS, baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimension: 1536, hasApiKey: true }, 'sk-x', post);
    expect(p.dimension()).toBe(1536);
    expect(p.model).toBe('text-embedding-3-small');
  });

  it('PRESETS.openai needs a key; PRESETS.ollama does not', () => {
    expect(PRESETS.ollama.needsKey).toBe(false);
    expect(PRESETS.openai.needsKey).toBe(true);
    expect(PRESETS.openai.dimension).toBe(1536);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/settings/settings.ts
import { OpenAICompatProvider } from '../providers/openai-compat';
import type { HttpPost } from '../providers/http';
import type { EmbeddingProvider } from '../providers/embedding-provider';

export interface VaneSettings {
  providerId: string;   // preset key: 'ollama' | 'openai' | 'custom'
  baseUrl: string;
  model: string;
  dimension: number;
  hasApiKey: boolean;   // whether a key is stored in SecretStorage (the key itself never lives here)
  queryPrefix: string;
  docPrefix: string;
  maxBatch: number;
  consentedHosts: string[];
}

export interface Preset {
  label: string; baseUrl: string; model: string; dimension: number;
  queryPrefix: string; docPrefix: string; needsKey: boolean;
}

export const PRESETS: Record<'ollama' | 'openai' | 'custom', Preset> = {
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', dimension: 768,
    queryPrefix: 'search_query: ', docPrefix: 'search_document: ', needsKey: false },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimension: 1536,
    queryPrefix: '', docPrefix: '', needsKey: true },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', dimension: 768,
    queryPrefix: '', docPrefix: '', needsKey: false },
};

// Cloud default (OpenAI): the index is per-device and a phone cannot reach a
// desktop's localhost Ollama, so the out-of-the-box provider must be one a phone
// can use. Users who want local/private switch the preset to Ollama on desktop.
export const DEFAULT_SETTINGS: VaneSettings = {
  providerId: 'openai',
  baseUrl: PRESETS.openai.baseUrl,
  model: PRESETS.openai.model,
  dimension: PRESETS.openai.dimension,
  hasApiKey: false,
  queryPrefix: PRESETS.openai.queryPrefix,
  docPrefix: PRESETS.openai.docPrefix,
  maxBatch: 64,
  consentedHosts: [],
};

export function isLocalHost(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
  } catch { return false; }
}

export function providerIdFor(baseUrl: string): string {
  try { return `oai:${new URL(baseUrl).host}`; } catch { return 'oai:invalid'; }
}

export function buildProvider(settings: VaneSettings, apiKey: string | null, post: HttpPost): EmbeddingProvider {
  return new OpenAICompatProvider({
    id: providerIdFor(settings.baseUrl),
    model: settings.model,
    dimension: settings.dimension,
    baseUrl: settings.baseUrl,
    apiKey: apiKey ?? undefined,
    queryPrefix: settings.queryPrefix,
    docPrefix: settings.docPrefix,
    maxBatch: settings.maxBatch,
  }, post);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/settings.ts tests/unit/settings.test.ts
git commit -m "feat: settings model, provider presets, and provider factory"
```

---

### Task 3: Settings tab UI and network-consent modal

**Files:**
- Create: `src/settings/settings-tab.ts`, `src/ui/consent-modal.ts`
- Test: `tests/unit/consent.test.ts` (pure helper only; the Obsidian UI is verified in the Task 5 manual gate)

**Interfaces:**
- Consumes: `VaneSettings`, `PRESETS`, `isLocalHost` (Task 2); a host-plugin contract (below).
- Produces:
  - `interface SettingsHost { settings: VaneSettings; saveSettings(): Promise<void>; setApiKey(key: string): void; clearApiKey(): void; hasApiKey(): boolean; testConnection(): Promise<{ ok: boolean; dimension?: number; message: string }>; reindex(): Promise<void> }`
  - `class VaneSettingsTab extends PluginSettingTab` — constructor `(app, plugin, host: SettingsHost)`
  - `class ConsentModal extends Modal` — constructor `(app, host: string, onConsent: () => void)`
  - `needsConsent(baseUrl: string, consentedHosts: string[]): boolean` (pure; exported from `consent-modal.ts`)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/consent.test.ts
import { describe, it, expect } from 'vitest';
import { needsConsent } from '../../src/ui/consent-modal';

describe('needsConsent', () => {
  it('never for localhost', () => {
    expect(needsConsent('http://localhost:11434/v1', [])).toBe(false);
  });
  it('true for a remote host not yet consented, false once consented', () => {
    expect(needsConsent('https://api.openai.com/v1', [])).toBe(true);
    expect(needsConsent('https://api.openai.com/v1', ['api.openai.com'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/consent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the consent modal + helper**

```ts
// src/ui/consent-modal.ts
import { App, Modal, Setting } from 'obsidian';
import { isLocalHost } from '../settings/settings';

/** A remote host that the user has not yet acknowledged needs consent before note text leaves the device. */
export function needsConsent(baseUrl: string, consentedHosts: string[]): boolean {
  if (isLocalHost(baseUrl)) return false;
  try { return !consentedHosts.includes(new URL(baseUrl).host); } catch { return true; }
}

export class ConsentModal extends Modal {
  constructor(app: App, private host: string, private onConsent: () => void) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Send note text to a network service?' });
    contentEl.createEl('p', { text:
      `Vane Search will send the text of your notes to ${this.host} to compute embeddings. ` +
      `The text leaves this device. Only proceed if you trust that service with your notes.` });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText(`I understand, use ${this.host}`).setCta().onClick(() => { this.onConsent(); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}
```

```ts
// src/settings/settings-tab.ts
import { App, PluginSettingTab, Plugin, Setting, Notice } from 'obsidian';
import { PRESETS, type VaneSettings } from './settings';

export interface SettingsHost {
  settings: VaneSettings;
  saveSettings(): Promise<void>;
  setApiKey(key: string): void;
  clearApiKey(): void;
  hasApiKey(): boolean;
  testConnection(): Promise<{ ok: boolean; dimension?: number; message: string }>;
  reindex(): Promise<void>;
}

export class VaneSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private host: SettingsHost) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.host.settings;

    new Setting(containerEl).setName('Provider').setDesc('Where embeddings are computed. Local Ollama is private and free.')
      .addDropdown((d) => {
        for (const [k, p] of Object.entries(PRESETS)) d.addOption(k, p.label);
        d.setValue(s.providerId).onChange(async (v) => {
          const preset = PRESETS[v as keyof typeof PRESETS];
          Object.assign(s, { providerId: v, baseUrl: preset.baseUrl, model: preset.model, dimension: preset.dimension,
            queryPrefix: preset.queryPrefix, docPrefix: preset.docPrefix });
          await this.host.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl).setName('Base URL').addText((t) =>
      t.setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim(); await this.host.saveSettings(); }));
    new Setting(containerEl).setName('Model').addText((t) =>
      t.setValue(s.model).onChange(async (v) => { s.model = v.trim(); await this.host.saveSettings(); }));
    new Setting(containerEl).setName('Embedding dimension').setDesc('Must match the model. "Test connection" fills this in.')
      .addText((t) => t.setValue(String(s.dimension)).onChange(async (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) { s.dimension = n; await this.host.saveSettings(); } }));

    new Setting(containerEl).setName('API key').setDesc('Stored in Obsidian SecretStorage, never in data.json. Leave blank for local Ollama.')
      .addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder(this.host.hasApiKey() ? '•••••• (saved)' : 'not set');
        t.onChange((v) => { if (v) this.host.setApiKey(v); else this.host.clearApiKey(); }); });

    new Setting(containerEl).setName('Test connection').setDesc('Embeds a probe string; on success, fills in the dimension.')
      .addButton((b) => b.setButtonText('Test').onClick(async () => {
        const r = await this.host.testConnection();
        new Notice(r.message);
        if (r.ok && r.dimension) { this.host.settings.dimension = r.dimension; await this.host.saveSettings(); this.display(); }
      }));

    new Setting(containerEl).setName('Rebuild index').setDesc('Re-embed the whole vault with the current provider.')
      .addButton((b) => b.setButtonText('Rebuild').setWarning().onClick(() => void this.host.reindex()));
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/unit/consent.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/settings/settings-tab.ts src/ui/consent-modal.ts tests/unit/consent.test.ts
git commit -m "feat: settings tab and network-consent modal"
```

---

### Task 4: Wire the real provider into the plugin

**Files:**
- Modify: `src/main.ts`
- Test: `tests/unit/provider-swap.test.ts` (pure fingerprint-change logic extracted to a helper)

**Interfaces:**
- Consumes: everything above; Phase-1 `main.ts` structure (`initialize`, `indexVault`, `embeddingFingerprint`, `CHUNKER_VERSION`, generation machinery, `SecretStorage`).
- Produces: a working plugin whose provider comes from settings; a Rebuild command `vane-search:rebuild-index`; `SettingsHost` implemented by the plugin; consent enforced before a remote embed; provider errors surfaced via Notice + status.

- [ ] **Step 1: Write the failing test** (the testable extract — the wiring itself is verified in the manual gate)

```ts
// tests/unit/provider-swap.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, buildProvider } from '../../src/settings/settings';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';
import { CHUNKER_VERSION } from '../../src/chunker/whole-file';

const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;

describe('provider swap triggers re-embed', () => {
  it('changing model changes the fingerprint (Phase-1 machinery then rebuilds)', () => {
    const a = buildProvider(DEFAULT_SETTINGS, null, post);
    const b = buildProvider({ ...DEFAULT_SETTINGS, model: 'mxbai-embed-large', dimension: 1024 }, null, post);
    expect(embeddingFingerprint(a, CHUNKER_VERSION)).not.toBe(embeddingFingerprint(b, CHUNKER_VERSION));
  });
  it('the fake→real switch also changes the fingerprint (id differs)', () => {
    const real = buildProvider(DEFAULT_SETTINGS, null, post);
    expect(real.id.startsWith('oai:')).toBe(true); // never collides with the fake provider's id 'fake'
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/provider-swap.test.ts`
Expected: FAIL — import path resolves but assertions run only after Task 2 exists; if Task 2 is present this passes immediately, which is fine (it is a guard, not TDD-red for new code). Proceed.

- [ ] **Step 3: Implement the wiring in `src/main.ts`**

Replace the Phase-1 provider construction and add settings/secret/consent/error handling. Apply these changes:

1. Imports (add): `requestUrl`, `Modal` already available via `obsidian`; add
   ```ts
   import { requestUrl } from 'obsidian';
   import { DEFAULT_SETTINGS, buildProvider, isLocalHost, type VaneSettings } from './settings/settings';
   import { requestUrlPost } from './providers/http';
   import { VaneSettingsTab, type SettingsHost } from './settings/settings-tab';
   import { ConsentModal, needsConsent } from './ui/consent-modal';
   ```
   Keep the `FakeEmbeddingProvider` import (still used as a safe fallback when the provider is unreachable during the very first run is NOT desired — instead, see step 3.4). Actually remove `new FakeEmbeddingProvider(384)` as the live provider.

2. Fields: add
   ```ts
   private settings: VaneSettings = { ...DEFAULT_SETTINGS };
   private apiKeyId = 'vane-search-api-key';
   private post = requestUrlPost(requestUrl as unknown as Parameters<typeof requestUrlPost>[0]);
   ```
   Remove the `private provider = new FakeEmbeddingProvider(64|384)` field; build the provider from settings instead.

3. Settings load/save + secret helpers:
   ```ts
   private async loadSettings() {
     this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) ?? {});
   }
   async saveSettings() { await this.saveData(this.settings); }
   private secret(): string | null {
     try { return this.app.secretStorage?.getSecret?.(this.apiKeyId) ?? null; } catch { return null; }
   }
   private makeProvider() {
     return buildProvider(this.settings, this.secret(), this.post);
   }
   ```

4. In `onload()`: `await this.loadSettings()` FIRST; construct `this.provider = this.makeProvider()`; register the settings tab `this.addSettingTab(new VaneSettingsTab(this.app, this, this.settingsHost()))`; add the command `this.addCommand({ id: 'rebuild-index', name: 'Rebuild index (re-embed vault)', callback: () => void this.indexVault(true) })`.

5. `settingsHost(): SettingsHost` returns an object delegating to the plugin: `settings`, `saveSettings`, `setApiKey(k){ this.app.secretStorage.setSecret(this.apiKeyId,k); this.settings.hasApiKey=true; void this.saveSettings(); this.provider=this.makeProvider(); }`, `clearApiKey`, `hasApiKey(){ return !!this.secret(); }`, `testConnection()` (embed one probe string via a freshly built provider, catch → message; on success return `{ok:true, dimension: vec.length, message}`), `reindex(){ return this.indexVault(true); }`.

6. `indexVault(force = false)`, in order:
   a. **No-key guard (cloud default first-run):** if the provider's host is remote (`!isLocalHost(this.settings.baseUrl)`) and `this.secret()` is null, do NOT attempt to embed. `new Notice('Vane Search: set your API key in Settings → Vane Search to start indexing.')`, `setStatus('needs API key')`, open the settings tab if possible, and return.
   b. **Consent:** if `needsConsent(this.settings.baseUrl, this.settings.consentedHosts)`, open `ConsentModal` and return; the modal's onConsent pushes the host into `consentedHosts`, saves, and re-invokes `indexVault(force)`.
   c. When `force`, bump to a new generation even if the fingerprint is unchanged.
   d. Wrap `runFullIndex` in try/catch that inspects an `EmbeddingError` (import the type) and surfaces: auth → "authentication failed — check the API key"; rate-limit → "rate limited, try again later"; network → "cannot reach {baseUrl}"; bad-response → "unexpected response from the provider"; each via `new Notice(...)` + `setStatus(...)`. The generation stays un-activated on failure (Phase-1 guarantee), so a fixed key + re-run resumes cleanly.

7. On `initialize()` startup, apply the same no-key guard for the status line: if remote and no key, `setStatus('needs API key')` instead of "no index".

8. Keep `FakeEmbeddingProvider` importable for tests, but the live plugin never constructs it.

Exact patch is mechanical; preserve every Phase-1 lifecycle guard (`unloaded`, `initDone`, `indexReady`) added earlier.

- [ ] **Step 4: Verify build + types + tests**

Run: `npm run typecheck && npm test && npm run build && node scripts/check-size.mjs`
Expected: all clean; `main.js` under 3 MB.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/unit/provider-swap.test.ts
git commit -m "feat: wire configured embedding provider, consent, secrets, rebuild command, error handling"
```

---

### Task 5: Manual gate — verify semantic search; README

**Files:**
- Modify: `README.md` (add a "Choosing an embedding provider" section)

The default provider is OpenAI, whose key belongs to the user and must never enter the build session. So the build-time verification runs against **local Ollama** (the same `OpenAICompatProvider` code, just a preset switch — no key needed), which proves the provider end-to-end; the OpenAI default path is verified by the user with their own key, and by the unit tests (mocked HTTP) for request shaping, auth header, and error classification.

- [ ] **Step 1:** Build and install: `npm run build && ./scripts/install-dev.sh ~/Obsidian/notes` (or copy `main.js`+`manifest.json` into `~/Obsidian/notes/.obsidian/plugins/vane-search/`), reload Obsidian.
- [ ] **Step 2:** First-run check (cloud default, no key yet): status bar reads `Vane: needs API key`; running "Index vault" shows the "set your API key" Notice and does not crash.
- [ ] **Step 3 (build-time verify via Ollama):** Confirm Ollama is up (`curl -s localhost:11434/api/tags`) and `nomic-embed-text` is pulled. In settings, switch the provider preset to Ollama. Click "Test connection" → success Notice, dimension 768. (Localhost needs no consent and no key.)
- [ ] **Step 4:** Run "Vane Search: Rebuild index (re-embed vault)". Watch the status bar count up to `ready`.
- [ ] **Step 5:** Search `change management`, `immunity to change`, `machine learning`. Expect topically relevant top results (not the Phase-1 word-overlap noise). Record a couple of before/after examples.
- [ ] **Step 6:** Quit + relaunch Obsidian → reaches `ready` without re-embedding (vectors durable at the new fingerprint).
- [ ] **Step 7 (OpenAI path, user-driven — documented, not blocking):** In settings, switch back to the OpenAI preset, paste an OpenAI API key (stored in SecretStorage), accept the one-time consent naming `api.openai.com`, and Rebuild. Confirm search works and that the same key/flow works in Obsidian mobile pointed at the same OpenAI base URL.
- [ ] **Step 8:** Add the README section: OpenAI as the default (key in SecretStorage, one-time consent, "note text leaves the device"), local Ollama for private desktop use, mobile guidance (cloud provider, or a desktop Ollama reached over LAN/Tailscale), and the "index is per-device" note. Commit:

```bash
git add README.md
git commit -m "docs: embedding provider setup (OpenAI default, Ollama local, mobile)"
```

---

## Deferred (not in this phase)

- Local in-process transformers.js model (spec Phase 5) — this phase uses Ollama's HTTP endpoint for "local", which is simpler and already installed.
- Persisted per-provider backoff state in the `meta` store (spec "Error handling") — this phase surfaces errors and stops; the work queue re-derives on restart as in Phase 1.
- Auto-detecting dimension without a manual "Test connection" click.
- Mobile: Ollama-on-localhost is desktop-only in practice; remote providers work on mobile but are out of scope for this phase's manual gate.
