import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
  // The real `obsidian` package is types-only (no runtime module) — see
  // tests/stubs/obsidian.ts for why this alias exists. The production build
  // (esbuild.config.mjs) is unaffected: it marks 'obsidian' as external and
  // never resolves it at all.
  resolve: { alias: { obsidian: path.resolve(dirname, 'tests/stubs/obsidian.ts') } },
});
