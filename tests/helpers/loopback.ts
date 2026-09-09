// tests/helpers/loopback.ts — client and host in one process, no Worker
import type { IndexRequest, IndexResponse, Transport } from '../../src/index/index-client';

export function loopbackTransport(handle: (msg: IndexRequest) => IndexResponse): Transport {
  let cb: (r: IndexResponse) => void = () => {};
  return {
    post: (msg) => queueMicrotask(() => cb(handle(msg))),
    onResponse: (c) => { cb = c; },
  };
}
