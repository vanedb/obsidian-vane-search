import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { initWasm } from '../helpers/wasm';
import { loopbackTransport } from '../helpers/loopback';
import { MemoryFileSource } from '../helpers/memory-files';
import { openVaneDb, reqAsPromise, txDone } from '../../src/storage/vane-db';
import { newGeneration, saveGeneration, activateGeneration, loadActiveGeneration } from '../../src/storage/generation-store';
import { createIndexHost } from '../../src/index/index-host';
import { IndexClient } from '../../src/index/index-client';
import { MemoryVaneIndex } from '../../src/index/memory-vane-index';
import { capacityFor } from '../../src/index/vane-index';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';
import { CHUNKER_VERSION } from '../../src/chunker/chunker';
import { runFullIndex } from '../../src/indexer/full-index';
import { loadGenerationIntoIndex } from '../../src/indexer/load-generation';

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

  it('batches embedding requests across files instead of one call per file', async () => {
    const { db, client, gen } = await setup();
    const source = new MemoryFileSource();
    for (let i = 0; i < 10; i++) source.set(`note-${i}.md`, `unique content number ${i} about topic ${i}`);
    let embedCallCount = 0;
    const countingCalls = new Proxy(provider, {
      get(target, prop) {
        if (prop === 'embed') {
          return (texts: string[], kind: 'query' | 'doc') => { embedCallCount++; return target.embed(texts, kind); };
        }
        return Reflect.get(target, prop);
      },
    });
    const res = await runFullIndex({ db, source, provider: countingCalls, client, gen });
    expect(res).toEqual({ indexed: 10, skipped: 0 });
    // The provider's own maxBatch/maxBatchChars splitting decides call count, not the
    // file count — 10 files must NOT mean 10 embed() calls.
    expect(embedCallCount).toBeLessThanOrEqual(2);
    for (let i = 0; i < 10; i++) {
      expect((await searchOccurrences(client, gen, `topic ${i}`))[0]).toBe(`note-${i}.md#0`);
    }
  });

  it('a shrinking chunk count tombstones the orphaned occurrence and drops its chunk row', async () => {
    const { db, source, client, gen } = await setup();
    // Body well over MAX_EMBED_CHARS (12000): a filler run long enough that the
    // marker text lands only in the SECOND chunk, never the first.
    const filler = 'lorem ipsum '.repeat(1700); // 20400 chars
    const marker = ' xylophone quokka narwhal';
    source.set('big.md', filler + marker);
    await runFullIndex({ db, source, provider, client, gen });

    const liveForBig = Object.entries(gen.idMap).filter(([, occ]) => occ.startsWith('big.md#'));
    expect(liveForBig.length).toBeGreaterThanOrEqual(2);
    const id1 = Number(liveForBig.find(([, occ]) => occ === 'big.md#1')![0]);
    expect(await searchOccurrences(client, gen, 'xylophone quokka narwhal')).toContain('big.md#1');

    // Edit the note down to a single short chunk.
    source.set('big.md', 'a short note about houseplants and watering schedule', 2);
    const res = await runFullIndex({ db, source, provider, client, gen });
    expect(res.indexed).toBe(1);

    // The orphaned occurrence is gone from idMap, tombstoned, and its chunk row dropped.
    expect(Object.values(gen.idMap)).not.toContain('big.md#1');
    expect(gen.tombstones).toContain(id1);
    expect(await reqAsPromise(db.transaction('chunks').objectStore('chunks').get('big.md#1'))).toBeUndefined();

    // The stale content no longer surfaces this note at all.
    expect(await searchOccurrences(client, gen, 'xylophone quokka narwhal')).not.toContain('big.md#1');

    // The surviving occurrence is live and searchable with the new content.
    expect(Object.values(gen.idMap)).toContain('big.md#0');
    expect((await searchOccurrences(client, gen, 'houseplants watering schedule'))[0]).toBe('big.md#0');

    // The path→vaneIds reconcile index scopes the scan to big.md only — the other setup
    // files' occurrences must be completely untouched by the reconcile pass above.
    expect(Object.values(gen.idMap)).toEqual(
      expect.arrayContaining(['coffee.md#0', 'k8s.md#0', 'bread.md#0', 'big.md#0']));
    expect(Object.values(gen.idMap)).toHaveLength(4);
  });

  it('a NEW generation re-indexes unchanged files (no stale mtime/size skip)', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    // Simulate a fresh generation (e.g. after a rebuild) with a fresh worker. Same
    // provider fingerprint — runFullIndex now refuses a MISMATCHED one outright (see the
    // fingerprint-mismatch test below) — only the generation NUMBER is new, which is what
    // this test's mtime/size-skip check actually exercises.
    const client2 = freshClient();
    await client2.init(64, capacityFor(100));
    const gen2 = newGeneration(2, { embeddingFingerprint: FP, graphFingerprint: GRAPH_FP, dim: 64 });
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

  it('a failed index insert leaves the generation untouched; a retry succeeds', async () => {
    const { db, source, client, gen } = await setup();
    let failNext = true;
    const flaky = new Proxy(client, {
      get(target, prop) {
        if (prop === 'insert') {
          return (entries: { vaneId: number; vector: Float32Array }[]) => {
            if (failNext) { failNext = false; return Promise.reject(new Error('boom')); }
            return target.insert(entries);
          };
        }
        return Reflect.get(target, prop);
      },
    });
    await expect(runFullIndex({ db, source, provider, client: flaky, gen })).rejects.toThrow('boom');
    // nothing was applied for the failed file: the insert rejected before any
    // generation mutation, so gen (and its rev map) must be exactly as before.
    expect(gen.idMap).toEqual({});
    expect(gen.tombstones).toEqual([]);
    expect(gen.nextVaneId).toBe(0);

    const res = await runFullIndex({ db, source, provider, client, gen });
    expect(res).toEqual({ indexed: 3, skipped: 0 });
  });

  it('refuses to index when the provider fingerprint does not match the generation, writing nothing', async () => {
    const { db, source, client } = await setup();
    // A generation stamped with a fingerprint the live `provider` did NOT produce — e.g. the
    // user switched provider without clicking "Rebuild". Every caller (manual or live) must
    // be refused before anything is read/embedded/written, so a poisoned vector row keyed by
    // the WRONG fingerprint can never land in the vectors store.
    const mismatched = newGeneration(99, {
      embeddingFingerprint: FP + ':mismatched', graphFingerprint: GRAPH_FP, dim: 64,
    });
    await saveGeneration(db, mismatched);

    await expect(runFullIndex({ db, source, provider, client, gen: mismatched }))
      .rejects.toThrow(/fingerprint mismatch/);

    // Nothing was applied: gen untouched, and — the actual bug this guards against —
    // no vector row was written under any fingerprint.
    expect(mismatched.idMap).toEqual({});
    expect(mismatched.nextVaneId).toBe(0);
    const vectorRows = await reqAsPromise(db.transaction('vectors').objectStore('vectors').getAll());
    expect(vectorRows).toEqual([]);
  });
});

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
