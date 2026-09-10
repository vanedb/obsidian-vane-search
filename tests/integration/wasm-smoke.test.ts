import { describe, it, expect, beforeAll } from 'vitest';
import { initWasm } from '../helpers/wasm';
import { ApproxIndex } from '@vanedb/wasm';

// Pins the vanedb contract the whole plugin relies on. If vanedb changes
// semantics, THIS test fails — not a silently inverted ranking in the UI.
//
// vanedb-wasm's ApproxIndex.search() returns a SearchResults object with
// `ids` (BigUint64Array, rank order) and `distances` (Float32Array, ascending).
// Metric 'dot' reports distance = -(dot product), so score = -distance.
describe('@vanedb/wasm contract', () => {
  beforeAll(() => initWasm());

  const unit = (...xs: number[]) => {
    const v = new Float32Array(4);
    xs.forEach((x, i) => (v[i] = x));
    const n = Math.hypot(...v);
    return v.map((x) => x / n) as Float32Array;
  };

  it('dot metric returns distance = -dot; identical vector scores ~1.0', () => {
    const idx = new ApproxIndex(4, 'dot', 16, 16, 200);
    idx.add(0n, unit(1, 0, 0, 0));
    idx.add(1n, unit(0.6, 0.8, 0, 0)); // dot with e1 = 0.6
    idx.add(2n, unit(0, 0, 1, 0));     // dot with e1 = 0
    const res = idx.search(unit(1, 0, 0, 0), 3);
    // res.ids / res.distances are parallel, ascending distance (best match first)
    expect(res.ids[0]).toBe(0n);
    expect(-res.distances[0]).toBeCloseTo(1.0, 3); // score = -distance
    expect(res.ids[1]).toBe(1n);
    expect(-res.distances[1]).toBeCloseTo(0.6, 3);
    expect(res.ids[2]).toBe(2n);
    idx.free();
  });

  it('size() and contains() behave', () => {
    const idx = new ApproxIndex(4, 'dot', 16, 16, 200);
    idx.add(7n, unit(1, 0, 0, 0));
    expect(idx.size()).toBe(1);
    expect(idx.contains(7n)).toBe(true);
    expect(idx.contains(8n)).toBe(false);
    idx.free();
  });
});
