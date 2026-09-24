import type { EmbeddingProvider } from '../providers/embedding-provider';
import type { IndexClient } from '../index/index-client';
import type { GenerationRecord } from '../storage/generation-store';

export interface ChunkMeta { path: string; breadcrumb: string }
export interface NoteResult { path: string; breadcrumb: string; score: number }

/** One lease pins provider, graph, mapping and metadata through all async query work. */
export interface SearchSnapshot {
  provider: EmbeddingProvider;
  client: IndexClient;
  gen: GenerationRecord | null;
  resolve: (occurrenceId: string) => ChunkMeta | undefined;
  fingerprint?: string | null;
  release?: () => void;
}

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
    getSnapshot?: () => SearchSnapshot;
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

  private snapshot(): SearchSnapshot {
    return this.deps.getSnapshot?.() ?? {
      provider: this.deps.getProvider(), client: this.deps.client,
      gen: this.deps.getGen(), resolve: this.deps.resolve,
      fingerprint: this.deps.getProviderFingerprint?.(),
    };
  }

  async search(query: string, limit = 20): Promise<NoteResult[]> {
    const snapshot = this.snapshot();
    try {
      const { gen, provider, fingerprint } = snapshot;
      if (!gen) return [];
      if (fingerprint != null && fingerprint !== gen.embeddingFingerprint) {
        throw new ProviderMismatchError(
          'This index was built with a different embedding provider. Run "Rebuild index" to re-embed with the current provider.'
        );
      }
      const [qv] = await provider.embed([query], 'query');
      return await this.groupHits(qv, limit, gen, snapshot);
    } finally { snapshot.release?.(); }
  }

  /**
   * Same grouping/floor/tombstone/widening logic as `search`, but takes a raw query vector
   * directly — no embedding call, no provider-fingerprint check. Used by callers that already
   * have a vector (e.g. a note-similarity centroid for the related-notes panel). Reads its own
   * gen snapshot since there's no earlier check it needs to stay consistent with.
   */
  async searchVector(
    queryVector: Float32Array,
    limit = 20,
    opts?: { excludePath?: string; expectedGeneration?: GenerationRecord },
  ): Promise<NoteResult[]> {
    const snapshot = this.snapshot();
    try {
      const gen = snapshot.gen;
      // A related-notes centroid may have been loaded while a replacement activated.
      // Never interpret an old-provider vector with a new-provider graph.
      if (!gen || (opts?.expectedGeneration && opts.expectedGeneration !== gen)) return [];
      return await this.groupHits(queryVector, limit, gen, snapshot, opts);
    } finally { snapshot.release?.(); }
  }

  /** The widening/group/floor/tombstone loop, against a caller-supplied gen snapshot. */
  private async groupHits(
    queryVector: Float32Array,
    limit: number,
    gen: GenerationRecord,
    snapshot: SearchSnapshot,
    opts?: { excludePath?: string; expectedGeneration?: GenerationRecord },
  ): Promise<NoteResult[]> {
    const tombstones = new Set(gen.tombstones);
    const floor = this.deps.getFloor ? this.deps.getFloor() : (this.deps.floor ?? -Infinity);

    // Tombstones are filtered post-search, so a starved result set widens k (spec "Data flow").
    let k = FIRST_K;
    for (let attempt = 0; ; attempt++) {
      const hits = await snapshot.client.search(queryVector, k);
      const byNote = new Map<string, NoteResult>();
      for (const h of hits) {
        if (tombstones.has(h.vaneId) || h.score < floor) continue;
        const occ = gen.idMap[h.vaneId];
        if (!occ) continue;
        const meta = snapshot.resolve(occ);
        if (!meta) continue;
        if (opts?.excludePath && meta.path === opts.excludePath) continue;
        const cur = byNote.get(meta.path);
        if (!cur || h.score > cur.score) {
          byNote.set(meta.path, { path: meta.path, breadcrumb: meta.breadcrumb, score: h.score });
        }
      }
      const notes = [...byNote.values()].sort((a, b) => b.score - a.score);
      const { size } = await snapshot.client.stats();
      if (notes.length >= limit || k >= size || attempt >= MAX_WIDENINGS) {
        return notes.slice(0, limit);
      }
      k = Math.min(k * WIDEN_FACTOR, Math.max(size, 1));
    }
  }
}
