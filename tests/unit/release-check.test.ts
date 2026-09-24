import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/check-release.mjs');
const files = ['manifest.json', 'package.json', 'package-lock.json', 'versions.json'];
const version = JSON.parse(readFileSync('manifest.json', 'utf8')).version as string;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vane-release-'));
  dirs.push(dir);
  for (const file of files) writeFileSync(join(dir, file), readFileSync(file));
  return dir;
}

function run(dir: string) {
  return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
}

describe('release metadata gate', () => {
  it('accepts the release metadata committed together', () => {
    const result = run(fixture());
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    ['manifest.json', ['version'], `${version}-rc1`],
    ['package.json', ['version'], '0.0.0'],
    ['package-lock.json', ['version'], '0.0.0'],
    ['package-lock.json', ['packages', '', 'version'], '0.0.0'],
    ['versions.json', [version], '0.0.0'],
    ['package.json', ['devDependencies', '@vanedb/wasm'], 'file:/tmp/candidate.tgz'],
    ['package-lock.json', ['packages', '', 'devDependencies', '@vanedb/wasm'], '0.0.0'],
    ['package-lock.json', ['packages', 'node_modules/@vanedb/wasm', 'version'], '0.0.0'],
  ])('rejects drift in %s at %j', (file, keys, replacement) => {
    const dir = fixture();
    const path = join(dir, file as string);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const parts = keys as string[];
    let target = json;
    for (const key of parts.slice(0, -1)) target = target[key];
    target[parts[parts.length - 1]] = replacement;
    writeFileSync(path, JSON.stringify(json));
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AssertionError');
  });
});
