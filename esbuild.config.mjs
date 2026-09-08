import esbuild from 'esbuild';

const prod = process.argv.includes('production');

// 1. Bundle the index worker to a self-contained IIFE string (wasm inlined as Uint8Array).
const worker = await esbuild.build({
  entryPoints: ['src/index/index.worker.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  write: false,
  minify: prod,
  loader: { '.wasm': 'binary' },
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
