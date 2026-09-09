import type { VaneIndex, VaneIndexOptions } from './vane-index';
import type { IndexRequest, IndexResponse } from './index-client';

/** Pure request dispatcher — the worker glue is 3 lines, everything testable lives here. */
export function createIndexHost(
  factory: (opts: VaneIndexOptions) => VaneIndex,
): (msg: IndexRequest) => IndexResponse {
  let index: VaneIndex | null = null;
  return (msg) => {
    try {
      switch (msg.type) {
        case 'init':
          index?.free();
          index = factory({ dim: msg.dim, capacity: msg.capacity });
          return { id: msg.id, ok: true };
        case 'insert': {
          if (!index) throw new Error('index not initialized');
          for (const e of msg.entries) index.insert(e.vaneId, e.vector);
          return { id: msg.id, ok: true };
        }
        case 'search': {
          if (!index) throw new Error('index not initialized');
          return { id: msg.id, ok: true, result: index.search(msg.query, msg.k) };
        }
        case 'stats':
          return { id: msg.id, ok: true, result: { size: index?.size() ?? 0, ready: index !== null } };
      }
    } catch (e) {
      return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
