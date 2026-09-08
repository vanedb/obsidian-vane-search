import { describe, it, expect } from 'vitest';
import { createIndexHost } from '../../src/index/index-host';
import { IndexClient, type Transport } from '../../src/index/index-client';
import { loopbackTransport } from '../helpers/loopback';
import type { IndexHit, VaneIndex, VaneIndexOptions } from '../../src/index/vane-index';

/** Deterministic stub index: score = 1 / (1 + |queryLen - vaneId|), no wasm involved. */
class StubIndex implements VaneIndex {
  ids: number[] = [];
  insert(vaneId: number) { this.ids.push(vaneId); }
  search(query: Float32Array, k: number): IndexHit[] {
    return this.ids
      .map((id) => ({ vaneId: id, score: 1 / (1 + Math.abs(query.length - id)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
  size() { return this.ids.length; }
  free() {}
}

describe('index host protocol', () => {
  const setup = () => {
    const handle = createIndexHost((_opts: VaneIndexOptions) => new StubIndex());
    return { client: new IndexClient(loopbackTransport(handle)) };
  };

  it('init → insert → search → stats round-trip', async () => {
    const { client } = setup();
    await client.init(64, 1024);
    await client.insert([{ vaneId: 3, vector: new Float32Array(64) }, { vaneId: 64, vector: new Float32Array(64) }]);
    const hits = await client.search(new Float32Array(64), 2);
    expect(hits[0].vaneId).toBe(64); // |64-64| = 0 → best
    expect(await client.stats()).toEqual({ size: 2, ready: true });
  });

  it('search before init rejects with a useful error', async () => {
    const { client } = setup();
    await expect(client.search(new Float32Array(4), 1)).rejects.toThrow(/not initialized/i);
  });

  it('errors are per-request: a failed call does not poison the next one', async () => {
    const { client } = setup();
    await expect(client.insert([{ vaneId: 0, vector: new Float32Array(4) }])).rejects.toThrow(/not initialized/i);
    await client.init(4, 16);
    await client.insert([{ vaneId: 0, vector: new Float32Array(4) }]);
    expect((await client.stats()).size).toBe(1);
  });

  it('interleaved requests resolve to their own responses', async () => {
    const { client } = setup();
    await client.init(4, 16);
    await client.insert([{ vaneId: 1, vector: new Float32Array(4) }]);
    const [a, b] = await Promise.all([client.stats(), client.search(new Float32Array(4), 1)]);
    expect(a).toEqual({ size: 1, ready: true });
    expect(b[0].vaneId).toBe(1);
  });

  it('a fatal transport error rejects every in-flight request', async () => {
    let fatal: ((e: Error) => void) | undefined;
    const t: Transport = { post: () => {}, onResponse: () => {}, onFatal: (cb) => { fatal = cb; } };
    const client = new IndexClient(t);
    const p1 = client.stats();
    const p2 = client.search(new Float32Array(4), 1);
    fatal!(new Error('worker crashed'));
    await expect(p1).rejects.toThrow('worker crashed');
    await expect(p2).rejects.toThrow('worker crashed');
  });
});
