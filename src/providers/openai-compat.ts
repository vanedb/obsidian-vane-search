import { l2Normalize, type EmbeddingProvider } from './embedding-provider';
import type { HttpPost } from './http';

export type { HttpPost } from './http';

export interface OpenAICompatConfig {
  id: string;
  model: string;
  dimension: number;
  baseUrl: string;
  apiKey?: string;
  queryPrefix?: string;
  docPrefix?: string;
  maxBatch?: number;
}

export type EmbeddingFailure = {
  kind: 'auth' | 'rate-limit' | 'network' | 'bad-response' | 'http';
  status?: number;
  retryAfterMs?: number;
  message: string;
};

export function classifyEmbeddingFailure(status: number, headers: Record<string, string>, bodyText: string): EmbeddingFailure {
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, message: `Authentication failed (HTTP ${status}). Check the API key.` };
  }
  if (status === 429) {
    const ra = headers['retry-after'] ?? headers['Retry-After'];
    const secs = ra ? Number(ra) : NaN;
    const retryAfterMs = Number.isFinite(secs) ? secs * 1000 : undefined;
    return { kind: 'rate-limit', status, retryAfterMs, message: 'Rate limited (HTTP 429).' };
  }
  return { kind: 'http', status, message: `Embedding request failed (HTTP ${status}): ${bodyText.slice(0, 200)}` };
}

export class EmbeddingError extends Error {
  constructor(public failure: EmbeddingFailure) { super(failure.message); this.name = 'EmbeddingError'; }
}

export class OpenAICompatProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  private cfg: OpenAICompatConfig;
  private post: HttpPost;

  constructor(cfg: OpenAICompatConfig, post: HttpPost) {
    this.cfg = cfg;
    this.post = post;
    this.id = cfg.id;
    this.model = cfg.model;
  }

  dimension(): number { return this.cfg.dimension; }
  maxBatch(): number { return this.cfg.maxBatch ?? 32; }

  async embed(texts: string[], kind: 'query' | 'doc'): Promise<Float32Array[]> {
    const prefix = kind === 'query' ? (this.cfg.queryPrefix ?? '') : (this.cfg.docPrefix ?? '');
    const out: Float32Array[] = [];
    const size = this.maxBatch();
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size).map((t) => prefix + t);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(input: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/embeddings`;

    let res: { status: number; json: unknown; headers: Record<string, string> };
    try {
      res = await this.post(url, { headers, body: JSON.stringify({ model: this.cfg.model, input }) });
    } catch (e) {
      throw new EmbeddingError({ kind: 'network', message: `Cannot reach ${url}: ${String(e)}` });
    }
    if (res.status < 200 || res.status >= 300) {
      throw new EmbeddingError(classifyEmbeddingFailure(res.status, res.headers, typeof res.json === 'string' ? res.json : JSON.stringify(res.json)));
    }

    const data = (res.json as { data?: { index?: number; embedding?: number[] }[] }).data;
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new EmbeddingError({ kind: 'bad-response', message: `expected ${input.length} embeddings, got ${Array.isArray(data) ? data.length : 'none'} (count mismatch)` });
    }
    const ordered = data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((row, i) => {
      const emb = row.embedding;
      if (!Array.isArray(emb) || emb.length !== this.cfg.dimension) {
        throw new EmbeddingError({ kind: 'bad-response', message: `row ${i}: expected dimension ${this.cfg.dimension}, got ${Array.isArray(emb) ? emb.length : 'none'}` });
      }
      const v = new Float32Array(this.cfg.dimension);
      for (let j = 0; j < emb.length; j++) {
        if (!Number.isFinite(emb[j])) throw new EmbeddingError({ kind: 'bad-response', message: `row ${i}: non-finite value` });
        v[j] = emb[j];
      }
      try {
        return l2Normalize(v); // throws on the zero vector (no normal direction)
      } catch (e) {
        throw new EmbeddingError({ kind: 'bad-response', message: `row ${i}: ${(e as Error).message}` });
      }
    });
  }
}
