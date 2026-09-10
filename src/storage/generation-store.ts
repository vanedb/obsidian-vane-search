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

/**
 * Next generation number to use for a new build, derived from the MAX generation number
 * already present in the `generations` store (active OR building rows) — NOT from
 * `(activeGeneration ?? 0) + 1`. That distinction matters for crash-safety: callers always
 * `saveGeneration` the new `building` row BEFORE starting the build (see
 * `buildGenerationInNewWorker` in main.ts), so if that build crashes, its (possibly partial)
 * `building` row survives in the store. A naive "active + 1" retry would recompute the exact
 * same number the crashed attempt used, and the crashed attempt's files-rows (stamped with
 * that number) could then be misread by the retry's skip-check as already indexed — even
 * though the retry's own in-memory generation never actually mapped them. Deriving from the
 * store's own max instead means the retry always picks one past whatever the crashed attempt
 * left behind, so its number is never reused. Empty store → 1.
 */
export async function nextGenerationNumber(db: IDBDatabase): Promise<number> {
  const keys = await reqAsPromise<IDBValidKey[]>(
    db.transaction('generations').objectStore('generations').getAllKeys());
  const max = keys.reduce((a: number, b) => Math.max(a, Number(b)), 0);
  return max + 1;
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
 * Puts a copy with state 'active' into the database, then mutates rec.state in memory
 * only after txDone resolves. This ensures subsequent saveGeneration(rec) calls
 * (incremental indexing re-persists the record) keep it 'active' — if activate fails,
 * rec remains 'building' and the caller knows the transaction did not commit.
 */
export async function activateGeneration(db: IDBDatabase, rec: GenerationRecord): Promise<void> {
  const tx = db.transaction('generations', 'readwrite');
  const store = tx.objectStore('generations');
  const keysReq = store.getAllKeys();
  keysReq.onsuccess = () => {
    for (const key of keysReq.result) if (key !== rec.generation) store.delete(key);
    store.put({ ...rec, state: 'active' });
  };
  await txDone(tx);
  rec.state = 'active';
}
