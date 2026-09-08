import { describe, it, expect, beforeAll } from 'vitest';
import { initWasm } from '../helpers/wasm';
import { MemoryVaneIndex } from '../../src/index/memory-vane-index';
import { capacityFor } from '../../src/index/vane-index';
import { FakeEmbeddingProvider } from '../../src/providers/fake';

describe('MemoryVaneIndex', () => {
  beforeAll(() => initWasm());

  it('ranks an exact re-embedding of a doc first, score ~1', async () => {
    const p = new FakeEmbeddingProvider(64);
    const docs = ['coffee brewing with a v60', 'kubernetes cluster upgrades', 'sourdough starter feeding'];
    const vecs = await p.embed(docs, 'doc');
    const idx = new MemoryVaneIndex({ dim: 64, capacity: capacityFor(docs.length) });
    vecs.forEach((v, i) => idx.insert(i, v));
    const [q] = await p.embed(['coffee brewing with a v60'], 'query');
    const hits = idx.search(q, 3);
    expect(hits[0].vaneId).toBe(0);
    expect(hits[0].score).toBeCloseTo(1.0, 3);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    idx.free();
  });

  it('size() tracks inserts; ids round-trip as numbers', async () => {
    const idx = new MemoryVaneIndex({ dim: 4, capacity: 1024 });
    idx.insert(41, Float32Array.from([1, 0, 0, 0]));
    idx.insert(999, Float32Array.from([0, 1, 0, 0]));
    expect(idx.size()).toBe(2);
    expect(idx.search(Float32Array.from([0, 1, 0, 0]), 1)[0].vaneId).toBe(999);
    idx.free();
  });

  it('capacityFor gives 2x with a floor', () => {
    expect(capacityFor(10)).toBe(1024);
    expect(capacityFor(10_000)).toBe(20_000);
  });
});
