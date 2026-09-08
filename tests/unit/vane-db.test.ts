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
