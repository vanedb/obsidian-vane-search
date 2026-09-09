export interface EmbeddingProvider {
  /** Stable short id, part of the embedding fingerprint (e.g. 'fake', 'openai-compat'). */
  readonly id: string;
  readonly model: string;
  dimension(): number;
  maxBatch(): number;
  /** Returns one L2-normalized vector per input text, in order. */
  embed(texts: string[], kind: 'query' | 'doc'): Promise<Float32Array[]>;
}

/** Embedding identity axis (spec "Versioning"): change ⇒ re-embed everything. */
export function embeddingFingerprint(p: EmbeddingProvider, chunkerVersion: number): string {
  return `${p.id}:${p.model}:${p.dimension()}:c${chunkerVersion}`;
}

export function l2Normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) throw new Error(`non-finite component at ${i}`);
    sq += v[i] * v[i];
  }
  const n = Math.sqrt(sq);
  if (n === 0) throw new Error('cannot normalize the zero vector');
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
