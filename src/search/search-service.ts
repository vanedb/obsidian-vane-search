import type { EmbeddingProvider } from '../providers/embedding-provider';
import type { IndexClient } from '../index/index-client';
import type { GenerationRecord } from '../storage/generation-store';

export interface ChunkMeta { path: string; breadcrumb: string }
export interface NoteResult { path: string; breadcrumb: string; score: number }

const FIRST_K = 64;
const WIDEN_FACTOR = 4;
const MAX_WIDENINGS = 2;

/** Thrown when the live provider doesn't match the generation being searched — the query must not be embedded remotely. */
export class ProviderMismatchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ProviderMismatchError';
  }
}

export class SearchService {
  constructor(private deps: {
    getProvider: () => EmbeddingProvider;
    client: IndexClient;
    resolve: (occurrenceId: string) => ChunkMeta | undefined;
    getGen: () => GenerationRecord | null;
    getProviderFingerprint?: () => string | null;
    /** Static floor (legacy / tests). Prefer getFloor for a value that can change at runtime. */
    floor?: number;
    /** Live accessor for the similarity floor — read on every search, so a settings change takes effect immediately. Takes precedence over `floor` when set. */
    getFloor?: () => number;
  }) {}

  async search(query: string, limit = 20): Promise<NoteResult[]> {
    const gen = this.deps.getGen();
    if (!gen) return [];
    if (this.deps.getProviderFingerprint) {
      const fp = this.deps.getProviderFingerprint();
      if (fp !== null && fp !== gen.embeddingFingerprint) {
        throw new ProviderMismatchError(
          'This index was built with a different embedding provider. Run "Rebuild index" to re-embed with the current provider.'
        );
      }
    }
    const [qv] = await this.deps.getProvider().embed([query], 'query');
    const tombstones = new Set(gen.tombstones);
    const floor = this.deps.getFloor ? this.deps.getFloor() : (this.deps.floor ?? -Infinity);

    // Tombstones are filtered post-search, so a starved result set widens k (spec "Data flow").
    let k = FIRST_K;
    for (let attempt = 0; ; attempt++) {
      const hits = await this.deps.client.search(qv, k);
      const byNote = new Map<string, NoteResult>();
      for (const h of hits) {
        if (tombstones.has(h.vaneId) || h.score < floor) continue;
        const occ = gen.idMap[h.vaneId];
        if (!occ) continue;
        const meta = this.deps.resolve(occ);
        if (!meta) continue;
        const cur = byNote.get(meta.path);
        if (!cur || h.score > cur.score) {
          byNote.set(meta.path, { path: meta.path, breadcrumb: meta.breadcrumb, score: h.score });
        }
      }
      const notes = [...byNote.values()].sort((a, b) => b.score - a.score);
      const { size } = await this.deps.client.stats();
      if (notes.length >= limit || k >= size || attempt >= MAX_WIDENINGS) {
        return notes.slice(0, limit);
      }
      k = Math.min(k * WIDEN_FACTOR, Math.max(size, 1));
    }
  }
}
