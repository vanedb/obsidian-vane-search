// src/index/index.worker.ts — worker glue; bundled standalone by esbuild, wasm inlined
import { initSync } from '../../vendor/vanedb-wasm/vanedb_wasm.js';
import wasmBytes from '../../vendor/vanedb-wasm/vanedb_wasm_bg.wasm';
import { createIndexHost } from './index-host';
import { MemoryVaneIndex } from './memory-vane-index';
import type { IndexRequest } from './index-client';

initSync({ module: wasmBytes });
const handle = createIndexHost((opts) => new MemoryVaneIndex(opts));
const scope = self as unknown as { onmessage: unknown; postMessage(m: unknown): void };
scope.onmessage = (e: MessageEvent) => scope.postMessage(handle(e.data as IndexRequest));
