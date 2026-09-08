import type { IndexHit } from './vane-index';

export type IndexRequest =
  | { id: number; type: 'init'; dim: number; capacity: number }
  | { id: number; type: 'insert'; entries: { vaneId: number; vector: Float32Array }[] }
  | { id: number; type: 'search'; query: Float32Array; k: number }
  | { id: number; type: 'stats' };

export type IndexResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

/** Plain `Omit` collapses a union to its common keys; this preserves each variant's own fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface Transport {
  post(msg: IndexRequest): void;
  onResponse(cb: (r: IndexResponse) => void): void;
  /** Fatal transport failure (worker crash): the client rejects everything in flight. */
  onFatal?(cb: (err: Error) => void): void;
}

export class IndexClient {
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;

  constructor(private transport: Transport) {
    transport.onResponse((r) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      r.ok ? p.resolve(r.result) : p.reject(new Error(r.error));
    });
    transport.onFatal?.((err) => {
      const inFlight = [...this.pending.values()];
      this.pending.clear();
      for (const p of inFlight) p.reject(err);
    });
  }

  private call(msg: DistributiveOmit<IndexRequest, 'id'>): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.post({ ...msg, id } as IndexRequest);
    });
  }

  init(dim: number, capacity: number): Promise<void> {
    return this.call({ type: 'init', dim, capacity }) as Promise<void>;
  }
  insert(entries: { vaneId: number; vector: Float32Array }[]): Promise<void> {
    return this.call({ type: 'insert', entries }) as Promise<void>;
  }
  search(query: Float32Array, k: number): Promise<IndexHit[]> {
    return this.call({ type: 'search', query, k }) as Promise<IndexHit[]>;
  }
  stats(): Promise<{ size: number; ready: boolean }> {
    return this.call({ type: 'stats' }) as Promise<{ size: number; ready: boolean }>;
  }
}

export function workerTransport(w: Worker): Transport {
  return {
    post: (msg) => w.postMessage(msg),
    onResponse: (cb) => { w.onmessage = (e: MessageEvent) => cb(e.data as IndexResponse); },
    onFatal: (cb) => { w.onerror = (e) => cb(new Error(`index worker crashed: ${e.message}`)); },
  };
}
