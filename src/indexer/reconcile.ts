import { txDone } from '../storage/vane-db';
import type { GenerationRecord } from '../storage/generation-store';

/**
 * Removes every occurrence whose file path is not in `presentPaths`. This is the exact
 * same removal shape `runFullIndex` already applies when a file shrinks to fewer chunks
 * (tombstone the vaneId, drop it from idMap, delete its chunk row) — just driven by
 * "is this path still in the vault" instead of "did this file's own chunk count shrink".
 * No worker mutation: tombstoned ids simply stop being mapped, and search already filters
 * tombstones (see `SearchService.groupHits`), so nothing needs to change in the live index.
 *
 * Used both at startup (reconcile drift from edits made while the plugin was off, or
 * synced in from another device) and per-path from live vault 'delete'/'rename' events.
 */
export async function reconcileDeletions(deps: {
  db: IDBDatabase;
  gen: GenerationRecord;
  presentPaths: Set<string>;
}): Promise<{ removed: number }> {
  const { db, gen, presentPaths } = deps;

  const staleOccurrenceIds: string[] = [];
  const staleFilePaths = new Set<string>();
  for (const [vaneIdStr, occ] of Object.entries(gen.idMap)) {
    const path = occ.slice(0, occ.lastIndexOf('#'));
    if (presentPaths.has(path)) continue;
    const vaneId = Number(vaneIdStr);
    gen.tombstones.push(vaneId);
    delete gen.idMap[vaneId];
    staleOccurrenceIds.push(occ);
    staleFilePaths.add(path);
  }
  if (staleOccurrenceIds.length === 0) return { removed: 0 };

  // Same tx2 discipline as runFullIndex: chunks + files + generation commit together.
  const tx = db.transaction(['files', 'generations', 'chunks'], 'readwrite');
  for (const occ of staleOccurrenceIds) tx.objectStore('chunks').delete(occ);
  for (const path of staleFilePaths) tx.objectStore('files').delete(path);
  tx.objectStore('generations').put(gen);
  await txDone(tx);

  return { removed: staleOccurrenceIds.length };
}
