import { describe, it, expect } from 'vitest';
import { meanVector } from '../../src/ui/related-notes-view';

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
