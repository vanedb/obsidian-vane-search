import { OpenAICompatProvider } from '../providers/openai-compat';
import type { HttpPost } from '../providers/http';
import type { EmbeddingProvider } from '../providers/embedding-provider';
import { hash64 } from '../hash';

export interface VaneSettings {
  providerId: string;   // preset key: 'ollama' | 'openai' | 'custom'
  baseUrl: string;
  model: string;
  dimension: number;
  hasApiKey: boolean;   // whether a key is stored in SecretStorage (the key itself never lives here)
  queryPrefix: string;
  docPrefix: string;
  maxBatch: number;
  consentedHosts: string[];
}

export interface Preset {
  label: string; baseUrl: string; model: string; dimension: number;
  queryPrefix: string; docPrefix: string; needsKey: boolean;
}

export const PRESETS: Record<'ollama' | 'ollama-bge-m3' | 'openai' | 'custom', Preset> = {
  ollama: { label: 'Ollama · nomic-embed-text (English)', baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', dimension: 768,
    queryPrefix: 'search_query: ', docPrefix: 'search_document: ', needsKey: false },
  'ollama-bge-m3': { label: 'Ollama · bge-m3 (multilingual)', baseUrl: 'http://localhost:11434/v1', model: 'bge-m3', dimension: 1024,
    queryPrefix: '', docPrefix: '', needsKey: false },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimension: 1536,
    queryPrefix: '', docPrefix: '', needsKey: true },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', dimension: 768,
    queryPrefix: '', docPrefix: '', needsKey: false },
};

// Cloud default (OpenAI): the index is per-device and a phone cannot reach a
// desktop's localhost Ollama, so the out-of-the-box provider must be one a phone
// can use. Users who want local/private switch the preset to Ollama on desktop.
export const DEFAULT_SETTINGS: VaneSettings = {
  providerId: 'openai',
  baseUrl: PRESETS.openai.baseUrl,
  model: PRESETS.openai.model,
  dimension: PRESETS.openai.dimension,
  hasApiKey: false,
  queryPrefix: PRESETS.openai.queryPrefix,
  docPrefix: PRESETS.openai.docPrefix,
  maxBatch: 64,
  consentedHosts: [],
};

export function isLocalHost(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
  } catch { return false; }
}

export function providerIdFor(baseUrl: string): string {
  try { return `oai:${new URL(baseUrl).host}`; } catch { return 'oai:invalid'; }
}

export function buildProvider(settings: VaneSettings, apiKey: string | null, post: HttpPost): EmbeddingProvider {
  // Fold the full baseUrl (not just host) and the query/doc prefixes into the
  // id: they are part of embedding identity and MUST change the fingerprint,
  // or switching between configs that share host/model/dimension but differ
  // in prefixes silently skips re-embedding and corrupts ranking (see
  // ollama vs. custom presets, which collide on host/model/dimension alone).
  const identity = `${settings.baseUrl} ${settings.queryPrefix} ${settings.docPrefix}`;
  const id = `${providerIdFor(settings.baseUrl)}:${hash64(identity).slice(0, 12)}`;
  return new OpenAICompatProvider({
    id,
    model: settings.model,
    dimension: settings.dimension,
    baseUrl: settings.baseUrl,
    apiKey: apiKey ?? undefined,
    queryPrefix: settings.queryPrefix,
    docPrefix: settings.docPrefix,
    maxBatch: settings.maxBatch,
  }, post);
}
