import { ApproxIndex } from '../../vendor/vanedb-wasm/vanedb_wasm.js';
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
    const hits: IndexHit[] = [];
    for (let i = 0; i < res.length; i++) {
      hits.push({ vaneId: Number(res.ids[i]), score: -res.distances[i] });
    }
    res.free();
    return hits;
  }

  size(): number { return this.idx.size(); }
  free(): void { this.idx.free(); }
}
