import { hash64 } from '../hash';
import { l2Normalize, type EmbeddingProvider } from './embedding-provider';

/**
 * Deterministic feature-hashing embedder: token unigrams hashed into dim buckets.
 * Similar texts get similar vectors, so ranking tests are meaningful — the
 * keystone test artifact of the spec. Never ships to users as a real provider.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'feature-hash-v1';
  constructor(private dim = 64) {}
  dimension() { return this.dim; }
  maxBatch() { return 512; }

  async embed(texts: string[], _kind: 'query' | 'doc'): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const tok of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        v[Number(BigInt('0x' + hash64(tok)) % BigInt(this.dim))] += 1;
      }
      if (v.every((x) => x === 0)) v[0] = 1; // empty text → fixed unit vector
      return l2Normalize(v);
    });
  }
}
