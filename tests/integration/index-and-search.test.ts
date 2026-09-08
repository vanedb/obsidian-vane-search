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

  it('a NEW generation re-indexes unchanged files (no stale mtime/size skip)', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    // simulate a provider/chunker change: new fingerprint, fresh generation + worker
    const client2 = freshClient();
    await client2.init(64, capacityFor(100));
    const gen2 = newGeneration(2, { embeddingFingerprint: FP + ':v2', graphFingerprint: GRAPH_FP, dim: 64 });
    await saveGeneration(db, gen2);
    const res = await runFullIndex({ db, source, provider, client: client2, gen: gen2 });
    expect(res.indexed).toBe(3); // mtime/size never moved, but the new generation must not skip
    expect(Object.keys(gen2.idMap)).toHaveLength(3);
  });

  it('incremental run after activation keeps the generation active', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    await activateGeneration(db, gen);
    source.set('bread.md', 'new content after activation', 2);
    await runFullIndex({ db, source, provider, client, gen }); // re-persists gen per file
    const active = await loadActiveGeneration(db);
    expect(active?.state).toBe('active'); // regression: saves must never demote to 'building'
    expect(active?.tombstones.length).toBeGreaterThan(0);
  });
});
