import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { initWasm } from '../helpers/wasm';
import { loopbackTransport } from '../helpers/loopback';
import { MemoryFileSource } from '../helpers/memory-files';
import { openVaneDb, reqAsPromise } from '../../src/storage/vane-db';
import { newGeneration, saveGeneration } from '../../src/storage/generation-store';
import { createIndexHost } from '../../src/index/index-host';
import { IndexClient } from '../../src/index/index-client';
import { MemoryVaneIndex } from '../../src/index/memory-vane-index';
import { capacityFor } from '../../src/index/vane-index';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';
import { CHUNKER_VERSION, type ChunkRow } from '../../src/chunker/whole-file';
import { runFullIndex, type FileSource } from '../../src/indexer/full-index';
import { loadGenerationIntoIndex } from '../../src/indexer/load-generation';
import { reconcileDeletions } from '../../src/indexer/reconcile';

// This file exercises the "keep the index in sync" primitives added on top of
// runFullIndex/loadGenerationIntoIndex: reconcileDeletions (startup + live delete/rename)
// and single-file reindex-via-runFullIndex (live create/modify/rename). main.ts's event
// wiring around these is thin Obsidian glue and is not re-tested here — see the plan.

beforeAll(() => initWasm());

const provider = new FakeEmbeddingProvider(64);
const FP = embeddingFingerprint(provider, CHUNKER_VERSION);
const GRAPH_FP = 'dot:m16:ef200';

function freshClient() {
  return new IndexClient(loopbackTransport(createIndexHost((o) => new MemoryVaneIndex(o))));
}

/** Mirrors main.ts's `singleFileSource`: a FileSource that lists exactly one path. */
function oneFile(path: string, content: string, mtime = 1): FileSource {
  return {
    list: () => [{ path, mtime, size: content.length }],
    read: async () => content,
  };
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
  const db = await openVaneDb(`reconcile-${n++}`);
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

describe('reconcileDeletions', () => {
  it('1. deleting a note tombstones it, drops it from idMap/chunks/files, and it stops being searchable', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    const breadId = Number(Object.entries(gen.idMap).find(([, occ]) => occ === 'bread.md#0')![0]);

    const presentPaths = new Set(['coffee.md', 'k8s.md']); // bread.md deleted
    const { removed } = await reconcileDeletions({ db, gen, presentPaths });
    expect(removed).toBe(1);

    expect(gen.idMap[breadId]).toBeUndefined();
    expect(gen.tombstones).toContain(breadId);
    expect(await reqAsPromise(db.transaction('chunks').objectStore('chunks').get('bread.md#0'))).toBeUndefined();
    expect(await reqAsPromise(db.transaction('files').objectStore('files').get('bread.md'))).toBeUndefined();

    const hits = await searchOccurrences(client, gen, 'sourdough starter feeding schedule');
    expect(hits).not.toContain('bread.md#0');
  });

  it('2. startup reconcile removes a note deleted while the plugin was off (or synced in from another device); a restart then loads only the survivors', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    expect(Object.keys(gen.idMap)).toHaveLength(3);

    // Simulate "while off" / cross-device deletion: k8s.md is gone from the vault, but the
    // index (built before the deletion happened, or synced from another device that hasn't
    // deleted it) still thinks it's live.
    const presentPaths = new Set(['coffee.md', 'bread.md']);
    const { removed } = await reconcileDeletions({ db, gen, presentPaths });
    expect(removed).toBe(1);
    expect(Object.values(gen.idMap)).not.toContain('k8s.md#0');

    // Restart-style rebuild of the worker index from IDB: only the two survivors load.
    const client2 = freshClient();
    await client2.init(gen.dim, capacityFor(Object.keys(gen.idMap).length + gen.tombstones.length));
    const { loaded, missing } = await loadGenerationIntoIndex({ db, client: client2, gen });
    expect(missing).toEqual([]);
    expect(loaded).toBe(2);
    const hits = await searchOccurrences(client2, gen, 'kubernetes cluster upgrade checklist');
    expect(hits).not.toContain('k8s.md#0');
  });
});

