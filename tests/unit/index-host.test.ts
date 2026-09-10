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

  it('rejectInFlight() rejects every pending call directly, independent of onFatal — used when a caller is about to terminate the worker itself (e.g. a background-rebuild swap)', async () => {
    const t: Transport = { post: () => {}, onResponse: () => {} }; // no onFatal — nothing ever calls the worker back
    const client = new IndexClient(t);
    const p1 = client.stats();
    const p2 = client.search(new Float32Array(4), 1);
    client.rejectInFlight(new Error('index worker swapped'));
    await expect(p1).rejects.toThrow('index worker swapped');
    await expect(p2).rejects.toThrow('index worker swapped');
    // A response that arrives after rejectInFlight has already cleared the queue must be a
    // harmless no-op — no stray resolve on an already-settled promise, no throw.
    expect(() => client.rejectInFlight(new Error('again'))).not.toThrow();
  });

  it('rejectInFlight() retires the client: a call made AFTER it rejects immediately instead of hanging (real client + real host, over the loopback transport)', async () => {
    // Uses a REAL IndexClient/host round-trip (via setup()), not a canned mock — this
    // exercises the actual call()/dead gate, not just a hand-rolled Transport stub.
    const { client } = setup();
    await client.init(64, 1024);

    // A call already posted and in flight when rejectInFlight fires rejects with that error
    // (pre-existing behavior, still covered here for completeness).
    const pending = client.search(new Float32Array(64), 1);
    client.rejectInFlight(new Error('index worker swapped'));
    await expect(pending).rejects.toThrow('index worker swapped');

    // A call made AFTER rejectInFlight — e.g. a search that was parked on an embedding call
    // at swap time and only reaches .search()/.stats() afterward — must reject immediately
    // instead of posting to a (by then terminated) worker and hanging forever: plain
    // Worker.terminate() makes postMessage a silent no-op, so nothing would otherwise ever
    // settle that promise.
    await expect(client.search(new Float32Array(64), 1)).rejects.toThrow(/no longer available/i);
    await expect(client.stats()).rejects.toThrow(/no longer available/i);

    // Calling rejectInFlight again (e.g. onFatal firing after the deliberate swap-time call)
    // must stay a harmless no-op.
    expect(() => client.rejectInFlight(new Error('again'))).not.toThrow();
  });
});
