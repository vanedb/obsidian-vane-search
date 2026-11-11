declare const __INDEX_WORKER_SOURCE__: string;
/** Version of the bundled @vanedb/wasm package, injected by esbuild.config.mjs. */
declare const __VANEDB_ENGINE_VERSION__: string;
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}
