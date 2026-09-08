import { describe, it, expect } from 'vitest';
import { FakeEmbeddingProvider } from '../../src/providers/fake';
import { l2Normalize, embeddingFingerprint } from '../../src/providers/embedding-provider';

const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('FakeEmbeddingProvider', () => {
  const p = new FakeEmbeddingProvider(64);

  it('is deterministic and L2-normalized', async () => {
    const [a] = await p.embed(['alpha beta gamma'], 'doc');
    const [b] = await p.embed(['alpha beta gamma'], 'doc');
    expect([...a]).toEqual([...b]);
    expect(Math.hypot(...a)).toBeCloseTo(1, 5);
    expect(a.length).toBe(64);
  });

  it('gives overlapping texts higher similarity than disjoint ones', async () => {
    const [q, near, far] = await p.embed(
      ['aaa bbb', 'aaa ccc ddd', 'eee fff ggg'], 'doc');
    expect(dot(q, near)).toBeGreaterThan(dot(q, far));
  });

  it('handles empty text without a zero vector', async () => {
    const [v] = await p.embed([''], 'doc');
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });

  it('fingerprint encodes provider, model, dim and chunker version', () => {
    expect(embeddingFingerprint(p, 0)).toBe('fake:feature-hash-v1:64:c0');
  });
});

describe('l2Normalize', () => {
  it('throws on the zero vector', () => {
    expect(() => l2Normalize(new Float32Array(4))).toThrow();
  });
  it('throws on non-finite values', () => {
    expect(() => l2Normalize(Float32Array.from([1, NaN, 0, 0]))).toThrow();
  });
});
