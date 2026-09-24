import 'fake-indexeddb/auto';
import { it, expect } from 'vitest';
import { openVaneDb, reqAsPromise } from '../../src/storage/vane-db';
import { newGeneration, saveGeneration, activateGeneration, loadActiveGeneration } from '../../src/storage/generation-store';
import { runFullIndex } from '../../src/indexer/full-index';
import { loadGenerationIntoIndex } from '../../src/indexer/load-generation';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';
import { CHUNKER_VERSION } from '../../src/chunker/whole-file';
import { MemoryFileSource } from '../helpers/memory-files';
import type { IndexClient } from '../../src/index/index-client';

// Independently reproduced on PR #16: its old active graph restored zero rows
// after a failed candidate overwrote the shared occurrence's inputHash.
it('failed replacement preserves the old active generation metadata and restart vectors', async () => {
  const db = await openVaneDb('audit-failed-rebuild');
  const source = new MemoryFileSource();
  source.set('note.md', '# Old heading\nold apples');
  const oldProvider = new FakeEmbeddingProvider(64);
  const oldGen = newGeneration(1, {
    embeddingFingerprint: embeddingFingerprint(oldProvider, CHUNKER_VERSION), graphFingerprint: 'test', dim: 64,
  });
  const client = { insert: async () => {} } as unknown as IndexClient;
  await saveGeneration(db, oldGen);
  await runFullIndex({ db, source, provider: oldProvider, client, gen: oldGen });
  await activateGeneration(db, oldGen);
  const before = await reqAsPromise(db.transaction('chunks').objectStore('chunks').get([1, 'note.md#0']));

  source.set('note.md', '# New heading\nnew bananas', 2);
  const newProvider = new FakeEmbeddingProvider(32);
  const buildGen = newGeneration(2, {
    embeddingFingerprint: embeddingFingerprint(newProvider, CHUNKER_VERSION), graphFingerprint: 'test', dim: 32,
  });
  await saveGeneration(db, buildGen);
  const broken = { insert: async () => { throw Error('build worker failed'); } } as unknown as IndexClient;
  await expect(runFullIndex({ db, source, provider: newProvider, client: broken, gen: buildGen }))
    .rejects.toThrow('build worker failed');

  const active = (await loadActiveGeneration(db))!;
  expect(active.generation).toBe(1);
  expect(await loadGenerationIntoIndex({ db, client, gen: active })).toEqual({ loaded: 1, missing: [] });
  expect(await reqAsPromise(db.transaction('chunks').objectStore('chunks').get([1, 'note.md#0']))).toEqual(before);
  expect(await reqAsPromise(db.transaction('chunks').objectStore('chunks').get([2, 'note.md#0']))).toBeUndefined();
  db.close();
});
