export interface IndexHit { vaneId: number; score: number }

/** Seam between MemoryVaneIndex (v1) and PersistentVaneIndex (Phase 4, byte API). */
export interface VaneIndex {
  insert(vaneId: number, vector: Float32Array): void;
  /** Hits sorted by descending score (score = -distance for the dot metric). */
  search(query: Float32Array, k: number): IndexHit[];
  size(): number;
  free(): void;
}

export interface VaneIndexOptions { dim: number; capacity: number; m?: number; efConstruction?: number }

/** vanedb pre-allocates capacity eagerly (a growth hint, not a hard cap) — 2x headroom, floor 1024. */
export function capacityFor(expected: number): number {
  return Math.max(1024, 2 * expected);
}
