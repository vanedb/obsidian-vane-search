import { reqAsPromise, type VectorRow } from '../storage/vane-db';
import type { GenerationRecord } from '../storage/generation-store';
import type { IndexClient } from '../index/index-client';
import type { ChunkRow } from '../chunker/whole-file';

const BATCH = 256;

/** Rebuild the volatile worker index from durable rows (MemoryVaneIndex startup path). */
export async function loadGenerationIntoIndex(deps: {
  db: IDBDatabase;
  client: IndexClient;
  gen: GenerationRecord;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ loaded: number; missing: string[] }> {
  const { db, client, gen } = deps;
  const entries = Object.entries(gen.idMap); // [vaneId(str), occurrenceId]
  const missing: string[] = [];
  let loaded = 0;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch: { vaneId: number; vector: Float32Array }[] = [];
    for (const [vid, occ] of entries.slice(i, i + BATCH)) {
      const chunk = await reqAsPromise<ChunkRow | undefined>(
        db.transaction('chunks').objectStore('chunks').get(occ));
      const vec = chunk && await reqAsPromise<VectorRow | undefined>(
        db.transaction('vectors').objectStore('vectors').get([gen.embeddingFingerprint, chunk.inputHash]));
      if (!chunk || !vec) { missing.push(occ); continue; }
      batch.push({ vaneId: Number(vid), vector: vec.vector });
    }
    if (batch.length) await client.insert(batch);
    loaded += batch.length;
    deps.onProgress?.(Math.min(i + BATCH, entries.length), entries.length);
  }
  return { loaded, missing };
}
