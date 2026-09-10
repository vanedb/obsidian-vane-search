import { txDone } from '../storage/vane-db';
import type { GenerationRecord } from '../storage/generation-store';

/**
 * Removes every occurrence whose path is in `paths`. This is the exact same removal shape
 * `runFullIndex` already applies when a file shrinks to fewer chunks (tombstone the
 * vaneId, drop it from idMap, delete its chunk row) — just driven by "is this path gone"
 * instead of "did this file's own chunk count shrink". No worker mutation: tombstoned ids
 * simply stop being mapped, and search already filters tombstones (see
 * `SearchService.groupHits`), so nothing needs to change in the live index.
 */
async function removeOccurrencesForPaths(
  db: IDBDatabase,
  gen: GenerationRecord,
  paths: Set<string>,
): Promise<{ removed: number }> {
  if (paths.size === 0) return { removed: 0 };

  const staleOccurrenceIds: string[] = [];
  for (const [vaneIdStr, occ] of Object.entries(gen.idMap)) {
    const path = occ.slice(0, occ.lastIndexOf('#'));
    if (!paths.has(path)) continue;
    const vaneId = Number(vaneIdStr);
    gen.tombstones.push(vaneId);
    delete gen.idMap[vaneId];
    staleOccurrenceIds.push(occ);
  }
  if (staleOccurrenceIds.length === 0) return { removed: 0 };

  // Same tx2 discipline as runFullIndex: chunks + files + generation commit together.
  const tx = db.transaction(['files', 'generations', 'chunks'], 'readwrite');
  for (const occ of staleOccurrenceIds) tx.objectStore('chunks').delete(occ);
  for (const path of paths) tx.objectStore('files').delete(path);
  tx.objectStore('generations').put(gen);
  await txDone(tx);

  return { removed: staleOccurrenceIds.length };
}

/**
 * Startup/batch reconcile: removes every occurrence whose path is NOT in `presentPaths` —
 * i.e. diffs the whole live idMap against the whole vault. Used once at plugin init to
 * catch notes deleted while the plugin was off, or deleted on another device and synced in.
 * For a single known path (a live 'delete' or the old side of a 'rename'), use
 * `removePaths` instead — it skips the O(vault) `presentPaths` computation.
 */
export async function reconcileDeletions(deps: {
  db: IDBDatabase;
  gen: GenerationRecord;
  presentPaths: Set<string>;
}): Promise<{ removed: number }> {
  const { db, gen, presentPaths } = deps;
  const absentPaths = new Set<string>();
  for (const occ of Object.values(gen.idMap)) {
    const path = occ.slice(0, occ.lastIndexOf('#'));
    if (!presentPaths.has(path)) absentPaths.add(path);
  }
  return removeOccurrencesForPaths(db, gen, absentPaths);
}

/**
 * Targeted removal for live vault events: removes every occurrence under the given paths,
 * without computing a whole-vault present-set. `delete` and the old side of a `rename`
 * both call this with a single-path set.
 */
export async function removePaths(deps: {
  db: IDBDatabase;
  gen: GenerationRecord;
  paths: Set<string>;
}): Promise<{ removed: number }> {
  return removeOccurrencesForPaths(deps.db, deps.gen, deps.paths);
}
