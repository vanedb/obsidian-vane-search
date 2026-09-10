import { describe, it, expect } from 'vitest';
import { SearchService, ProviderMismatchError } from '../../src/search/search-service';
import { IndexClient, type Transport, type IndexRequest, type IndexResponse } from '../../src/index/index-client';
import { newGeneration, type GenerationRecord } from '../../src/storage/generation-store';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import type { EmbeddingProvider } from '../../src/providers/embedding-provider';
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
    const svc = new SearchService({ getProvider: () => provider, getClient: () => client, resolve: (o) => meta(o.split('#')[0]), getGen: () => gen });
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
    const svc = new SearchService({ getProvider: () => provider, getClient: () => client, resolve: (o) => meta(o.split('#')[0]), getGen: () => genWith(idMap, tomb) });
    const results = await svc.search('anything', 20);
    expect(results).toHaveLength(20);
    expect(results[0].path).toBe('n60.md');
    expect(ks.length).toBeGreaterThan(1); // widened at least once
  });

  it('applies the similarity floor', async () => {
    const { client } = cannedClient([{ vaneId: 0, score: 0.9 }, { vaneId: 1, score: 0.1 }], 2);
    const gen = genWith({ 0: 'a.md#0', 1: 'b.md#0' });
    const svc = new SearchService({ getProvider: () => provider, getClient: () => client, resolve: (o) => meta(o.split('#')[0]), getGen: () => gen, floor: 0.5 });
    expect((await svc.search('x')).map((r) => r.path)).toEqual(['a.md']);
  });

  it('applies a live floor via getFloor, re-read on every search', async () => {
    const { client } = cannedClient([{ vaneId: 0, score: 0.9 }, { vaneId: 1, score: 0.1 }], 2);
    const gen = genWith({ 0: 'a.md#0', 1: 'b.md#0' });
    let floor = 0.5;
    const svc = new SearchService({
      getProvider: () => provider, getClient: () => client, resolve: (o) => meta(o.split('#')[0]), getGen: () => gen,
      getFloor: () => floor,
    });
    expect((await svc.search('x')).map((r) => r.path)).toEqual(['a.md']);
    floor = 0; // simulate a settings change taking effect on the next search
    expect((await svc.search('x')).map((r) => r.path)).toEqual(['a.md', 'b.md']);
  });

  it('returns [] when no generation is loaded', async () => {
    const { client } = cannedClient([], 0);
    const svc = new SearchService({ getProvider: () => provider, getClient: () => client, resolve: () => undefined, getGen: () => null });
    expect(await svc.search('x')).toEqual([]);
  });

  it('searchVector: groups/floors/excludes on a raw vector, no embedding call', async () => {
    const { client } = cannedClient([
      { vaneId: 0, score: 0.9 }, { vaneId: 1, score: 0.8 }, { vaneId: 2, score: 0.4 },
    ], 3);
    const gen = genWith({ 0: 'a.md#0', 1: 'b.md#0', 2: 'c.md#0' });
    const throwingProvider: EmbeddingProvider = {
      id: 'fake', model: 'feature-hash-v1', dimension: () => 64, maxBatch: () => 512,
      embed: () => { throw new Error('searchVector must not embed'); },
    };
    const svc = new SearchService({ getProvider: () => throwingProvider, getClient: () => client, resolve: (o) => meta(o.split('#')[0]), getGen: () => gen, floor: 0.5 });
    const results = await svc.searchVector(new Float32Array(64), 20, { excludePath: 'b.md' });
    // b.md (0.8) is excluded despite clearing the floor; c.md (0.4) is dropped by the floor.
    expect(results).toEqual([{ path: 'a.md', breadcrumb: 'a', score: 0.9 }]);
  });

  it('search(): groups against the SAME gen snapshot used for the fingerprint check, even if getGen() would return a different generation after the embed await (simulates a rebuild racing the query)', async () => {
    const { client } = cannedClient([{ vaneId: 0, score: 0.9 }], 1);
    const genAtCallTime = genWith({ 0: 'a.md#0' }); // the snapshot search() must stick with
    const genAfterRebuild = genWith({ 0: 'b.md#0' }); // a different generation object — must NOT be used for grouping
    let calls = 0;
    const svc = new SearchService({
      getProvider: () => provider,
      getClient: () => client,
      resolve: (o) => meta(o.split('#')[0]),
      // First call (inside search(), before the embed await) returns the original snapshot;
      // any later call (e.g. a buggy re-read inside grouping) would return the swapped generation.
      getGen: () => (calls++ === 0 ? genAtCallTime : genAfterRebuild),
    });
    const results = await svc.search('anything');
    expect(results).toEqual([{ path: 'a.md', breadcrumb: 'a', score: 0.9 }]);
  });

  it('rejects with ProviderMismatchError and never embeds when the live provider fingerprint differs from the generation', async () => {
    const { client } = cannedClient([{ vaneId: 0, score: 0.9 }], 1);
    const gen = genWith({ 0: 'a.md#0' }); // genWith → embeddingFingerprint: 'f'
    const throwingProvider: EmbeddingProvider = {
      id: 'fake', model: 'feature-hash-v1',
      dimension: () => 64,
      maxBatch: () => 512,
      embed: () => { throw new Error('must not be called — provider mismatch should short-circuit before embedding'); },
    };
    const svc = new SearchService({
      getProvider: () => throwingProvider,
      getClient: () => client,
      resolve: (o) => meta(o.split('#')[0]),
      getGen: () => gen,
      getProviderFingerprint: () => 'DIFFERENT',
    });
    await expect(svc.search('anything')).rejects.toBeInstanceOf(ProviderMismatchError);
  });

  it('reads the client live: a search issued after getClient() starts returning a new client uses that new client', async () => {
    const { client: clientA } = cannedClient([{ vaneId: 0, score: 0.9 }], 1);
    const { client: clientB } = cannedClient([{ vaneId: 1, score: 0.8 }], 1);
    const gen = genWith({ 0: 'a.md#0', 1: 'b.md#0' });
    let current = clientA;
    const svc = new SearchService({
      getProvider: () => provider,
      getClient: () => current,
      resolve: (o) => meta(o.split('#')[0]),
      getGen: () => gen,
    });
    expect((await svc.search('x')).map((r) => r.path)).toEqual(['a.md']);
    current = clientB; // simulate the atomic swap after a background rebuild completes
    expect((await svc.search('x')).map((r) => r.path)).toEqual(['b.md']);
  });

  it('search(): groups against the client snapshotted BEFORE the embed await, even if a rebuild swap fires while parked on that await (would otherwise pair OLD gen with NEW client — a torn read)', async () => {
    const { client: clientA } = cannedClient([{ vaneId: 0, score: 0.9 }], 1);
    const { client: clientB } = cannedClient([{ vaneId: 1, score: 0.8 }], 1); // must NOT be used
    const gen = genWith({ 0: 'a.md#0', 1: 'b.md#0' });
    let current = clientA;
    const swappingProvider: EmbeddingProvider = {
      id: 'fake', model: 'feature-hash-v1', dimension: () => 64, maxBatch: () => 512,
      embed: async (texts, kind) => {
        current = clientB; // the atomic swap happens while this search is parked right here
        return provider.embed(texts, kind);
      },
    };
    const svc = new SearchService({
      getProvider: () => swappingProvider,
      getClient: () => current,
      resolve: (o) => meta(o.split('#')[0]),
      getGen: () => gen,
    });
    const results = await svc.search('anything');
    expect(results).toEqual([{ path: 'a.md', breadcrumb: 'a', score: 0.9 }]);
  });
});
