import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import VaneSearchPlugin from '../../src/main';
import { spawnIndexWorker } from '../../src/index/spawn-worker';
import { createIndexHost } from '../../src/index/index-host';
import { MemoryVaneIndex } from '../../src/index/memory-vane-index';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import * as generations from '../../src/storage/generation-store';
import { reqAsPromise } from '../../src/storage/vane-db';
import { MemoryFileSource } from '../helpers/memory-files';
import { initWasm } from '../helpers/wasm';

vi.mock('../../src/index/spawn-worker', () => ({ spawnIndexWorker: vi.fn() }));
vi.mock('obsidian', async (original) => ({
  ...await original<object>(),
  TFile: class {}, SuggestModal: class {}, requestUrl: vi.fn(), setIcon: vi.fn(),
}));

let workerFailure: 'init' | 'insert' | null = null;
const workers: any[] = [];
beforeAll(async () => {
  await initWasm();
  vi.stubGlobal('navigator', {});
});
beforeEach(() => {
  vi.mocked(spawnIndexWorker).mockImplementation(() => {
    const host = createIndexHost((o) => new MemoryVaneIndex(o));
    const failure = workerFailure;
    workerFailure = null;
    const worker: any = {
      stopped: false, onmessage: null, onerror: null,
      terminate() { this.stopped = true; },
      postMessage(msg: any) {
        queueMicrotask(() => {
          if (this.stopped) return;
          this.onmessage({ data: msg.type === failure
            ? { id: msg.id, ok: false, error: `injected ${failure} failure` } : host(msg) });
        });
      },
    };
    workers.push(worker);
    return worker;
  });
});
afterEach(() => { vi.restoreAllMocks(); workerFailure = null; });

let seq = 0;
const configs = {
  a: { ...DEFAULT_SETTINGS, providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'a', dimension: 64 },
  b: { ...DEFAULT_SETTINGS, providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'b', dimension: 32 },
};
async function setup() {
  const vault = `provider-atomic-${seq++}`;
  const secrets = new Map<string, string>([['vane-search-api-key', 'original-key']]);
  const source = new MemoryFileSource();
  source.set('coffee.md', 'coffee brewing original content');
  source.set('bread.md', 'bread baking original content');
  const requests: { model: string; input: string[]; auth: string | undefined }[] = [];
  let rejectModel: string | null = null;
  let pauseQuery: Promise<void> | null = null;
  let pauseDocs: Promise<void> | null = null;
  const post = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    requests.push({ ...body, auth: init.headers.Authorization });
    if (body.model === rejectModel) throw new Error('injected network failure');
    if (body.input[0]?.includes('search_query:') && pauseQuery) await pauseQuery;
    if (body.input[0]?.includes('search_document:') && pauseDocs) await pauseDocs;
    const vectors = await new FakeEmbeddingProvider(body.model === 'a' ? 64 : 32).embed(body.input, 'doc');
    return { status: 200, headers: {}, json: { data: vectors.map((v, index) => ({ index, embedding: [...v] })) } };
  };
  const create = async (settings = configs.a) => {
    const plugin: any = new VaneSearchPlugin({} as any, {} as any);
    plugin.app = { appId: vault, secretStorage: {
      getSecret: (id: string) => secrets.get(id), setSecret: (id: string, value: string) => secrets.set(id, value),
    }, vault: { getMarkdownFiles: () => source.list(), on: () => ({}),
      getAbstractFileByPath: (path: string) => {
        const meta = source.list().find((f) => f.path === path);
        return meta ? Object.assign(new TFile(), { path, extension: 'md', stat: meta }) : null;
      }, cachedRead: (file: TFile) => source.read(file.path),
    }, workspace: { detachLeavesOfType: () => {} } };
    plugin.vaneSettings = { ...settings, queryPrefix: 'search_query: ', docPrefix: 'search_document: ' };
    plugin.post = post;
    plugin.provider = plugin.makeProvider();
    plugin.fileSource = () => source;
    plugin.registerEvent = () => {};
    plugin.saveData = async () => {};
    await plugin.initialize();
    return plugin;
  };
  const plugin = await create();
  await plugin.indexVault();
  expect(plugin.gen.generation).toBe(1);
  return { plugin, create, source, secrets, requests,
    failNetwork: (model: string | null) => { rejectModel = model; },
    holdQuery: (p: Promise<void> | null) => { pauseQuery = p; },
    holdDocs: (p: Promise<void> | null) => { pauseDocs = p; },
  };
}
function chooseB(p: any) { Object.assign(p.vaneSettings, configs.b, { queryPrefix: 'search_query: ', docPrefix: 'search_document: ' }); }
async function oldStillWorks(p: any, original: any) {
  expect(p.gen).toBe(original.gen);
  expect(p.provider).toBe(original.provider);
  expect(p.client).toBe(original.client);
  expect(p.worker).toBe(original.worker);
  expect(original.worker.stopped).toBe(false);
  expect((await p.search.search('coffee brewing')).map((r: any) => r.path)).toContain('coffee.md');
  expect((await generations.loadActiveGeneration(p.db))?.generation).toBe(1);
}

