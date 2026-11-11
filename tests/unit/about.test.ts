import { describe, it, expect } from 'vitest';
import { versionLine } from '../../src/settings/about';

describe('settings version line', () => {
  it('names the plugin and the bundled engine, so two builds of one plugin version can be told apart', () => {
    expect(versionLine('0.2.0', '0.2.0-rc.4')).toBe('Vane Search 0.2.0 · VaneDB engine 0.2.0-rc.4');
  });
});
