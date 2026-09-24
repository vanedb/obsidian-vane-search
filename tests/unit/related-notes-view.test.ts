import { describe, it, expect } from 'vitest';
import { meanVector, normalizedCentroid, CENTROID_NORM_FLOOR } from '../../src/ui/related-notes-view';

describe('meanVector', () => {
  it('returns the vector unchanged when given a single vector', () => {
    const v = Float32Array.from([1, 2, 3]);
    expect([...meanVector([v], 3)]).toEqual([1, 2, 3]);
  });

  it('returns the component-wise mean of multiple vectors', () => {
    const a = Float32Array.from([1, 0, 4]);
    const b = Float32Array.from([3, 2, 0]);
    expect([...meanVector([a, b], 3)]).toEqual([2, 1, 2]);
  });

  it('does not mutate its input arrays', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([5, 6, 7]);
    meanVector([a, b], 3);
    expect([...a]).toEqual([1, 2, 3]);
    expect([...b]).toEqual([5, 6, 7]);
  });
});


describe('normalizedCentroid', () => {
  it('returns no direction for no chunks, zero chunks, or opposing chunks', () => {
    expect(normalizedCentroid([], 2)).toBeNull();
    expect(normalizedCentroid([new Float32Array(2)], 2)).toBeNull();
    expect(normalizedCentroid([Float32Array.of(1, 0), Float32Array.of(-1, 0)], 2)).toBeNull();
  });

  it('suppresses near cancellation on either side of zero', () => {
    for (const residual of [-CENTROID_NORM_FLOOR, CENTROID_NORM_FLOOR]) {
      expect(normalizedCentroid([Float32Array.of(1, 0), Float32Array.of(-1, residual)], 2)).toBeNull();
    }
  });

  it('keeps a direction above the floor and preserves cosine-score scaling', () => {
    const vectors = [Float32Array.of(1, 0), Float32Array.of(0, 1)];
    const mean = meanVector(vectors, 2);
    const centroid = normalizedCentroid(vectors, 2)!;
    expect(Math.hypot(...centroid)).toBeCloseTo(1, 6);
    const candidate = Float32Array.of(0.6, 0.8);
    const score = centroid.reduce((sum, value, i) => sum + value * candidate[i], 0);
    const cosine = mean.reduce((sum, value, i) => sum + value * candidate[i], 0) / Math.hypot(...mean);
    expect(score).toBeCloseTo(cosine, 6);
    expect(score).toBeGreaterThan(0.9); // a unit-vector search floor, unaffected by mean length
    expect([...vectors[0]]).toEqual([1, 0]);
    expect([...vectors[1]]).toEqual([0, 1]);
    expect(normalizedCentroid([Float32Array.of(1, 0), Float32Array.of(-1, 4 * CENTROID_NORM_FLOOR)], 2)).not.toBeNull();
  });

  it('does not lose a small surviving component to float32 summation', () => {
    const vectors = [Float32Array.of(1, 0), Float32Array.of(1e-8, 0), Float32Array.of(-1, 0)];
    expect(meanVector(vectors, 2)[0]).toBeCloseTo(1e-8 / 3, 14);
  });
});
