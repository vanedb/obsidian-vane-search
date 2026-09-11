import { describe, it, expect, vi } from 'vitest';
import { SerialQueue } from '../../src/lifecycle/serial-queue';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SerialQueue', () => {
  it('runs ops in enqueue order', async () => {
    const q = new SerialQueue(() => {});
    const order: number[] = [];
    q.enqueue(async () => { order.push(1); });
    q.enqueue(async () => { order.push(2); });
    await q.enqueue(async () => { order.push(3); });
    expect(order).toEqual([1, 2, 3]);
  });

  it('never overlaps ops (second waits for the first to finish)', async () => {
    const q = new SerialQueue(() => {});
    const events: string[] = [];
    q.enqueue(async () => {
      events.push('a:start');
      await tick();
      await tick();
      events.push('a:end');
    });
    await q.enqueue(async () => { events.push('b:start'); events.push('b:end'); });
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('routes a throwing op to onError and keeps the chain alive', async () => {
    const onError = vi.fn();
    const q = new SerialQueue(onError);
    const boom = new Error('boom');
    await q.enqueue(async () => { throw boom; });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    const after: string[] = [];
    await q.enqueue(async () => { after.push('ran'); });
    expect(after).toEqual(['ran']); // chain not poisoned
  });

  it('enqueue resolves (does not reject) when the op throws', async () => {
    const q = new SerialQueue(() => {});
    await expect(q.enqueue(async () => { throw new Error('x'); })).resolves.toBeUndefined();
  });
});
