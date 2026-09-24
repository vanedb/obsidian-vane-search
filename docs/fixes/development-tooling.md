# Coherent test and build tooling

The independent Vitest upgrades in PRs #9 and #13 could not complete `npm ci`:
#9 combined Vite 8's esbuild peer requirement with the root's esbuild 0.24, and
#13's lockfile omitted required esbuild platform packages. They should be
superseded by this single compatible dependency update, rather than merged in
sequence.

The regenerated lock uses Vitest 4.1.11, Vite 8.3.1 and esbuild 0.28.2. Vite is an
explicit development dependency so its supported major is intentional. CI and the
release workflow retain Node 20; the package declares the Vite engine minimum of
Node 20.19 (or Node 22.12+). Vitest 5 requires Node 22.12+ and is a separate future
migration, not necessary to repair the current build.

Official metadata: [Vitest 4.1.11](https://registry.npmjs.org/vitest/4.1.11),
[Vite 8.3.1](https://registry.npmjs.org/vite/8.3.1),
[esbuild 0.28.2](https://registry.npmjs.org/esbuild/0.28.2), and the
[Vitest 5 migration prerequisites](https://vitest.dev/guide/migration/).

Validated on Node 20.20.2 and npm 10.8.2, without `--force`, `--legacy-peer-deps`,
or install-script bypasses: a clean `npm ci`, typecheck, all 98 current-main tests,
production build, and bundle-size check. The resulting main bundle is 216 KB
against the existing 3 MB limit. Online `npm audit --json` reported zero advisories
for the resolved dependency graph on 2026-09-24. This is a dated audit result, not
a guarantee about future advisories.

The esbuild upgrade can change generated bundle bytes; the final release artifact
must be rebuilt and checked after integration. These packages are development
tooling; this change does not upgrade the embedded `@vanedb/wasm` 0.1.1 engine.
