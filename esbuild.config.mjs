import esbuild from 'esbuild';

const prod = process.argv.includes('production');

// 1. Bundle the index worker to a self-contained IIFE string (wasm inlined as Uint8Array).
// The vendored ESM glue references `import.meta.url` in its async default-init path (unused —
// the worker only calls `initSync`); esbuild can't support import.meta in "iife" output and
// warns. Defining it to a harmless constant resolves it at build time instead of at runtime,
// which silences the warning without touching vendored source.
const worker = await esbuild.build({
  entryPoints: ['src/index/index.worker.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  // @vanedb/wasm's package.json exports map picks resolution by condition, not
  // by esbuild's platform default (which is neutral/node-first). Force the
  // browser/web build (`web/index.js`) so `initSync`/`ApproxIndex` come from the
  // wasm-pack --target web glue and the raw `.wasm` import below resolves to
  // `web/vanedb_wasm_bg.wasm`, which esbuild's binary loader inlines. The
  // node build's `initSync()` takes no args and lazily requires the wasm file
  // at runtime — wrong for this offline, inlined, Blob-URL-worker plugin.
  platform: 'browser',
  conditions: ['browser', 'import', 'default'],
  write: false,
  minify: prod,
  loader: { '.wasm': 'binary' },
  define: { 'import.meta.url': '"file:///index.worker.js"' },
});

// 2. Bundle the plugin; the worker source is injected as a compile-time string constant.
const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  external: ['obsidian', 'electron'],
  outfile: 'main.js',
  minify: prod,
  logLevel: 'info',
  define: { __INDEX_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  // NOTE: watch mode does not re-bundle the worker; re-run `npm run dev` after editing src/index/**.
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
}
