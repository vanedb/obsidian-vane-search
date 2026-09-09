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
