import { describe, it, expect } from 'vitest';
import manifest from '../../manifest.json';
import pkg from '../../package.json';

describe('scaffold', () => {
  it('manifest agrees with package.json and the spec constraints', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.minAppVersion).toBe('1.11.4');
    expect(manifest.isDesktopOnly).toBe(false);
  });
});
