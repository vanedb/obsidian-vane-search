import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, PRESETS, isLocalHost, providerIdFor, buildProvider } from '../../src/settings/settings';
import { embeddingFingerprint } from '../../src/providers/embedding-provider';

describe('settings', () => {
  it('defaults to OpenAI text-embedding-3-small at 1536 dims (works on mobile)', () => {
    expect(DEFAULT_SETTINGS.providerId).toBe('openai');
    expect(DEFAULT_SETTINGS.baseUrl).toBe('https://api.openai.com/v1');
    expect(DEFAULT_SETTINGS.model).toBe('text-embedding-3-small');
    expect(DEFAULT_SETTINGS.dimension).toBe(1536);
    expect(DEFAULT_SETTINGS.docPrefix).toBe('');
    expect(DEFAULT_SETTINGS.queryPrefix).toBe('');
    expect(DEFAULT_SETTINGS.hasApiKey).toBe(false);
  });

  it('the Ollama preset stays available for local use', () => {
    expect(PRESETS.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(PRESETS.ollama.model).toBe('nomic-embed-text');
    expect(PRESETS.ollama.dimension).toBe(768);
  });

  it('the multilingual bge-m3 preset is available (local, 1024-dim, no prefixes/key)', () => {
    const p = PRESETS['ollama-bge-m3'];
    expect(p.baseUrl).toBe('http://localhost:11434/v1');
    expect(p.model).toBe('bge-m3');
    expect(p.dimension).toBe(1024);
    expect(p.queryPrefix).toBe('');
    expect(p.docPrefix).toBe('');
    expect(p.needsKey).toBe(false);
  });

  it('isLocalHost recognizes localhost and 127.0.0.1, rejects remote', () => {
    expect(isLocalHost('http://localhost:11434/v1')).toBe(true);
    expect(isLocalHost('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalHost('https://api.openai.com/v1')).toBe(false);
  });

  it('providerIdFor encodes the host so switching host/model re-embeds', () => {
    const local = providerIdFor('http://localhost:11434/v1');
    const remote = providerIdFor('https://api.openai.com/v1');
    expect(local).not.toBe(remote);
    // fingerprint differs across hosts and models
    const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;
    const a = buildProvider({ ...DEFAULT_SETTINGS }, 'k', post); // OpenAI default
    const b = buildProvider({ ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', dimension: 768 }, null, post);
    expect(embeddingFingerprint(a, 0)).not.toBe(embeddingFingerprint(b, 0));
  });

  it('buildProvider wires the apiKey and dimension through', () => {
    const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;
    const p = buildProvider({ ...DEFAULT_SETTINGS, baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimension: 1536, hasApiKey: true }, 'sk-x', post);
    expect(p.dimension()).toBe(1536);
    expect(p.model).toBe('text-embedding-3-small');
  });

  it('PRESETS.openai needs a key; PRESETS.ollama does not', () => {
    expect(PRESETS.ollama.needsKey).toBe(false);
    expect(PRESETS.openai.needsKey).toBe(true);
    expect(PRESETS.openai.dimension).toBe(1536);
  });

  it('providers differing only in query/doc prefixes must not collide (ollama vs custom preset)', () => {
    // Concrete regression: PRESETS.ollama and PRESETS.custom share the same
    // baseUrl/model/dimension and differ ONLY in queryPrefix/docPrefix. If the
    // fingerprint ignores prefixes, switching between them silently skips
    // re-embedding and the query/doc prefix mismatch corrupts ranking forever.
    const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;
    const a = buildProvider({ ...DEFAULT_SETTINGS, ...PRESETS.ollama }, null, post);
    const b = buildProvider({ ...DEFAULT_SETTINGS, ...PRESETS.custom }, null, post);
    expect(PRESETS.ollama.baseUrl).toBe(PRESETS.custom.baseUrl);
    expect(PRESETS.ollama.model).toBe(PRESETS.custom.model);
    expect(PRESETS.ollama.dimension).toBe(PRESETS.custom.dimension);
    expect(embeddingFingerprint(a, 0)).not.toBe(embeddingFingerprint(b, 0));
  });

  it('providers differing only in baseUrl path (same host) must not collide', () => {
    const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;
    const a = buildProvider({ ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:11434/v1' }, null, post);
    const b = buildProvider({ ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:11434/v2' }, null, post);
    expect(embeddingFingerprint(a, 0)).not.toBe(embeddingFingerprint(b, 0));
  });

  it('identical settings produce identical fingerprints', () => {
    const post = (async () => ({ status: 200, json: {}, headers: {} })) as any;
    const a = buildProvider({ ...DEFAULT_SETTINGS, ...PRESETS.ollama }, null, post);
    const b = buildProvider({ ...DEFAULT_SETTINGS, ...PRESETS.ollama }, null, post);
    expect(embeddingFingerprint(a, 0)).toBe(embeddingFingerprint(b, 0));
  });
});
