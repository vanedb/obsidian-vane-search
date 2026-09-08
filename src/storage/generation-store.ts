import { reqAsPromise, txDone } from './vane-db';

/**
 * The atomic consistency unit (spec "Persistence"): everything needed to
 * interpret the index — id mapping, tombstones, id counter, identity
 * fingerprints — commits together or not at all.
 */
export interface GenerationRecord {
  generation: number;
  state: 'active' | 'building';
  embeddingFingerprint: string;
  graphFingerprint: string;
  dim: number;
  idMap: Record<number, string>; // vaneId → occurrenceId
  tombstones: number[];
  nextVaneId: number;
  snapshotSeq: number; // replacement-build replay marker; unused until Phase 4
}

export function newGeneration(
  generation: number,
  opts: { embeddingFingerprint: string; graphFingerprint: string; dim: number },
): GenerationRecord {
  return {
    generation, state: 'building', ...opts,
    idMap: {}, tombstones: [], nextVaneId: 0, snapshotSeq: 0,
  };
}

export async function saveGeneration(db: IDBDatabase, rec: GenerationRecord): Promise<void> {
  const tx = db.transaction('generations', 'readwrite');
  tx.objectStore('generations').put(rec);
  await txDone(tx);
}

export async function loadActiveGeneration(db: IDBDatabase): Promise<GenerationRecord | null> {
  const all = await reqAsPromise<GenerationRecord[]>(
    db.transaction('generations').objectStore('generations').getAll());
  const actives = all.filter((g) => g.state === 'active');
  if (actives.length === 0) return null;
  return actives.reduce((a, b) => (b.generation > a.generation ? b : a));
}

/**
 * One transaction: the new record becomes active and every other row dies with it.
 * Mutates rec.state in memory on purpose: subsequent saveGeneration(rec) calls
 * (incremental indexing re-persists the record) must keep it 'active' — writing
 * a copy here would let them silently demote the row back to 'building'.
 */
export function activateGeneration(db: IDBDatabase, rec: GenerationRecord): Promise<void> {
  rec.state = 'active';
  return new Promise((resolve, reject) => {
    const tx = db.transaction('generations', 'readwrite');
    const store = tx.objectStore('generations');
    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      for (const key of keysReq.result) if (key !== rec.generation) store.delete(key);
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('activate failed'));
    tx.onabort = () => reject(tx.error ?? new Error('activate aborted'));
  });
}
