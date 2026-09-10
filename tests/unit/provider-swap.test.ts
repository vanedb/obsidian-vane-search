import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, buildProvider } from '../../src/settings/settings';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';
import { CHUNKER_VERSION } from '../../src/chunker/chunker';

const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;

describe('provider swap triggers re-embed', () => {
  it('changing model changes the fingerprint (Phase-1 machinery then rebuilds)', () => {
    const a = buildProvider(DEFAULT_SETTINGS, null, post);
    const b = buildProvider({ ...DEFAULT_SETTINGS, model: 'mxbai-embed-large', dimension: 1024 }, null, post);
    expect(embeddingFingerprint(a, CHUNKER_VERSION)).not.toBe(embeddingFingerprint(b, CHUNKER_VERSION));
  });
  it('the fake→real switch also changes the fingerprint (id differs)', () => {
    const real = buildProvider(DEFAULT_SETTINGS, null, post);
    expect(real.id.startsWith('oai:')).toBe(true); // never collides with the fake provider's id 'fake'
  });
});
