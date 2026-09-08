import type { EmbeddingProvider } from '../providers/embedding-provider';
import type { IndexClient } from '../index/index-client';
import type { GenerationRecord } from '../storage/generation-store';

export interface ChunkMeta { path: string; breadcrumb: string }
export interface NoteResult { path: string; breadcrumb: string; score: number }

const FIRST_K = 64;
const WIDEN_FACTOR = 4;
const MAX_WIDENINGS = 2;

export class SearchService {
  constructor(private deps: {
    getProvider: () => EmbeddingProvider;
    client: IndexClient;
    resolve: (occurrenceId: string) => ChunkMeta | undefined;
    getGen: () => GenerationRecord | null;
    floor?: number;
  }) {}

  async search(query: string, limit = 20): Promise<NoteResult[]> {
    const gen = this.deps.getGen();
    if (!gen) return [];
    const [qv] = await this.deps.getProvider().embed([query], 'query');
    const tombstones = new Set(gen.tombstones);
    const floor = this.deps.floor ?? -Infinity;

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
