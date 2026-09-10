// tests/helpers/wasm.ts — one-time wasm init for Node tests
//
// Under vitest (Node), `@vanedb/wasm`'s package.json exports map resolves the
// "node" condition (./node/index.mjs), which requires the compiled wasm
// synchronously at module load and exposes a no-arg `initSync()`. The
// package's single root `index.d.ts` types `initSync` for the browser/web
// build only (it takes the wasm bytes); it doesn't describe the node build's
// wrapper. The cast below reflects the actual (no-arg) runtime signature for
// the node condition — the underlying wasm is already loaded either way.
import { initSync as initSyncNode } from '@vanedb/wasm';

const initSync = initSyncNode as unknown as () => void;

let done = false;
export function initWasm(): void {
  if (done) return;
  initSync();
  done = true;
}