describe('live create/modify/rename via single-file runFullIndex', () => {
  it('5. create/modify: a new file is indexed and searchable; a later modify tombstones the old chunk and indexes the new content', async () => {
    const { db, client, gen } = await setup();
    // 'create' → single-file reindex.
    await runFullIndex({ db, source: oneFile('tea.md', 'oolong tea steeping temperature guide'), provider, client, gen });
    expect(Object.values(gen.idMap)).toContain('tea.md#0');
    expect((await searchOccurrences(client, gen, 'oolong tea steeping temperature'))[0]).toBe('tea.md#0');
    const oldId = Number(Object.entries(gen.idMap).find(([, occ]) => occ === 'tea.md#0')![0]);

    // 'modify' → single-file reindex again, with changed content.
    await runFullIndex({ db, source: oneFile('tea.md', 'matcha whisking technique and water temperature', 2), provider, client, gen });
    expect(gen.tombstones).toContain(oldId);
    const newId = Number(Object.entries(gen.idMap).find(([, occ]) => occ === 'tea.md#0')![0]);
    expect(newId).not.toBe(oldId);
    const hits = await searchOccurrences(client, gen, 'matcha whisking technique');
    expect(hits[0]).toBe('tea.md#0');
  });
});

describe('rename', () => {
  it('3. basename change: removePath(old) + reindex(new) drops the old occurrence and makes the new path searchable', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    const oldId = Number(Object.entries(gen.idMap).find(([, occ]) => occ === 'coffee.md#0')![0]);

    // removePath('coffee.md'): reconcile with every OTHER path present.
    const presentPaths = new Set(['k8s.md', 'bread.md']);
    await reconcileDeletions({ db, gen, presentPaths });
    expect(gen.idMap[oldId]).toBeUndefined();
    expect(gen.tombstones).toContain(oldId);

    // reindex(new path) — same content, new basename → new title → re-embedded, new occurrenceId.
    await runFullIndex({ db, source: oneFile('espresso.md', 'v60 pourover brewing ratios and grind size'), provider, client, gen });
    expect(Object.values(gen.idMap)).toContain('espresso.md#0');
    expect(Object.values(gen.idMap)).not.toContain('coffee.md#0');
    const hits = await searchOccurrences(client, gen, 'pourover brewing ratios grind size');
    expect(hits[0]).toBe('espresso.md#0');
  });

  it('4. move (folder change, same basename): the new path is indexed WITHOUT re-embedding (vector reused via dedupe); the old path is removed', async () => {
    const { db, source, client, gen } = await setup();
    await runFullIndex({ db, source, provider, client, gen });
    const oldId = Number(Object.entries(gen.idMap).find(([, occ]) => occ === 'coffee.md#0')![0]);

    const presentPaths = new Set(['k8s.md', 'bread.md']);
    await reconcileDeletions({ db, gen, presentPaths });
    expect(gen.idMap[oldId]).toBeUndefined();

    let embedCalls = 0;
    const counting = new Proxy(provider, {
      get(target, prop) {
        if (prop === 'embed') {
          return (texts: string[], kind: 'query' | 'doc') => { embedCalls += texts.length; return target.embed(texts, kind); };
        }
        return Reflect.get(target, prop);
      },
    });
    // Same basename ('coffee'), different folder, IDENTICAL content → same inputHash → the
    // stored vector from the original coffee.md is reused; the provider is not called again.
    await runFullIndex({ db, source: oneFile('archive/coffee.md', 'v60 pourover brewing ratios and grind size'), provider: counting, client, gen });
    expect(embedCalls).toBe(0);

    expect(Object.values(gen.idMap)).toContain('archive/coffee.md#0');
    expect(Object.values(gen.idMap)).not.toContain('coffee.md#0');
    const hits = await searchOccurrences(client, gen, 'pourover brewing ratios grind size');
    expect(hits[0]).toBe('archive/coffee.md#0');
  });
});
