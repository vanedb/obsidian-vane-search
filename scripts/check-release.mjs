import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const manifest = read('manifest.json');
const pkg = read('package.json');
const lock = read('package-lock.json');
const versions = read('versions.json');

assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'Obsidian release version must be MAJOR.MINOR.PATCH');
for (const [name, version] of [
  ['package.json', pkg.version],
  ['package-lock.json', lock.version],
  ['package-lock.json root package', lock.packages[''].version],
]) {
  assert.equal(version, manifest.version, `${name} must match manifest.json`);
}
assert.equal(versions[manifest.version], manifest.minAppVersion,
  'versions.json must map this release to its minimum Obsidian version');
const engine = pkg.devDependencies['@vanedb/wasm'];
assert.match(engine, /^\d+\.\d+\.\d+$/, 'Pin a published engine version, not a range or local tarball');
assert.equal(lock.packages[''].devDependencies['@vanedb/wasm'], engine,
  'root engine dependency must match the lockfile');
assert.equal(lock.packages['node_modules/@vanedb/wasm'].version, engine,
  'locked engine version must match the declared release dependency');
console.log(`Vane Search ${manifest.version}; @vanedb/wasm ${engine}; Obsidian >=${manifest.minAppVersion}`);
