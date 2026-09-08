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
