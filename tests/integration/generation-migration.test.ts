import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbName, openVaneDb, reqAsPromise, txDone } from '../../src/storage/vane-db';
import { newGeneration, loadActiveGeneration } from '../../src/storage/generation-store';
import { chunkWholeFile, CHUNKER_VERSION } from '../../src/chunker/whole-file';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';
import { loadGenerationIntoIndex } from '../../src/indexer/load-generation';
import { IndexClient } from '../../src/index/index-client';
import { createIndexHost } from '../../src/index/index-host';
import { MemoryVaneIndex } from '../../src/index/memory-vane-index';
import { loopbackTransport } from '../helpers/loopback';
import { initWasm } from '../helpers/wasm';

beforeAll(() => initWasm());
describe('generation-scoped schema migration', () => {
  it('upgrades an existing v1 active graph without losing vectors, file checkpoints or metadata', async () => {
    const name = 'v1-generation-migration';
    const request = indexedDB.open(dbName(name), 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('chunks', { keyPath: 'occurrenceId' });
      db.createObjectStore('files', { keyPath: 'path' });
      db.createObjectStore('vectors', { keyPath: ['fingerprint', 'inputHash'] });
      db.createObjectStore('generations', { keyPath: 'generation' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    const oldDb = await reqAsPromise(request);
    const provider = new FakeEmbeddingProvider(64);
    const fingerprint = embeddingFingerprint(provider, CHUNKER_VERSION);
    const gen = newGeneration(4, { dim: 64, embeddingFingerprint: fingerprint, graphFingerprint: 'g' });
    gen.state = 'active'; gen.idMap = { 0: 'note.md#0' }; gen.nextVaneId = 1;
    const chunk = chunkWholeFile('note.md', 'retained coffee content')[0];
    const [vector] = await provider.embed([chunk.embeddedText], 'doc');
    const tx = oldDb.transaction(['chunks', 'files', 'vectors', 'generations'], 'readwrite');
    tx.objectStore('chunks').put(chunk.row);
    tx.objectStore('files').put({ path: 'note.md', generation: 4, mtime: 1, size: 23, contentHash: 'h' });
    tx.objectStore('vectors').put({ fingerprint, inputHash: chunk.row.inputHash, vector });
    tx.objectStore('generations').put(gen);
    await txDone(tx); oldDb.close();

    const db = await openVaneDb(name);
    expect(db.version).toBe(2);
    expect(await reqAsPromise(db.transaction('chunks').objectStore('chunks').get([4, 'note.md#0'])))
      .toEqual({ ...chunk.row, generation: 4 });
    expect(await reqAsPromise(db.transaction('files').objectStore('files').get([4, 'note.md']))).toBeTruthy();
    const active = await loadActiveGeneration(db);
    expect(active).toEqual(gen);
    const client = new IndexClient(loopbackTransport(createIndexHost((o) => new MemoryVaneIndex(o))));
    await client.init(64, 10);
    expect(await loadGenerationIntoIndex({ db, client, gen: active! })).toEqual({ loaded: 1, missing: [] });
    expect((await client.search(vector, 1))[0].vaneId).toBe(0);
    db.close();
  });
});
