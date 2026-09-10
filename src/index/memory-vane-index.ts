import { ApproxIndex } from '@vanedb/wasm';
import type { IndexHit, VaneIndex, VaneIndexOptions } from './vane-index';

export class MemoryVaneIndex implements VaneIndex {
  private idx: ApproxIndex;

  constructor(opts: VaneIndexOptions) {
    this.idx = new ApproxIndex(opts.dim, 'dot', opts.capacity, opts.m ?? 16, opts.efConstruction ?? 200);
  }

  insert(vaneId: number, vector: Float32Array): void {
    try {
      this.idx.add(BigInt(vaneId), vector);
    } catch (e) {
      throw new Error(`index insert failed (capacity ${this.idx.size()} used?): ${String(e)}`);
    }
  }

  search(query: Float32Array, k: number): IndexHit[] {
    const res = this.idx.search(query, k); // ids/distances rank order, ascending distance
    try {
      // res.ids / res.distances are wasm-bindgen getters: each access invokes a wasm
      // export and copies the whole array. Read once, then loop over the local copies.
      const ids = res.ids;
      const distances = res.distances;
      const n = res.length;
      const hits: IndexHit[] = [];
      for (let i = 0; i < n; i++) {
        hits.push({ vaneId: Number(ids[i]), score: -distances[i] });
      }
      return hits;
    } finally {
      res.free();
    }
  }

  size(): number { return this.idx.size(); }
  free(): void { this.idx.free(); }
}
