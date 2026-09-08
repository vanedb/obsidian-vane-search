import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { openVaneDb } from '../../src/storage/vane-db';
import {
  newGeneration, saveGeneration, loadActiveGeneration, activateGeneration,
} from '../../src/storage/generation-store';

const OPTS = { embeddingFingerprint: 'fake:feature-hash-v1:64:c0', graphFingerprint: 'dot:m16:ef200', dim: 64 };
let n = 0;
const freshDb = () => openVaneDb(`gen-test-${n++}`);

describe('generation store', () => {
  it('no generations → loadActive returns null', async () => {
    expect(await loadActiveGeneration(await freshDb())).toBeNull();
  });

  it('activate swaps atomically and removes older generations', async () => {
    const db = await freshDb();
    const g1 = newGeneration(1, OPTS);
    g1.idMap[0] = 'a.md#0';
    await activateGeneration(db, g1);
    const g2 = newGeneration(2, OPTS);
    g2.idMap[0] = 'b.md#0';
    await saveGeneration(db, g2); // building
    await activateGeneration(db, g2);
    const active = await loadActiveGeneration(db);
    expect(active?.generation).toBe(2);
    expect(active?.state).toBe('active');
    // g1 is gone — activate deleted it in the same transaction
    const all = await new Promise<unknown[]>((res) => {
      const r = db.transaction('generations').objectStore('generations').getAll();
      r.onsuccess = () => res(r.result);
    });
    expect(all).toHaveLength(1);
  });

  it('CRASH before activate: building row is ignored, old active survives', async () => {
    const db = await freshDb();
    const g1 = newGeneration(1, OPTS);
    await activateGeneration(db, g1);
    const g2 = newGeneration(2, OPTS); // crash: saved as building, never activated
    await saveGeneration(db, g2);
    expect((await loadActiveGeneration(db))?.generation).toBe(1);
  });

  it('round-trips idMap, tombstones, nextVaneId', async () => {
    const db = await freshDb();
    const g = newGeneration(1, OPTS);
    g.idMap[0] = 'a.md#0';
    g.idMap[1] = 'b.md#0';
    g.tombstones.push(0);
    g.nextVaneId = 2;
    await activateGeneration(db, g);
    const back = await loadActiveGeneration(db);
    expect(back?.idMap).toEqual({ 0: 'a.md#0', 1: 'b.md#0' });
    expect(back?.tombstones).toEqual([0]);
    expect(back?.nextVaneId).toBe(2);
    expect(back?.dim).toBe(64);
  });
});
