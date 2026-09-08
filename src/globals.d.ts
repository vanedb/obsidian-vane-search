declare const __INDEX_WORKER_SOURCE__: string;
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}