describe('atomic provider replacement through the plugin controller', () => {
  it.each(['network', 'init', 'insert', 'save', 'activate', 'activate-abort'] as const)('keeps the original provider, graph and restart rows after %s failure', async (kind) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await setup(); const p = s.plugin;
    const original = { gen: p.gen, provider: p.provider, client: p.client, worker: p.worker };
    const oldChunk = await reqAsPromise(p.db.transaction('chunks').objectStore('chunks').get([1, 'coffee.md#0']));
    s.source.set('coffee.md', 'edited while selecting another provider', 2);
    chooseB(p);
    if (kind === 'network') s.failNetwork('b');
    if (kind === 'init' || kind === 'insert') workerFailure = kind;
    if (kind === 'save') vi.spyOn(generations, 'saveGeneration').mockRejectedValueOnce(new Error('injected persistence failure'));
    if (kind === 'activate') vi.spyOn(generations, 'activateGeneration').mockRejectedValueOnce(new Error('injected activation failure'));
    if (kind === 'activate-abort') {
      const transaction = p.db.transaction.bind(p.db);
      vi.spyOn(p.db, 'transaction').mockImplementation((...args: any[]) => {
        const tx = transaction(...args);
        if (args[0] === 'generations' && args[1] === 'readwrite') {
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name: string) => {
            const store = objectStore(name);
            const put = store.put.bind(store);
            store.put = (value: any) => {
              const req = put(value);
              if (value.generation === 2 && value.state === 'active') tx.abort();
              return req;
            };
            return store;
          };
        }
        return tx;
      });
    }

    await p.indexVault(true);
    await oldStillWorks(p, original);
    expect(await reqAsPromise(p.db.transaction('chunks').objectStore('chunks').get([1, 'coffee.md#0']))).toEqual(oldChunk);
    expect(await reqAsPromise(p.db.transaction('generations').objectStore('generations').get(2))).toBeUndefined();
    expect(workers.at(-1).stopped).toBe(true);
    p.onunload();
    const restarted = await s.create(configs.b);
    expect(restarted.gen.generation).toBe(1);
    expect(restarted.provider.model).toBe('a');
    expect((await restarted.client.stats()).size).toBe(2);
    expect((await restarted.search.search('coffee')).map((r: any) => r.path)).toContain('coffee.md');
    restarted.onunload();
  });

  it('keeps A searchable while B is paused after a full 128-file window, then rolls back a later network failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await setup(); const p = s.plugin;
    for (let i = 0; i < 128; i++) s.source.set(`extra-${i}.md`, `original content ${i}`);
    await p.indexVault();
    const oldRows = await reqAsPromise(p.db.transaction('chunks').objectStore('chunks').getAll());
    const original = { gen: p.gen, provider: p.provider, client: p.client, worker: p.worker };
    const originalPost = p.post;
    let docs = 0; let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let paused = false;
    p.post = async (url: string, init: any) => {
      const input = JSON.parse(init.body);
      if (input.model === 'b' && ++docs === 2) {
        paused = true; await held; throw new Error('second window network failure');
      }
      return originalPost(url, init);
    };
    s.source.set('coffee.md', 'edited content must not overwrite generation A', 5);
    chooseB(p); p.vaneSettings.maxBatch = 512;
    const building = p.indexVault(true);
    await vi.waitFor(() => expect(paused).toBe(true));
    const candidate: any = await reqAsPromise(p.db.transaction('generations').objectStore('generations').get(2));
    expect(Object.keys(candidate.idMap)).toHaveLength(128);
    await oldStillWorks(p, original);
    release(); await building;
    await oldStillWorks(p, original);
    expect(await reqAsPromise(p.db.transaction('chunks').objectStore('chunks').getAll())).toEqual(oldRows);
    p.onunload();
    const restarted = await s.create(configs.b);
    expect((await restarted.client.stats()).size).toBe(130);
    restarted.onunload();
  });

  it('isolates a failed forced rebuild even when provider fingerprint stays the same', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await setup(); const p = s.plugin;
    const original = { gen: p.gen, provider: p.provider, client: p.client, worker: p.worker };
    s.source.set('coffee.md', 'changed content for same-provider rebuild', 8);
    workerFailure = 'insert';
    await p.indexVault(true);
    await oldStillWorks(p, original);
    p.onunload();
    const restarted = await s.create();
    expect((await restarted.client.stats()).size).toBe(2);
    restarted.onunload();
  });

  it('publishes the complete replacement, lets old in-flight queries finish, and existing search UI uses B next', async () => {
    const s = await setup(); const p = s.plugin;
    const search = p.search; const oldWorker = p.worker; const oldKey = p.gen.secretId;
    let release!: () => void;
    s.holdQuery(new Promise<void>((r) => { release = r; }));
    const query = search.search('coffee');
    await Promise.resolve();
    chooseB(p);
    p.settingsHost().setApiKey('replacement-key');
    await p.indexVault(true);
    expect(p.gen.generation).toBe(2);
    expect(p.provider.model).toBe('b');
    expect(oldWorker.stopped).toBe(false);
    expect(s.secrets.get(oldKey)).toBe('original-key');
    release(); s.holdQuery(null);
    expect((await query).map((r: any) => r.path)).toContain('coffee.md');
    expect(oldWorker.stopped).toBe(true);
    expect(s.secrets.get(oldKey)).toBe('');
    expect((await search.search('coffee')).map((r: any) => r.path)).toContain('coffee.md');
    expect(s.requests.at(-1)?.model).toBe('b');
    expect(s.requests.at(-1)?.auth).toBe('Bearer replacement-key');
    p.onunload();
    const restarted = await s.create(configs.a);
    expect(restarted.gen.generation).toBe(2);
    expect(restarted.provider.model).toBe('b');
    expect((await restarted.client.stats()).size).toBe(2);
    restarted.onunload();
  });

  it('restores the previous provider without re-embedding retained unchanged content after a successful switch', async () => {
    const s = await setup(); const p = s.plugin;
    chooseB(p); await p.indexVault(true);
    const before = s.requests.length;
    Object.assign(p.vaneSettings, configs.a, { queryPrefix: 'search_query: ', docPrefix: 'search_document: ' });
    await p.indexVault(true);
    expect(p.gen.generation).toBe(3);
    expect(p.provider.model).toBe('a');
    expect(s.requests.slice(before)).toEqual([]);
    expect((await p.search.search('bread')).map((r: any) => r.path)).toContain('bread.md');
    p.onunload();
  });

  it('does not activate an interrupted replacement after unload, and restart serves the original', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await setup(); const p = s.plugin;
    let release!: () => void;
    s.holdDocs(new Promise<void>((r) => { release = r; }));
    chooseB(p);
    const building = p.indexVault(true);
    await vi.waitFor(() => expect(s.requests.some((r) => r.model === 'b')).toBe(true));
    p.onunload(); release(); s.holdDocs(null);
    await building;
    const restarted = await s.create(configs.b);
    expect(restarted.gen.generation).toBe(1);
    expect(restarted.provider.model).toBe('a');
    expect((await restarted.client.stats()).size).toBe(2);
    await restarted.indexVault(true); // an interrupted candidate can be retried safely
    expect(restarted.gen.generation).toBe(2);
    restarted.onunload();
  });

  it('replays a live edit queued during rebuild against the newly active provider', async () => {
    const s = await setup(); const p = s.plugin;
    let release!: () => void;
    s.holdDocs(new Promise<void>((r) => { release = r; }));
    chooseB(p);
    const building = p.indexVault(true);
    await vi.waitFor(() => expect(s.requests.some((r) => r.model === 'b')).toBe(true));
    s.source.set('coffee.md', 'newest live edit after the replacement read this file', 3);
    const queued = p.enqueue(() => p.reindexFile('coffee.md'));
    release(); s.holdDocs(null); await building; await queued;
    expect(p.gen.generation).toBe(2);
    expect(p.gen.tombstones).toContain(0);
    const row: any = await reqAsPromise(p.db.transaction('files').objectStore('files').get([2, 'coffee.md']));
    expect(row.mtime).toBe(3);
    expect(s.requests.filter((r) => r.model === 'b')).toHaveLength(2);
    p.onunload();
    const restarted = await s.create(configs.a);
    expect((await restarted.client.stats()).size).toBe(2);
    restarted.onunload();
  });

  it('honors explicit credential revocation during a candidate build', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await setup(); const p = s.plugin;
    let release!: () => void;
    s.holdDocs(new Promise<void>((r) => { release = r; }));
    chooseB(p);
    const building = p.indexVault(true);
    await vi.waitFor(() => expect(s.requests.some((r) => r.model === 'b')).toBe(true));
    p.settingsHost().clearApiKey();
    release(); s.holdDocs(null); await building;
    expect(p.gen.generation).toBe(1);
    expect([...s.secrets.values()].every((v) => !v)).toBe(true);
    await p.search.search('coffee');
    expect(s.requests.at(-1)?.auth).toBeUndefined();
    p.onunload();
  });
});
