// tests/helpers/wasm.ts — one-time wasm init for Node tests
import { readFileSync } from 'node:fs';
import { initSync } from '../../vendor/vanedb-wasm/vanedb_wasm.js';

let done = false;
export function initWasm(): void {
  if (done) return;
  initSync({ module: readFileSync(new URL('../../vendor/vanedb-wasm/vanedb_wasm_bg.wasm', import.meta.url)) });
  done = true;
}
